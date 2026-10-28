/**
 * 外壳桥（`ShellBridge`）的契约。
 *
 * 这座桥做四件容易被写错的事，每条都单独锁住：
 * 1. **形态落到 store 与 `<html data-app-mode>`**：后者是唯一形态 CSS 锚点；
 * 2. **会话镜像单向推给 Rust 且按值去重**：`cooling_down` 必须折叠成 `locked`；
 * 3. **岛面相位 → 窗口缩放**：`closing` 仍算展开（否则收起动画被窗口裁掉），
 *    全形态下一次都不上报；
 * 4. **退出顺序**：先 `dispose()`（清剪贴板）再 `shell_quit`。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { ShellBridge, CLOSE_HINT_MESSAGE } from '../ShellBridge';
import { useUiStore } from '../../../stores/ui-store';
import type { SessionStatus } from '../../../core/vault/types';
import type { ShellModeEvent, ShellPort } from '../../../services/window-shell';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** 可编排的假端口：记录每次调用，并能主动"发事件"。 */
function createFakePort() {
  const sessionCalls: SessionStatus[] = [];
  const expandedCalls: boolean[] = [];
  const calls: string[] = [];
  let modeEvent: ShellModeEvent | null = null;
  let modeHandler: ((event: ShellModeEvent) => void) | null = null;
  let lockHandler: (() => void) | null = null;
  let quitHandler: (() => void) | null = null;

  const port: ShellPort = {
    available: () => true,
    readMode: async () => modeEvent,
    showMain: async () => {
      calls.push('showMain');
    },
    enterIsland: async () => {
      calls.push('enterIsland');
    },
    setExpanded: async (expanded: boolean) => {
      expandedCalls.push(expanded);
    },
    setSession: async (status: SessionStatus) => {
      sessionCalls.push(status);
    },
    quit: async () => {
      calls.push('quit');
    },
    getAutostart: async () => false,
    setAutostart: async (enabled: boolean) => enabled,
    onMode: async (callback) => {
      modeHandler = callback;
      return () => {
        modeHandler = null;
      };
    },
    onLockRequested: async (callback) => {
      lockHandler = callback;
      return () => {
        lockHandler = null;
      };
    },
    onQuitRequested: async (callback) => {
      quitHandler = callback;
      return () => {
        quitHandler = null;
      };
    },
  };

  return {
    port,
    calls,
    sessionCalls,
    expandedCalls,
    setInitialMode(event: ShellModeEvent | null) {
      modeEvent = event;
    },
    emitMode(event: ShellModeEvent) {
      modeHandler?.(event);
    },
    emitLock() {
      lockHandler?.();
    },
    emitQuit() {
      quitHandler?.();
    },
  };
}

/** 每个用例前把 UI 状态复位（`appMode` 必须一起复位，否则会跨用例污染）。 */
beforeEach(() => {
  useUiStore.setState({
    appMode: 'full',
    island: { phase: 'collapsed', query: '', activeIndex: 0, focused: false },
    session: { status: 'uninitialized', cooldownUntil: null },
    filters: { category: 'all', sort: 'recent_updated' },
    autoLockPolicy: '30m',
  });
});

afterEach(() => {
  delete document.documentElement.dataset.appMode;
});

