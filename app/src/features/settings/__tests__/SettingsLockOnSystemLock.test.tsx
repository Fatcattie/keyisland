/**
 * 设置面板 · 「系统锁屏 / 休眠时立即锁定」开关（PRD FR-01，默认开、可关）。
 *
 * 契约：
 * 1. 默认开启，且文案如实说明 Web 端是近似（切到后台即上锁）；
 * 2. 关闭后回填新快照并提示，门面状态同步为关；
 * 3. 面板按快照如实显示——关闭后重开设置页看到的是"已关闭"，不是永远"已开启"。
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { SettingsPanel } from '../SettingsPanel';
import type { SessionSnapshot } from '../../../core/vault/types';
import type { VaultClient } from '../../../services/vault-client';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

const SWITCH_NAME = '系统锁屏 / 休眠时立即锁定';

interface SetupResult {
  client: VaultClient;
  lastSnapshot: () => SessionSnapshot | null;
}

/** 建库并渲染设置面板；等到异步的位置读取落定再返回。 */
async function setup(): Promise<SetupResult> {
  const { client } = createTestClient('boot');
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  const initial = await client.status();
  let last: SessionSnapshot | null = null;
  renderWithProviders(
    client,
    <SettingsPanel
      open
      snapshot={initial}
      onClose={() => {}}
      onSessionChange={(next) => {
        last = next;
      }}
      onDataChanged={() => {}}
      onLocateItem={vi.fn()}
    />,
  );
  // 打开时会异步拉一次数据文件位置：不等它落定，后续断言会撞上 act 警告。
  await screen.findByTestId('storage-location');
  return { client, lastSnapshot: () => last };
}

describe('设置面板 · 系统锁屏立即锁定', () => {
  it('默认开启，并说明 Web 端只是近似', async () => {
    await setup();

    const toggle = screen.getByRole('switch', { name: SWITCH_NAME });
    expect(toggle).toBeChecked();
    expect(screen.getByTestId('lock-on-system-lock-state')).toHaveTextContent('已开启');
    // 文案必须交代"切标签页也会锁"，否则用户会当成 bug。
    expect(screen.getByText(/页面切到后台/)).toBeInTheDocument();
  });

  it('关闭后回填快照、提示，并写入门面', async () => {
    const { client, lastSnapshot } = await setup();

    fireEvent.click(screen.getByRole('switch', { name: SWITCH_NAME }));

    expect(await screen.findByText('已关闭：系统锁屏时不再自动锁定')).toBeInTheDocument();
    await waitFor(() => {
      expect(lastSnapshot()).not.toBeNull();
    });
    expect(lastSnapshot()?.lockOnSystemLock).toBe(false);
    // 界面拿到的快照与门面真实状态一致。
    expect((await client.status()).lockOnSystemLock).toBe(false);
  });

  it('重新打开设置页时显示"已关闭"（不是永远已开启）', async () => {
    // 直接改门面再渲染 = 用户关掉开关后重新打开设置页。
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER_PASSWORD });
    await client.setLockOnSystemLock(false);

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

    expect(await screen.findByTestId('lock-on-system-lock-state')).toHaveTextContent('已关闭');
    expect(screen.getByRole('switch', { name: SWITCH_NAME })).not.toBeChecked();
  });
});
