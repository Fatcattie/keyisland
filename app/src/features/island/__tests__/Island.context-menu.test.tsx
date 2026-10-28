/**
 * 灵动岛右键菜单回归（PRD FR-02：「右键菜单（类输入法）：打开主面板 / 新建卡片 /
 * 设置 / 立即锁定 / 开机自启开关 / 退出」）。
 *
 * 契约：
 * 1. 右键岛面板打开菜单，六项齐全；
 * 2. 菜单不能只有鼠标一条路——头部「菜单」按钮打开同一份菜单（键盘可达）；
 * 3. 动作执行后菜单关闭，且动作确实被调用（新建开表单、锁定回调、设置回调）；
 * 4. Esc 只关菜单，**不**收起整个岛（两件事必须分开）；
 * 5. Tauri 依赖项（开机自启、退出）禁用并带原因，不摆假按钮；
 * 6. 锁定态下需要解锁的三项禁用。
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Island } from '../Island';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** 渲染岛并展开面板。 */
async function expand(options: { unlocked?: boolean } = {}) {
  const unlocked = options.unlocked ?? true;
  const { client } = createTestClient('boot');
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  await client.createItem({
    title: '菜单卡片',
    username: 'menu@example.test',
    password: 'Value-Menu-1',
  });
  const onLock = vi.fn();
  const onOpenSettings = vi.fn();
  renderWithProviders(
    client,
    <Island
      status={unlocked ? 'unlocked' : 'locked'}
      onLock={onLock}
      onRequestUnlock={vi.fn()}
      onOpenSettings={onOpenSettings}
    />,
  );

  // 热区是 `pointer-events-none` 的装饰层，测试里用键盘唤出按钮展开（与
  // IslandHotzone.test 一致）。
  fireEvent.click(screen.getByRole('button', { name: '唤出灵动岛' }));
  const panel = await screen.findByTestId('island-panel');
  return { panel, onLock, onOpenSettings, client };
}

/** 打开菜单（右键路径）。 */
async function openMenuByContextMenu(panel: HTMLElement): Promise<HTMLElement> {
  fireEvent.contextMenu(panel);
  return screen.findByTestId('island-context-menu');
}

describe('灵动岛 · 右键菜单', () => {
  it('右键面板打开菜单，六项齐全且顺序符合 PRD', async () => {
    const { panel } = await expand();
    const menu = await openMenuByContextMenu(panel);

    const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((node) =>
      (node.textContent ?? '').trim(),
    );
    expect(items).toEqual(['打开主面板', '新建卡片', '设置', '立即锁定', '开机自启：已关', '退出']);
    // 读屏能拿到菜单语义与名字。
    expect(menu).toHaveAttribute('role', 'menu');
    expect(menu).toHaveAttribute('aria-label', '密岛菜单');
  });

  it('「菜单」按钮也能打开同一份菜单（键盘可达路径）', async () => {
    await expand();

    fireEvent.click(screen.getByTestId('island-menu-trigger'));

    const menu = await screen.findByTestId('island-context-menu');
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(6);
    // 打开即聚焦第一项，键盘用户可直接用方向键。
    expect(document.activeElement?.textContent).toContain('打开主面板');
  });

  it('「新建卡片」打开快捷新建表单并关闭菜单', async () => {
    const { panel } = await expand();
    await openMenuByContextMenu(panel);

    fireEvent.click(screen.getByRole('menuitem', { name: '新建卡片' }));

    expect(await screen.findByLabelText('标题')).toBeInTheDocument();
    expect(screen.queryByTestId('island-context-menu')).toBeNull();
  });

  it('「立即锁定」调用回调并关闭菜单', async () => {
    const { panel, onLock } = await expand();
    await openMenuByContextMenu(panel);

    fireEvent.click(screen.getByRole('menuitem', { name: '立即锁定' }));

    expect(onLock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('island-context-menu')).toBeNull();
  });

  it('「设置」调用回调并关闭菜单', async () => {
    const { panel, onOpenSettings } = await expand();
    await openMenuByContextMenu(panel);

    fireEvent.click(screen.getByRole('menuitem', { name: '设置' }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('island-context-menu')).toBeNull();
  });

  it('Esc 只关菜单，不收起岛', async () => {
    const { panel } = await expand();
    const menu = await openMenuByContextMenu(panel);

    fireEvent.keyDown(menu, { key: 'Escape' });

    expect(screen.queryByTestId('island-context-menu')).toBeNull();
    // 岛面板还在——Esc 在菜单里只该关菜单。
    expect(screen.getByTestId('island-panel')).toBeInTheDocument();
  });

  it('Web 预览下开机自启与退出禁用并说明原因，不摆假按钮', async () => {
    const { panel } = await expand();
    await openMenuByContextMenu(panel);

    // 单测跑在 jsdom 里，没有 Tauri 壳 → `shellPort().available()` 为 false。
    const autostart = screen.getByRole('menuitem', { name: /开机自启/ });
    const quit = screen.getByRole('menuitem', { name: /退出/ });

    expect(autostart).toBeDisabled();
    expect(autostart.title).toContain('仅桌面版可用');
    expect(quit).toBeDisabled();
    expect(quit.title).toContain('仅桌面版可用');
  });

  it('锁定态下需要解锁的三项禁用', async () => {
    const { panel } = await expand({ unlocked: false });
    await openMenuByContextMenu(panel);

    expect(screen.getByRole('menuitem', { name: '新建卡片' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: '设置' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: '立即锁定' })).toBeDisabled();
    // 打开主面板不需要解锁。
    expect(screen.getByRole('menuitem', { name: '打开主面板' })).toBeEnabled();
  });

  it('点击菜单外部关闭菜单', async () => {
    const { panel } = await expand();
    await openMenuByContextMenu(panel);

    fireEvent.mouseDown(document.body);

    expect(screen.queryByTestId('island-context-menu')).toBeNull();
  });
});
