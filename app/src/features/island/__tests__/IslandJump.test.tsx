/**
 * 灵动岛侧的跳转入口（PRD FR-07.1「卡片**与灵动岛**提供"跳转"操作」）。
 *
 * 七条行为，逐条对应 PRD 与"和卡片侧必须同源"的约束：
 * 1. 只有网址 → 右键直接打开，不弹菜单；
 * 2. Ctrl+Enter 走跳转，**不能**顺带把密码复制进剪贴板（两个动作隐私含义不同）；
 * 3. 网址 + 本地应用双目标 → 弹二选一菜单，本地项在 Web 阶段置灰；
 * 4. 只有本地应用 → 桌面版提示，且不调 window.open；
 * 5. 两个目标都没配 → 提示未配置；
 * 6. 右键卡片不连带弹出岛级右键菜单（两扇门不能一起开）；
 * 7. 跳转菜单开着时指针离开岛面不收起（菜单 portal 在 body 上，指针已经出岛）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { Island } from '../Island';
import { createTestClient, MASTER_PASSWORD, renderWithProviders } from '../../__tests__/support/harness';
import type { TestClient } from '../../__tests__/support/harness';
import { useUiStore } from '../../../stores/ui-store';

/** 展开态默认收起延时 2 秒（PRD FR-02）；用例推到它之后。 */
const HIDE_AFTER_LEAVE_MS = 2500;

/**
 * window.open 替身：返回 null 表示"打开了但拿不到窗口对象"。
 *
 * 返回值不写显式类型注解——`vi.spyOn` 的泛型签名在各 vitest 版本间不一致，
 * 手写 `ReturnType<typeof vi.spyOn>` 会与真实返回类型对不上，交给推断最稳。
 */
function stubWindowOpen() {
  return vi.spyOn(window, 'open').mockReturnValue(null);
}

function renderIslandWith(test: TestClient): void {
  renderWithProviders(
    test.client,
    <Island status="unlocked" onLock={() => {}} onRequestUnlock={() => {}} onOpenSettings={() => {}} />,
  );
}

/**
 * 让展开副作用里的异步 `setState` 在 `act` 内落地。
 *
 * `Island` 展开后会 `await client.getRecentItems()` 再 `setItems`；不flush 这段
 * 微/宏任务链，React 会抛 "not wrapped in act"，那类警告会掩盖真实的断言。
 */
async function flushAsyncEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
}

async function openPanel(): Promise<void> {
  act(() => {
    useUiStore.getState().openIsland();
  });
  await screen.findByPlaceholderText('搜索资产…');
  await flushAsyncEffects();
}

/**
 * 建一张卡并让它出现在岛内列表里。
 *
 * 岛内列表读的是**最近使用**（recency），`createItem` 本身不记使用——
 * 必须真的走一次 `copyPassword` 才会进 `getRecentItems()`。这也是
 * `Island.test.tsx` 里"还没有最近使用记录"那条空状态的由来。
 */
async function seed(
  test: TestClient,
  input: { title: string; url?: string | null; appPath?: string | null },
): Promise<number> {
  const item = await test.client.createItem({
    title: input.title,
    username: 'user@example.com',
    password: 'pw-123456',
    url: input.url ?? null,
    appPath: input.appPath ?? null,
  });
  await test.client.copyPassword(item.id);
  await openPanel();
  await screen.findByText(input.title);
  return item.id;
}

/** 列表里标题为 title 的那一行（`<li role="option">`）。 */
function row(title: string): HTMLElement {
  const node = screen.getByText(title).closest('li');
  if (node === null) {
    throw new Error(`找不到标题为「${title}」的列表行`);
  }
  return node as HTMLElement;
}