/** 让异步订阅（`onMode` 等）真正注册上。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

describe('ShellBridge · 形态', () => {
  it('挂载时读一次形态，并写到 store 与 <html data-app-mode>', async () => {
    const fake = createFakePort();
    fake.setInitialMode({ mode: 'island', expanded: false, showCloseHint: false });
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER_PASSWORD });

    renderWithProviders(client, <ShellBridge port={fake.port} />);

    await waitFor(() => {
      expect(useUiStore.getState().appMode).toBe('island');
    });
    expect(document.documentElement.dataset.appMode).toBe('island');
  });

  it('收到 shell://mode 事件后切换形态，回到 full 也能复原', async () => {
    const fake = createFakePort();
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER_PASSWORD });
    renderWithProviders(client, <ShellBridge port={fake.port} />);
    await settle();

    act(() => {
      fake.emitMode({ mode: 'island', expanded: false, showCloseHint: false });
    });
    await waitFor(() => {
      expect(useUiStore.getState().appMode).toBe('island');
    });
    expect(document.documentElement.dataset.appMode).toBe('island');

    act(() => {
      fake.emitMode({ mode: 'full', expanded: false, showCloseHint: false });
    });
    await waitFor(() => {
      expect(useUiStore.getState().appMode).toBe('full');
    });
    expect(document.documentElement.dataset.appMode).toBe('full');
  });

  it('进入岛形态时把展开的岛面收回 collapsed（否则面板会被塞进 44px 高的小窗）', async () => {
    const fake = createFakePort();
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER_PASSWORD });
    useUiStore.setState({
      island: { phase: 'expanded', query: 'github', activeIndex: 2, focused: true },
    });
    renderWithProviders(client, <ShellBridge port={fake.port} />);
    await settle();

    act(() => {
      fake.emitMode({ mode: 'island', expanded: false, showCloseHint: false });
    });

    await waitFor(() => {
      expect(useUiStore.getState().island.phase).toBe('collapsed');
    });
    // 搜索词与高亮一起清掉：锁定/收起之后不该留着上一次的查询。
    expect(useUiStore.getState().island.query).toBe('');
    expect(useUiStore.getState().island.activeIndex).toBe(0);
  });

  it('首次关闭提示由 Rust 的 showCloseHint 决定', async () => {
    const fake = createFakePort();
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER_PASSWORD });
    renderWithProviders(client, <ShellBridge port={fake.port} />);
    await settle();

    act(() => {
      fake.emitMode({ mode: 'island', expanded: false, showCloseHint: true });
    });

    expect(await screen.findByText(CLOSE_HINT_MESSAGE)).toBeInTheDocument();
  });
});

describe('ShellBridge · 会话镜像', () => {
  it('状态变化各推一次，同值不重复推，冷却期折叠成 locked', async () => {
    const fake = createFakePort();
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER_PASSWORD });
    renderWithProviders(client, <ShellBridge port={fake.port} />);
    await settle();

    // 挂载时先推一次初始状态（未建库）。
    expect(fake.sessionCalls).toEqual(['uninitialized']);

    act(() => {
      useUiStore.getState().setSessionStatus('unlocked');
    });
    await waitFor(() => {
      expect(fake.sessionCalls).toEqual(['uninitialized', 'unlocked']);
    });

    // 同值重复写入不重复上报。
    act(() => {
      useUiStore.getState().setSessionStatus('unlocked');
    });
    await settle();
    expect(fake.sessionCalls).toEqual(['uninitialized', 'unlocked']);

    act(() => {
      useUiStore.getState().setSessionStatus('locked');
    });
    await waitFor(() => {
      expect(fake.sessionCalls).toEqual(['uninitialized', 'unlocked', 'locked']);
    });

    // 冷却期与 locked 同属"没有可用资产"，不该再推一次。
    act(() => {
      useUiStore.getState().setSessionStatus('cooling_down', Date.now() + 60_000);
    });
    await settle();
    expect(fake.sessionCalls).toEqual(['uninitialized', 'unlocked', 'locked']);
  });
});

describe('ShellBridge · 岛面相位 → 窗口缩放', () => {
  it('岛形态下 closing 仍算展开，收起完成才缩窗', async () => {
    const fake = createFakePort();
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER_PASSWORD });
    useUiStore.setState({ appMode: 'island' });
    renderWithProviders(client, <ShellBridge port={fake.port} />);
    await settle();

    // 初始 collapsed → 上报"不展开"。
    expect(fake.expandedCalls).toEqual([false]);

    act(() => {
      useUiStore.getState().openIsland();
    });
    await waitFor(() => {
      expect(fake.expandedCalls).toEqual([false, true]);
    });

    act(() => {
      useUiStore.getState().closeIsland();
    });
    await settle();
    // `closing` 期间窗口必须保持展开尺寸，否则退出动画被裁掉一半。
    expect(fake.expandedCalls).toEqual([false, true]);

    act(() => {
      useUiStore.getState().finishClosing();
    });
    await waitFor(() => {
      expect(fake.expandedCalls).toEqual([false, true, false]);
    });
  });

  it('全形态下一次都不上报（主面板不缩窗）', async () => {
    const fake = createFakePort();
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER_PASSWORD });
    renderWithProviders(client, <ShellBridge port={fake.port} />);
    await settle();

    act(() => {
      useUiStore.getState().openIsland();
    });
    act(() => {
      useUiStore.getState().closeIsland();
    });
    await settle();

    expect(fake.expandedCalls).toEqual([]);
  });
});

describe('ShellBridge · 退出', () => {
  it('收到退出请求后先 dispose 再 shell_quit（剪贴板必须先清）', async () => {
    const fake = createFakePort();
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER_PASSWORD });

    const order: string[] = [];
    const originalDispose = client.dispose.bind(client);
    (client as unknown as { dispose: () => Promise<void> }).dispose = async () => {
      order.push('dispose');
      await originalDispose();
    };
    const originalQuit = fake.port.quit;
    fake.port.quit = async () => {
      order.push('quit');
      await originalQuit();
    };

    renderWithProviders(client, <ShellBridge port={fake.port} />);
    await settle();

    act(() => {
      fake.emitQuit();
    });

    await waitFor(() => {
      expect(order).toEqual(['dispose', 'quit']);
    });
  });
});
