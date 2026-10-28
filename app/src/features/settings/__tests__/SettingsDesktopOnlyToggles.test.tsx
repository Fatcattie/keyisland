/**
 * 设置面板 · 桌面端专属开关（PRD FR-05「防截屏可开关」「检查更新显式开关，默认关」）。
 *
 * 契约：Web 阶段这两项都不具备，必须**置灰 + 说明原因**。
 * 特别地，不用"勾着的禁用复选框"表示"桌面版默认开"——那会被读成"现在是开的"，
 * 而事实是没有这个能力。宁可显示未勾选 + 一句原因，也不给假状态。
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

describe('FR-05 · 桌面端专属开关', () => {
  it('防截屏：置灰且说明 Web 阶段无法调用 WDA_EXCLUDEFROMCAPTURE', async () => {
    await setup();

    const row = screen.getByTestId('setting-anti-screenshot');
    expect(within(row).getByRole('checkbox')).toBeDisabled();
    expect(within(row).getByRole('checkbox')).not.toBeChecked();
    expect(row).toHaveTextContent('WDA_EXCLUDEFROMCAPTURE');
    expect(row).toHaveTextContent('桌面版默认开启');
  });

  it('检查更新：置灰，并说明当前版本没有任何网络请求', async () => {
    await setup();

    const row = screen.getByTestId('setting-check-update');
    expect(within(row).getByRole('checkbox')).toBeDisabled();
    expect(within(row).getByRole('checkbox')).not.toBeChecked();
    expect(row).toHaveTextContent('不含任何网络请求');
  });
});
