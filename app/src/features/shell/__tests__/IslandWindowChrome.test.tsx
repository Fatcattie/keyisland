/**
 * 岛形态窗口层（`IslandWindowChrome`）的契约。
 *
 * 三件事必须钉住：
 * 1. **收起态那条窄条可用**：点一下就能展开（岛形态没有"屏幕顶部热区"这套语义了）；
 * 2. **窗口级右键菜单三项、顺序固定**：打开主面板 / 锁定保险库 / 退出密岛；
 *    且**不与岛内菜单同时弹出**（面板自己已经 `preventDefault` 过的事件必须让路）；
 * 3. **失焦收起**：小窗没有"页面其他位置"可点，失焦是最接近"用户走开了"的信号。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { IslandWindowChrome } from '../IslandWindowChrome';
import { useUiStore } from '../../../stores/ui-store';
import type { SessionStatus } from '../../../core/vault/types';
import type { ShellPort } from '../../../services/window-shell';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** 只记录调用、不做任何真事的端口。 */
function createFakePort() {
  const calls: string[] = [];
  const port: ShellPort = {
    available: () => true,
    readMode: async () => null,
    showMain: async () => {
      calls.push('showMain');
    },
    enterIsland: async () => {
      calls.push('enterIsland');
    },
    setExpanded: async () => undefined,
    setSession: async () => undefined,
    quit: async () => {
      calls.push('quit');
    },
    getAutostart: async () => false,
    setAutostart: async (enabled: boolean) => enabled,
    onMode: async () => () => undefined,
    onLockRequested: async () => () => undefined,
    onQuitRequested: async () => () => undefined,
  };
  return { port, calls };
}

/** 建库 + 渲染窗口层。 */
async function render(status: SessionStatus = 'unlocked', phase: 'collapsed' | 'expanded' = 'collapsed') {
  const { client } = createTestClient('boot');
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  await client.createItem({ title: 'GitHub', username: 'dev@example.test', password: 'Value-1' });
  useUiStore.setState({
    appMode: 'island',
    island: { phase, query: '', activeIndex: 0, focused: false },
    session: { status, cooldownUntil: null },
  });
  const fake = createFakePort();
  const onLock = vi.fn();
  const onRequestUnlock = vi.fn();
  renderWithProviders(
    client,
    <IslandWindowChrome
      status={status}
      onLock={onLock}
      onRequestUnlock={onRequestUnlock}
      onOpenSettings={vi.fn()}
      port={fake.port}
    />,
  );
  return { ...fake, client, onLock, onRequestUnlock };
}

beforeEach(() => {
  useUiStore.setState({
    appMode: 'full',
    island: { phase: 'collapsed', query: '', activeIndex: 0, focused: false },
    session: { status: 'uninitialized', cooldownUntil: null },
  });
});

describe('IslandWindowChrome · 收起态', () => {
  it('收起态只有一条窄条，点击即展开成完整岛面', async () => {
    await render('unlocked', 'collapsed');

    const bar = screen.getByTestId('island-window-bar');
    expect(bar).toBeInTheDocument();
    // 收起态不渲染岛面板（`Island` 是卸载的，避免它那套"顶部热区"语义漏进来）。
    expect(screen.queryByTestId('island-panel')).toBeNull();

    fireEvent.click(bar);

    // 点一下 → 进入展开流程，最终渲染出完整的岛面板（搜索框可用）。
    const panel = await screen.findByTestId('island-panel');
    expect(panel).toBeInTheDocument();
    expect(await screen.findByTestId('island-input')).toBeInTheDocument();
  });

  it('锁定态点窄条不去岛上验密，而是把主面板叫回来', async () => {
    const { onRequestUnlock } = await render('locked', 'collapsed');

    fireEvent.click(screen.getByTestId('island-window-bar'));

    expect(onRequestUnlock).toHaveBeenCalledTimes(1);
    // 锁定态岛面不能出现任何资产信息。
    expect(screen.getByTestId('island-window-status')).toHaveTextContent('已锁定');
  });
});

describe('IslandWindowChrome · 窗口级右键菜单', () => {
  it('右键窗口出现三项，顺序与文案固定', async () => {
    await render();

    fireEvent.contextMenu(screen.getByTestId('island-window'));

    const menu = await screen.findByTestId('window-context-menu');
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((node) =>
      (node.textContent ?? '').trim(),
    );
    expect(items).toEqual(['打开主面板', '锁定保险库', '退出密岛']);
    expect(menu).toHaveAttribute('role', 'menu');
    expect(menu).toHaveAttribute('aria-label', '密岛窗口菜单');
  });

  it('「打开主面板」还原窗口并关闭菜单', async () => {
    const { calls } = await render();

    fireEvent.contextMenu(screen.getByTestId('island-window'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /打开主面板/ }));

    expect(calls).toContain('showMain');
    expect(screen.queryByTestId('window-context-menu')).toBeNull();
  });

  it('「锁定保险库」调用同一个前端锁定动作', async () => {
    const { onLock } = await render('unlocked', 'collapsed');

    fireEvent.contextMenu(screen.getByTestId('island-window'));
    const item = await screen.findByRole('menuitem', { name: /锁定保险库/ });
    expect(item).toBeEnabled();
    fireEvent.click(item);

    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('已锁定时「锁定保险库」置灰并说明原因（不摆假按钮）', async () => {
    const { onLock } = await render('locked', 'collapsed');

    fireEvent.contextMenu(screen.getByTestId('island-window'));
    const item = await screen.findByRole('menuitem', { name: /锁定保险库/ });

    expect(item).toBeDisabled();
    expect(item.title).toContain('已锁定');
    expect(onLock).not.toHaveBeenCalled();
  });

  it('「退出密岛」走 dispose + shell_quit', async () => {
    const { calls } = await render();

    fireEvent.contextMenu(screen.getByTestId('island-window'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /退出密岛/ }));

    await waitFor(() => {
      expect(calls).toContain('quit');
    });
  });

  it('岛内菜单已经开着时不再开窗口菜单（两扇门不能同时开）', async () => {
    await render();

    // 模拟 `Island` 面板已经开了自己的六项菜单（那棵树由 React 管，这里只造一个
    // 同 testid 的节点来验证"让路"这条判据）。
    const islandMenu = document.createElement('div');
    islandMenu.dataset.testid = 'island-context-menu';
    document.body.appendChild(islandMenu);

    try {
      fireEvent.contextMenu(screen.getByTestId('island-window'));
      expect(screen.queryByTestId('window-context-menu')).toBeNull();
    } finally {
      islandMenu.remove();
    }
  });
});

describe('IslandWindowChrome · 失焦收起', () => {
  it('窗口失去焦点时把展开的岛收回去', async () => {
    await render('unlocked', 'expanded');
    expect(useUiStore.getState().island.phase).not.toBe('collapsed');

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    await waitFor(() => {
      expect(useUiStore.getState().island.phase).toBe('closing');
    });
  });
});
