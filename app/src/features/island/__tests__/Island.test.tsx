/**
 * 灵动岛回归测试。
 *
 * 覆盖：展开/收起、↑↓ 选择、Enter 复制密码、Shift+Enter 复制账号、
 * Esc 收起、搜索空态、锁定态输入禁用。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Island } from '../Island';
import { createTestClient, renderWithProviders } from '../../__tests__/support/harness';
import { MASTER_PASSWORD } from '../../__tests__/support/harness';
import { useUiStore } from '../../../stores/ui-store';

/** 每个用例前把灵动岛状态复位，避免用例间互相污染。 */
beforeEach(() => {
  useUiStore.setState({
    island: { phase: 'collapsed', query: '', activeIndex: 0, focused: false },
    session: { status: 'unlocked', cooldownUntil: null },
    filters: { category: 'all', sort: 'recent_updated' },
    autoLockPolicy: '30m',
  });
});

/** 建库 + 两张卡片，并用"复制"把顺序写进最近使用（GitHub 最新）。 */
async function setup(): Promise<ReturnType<typeof createTestClient> & { githubId: number; mailId: number }> {
  const harness = createTestClient();
  await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
  const github = await harness.client.createItem({
    title: 'GitHub',
    platform: 'GitHub',
    username: 'dev-alpha',
    password: 'Value-Alpha-1',
  });
  const mail = await harness.client.createItem({
    title: '公司邮箱',
    platform: '企业邮箱',
    username: 'me-bravo',
    password: 'Value-Bravo-2',
  });
  // 先复制邮箱、再复制 GitHub，让 GitHub 成为最近使用第一位。
  await harness.client.copyPassword(mail.id);
  harness.advance(1000);
  await harness.client.copyUsername(github.id);
  return { ...harness, githubId: github.id, mailId: mail.id };
}

/**
 * 唤出表面并展开面板，但**不等待列表就绪**。
 *
 * 空列表场景（最近使用为空）不会有任何 `option`，`openIsland` 会一直等到超时，
 * 所以空态用例必须用这个更弱的前置条件。
 */
async function expandIsland(): Promise<HTMLElement> {
  // 灵动岛默认隐藏：先把鼠标推到顶端热区唤出表面，再点胶囊展开。
  // jsdom 没有 PointerEvent，`pointerMove` 事件不带坐标，因此用 mousemove。
  fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '展开密岛' })).toBeDefined();
  });
  fireEvent.click(screen.getByRole('button', { name: '展开密岛' }));
  return screen.findByTestId('island-panel');
}

/** 展开灵动岛并等待列表就绪。 */
async function openIsland(): Promise<HTMLElement> {
  const panel = await expandIsland();
  await screen.findAllByRole('option');
  return panel;
}

