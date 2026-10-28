/**
 * 设置面板 · 操作日志区块（NFR 可靠性）。
 *
 * 契约：
 * 1. 空态给出说明，而不是一片空白；
 * 2. 有记录时显示「时间 · 动作 · 资产编号」，动作是中文标签；
 * 3. 清空要同时清门面与界面——只清一边会让人以为没生效；
 * 4. 区块里必须写明"不含密码 / 账号 / 标题"，这是它能被放心看的前提。
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { SettingsPanel } from '../SettingsPanel';
import type { AuditEntry } from '../../../core/vault/audit';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

const NOW = 1_700_000_000_000;

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

describe('NFR · 设置页操作日志', () => {
  it('没有记录时给出空态说明，并声明不含敏感内容', async () => {
    await setup();

    expect(await screen.findByTestId('audit-empty')).toBeInTheDocument();
    expect(screen.getByText(/不含密码、账号与标题/)).toBeInTheDocument();
  });

  it('有记录时显示中文动作与资产编号', async () => {
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER_PASSWORD });
    const entries: AuditEntry[] = [
      { id: 2, at: NOW, action: 'item.copy_password', itemId: 7, detail: null },
      { id: 1, at: NOW, action: 'jump', itemId: 7, detail: 'https://example.com/login' },
    ];
    vi.spyOn(client, 'getAuditLog').mockResolvedValue(entries);
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

    const list = await screen.findByTestId('audit-list');
    expect(list).toHaveTextContent('复制密码');
    expect(list).toHaveTextContent('#7');
    expect(list).toHaveTextContent('跳转');
    expect(list).toHaveTextContent('https://example.com/login');
  });

  it('清空后回到空态', async () => {
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER_PASSWORD });
    vi.spyOn(client, 'getAuditLog').mockResolvedValue([
      { id: 1, at: NOW, action: 'unlock', itemId: null, detail: null },
    ]);
    const clear = vi.spyOn(client, 'clearAuditLog').mockResolvedValue(undefined);
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
    await screen.findByTestId('audit-list');

    fireEvent.click(screen.getByRole('button', { name: '清空' }));

    expect(clear).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('audit-empty')).toBeInTheDocument();
    expect(await screen.findByText('操作日志已清空')).toBeInTheDocument();
  });
});
