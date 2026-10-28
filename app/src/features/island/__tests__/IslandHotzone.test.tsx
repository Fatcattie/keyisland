/**
 * 灵动岛「顶部热区唤起」回归（SDD §1 Web 阶段落地）。
 *
 * 产品行为：灵动岛默认完全隐藏，只有鼠标推到屏幕顶端才滑出；离开后又藏起来。
 * 生产版由 Rust 窗口层的真实全局热区触发（WS_EX_NOACTIVATE / 原生轮询），
 * 本轮用页面级监听 + 4px 命中带实现同样的时序，便于后续替换。
 *
 * jsdom 现实（已实测，见下）：
 * - 本组合里 `window.PointerEvent` 是 `undefined`，`fireEvent.pointerMove(window, ...)`
 *   只会派发一个没有坐标的普通 `Event`（`clientY === undefined`）。
 * - 因此测试用 `fireEvent.mouseMove`；组件同时监听 `pointermove` 与 `mousemove`，
 *   真实浏览器里走 `pointermove`，行为完全一致。
 * - 隐藏有两档延时（胶囊 250ms / 展开态默认 2s，见 `lib/timing.ts`），用例用
 *   vitest 假定时钟推进；假定时钟下不用 `waitFor`（它内部依赖定时器），
 *   改为 `act(() => vi.advanceTimersByTime(...))`。
 *
 * 坐标约定：`fireEvent.mouseMove` 会把**没传的坐标补成 0**，所以只写
 * `{ clientY: 0 }` 等于"鼠标在屏幕左上角"。热区从 FR-02 起是居中的一条带
 * （默认 300px，jsdom 视口 1024 → [362, 662]），左上角并不在带内。
 * 因此所有"鼠标推到顶端"的用例都必须显式给 `clientX: 512`（屏幕水平中心）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Island } from '../Island';
import { createTestClient, renderWithProviders, MASTER_PASSWORD } from '../../__tests__/support/harness';
import { useUiStore } from '../../../stores/ui-store';

/** 把灵动岛复位为收起态，避免用例间互相污染。 */
function resetUiStore(): void {
  useUiStore.setState({
    island: { phase: 'collapsed', query: '', activeIndex: 0, focused: false },
    session: { status: 'unlocked', cooldownUntil: null },
  });
}