describe('Island 灵动岛', () => {
  it('点击胶囊展开后按最近使用顺序列出资产', async () => {
    const { client } = await setup();
    renderWithProviders(client, <Island status="unlocked" onLock={vi.fn()} onRequestUnlock={vi.fn()} onOpenSettings={() => {}} />);

    await openIsland();

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('GitHub');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('↑/↓ 切换高亮项', async () => {
    const { client } = await setup();
    renderWithProviders(client, <Island status="unlocked" onLock={vi.fn()} onRequestUnlock={vi.fn()} onOpenSettings={() => {}} />);

    const panel = await openIsland();

    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    });

    fireEvent.keyDown(panel, { key: 'ArrowUp' });
    await waitFor(() => {
      expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('aria-activedescendant 跟随 ↑/↓ 指向当前高亮项（SDD §12）', async () => {
    const { client } = await setup();
    renderWithProviders(client, <Island status="unlocked" onLock={vi.fn()} onRequestUnlock={vi.fn()} onOpenSettings={() => {}} />);

    const panel = await openIsland();
    const input = screen.getByTestId('island-input');

    // combobox ↔ listbox 的关联三件套必须齐备，否则屏幕阅读器读不到选项。
    expect(input).toHaveAttribute('role', 'combobox');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', 'island-listbox');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(screen.getByRole('listbox', { name: '最近使用' })).toHaveAttribute('id', 'island-listbox');

    const options = screen.getAllByRole('option');
    const firstId = options[0].id;
    expect(firstId).not.toBe('');
    expect(input.getAttribute('aria-activedescendant')).toBe(firstId);
    // 指向的 id 必须真的能在文档里找到对应 option —— 防止拼出 `island-option-undefined`。
    expect(document.getElementById(firstId)?.getAttribute('role')).toBe('option');

    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id);
    });
    expect(document.getElementById(options[1].id)?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(panel, { key: 'ArrowUp' });
    await waitFor(() => {
      expect(input.getAttribute('aria-activedescendant')).toBe(firstId);
    });
  });

  it('Enter 复制高亮项的密码', async () => {
    const { client, clipboard } = await setup();
    renderWithProviders(client, <Island status="unlocked" onLock={vi.fn()} onRequestUnlock={vi.fn()} onOpenSettings={() => {}} />);

    const panel = await openIsland();
    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    fireEvent.keyDown(panel, { key: 'Enter' });

    await waitFor(() => {
      expect(clipboard.value).toBe('Value-Bravo-2');
    });
    // SDD §6.4：Toast 必须说明复制对象与自动清空时间。
    expect(await screen.findByText('已复制密码 · 30 秒后自动清空')).toBeInTheDocument();
  });

  it('Shift+Enter 复制账号', async () => {
    const { client, clipboard } = await setup();
    renderWithProviders(client, <Island status="unlocked" onLock={vi.fn()} onRequestUnlock={vi.fn()} onOpenSettings={() => {}} />);

    const panel = await openIsland();
    fireEvent.keyDown(panel, { key: 'Enter', shiftKey: true });

    await waitFor(() => {
      expect(clipboard.value).toBe('dev-alpha');
    });
  });

  it('Esc 立即收起', async () => {
    const { client } = await setup();
    renderWithProviders(client, <Island status="unlocked" onLock={vi.fn()} onRequestUnlock={vi.fn()} onOpenSettings={() => {}} />);

    const panel = await openIsland();
    fireEvent.keyDown(panel, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('island-panel')).toBeNull();
    });
  });

  it('搜索无结果时显示空态', async () => {
    const { client } = await setup();
    renderWithProviders(client, <Island status="unlocked" onLock={vi.fn()} onRequestUnlock={vi.fn()} onOpenSettings={() => {}} />);

    await openIsland();
    fireEvent.change(screen.getByTestId('island-input'), { target: { value: 'zzz-不存在' } });

    expect(await screen.findByText('没有匹配的资产')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('搜不到结果时不出现「复制卡片后出现」的误导副文案', async () => {
    const { client } = await setup();
    renderWithProviders(client, <Island status="unlocked" onLock={vi.fn()} onRequestUnlock={vi.fn()} onOpenSettings={() => {}} />);

    await openIsland();
    fireEvent.change(screen.getByTestId('island-input'), { target: { value: 'zzz-不存在' } });

    expect(await screen.findByText('没有匹配的资产')).toBeInTheDocument();
    // 用户明明有卡片、只是关键词打错了，再让他「去复制一张卡」是误导。
    expect(screen.queryByText('复制任意卡片后会自动出现在这里')).toBeNull();
    expect(screen.getByText('换个关键词试试，或点右上角「新建」建这张卡')).toBeInTheDocument();

    // 列表空了之后 combobox 必须收起，且不能残留指向已消失选项的 activedescendant。
    const input = screen.getByTestId('island-input');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('没有搜索词时（岛列表为空）副文案说明"主面板建的卡也会立即出现"', async () => {
    const harness = createTestClient();
    await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
    // 一张卡都不复制 → 岛列表为空；搜索框也为空，两个条件同时成立才是真正的"首次进入"。
    renderWithProviders(harness.client, <Island status="unlocked" onLock={vi.fn()} onRequestUnlock={vi.fn()} onOpenSettings={() => {}} />);

    await expandIsland();

    expect(await screen.findByText('还没有卡片')).toBeInTheDocument();
    // 项⑤：文案已纠正——主面板建的卡会立即出现，不再误导"复制任意卡片后才会出现"。
    expect(screen.getByText('点右上角「新建」创建第一张卡，主面板建的卡也会立即出现在这里')).toBeInTheDocument();
    expect(screen.queryByText('换个关键词试试，或点右上角「新建」建这张卡')).toBeNull();
  });

  it('岛内搜索支持拼音首字母与全拼（与主面板同一套匹配规则）', async () => {
    const { client } = await setup();
    renderWithProviders(client, <Island status="unlocked" onLock={vi.fn()} onRequestUnlock={vi.fn()} onOpenSettings={() => {}} />);

    await openIsland();
    // 「公司邮箱」→ gongsiyouxiang / gsyx
    fireEvent.change(screen.getByTestId('island-input'), { target: { value: 'gsyx' } });
    await waitFor(() => {
      const options = screen.getAllByRole('option');
      expect(options).toHaveLength(1);
      expect(options[0]).toHaveTextContent('公司邮箱');
    });

    fireEvent.change(screen.getByTestId('island-input'), { target: { value: 'gongsiyouxiang' } });
    await waitFor(() => {
      expect(screen.getAllByRole('option')[0]).toHaveTextContent('公司邮箱');
    });
  });

  it('点击卡片复制该卡密码，且岛不收起', async () => {
    const { client, clipboard } = await setup();
    renderWithProviders(client, <Island status="unlocked" onLock={vi.fn()} onRequestUnlock={vi.fn()} onOpenSettings={() => {}} />);

    await openIsland();
    // 第 2 张是「公司邮箱」（Value-Bravo-2）。点击时 `activeIndex` 还是 0，
    // 所以这条用例同时钉住"按 id 复制"而不是"按高亮项复制"。
    fireEvent.click(screen.getAllByRole('option')[1]);

    await waitFor(() => {
      expect(clipboard.value).toBe('Value-Bravo-2');
    });
    expect(await screen.findByText('已复制密码 · 30 秒后自动清空')).toBeInTheDocument();

    // 点击不收起：与 Enter 路径一致，方便连续复制账号。
    expect(screen.getByTestId('island-panel')).toBeInTheDocument();
    expect(useUiStore.getState().island.phase).toBe('expanded');
    // 点击顺手把高亮挪过去，键盘接力不会跳回第 1 项。
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('点击卡片不抢焦点：mousedown 默认行为被阻止，键盘接力可用', async () => {
    const { client, clipboard } = await setup();
    renderWithProviders(client, <Island status="unlocked" onLock={vi.fn()} onRequestUnlock={vi.fn()} onOpenSettings={() => {}} />);

    await openIsland();
    const option = screen.getAllByRole('option')[1];

    // jsdom 的 `fireEvent.click` **不模拟焦点转移**，所以不能断言 `document.activeElement`。
    // 这里断言的是机制：`fireEvent` 返回 `false` 表示 `defaultPrevented === true`，
    // 即 mousedown 的默认行为（把焦点移到最近的可聚焦祖先 / body）被阻止了。
    // 真实浏览器里，这一步保住的就是"焦点仍在搜索框"，↑↓/Enter/Esc 才不会全哑。
    expect(fireEvent.mouseDown(option)).toBe(false);

    // 阻止 mousedown 不能影响 click：复制逻辑必须照常跑。
    fireEvent.click(option);
    await waitFor(() => {
      expect(clipboard.value).toBe('Value-Bravo-2');
    });
    expect(screen.getByTestId('island-panel')).toBeInTheDocument();
    expect(useUiStore.getState().island.phase).toBe('expanded');
  });

  it('注入负索引时不丢选中态（渲染期双边夹取）', async () => {
    const { client } = await setup();
    renderWithProviders(client, <Island status="unlocked" onLock={vi.fn()} onRequestUnlock={vi.fn()} onOpenSettings={() => {}} />);

    await openIsland();

    // `setActiveIndex` 自带 `Math.max(0, ...)` 兜底，注入不了负数，只能直改 store 状态。
    act(() => {
      useUiStore.setState((state) => ({ island: { ...state.island, activeIndex: -3 } }));
    });

    // 只夹上界时 `visible[-3]` 是 undefined → 一个选中项都没有、Enter 变空操作。
    await waitFor(() => {
      expect(document.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
    });
    const first = screen.getAllByRole('option')[0];
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('island-input').getAttribute('aria-activedescendant')).toBe(first.id);
  });

  it('锁定态下搜索输入被禁用', async () => {
    const { client } = await setup();
    useUiStore.setState({ island: { phase: 'expanded', query: '', activeIndex: 0, focused: true } });

    renderWithProviders(client, <Island status="locked" onLock={vi.fn()} onRequestUnlock={vi.fn()} onOpenSettings={() => {}} />);

    const input = await screen.findByTestId('island-input');
    expect(input).toBeDisabled();
    expect(screen.getByText('保险库已锁定，无法读取资产')).toBeInTheDocument();
  });
});
