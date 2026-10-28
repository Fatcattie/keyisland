/**
 * 会话门 · 岛形态（主面板收起、只留岛）。
 *
 * 这一层是"形态"与"安全"交界处，四个断言都不能少：
 * 1. 岛形态下主面板**仍挂载但不可见**（`hidden` + `aria-hidden`）——
 *    这是 CHG-02「恢复原状态」的唯一实现方式，条件渲染会把编辑态丢掉；
 * 2. 切回全形态后编辑中的内容还在（证明第 1 条真的成立，而不只是 class 对了）；
 * 3. **锁定后主面板必须消失**（安全不变式 S5：锁定后不残留资产）——
 *    解锁屏之外不该有任何卡片标题留在 DOM 里；
 * 4. 每次拿到新快照都把状态写进 `ui-store`（托盘据此置灰）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { SessionGate } from '../SessionGate';
import { useUiStore } from '../../../stores/ui-store';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** 建库 + 两张卡 + 渲染会话门，等到主面板出现。 */
async function setup(options: { mode?: 'full' | 'island' } = {}) {
  const { client } = createTestClient('boot');
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  await client.createItem({ title: 'GitHub', username: 'dev@example.test', password: 'Value-1' });
  await client.createItem({ title: '邮箱', username: 'me@example.test', password: 'Value-2' });

  useUiStore.setState({
    appMode: options.mode ?? 'full',
    island: { phase: 'collapsed', query: '', activeIndex: 0, focused: false },
    session: { status: 'uninitialized', cooldownUntil: null },
  });

  renderWithProviders(client, <SessionGate />);
  // 解锁态下主面板一定会挂载（岛形态下是"挂载但 hidden"）。
  await waitFor(() => {
    expect(document.getElementById('main-search')).not.toBeNull();
  });
  return { client };
}

/** 切形态（模拟 Rust 发来的 `shell://mode`，桥写 store 的那一步）。 */
async function switchMode(mode: 'full' | 'island'): Promise<void> {
  await act(async () => {
    useUiStore.setState({ appMode: mode });
  });
}

beforeEach(() => {
  useUiStore.setState({
    appMode: 'full',
    island: { phase: 'collapsed', query: '', activeIndex: 0, focused: false },
    session: { status: 'uninitialized', cooldownUntil: null },
  });
});

describe('SessionGate · 岛形态', () => {
  it('主面板仍挂载但不可见，岛上出现窗口层', async () => {
    await setup({ mode: 'island' });

    // 挂载：节点还在（编辑态/筛选/滚动位置都靠它保住）。
    const search = document.getElementById('main-search');
    expect(search).not.toBeNull();
    // 不可见：`hidden`（display:none）+ `aria-hidden`，读屏与 Tab 都不该进得去。
    expect(search?.closest('.hidden')).not.toBeNull();
    expect(search?.closest('[aria-hidden="true"]')).not.toBeNull();
    // `getByRole` 默认跳过 aria-hidden 子树，所以这里查不到才是对的。
    expect(screen.queryByRole('searchbox')).toBeNull();

    // 岛形态的窗口层在场（窄条 + 窗口级菜单的宿主）。
    expect(screen.getByTestId('island-window')).toBeInTheDocument();
    expect(screen.getByTestId('island-window-bar')).toBeInTheDocument();
  });

  it('切回全形态后编辑中的内容还在（恢复原状态）', async () => {
    await setup({ mode: 'full' });

    fireEvent.click(screen.getByRole('button', { name: /新建卡片/ }));
    const titleInput = (await waitFor(() => {
      const input = document.getElementById('editor-title');
      expect(input).not.toBeNull();
      return input as HTMLInputElement;
    })) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: '还没保存的标题' } });
    expect(titleInput.value).toBe('还没保存的标题');

    // 关主面板 → 岛形态 → 再打开主面板。
    await switchMode('island');
    expect(document.getElementById('main-search')?.closest('.hidden')).not.toBeNull();
    await switchMode('full');

    const restored = document.getElementById('editor-title') as HTMLInputElement | null;
    expect(restored).not.toBeNull();
    expect(restored?.value).toBe('还没保存的标题');
  });

  it('岛形态下锁定后主面板消失，DOM 里不残留任何资产标题', async () => {
    await setup({ mode: 'island' });

    // 从窗口级菜单锁定：这条路径与岛内「立即锁定」、托盘「锁定保险库」同源。
    fireEvent.contextMenu(screen.getByTestId('island-window'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /锁定保险库/ }));

    await waitFor(() => {
      expect(useUiStore.getState().session.status).toBe('locked');
    });
    // 主面板整棵卸载：锁定之后连"有哪些卡片"都不该留在 DOM 里。
    expect(document.getElementById('main-search')).toBeNull();
    expect(screen.queryByText('GitHub')).toBeNull();
    expect(screen.queryByText('邮箱')).toBeNull();
    // 岛上只剩锁定态，不出现任何资产信息。
    expect(screen.getByTestId('island-window-status')).toHaveTextContent('已锁定');
  });

  it('会话状态每次都写进 ui-store（托盘据此置灰）', async () => {
    await setup({ mode: 'island' });

    await waitFor(() => {
      expect(useUiStore.getState().session.status).toBe('unlocked');
    });

    fireEvent.contextMenu(screen.getByTestId('island-window'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /锁定保险库/ }));

    await waitFor(() => {
      expect(useUiStore.getState().session.status).toBe('locked');
    });
  });
});
