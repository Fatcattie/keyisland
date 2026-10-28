/**
 * 设置面板 · 上次备份一行（PRD FR-06）。
 *
 * 契约：
 * 1. 从未备份显示「从未备份」，未超期时不加黄色提醒；
 * 2. 超期时显示「N 天前」并追加「已超过 7 天」的提醒——提醒必须能被看见，
 *    否则锁定前那条 toast 就没有可对照的地方；
 * 3. 读失败显示「—」而不是「从未备份」：把"不知道"说成"没有"会让用户白紧张。
 */

import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { SettingsPanel } from '../SettingsPanel';
import type { BackupStatus } from '../../../services/vault-client';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** 建库并渲染设置面板，可注入备份状态。 */
async function setup(status?: BackupStatus | Error): Promise<void> {
  const { client } = createTestClient('boot');
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  if (status instanceof Error) {
    vi.spyOn(client, 'getBackupStatus').mockRejectedValue(status);
  } else if (status !== undefined) {
    vi.spyOn(client, 'getBackupStatus').mockResolvedValue(status);
  }
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

describe('FR-06 · 设置页「上次备份」', () => {
  it('从未备份且未超期：只说"从未备份"，不加黄色提醒', async () => {
    await setup({ lastBackupAt: null, daysSinceBackup: 0, overdue: false });

    const row = screen.getByTestId('backup-status');
    expect(row).toHaveTextContent('上次备份');
    expect(row).toHaveTextContent('从未备份');
    expect(row).not.toHaveTextContent('已超过');
  });

  it('超期：显示天数并提示尽快导出', async () => {
    await setup({ lastBackupAt: 1_700_000_000_000, daysSinceBackup: 12, overdue: true });

    const row = screen.getByTestId('backup-status');
    expect(row).toHaveTextContent('12 天前');
    expect(row).toHaveTextContent('已超过 7 天');
  });

  it('读失败：显示占位符，不谎称"从未备份"', async () => {
    await setup(new Error('boom'));

    const row = screen.getByTestId('backup-status');
    expect(row).toHaveTextContent('—');
    expect(row).not.toHaveTextContent('从未备份');
  });
});