beforeEach(() => {
  useUiStore.getState().closeIsland();
  useUiStore.getState().finishClosing();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Island 跳转入口', () => {
  it('只有网址：右键卡片直接打开，不弹菜单', async () => {
    const openSpy = stubWindowOpen();
    const test = createTestClient();
    await test.client.initialize({ masterPassword: MASTER_PASSWORD });
    renderIslandWith(test);
    await seed(test, { title: 'GitHub', url: 'https://github.com/login' });

    fireEvent.contextMenu(row('GitHub'));
    await flushAsyncEffects();

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(String(openSpy.mock.calls[0][0])).toBe('https://github.com/login');
    expect(screen.queryByTestId('item-jump-menu')).toBeNull();
  });

  it('Ctrl+Enter 只跳转，不把密码复制进剪贴板', async () => {
    const openSpy = stubWindowOpen();
    const test = createTestClient();
    await test.client.initialize({ masterPassword: MASTER_PASSWORD });
    renderIslandWith(test);
    await seed(test, { title: 'GitHub', url: 'https://github.com/login' });

    // seed 里已经复制过一次（为了把卡片写进最近使用）。记下写入次数，
    // 之后每一次多余写入都意味着"该跳转的时候顺手复制了密码"。
    const writesBefore = test.clipboard.writeCount;
    fireEvent.keyDown(screen.getByTestId('island-panel'), { key: 'Enter', ctrlKey: true });
    await flushAsyncEffects();

    expect(openSpy).toHaveBeenCalledTimes(1);
    // 用户按的是"打开网站"，密码不该再悄悄进一次剪贴板。
    expect(test.clipboard.writeCount).toBe(writesBefore);
  });

  it('网址 + 本地应用双目标：弹二选一菜单，本地项在 Web 阶段置灰', async () => {
    const openSpy = stubWindowOpen();
    const test = createTestClient();
    await test.client.initialize({ masterPassword: MASTER_PASSWORD });
    renderIslandWith(test);
    await seed(test, { title: 'Steam', url: 'https://store.steampowered.com', appPath: 'steam://' });

    fireEvent.contextMenu(row('Steam'));

    const menu = screen.getByTestId('item-jump-menu');
    expect(menu).toBeDefined();
    // 双目标时不能自作主张直接开网页。
    expect(openSpy).not.toHaveBeenCalled();

    const web = screen.getByRole('menuitem', { name: '在浏览器打开' });
    const app = screen.getByRole('menuitem', { name: '启动本地应用' }) as HTMLButtonElement;
    expect(web.hasAttribute('disabled')).toBe(false);
    expect(app.disabled).toBe(true);

    fireEvent.click(web);
    await flushAsyncEffects();
    expect(openSpy).toHaveBeenCalledTimes(1);
    // `new URL()` 会给无路径的域名补上尾斜杠，这里断言的是归一化后的结果。
    expect(String(openSpy.mock.calls[0][0])).toBe('https://store.steampowered.com/');
    expect(screen.queryByTestId('item-jump-menu')).toBeNull();
  });

  it('只有本地应用：给桌面版提示，不调 window.open', async () => {
    const openSpy = stubWindowOpen();
    const test = createTestClient();
    await test.client.initialize({ masterPassword: MASTER_PASSWORD });
    renderIslandWith(test);
    await seed(test, { title: 'Steam', appPath: 'steam://' });

    fireEvent.contextMenu(row('Steam'));
    await flushAsyncEffects();

    expect(screen.getByText('桌面版将启动本地应用（Web 阶段不执行本地路径）')).toBeDefined();
    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('item-jump-menu')).toBeNull();
  });

  it('两个目标都没配：提示未配置', async () => {
    const openSpy = stubWindowOpen();
    const test = createTestClient();
    await test.client.initialize({ masterPassword: MASTER_PASSWORD });
    renderIslandWith(test);
    await seed(test, { title: '无目标卡片' });

    fireEvent.contextMenu(row('无目标卡片'));
    await flushAsyncEffects();

    expect(screen.getByText('该卡片没有配置跳转目标')).toBeDefined();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('右键卡片只开跳转，不连带弹出岛级右键菜单', async () => {
    const openSpy = stubWindowOpen();
    const test = createTestClient();
    await test.client.initialize({ masterPassword: MASTER_PASSWORD });
    renderIslandWith(test);
    await seed(test, { title: 'GitHub', url: 'https://github.com/login' });

    fireEvent.contextMenu(row('GitHub'));
    await flushAsyncEffects();

    expect(screen.queryByTestId('island-context-menu')).toBeNull();
    // 右键这一下确实走的是跳转：链接开了，而不是被岛级菜单吞掉。
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('跳转菜单开着时指针离开岛面，不收起面板', async () => {
    const openSpy = stubWindowOpen();
    const test = createTestClient();
    await test.client.initialize({ masterPassword: MASTER_PASSWORD });
    renderIslandWith(test);
    await seed(test, { title: 'Steam', url: 'https://store.steampowered.com', appPath: 'steam://' });

    fireEvent.contextMenu(row('Steam'));
    expect(screen.getByTestId('item-jump-menu')).toBeDefined();
    // 双目标必须停在菜单上，不能自作主张直接开网页。
    expect(openSpy).not.toHaveBeenCalled();

    // 菜单 portal 到 body，指针此刻已经不在岛内——照常收起会把菜单连带撤掉。
    vi.useFakeTimers();
    fireEvent.pointerLeave(screen.getByTestId('island-panel'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HIDE_AFTER_LEAVE_MS);
    });

    expect(screen.getByTestId('item-jump-menu')).toBeDefined();
    expect(screen.getByTestId('island-panel')).toBeDefined();
  });
});
