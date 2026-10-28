/**
 * 设置面板 · 快捷键（NFR 可用性「所有快捷键可在设置中查看与自定义」）。
 *
 * 契约：
 * 1. 列出应用内真实存在的快捷键（搜索 / 复制密码 / 复制账号 / 跳转 / ↑↓ / Esc…）；
 * 2. 可配置项以**下拉框**呈现（可改），固定项以 `<kbd>` 呈现并标注「固定」——
 *    读屏能听出"这是按键"；
 * 3. 如实说明全局热键（唤出 / 锁定）与系统级自定义绑定需要桌面版。
 */

import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { SettingsPanel } from '../SettingsPanel';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** 建库并渲染设置面板。 */
async function setup(): Promise<void> {
  const { client } = createTestClient('boot');
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  renderWithProviders(
    client,
    <SettingsPanel
      open
      snapshot={await client.status()}
      onClose={() => {}}
      onSessionChange={() => {}}
      onDataChanged={() => {}}
      onLocateItem={vi.fn()}
    />,
  );
  await screen.findByTestId('storage-location');
}

describe('NFR · 设置页快捷键', () => {
  it('列出真实快捷键：可配置项带下拉框、固定项用 kbd 并标注「固定」', async () => {
    await setup();

    const list = await screen.findByTestId('shortcut-list');
    // 可配置动作显示名称（下拉框的 label）。
    expect(list).toHaveTextContent('聚焦搜索框');
    expect(list).toHaveTextContent('复制密码');
    expect(list).toHaveTextContent('复制账号');
    expect(list).toHaveTextContent('打开跳转目标');
    // 固定动作显示名称，并标注「固定」。
    expect(list).toHaveTextContent('上一个结果');
    expect(list).toHaveTextContent('固定');
    // 固定项用 kbd 语义化渲染（读屏可识别），共三项（↑ / ↓ / Esc）。
    expect(within(list).getAllByText('ArrowUp', { selector: 'kbd' })).toHaveLength(1);
    expect(within(list).getAllByText('ArrowDown', { selector: 'kbd' })).toHaveLength(1);
    expect(within(list).getAllByText('Escape', { selector: 'kbd' })).toHaveLength(1);
  });

  it('说明全局热键与系统级自定义绑定需要桌面版', async () => {
    await setup();

    await screen.findByTestId('shortcut-list');
    expect(
      screen.getByText(/全局热键.*系统级自定义绑定需要桌面版/),
    ).toBeInTheDocument();
  });
});
