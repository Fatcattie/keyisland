/**
 * 灵动岛 · 滚轮「滑动线」选型器（项③）+ 停留时长自动隐藏（项②）的集成测试。
 *
 * 复用 `renderWithProviders` 与 FakeClipboardPort，断言滚轮唤出选择器后能分账号 /
 * 密码复制，以及空闲到期自动隐藏。计时器用真实计时（`vi.useFakeTimers` 会同时劫持
 * `Date.now()` 与 `waitFor`，反而测不动），所以停留时长只设到 40ms 量级。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { createTestClient, renderWithProviders, MASTER_PASSWORD } from '../../__tests__/support/harness';
import { useUiStore } from '../../../stores/ui-store';
import { Island } from '../Island';

type Harness = ReturnType<typeof createTestClient>;

async function setupWithItems(): Promise<Harness & { githubId: number }> {
  const harness = createTestClient();
  await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
  const github = await harness.client.createItem({
    title: 'GitHub',
    username: 'octocat',
    password: 'gh-secret',
  });
  await harness.client.createItem({
    title: '邮箱',
    username: 'me@x.com',
    password: 'mail-secret',
  });
  return { ...harness, githubId: github.id };
}

/** 沿用 Island.test 的唤出路径：先推鼠标到顶边唤出胶囊，再点开。 */
async function expand(harness: Harness): Promise<HTMLElement> {
  renderWithProviders(
    harness.client,
    <Island status="unlocked" onLock={vi.fn()} onRequestUnlock={vi.fn()} onOpenSettings={() => {}} />,
  );
  fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '展开密岛' })).toBeDefined();
  });
  fireEvent.click(screen.getByRole('button', { name: '展开密岛' }));
  const panel = await screen.findByTestId('island-panel');
  // 展开后列表是异步拉取的：滚轮要判断 `visible.length`，必须先等列表就绪。
  await screen.findAllByRole('option');
  return panel;
}

afterEach(() => {
  cleanup();
  // 还原默认停留时长，避免污染其它用例（store 是单例）。
  useUiStore.setState({ dwellDelayMs: 10_000 });
});

beforeEach(() => {
  // store 是单例：上个用例收尾时可能把 `island.phase` 留在 expanded/closing，
  // 那样胶囊（"展开密岛"按钮）不再渲染，`expand()` 就找不到入口。每个用例从
  // 干净的折叠态起步。
  useUiStore.setState({
    island: { phase: 'collapsed', query: '', activeIndex: 0, focused: false },
    dwellDelayMs: 10_000,
  });
});

describe('灵动岛 · 滚轮滑动线选择器', () => {
  it('鼠标在岛上滚中键唤出滑动线，列出卡片并可分别复制账号 / 密码', async () => {
    const harness = await setupWithItems();
    const panel = await expand(harness);

    // jsdom 里列表的滚动容器高/可滚动高度都是 0，不会被判成"列表自己能滚"。
    fireEvent.wheel(panel, { deltaY: 100 });

    const picker = await screen.findByTestId('island-scroll-picker');
    expect(picker).toBeInTheDocument();

    // 复制账号（走 client → 剪贴板，是异步的，必须等）。
    // 注：`getIslandItems()` 是"最近优先"，本用例最后建的是「邮箱」，所以它排第 0、
    // 也就是滚轮向下打开时默认选中的那张——复制的应是它的账号/密码。
    fireEvent.click(screen.getByTestId('island-picker-copy-username'));
    await waitFor(() => {
      expect(harness.clipboard.value).toBe('me@x.com');
    });

    // 复制密码。
    fireEvent.click(screen.getByTestId('island-picker-copy-password'));
    await waitFor(() => {
      expect(harness.clipboard.value).toBe('mail-secret');
    });
  });

  it('中键（按下滚轮）退出滑动线、回到面板', async () => {
    const harness = await setupWithItems();
    const panel = await expand(harness);

    fireEvent.wheel(panel, { deltaY: 100 });
    await screen.findByTestId('island-scroll-picker');

    fireEvent.mouseDown(panel, { button: 1 });
    await waitFor(() => {
      expect(screen.queryByTestId('island-scroll-picker')).toBeNull();
    });
    // 岛面板还在，且没有连带收起。
    expect(screen.getByTestId('island-panel')).toBeInTheDocument();
  });

  it('左键不会误关滑动线（只有中键生效）', async () => {
    const harness = await setupWithItems();
    const panel = await expand(harness);

    fireEvent.wheel(panel, { deltaY: 100 });
    await screen.findByTestId('island-scroll-picker');

    fireEvent.mouseDown(panel, { button: 0 });
    expect(screen.getByTestId('island-scroll-picker')).toBeInTheDocument();
  });

  it('Esc 只关滑动线、不收起整个岛', async () => {
    const harness = await setupWithItems();
    const panel = await expand(harness);

    fireEvent.wheel(panel, { deltaY: 100 });
    await screen.findByTestId('island-scroll-picker');

    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('island-scroll-picker')).toBeNull();
    });
    // 岛面板还在。
    expect(screen.getByTestId('island-panel')).toBeInTheDocument();
  });

  it('滚轮向下从第一张开始、向上从最后一张开始（开选择器时的方向语义）', async () => {
    const harness = await setupWithItems();
    const panel = await expand(harness);

    // 向下滚：在「未开选择器」分支里 activeIndex 钉到 0（第一张 GitHub）。
    fireEvent.wheel(panel, { deltaY: 100 });
    await screen.findByTestId('island-scroll-picker');
    expect(screen.getByTestId('island-picker-option-0')).toHaveAttribute('aria-selected', 'true');

    // 关掉选择器，再用「向上滚」重新打开：未开分支里 activeIndex 钉到末张（邮箱）。
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('island-scroll-picker')).toBeNull();
    });
    fireEvent.wheel(panel, { deltaY: -100 });
    await screen.findByTestId('island-scroll-picker');
    expect(screen.getByTestId('island-picker-option-1')).toHaveAttribute('aria-selected', 'true');
  });
});

describe('灵动岛 · 停留时长自动隐藏（项②）', () => {
  it('展开后无操作超过停留时长自动隐藏，且只撤表面不抛错', async () => {
    const harness = await setupWithItems();
    // 把停留时长压到 40ms，避免真实等待太久。
    useUiStore.setState({ dwellDelayMs: 40 });

    await expand(harness);

    // 不动它：到时后表面（胶囊）被撤掉。
    await waitFor(
      () => {
        expect(screen.queryByTestId('island-panel')).toBeNull();
        expect(screen.queryByRole('button', { name: '展开密岛' })).toBeNull();
      },
      { timeout: 1500 },
    );
  });

  it('在岛内持续操作（按键）会续命，不会触发空闲隐藏', async () => {
    const harness = await setupWithItems();
    const panel = await expand(harness);

    // 展开稳定后再把停留时长压到 40ms：若在 `expand()` 之前就设 40ms，展开过程里
    // 的异步等待（拉列表）会让 40ms 倒计时把面板先收走，按键循环就打在已卸载的节点上。
    useUiStore.setState({ dwellDelayMs: 40 });

    // 反复在面板里按键续命：每次 keydown 都会重排停留计时，面板不该被收走。
    // 注意：必须是"在岛上"的操作才重置空闲计时（移到岛外不算，那正该隐藏）。
    for (let i = 0; i < 6; i += 1) {
      fireEvent.keyDown(panel, { key: 'Shift' });
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(screen.queryByTestId('island-panel')).toBeInTheDocument();
  });
});