beforeEach(() => {
  resetUiStore();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 渲染一座已解锁的灵动岛（默认应处于隐藏态）。 */
async function renderIsland(): Promise<void> {
  const harness = createTestClient();
  await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
  renderWithProviders(
    harness.client,
    <Island status="unlocked" onLock={() => {}} onRequestUnlock={() => {}} onOpenSettings={() => {}} />,
  );
}

/**
 * 让展开副作用里的异步 `setState` 在 `act` 内落地。
 *
 * `Island` 展开后会 `await client.getRecentItems()` 再 `setItems`；用例若在展开后
 * 立刻断言并结束，这段 promise 链会落在 `act` 之外，React 抛
 * "An update to Island inside a test was not wrapped in act(...)"。
 * 那类警告会掩盖真实的时序断言，所以主动 flush 一次宏任务把它收干净。
 */
async function flushAsyncEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
}

/**
 * 展开态「指针离开 → 收起」的等待时长。
 *
 * 默认收起延时是 2000ms（PRD FR-02「鼠标离开 2 秒后自动收起」/ SDD §6.5），
 * 这里多给 500ms 余量覆盖 180ms 的收起动画。
 * **胶囊态仍然是 250ms**——它不是 PRD 里的"工具栏"，见 `lib/timing.ts`。
 */
const HIDE_AFTER_LEAVE_MS = 2500;

describe('Island 热区唤起', () => {
  it('初始渲染：灵动岛表面不在 DOM 中，只留热区与键盘入口', async () => {
    await renderIsland();

    expect(screen.queryByPlaceholderText('搜索资产…')).toBeNull();
    expect(screen.queryByRole('dialog', { name: '密岛灵动岛' })).toBeNull();
    expect(screen.queryByRole('button', { name: '展开密岛' })).toBeNull();

    // 命中带与键盘唤出入口始终存在。
    expect(screen.getByTestId('island-hotzone')).toBeDefined();
    expect(screen.getByRole('button', { name: '唤出灵动岛' })).toBeDefined();
  });

  it('命中带不挡住页面：没有全屏遮罩，且只有 4px 命中区域', async () => {
    await renderIsland();

    const hotzone = screen.getByTestId('island-hotzone');
    expect(hotzone.getAttribute('aria-hidden')).toBe('true');
    // 唤起靠 window 上的 mousemove（照样冒泡），所以命中带不该接收指针事件，
    // 否则会吃掉页面最顶端 4px 的点击（QA 复验 P2-2）。
    expect(hotzone.className).toContain('pointer-events-none');
    // 键盘唤出入口同样只服务键盘，不该截获顶部中央的点击。
    expect(screen.getByTestId('island-summon').className).toContain('pointer-events-none');
    // 4px → Tailwind 的 h-1；不能出现覆盖全屏的遮罩。
    expect(hotzone.className).toContain('h-1');
    expect(hotzone.className).not.toContain('inset-0');

    // 页面主体不能被任何全屏容器挡住：DOM 里不存在 `fixed inset-0` 遮罩。
    const overlays = Array.from(document.body.querySelectorAll('div')).filter(
      (node) => node.className.includes('inset-0') && node.className.includes('fixed'),
    );
    expect(overlays).toHaveLength(0);
  });

  it('鼠标移到顶端（clientY <= 4）唤出折叠胶囊', async () => {
    await renderIsland();

    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '展开密岛' })).toBeDefined();
    });
    // 只是唤出胶囊，不应该直接展开面板。
    expect(screen.queryByTestId('island-panel')).toBeNull();
    expect(useUiStore.getState().island.phase).toBe('collapsed');
  });

  it('胶囊态：鼠标离开（clientY > 48）并等待 250ms 后隐藏', async () => {
    await renderIsland();
    vi.useFakeTimers();

    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
    expect(screen.getByRole('button', { name: '展开密岛' })).toBeDefined();

    fireEvent.mouseMove(window, { clientX: 512, clientY: 300 });
    // 250ms 延迟之内仍然看得见：给鼠标穿过迟滞带留时间。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.queryByRole('button', { name: '展开密岛' })).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.queryByRole('button', { name: '展开密岛' })).toBeNull();
    expect(screen.queryByTestId('island-panel')).toBeNull();
    expect(screen.queryByPlaceholderText('搜索资产…')).toBeNull();
  });

  it('迟滞带：鼠标停在 4–48px 之间不隐藏', async () => {
    await renderIsland();
    vi.useFakeTimers();
    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
    expect(screen.getByRole('button', { name: '展开密岛' })).toBeDefined();

    fireEvent.mouseMove(window, { clientX: 512, clientY: 30 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.queryByRole('button', { name: '展开密岛' })).not.toBeNull();
  });

  it('迟滞带会取消已排队的隐藏（指针从下方快速回到顶端附近）', async () => {
    await renderIsland();
    vi.useFakeTimers();
    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
    expect(screen.getByRole('button', { name: '展开密岛' })).toBeDefined();

    // 先移到远处 → 排入 250ms 隐藏；在它到期前回到迟滞带。
    fireEvent.mouseMove(window, { clientX: 512, clientY: 300 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    fireEvent.mouseMove(window, { clientX: 512, clientY: 20 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // 待执行的隐藏已被取消，胶囊仍在。
    expect(screen.queryByRole('button', { name: '展开密岛' })).not.toBeNull();
  });

  it('展开态鼠标彻底离开：收起并隐藏', async () => {
    await renderIsland();

    // 唤出 → 折叠胶囊 → 点击展开。
    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
    fireEvent.click(screen.getByRole('button', { name: '展开密岛' }));
    expect(screen.getByTestId('island-panel')).toBeDefined();
    expect(useUiStore.getState().island.phase).toBe('expanded');

    vi.useFakeTimers();
    fireEvent.mouseMove(window, { clientX: 512, clientY: 400 });
    // 第一步：收起延时（默认 2s）到期 → 收起面板。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HIDE_AFTER_LEAVE_MS);
    });
    expect(screen.queryByTestId('island-panel')).toBeNull();

    // 第二步：180ms 收起动画收尾 → 相位回到 collapsed，表面彻底撤出 DOM。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.queryByRole('button', { name: '展开密岛' })).toBeNull();
    expect(screen.queryByPlaceholderText('搜索资产…')).toBeNull();
    expect(useUiStore.getState().island.phase).toBe('collapsed');
  });

  it('键盘 Tab 唤出：聚焦唤出按钮后展开，焦点落到搜索框', async () => {
    await renderIsland();

    fireEvent.focus(screen.getByRole('button', { name: '唤出灵动岛' }));

    expect(await screen.findByTestId('island-panel')).toBeDefined();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByPlaceholderText('搜索资产…'));
    });
  });

  it('鼠标在展开面板内部移动不会被误判成"已离开"', async () => {
    // 回归 P0-1：面板从 top-2 起、高约 306px，除顶部几十 px 外 clientY 都 > 48。
    // 早期版本只看 clientY 就安排隐藏，于是鼠标在列表区移动后面板被撤掉。
    await renderIsland();

    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
    fireEvent.click(screen.getByRole('button', { name: '展开密岛' }));
    expect(screen.getByTestId('island-panel')).toBeDefined();

    vi.useFakeTimers();
    // 派发在**面板内部元素**上（clientY 120），target 是岛的子孙节点。
    // 注意不要用列表项做 target：这个用例没有造资产，列表不会渲染。
    const panel = screen.getByTestId('island-panel');
    fireEvent.mouseMove(panel, { clientY: 120 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.getByTestId('island-panel')).toBeDefined();
    expect(useUiStore.getState().island.phase).toBe('expanded');
  });

  it('折叠胶囊区域内移动同样不触发隐藏', async () => {
    await renderIsland();

    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
    const capsule = screen.getByRole('button', { name: '展开密岛' });
    expect(capsule).toBeDefined();

    vi.useFakeTimers();
    fireEvent.mouseMove(capsule, { clientY: 20 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.queryByRole('button', { name: '展开密岛' })).not.toBeNull();
  });

  it('快捷新建表单：鼠标移出面板后表单与已输入内容都保留', async () => {
    // 回归 P0-2：填标题时 query 为空、keyboardSummoned 为 false，
    // "正在表单里打字"必须被算作用户在工作。
    await renderIsland();

    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
    fireEvent.click(screen.getByRole('button', { name: '展开密岛' }));
    expect(screen.getByTestId('island-panel')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '回归用 · GitHub' } });

    vi.useFakeTimers();
    fireEvent.mouseMove(window, { clientX: 512, clientY: 300 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HIDE_AFTER_LEAVE_MS);
    });

    // 表单还在，而且用户输入的值没有丢。
    expect(screen.getByLabelText('标题')).toBeDefined();
    expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('回归用 · GitHub');
    expect(screen.getByRole('button', { name: '创建并复制密码' })).toBeDefined();
  });

  it('快捷新建表单：焦点丢失（点面板空白）后鼠标离开也不销毁表单', async () => {
    // 回归 QA 复验的 P1：只看"岛内还有焦点"是不够的——点面板空白会让
    // activeElement 退回 body，填了一半的标题照样会被销毁。
    await renderIsland();

    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
    fireEvent.click(screen.getByRole('button', { name: '展开密岛' }));
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '焦点丢失也不该丢' } });

    // 模拟"点面板空白"：焦点离开岛内。
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    vi.useFakeTimers();
    fireEvent.mouseMove(window, { clientX: 512, clientY: 300 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HIDE_AFTER_LEAVE_MS);
    });

    expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('焦点丢失也不该丢');
  });

  it('主动 dismiss 会复位快捷新建：重新唤出不会看到残留表单，且岛仍能自动收起', async () => {
    // 回归 QA 复验的 P2-1：表单状态不复位会让 createOpen 恒为真，
    // 隐藏被永久顺延 → 岛再也收不起来。
    await renderIsland();

    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
    fireEvent.click(screen.getByRole('button', { name: '展开密岛' }));
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '残留检查' } });

    // 点面板外部：主动 dismiss。
    fireEvent.pointerDown(document.body);
    await waitFor(() => {
      expect(screen.queryByTestId('island-panel')).toBeNull();
    });

    // 重新唤出并展开：表单必须是关闭的、标题为空。
    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
    fireEvent.click(screen.getByRole('button', { name: '展开密岛' }));
    expect(screen.getByTestId('island-panel')).toBeDefined();
    expect(screen.queryByLabelText('标题')).toBeNull();

    // 而且自动隐藏重新生效。
    vi.useFakeTimers();
    fireEvent.mouseMove(window, { clientX: 512, clientY: 300 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HIDE_AFTER_LEAVE_MS);
    });
    expect(screen.queryByTestId('island-panel')).toBeNull();
  });

  it('唤出按钮可用 Enter 键唤出', async () => {
    await renderIsland();

    const summon = screen.getByRole('button', { name: '唤出灵动岛' });
    act(() => {
      summon.focus();
    });
    fireEvent.click(summon);

    expect(await screen.findByTestId('island-panel')).toBeDefined();
  });

  it('键盘优先：键盘唤出的面板不因鼠标离开而收起', async () => {
    await renderIsland();

    // 先在真实定时器下完成唤出与展开（自动聚焦搜索框）。
    fireEvent.focus(screen.getByRole('button', { name: '唤出灵动岛' }));
    expect(await screen.findByTestId('island-panel')).toBeDefined();

    vi.useFakeTimers();
    fireEvent.mouseMove(window, { clientX: 512, clientY: 400 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HIDE_AFTER_LEAVE_MS);
    });

    // 键盘用户不该被"指针离开"打断。
    expect(screen.getByTestId('island-panel')).toBeDefined();
  });

  it('已输入搜索词时顺延隐藏，清空搜索词后恢复自动隐藏', async () => {
    await renderIsland();

    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
    fireEvent.click(screen.getByRole('button', { name: '展开密岛' }));
    expect(await screen.findByTestId('island-panel')).toBeDefined();

    vi.useFakeTimers();
    // 输入搜索词 → 用户在键盘上工作，隐藏顺延。
    fireEvent.change(screen.getByPlaceholderText('搜索资产…'), { target: { value: 'g' } });
    fireEvent.mouseMove(window, { clientX: 512, clientY: 400 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HIDE_AFTER_LEAVE_MS);
    });
    expect(screen.getByTestId('island-panel')).toBeDefined();

    // 清空搜索词 → 重新唤出再离开，应当正常隐藏（保护不是永久生效的）。
    fireEvent.change(screen.getByPlaceholderText('搜索资产…'), { target: { value: '' } });
    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 512, clientY: 400 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HIDE_AFTER_LEAVE_MS);
    });
    expect(screen.queryByTestId('island-panel')).toBeNull();
  });

  it('Esc 收起后胶囊不残留', async () => {
    // 回归 P2-1：主动 dismiss 要把表面一起撤掉，否则面板没了胶囊还挂在屏幕上。
    await renderIsland();

    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
    fireEvent.click(screen.getByRole('button', { name: '展开密岛' }));
    const panel = screen.getByTestId('island-panel');

    fireEvent.keyDown(panel, { key: 'Escape' });

    // 面板立刻消失；胶囊要等 180ms 的收起动画结束后才卸载（这是设计，不是残留）。
    expect(screen.queryByTestId('island-panel')).toBeNull();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '展开密岛' })).toBeNull();
    });
    expect(screen.queryByPlaceholderText('搜索资产…')).toBeNull();
    // 命中带与键盘唤出入口始终在。
    expect(screen.getByTestId('island-hotzone')).toBeDefined();
    expect(screen.getByRole('button', { name: '唤出灵动岛' })).toBeDefined();
  });

  it('点击外部收起后胶囊不残留', async () => {
    await renderIsland();

    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
    fireEvent.click(screen.getByRole('button', { name: '展开密岛' }));
    expect(screen.getByTestId('island-panel')).toBeDefined();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByTestId('island-panel')).toBeNull();
    // 胶囊随收起动画（180ms）一起卸载。
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '展开密岛' })).toBeNull();
    });
  });

  it('Esc 在快捷新建里只退出新建，不收起整个岛', async () => {
    await renderIsland();

    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
    fireEvent.click(screen.getByRole('button', { name: '展开密岛' }));
    await flushAsyncEffects();
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    expect(screen.getByLabelText('标题')).toBeDefined();

    const panel = screen.getByTestId('island-panel');
    fireEvent.keyDown(panel, { key: 'Escape' });

    // 表单退出，但岛还在展开态（用户还在用）。
    expect(screen.queryByLabelText('标题')).toBeNull();
    expect(screen.getByTestId('island-panel')).toBeDefined();
    expect(useUiStore.getState().island.phase).toBe('expanded');
  });

  it('键盘唤出后焦点离开：指针移开能正常收起（不再滞留）', async () => {
    // 回归 QA 复验 P2-5：键盘唤出后焦点挂在搜索框上，若只看"键盘唤出"标记，
    // 指针怎么移都不会收起。焦点离开岛时必须撤销这个顺延资格。
    await renderIsland();

    fireEvent.focus(screen.getByRole('button', { name: '唤出灵动岛' }));
    await waitFor(() => {
      expect(screen.getByTestId('island-panel')).toBeDefined();
    });

    vi.useFakeTimers();
    // 焦点仍在岛内：指针离开也不收起（这是键盘用户要的）。
    fireEvent.mouseMove(window, { clientX: 512, clientY: 300 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HIDE_AFTER_LEAVE_MS);
    });
    expect(screen.getByTestId('island-panel')).toBeDefined();

    // 焦点离开岛（相当于用户点了页面别处）→ 再移开鼠标 → 正常收起。
    fireEvent.blur(screen.getByTestId('island-input'), { relatedTarget: document.body });
    fireEvent.mouseMove(window, { clientX: 512, clientY: 300 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HIDE_AFTER_LEAVE_MS);
    });
    expect(screen.queryByTestId('island-panel')).toBeNull();
  });

  it('prefers-reduced-motion 下表面照常出现（动效可关）', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    try {
      await renderIsland();
      fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: '展开密岛' })).toBeDefined();
      });
      fireEvent.click(screen.getByRole('button', { name: '展开密岛' }));
      await flushAsyncEffects();
      expect(screen.getByTestId('island-panel')).toBeDefined();
    } finally {
      window.matchMedia = original;
    }
  });

  it('锁定态同样可以唤出，胶囊提示去解锁', async () => {
    const harness = createTestClient();
    const onRequestUnlock = vi.fn();
    await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
    await harness.client.lock();
    renderWithProviders(
      harness.client,
      <Island status="locked" onLock={() => {}} onRequestUnlock={onRequestUnlock} onOpenSettings={() => {}} />,
    );

    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
    const capsule = await screen.findByRole('button', { name: '展开密岛' });
    fireEvent.click(capsule);

    expect(onRequestUnlock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('island-panel')).toBeNull();
  });
});
