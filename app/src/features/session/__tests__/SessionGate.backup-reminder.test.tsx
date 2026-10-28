/**
 * 会话门 · 锁定前的备份轻提示（PRD FR-06）。
 *
 * 契约：
 * 1. 锁定后如果门面给出提醒文案，就弹一条 toast（"轻提示"，不打断锁定）；
 * 2. 门面返回 null（未超期 / 当日已提醒过）时什么都不弹；
 * 3. **提醒失败不能影响锁定**：这是本轮最要紧的一条——为了提醒用户备份而把
 *    会话留在解锁态，是把附属功能做成了安全事故。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { SessionGate } from '../SessionGate';
import type { VaultClient } from '../../../services/vault-client';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** 覆写 jsdom 的可见性。 */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
}

/** 模拟"页面转入后台"（FR-01 的系统锁屏近似）。 */
function hidePage(): void {
  setVisibility('hidden');
  fireEvent(document, new Event('visibilitychange'));
}

/** 建库、渲染会话门并等到主面板出现。 */
async function setup(): Promise<VaultClient> {
  const { client } = createTestClient('boot');
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  renderWithProviders(client, <SessionGate />);
  await waitFor(() => {
    expect(document.getElementById('main-search')).not.toBeNull();
  });
  return client;
}

afterEach(() => {
  setVisibility('visible');
});

describe('FR-06 · 锁定前的备份轻提示', () => {
  it('超期时锁定会弹一次提醒', async () => {
    const client = await setup();
    vi.spyOn(client, 'takeBackupReminder').mockResolvedValue(
      '已经 9 天没有备份了，建议现在导出一份 .kib。',
    );

    hidePage();

    expect(await screen.findByText(/9 天没有备份/)).toBeInTheDocument();
    // 提醒归提醒，该锁还是锁了。
    expect(document.getElementById('unlock-password')).not.toBeNull();
  });

  it('未超期（门面返回 null）时不弹任何提醒', async () => {
    const client = await setup();
    vi.spyOn(client, 'takeBackupReminder').mockResolvedValue(null);

    hidePage();
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });

    expect(screen.queryByText(/没有备份/)).toBeNull();
    expect(document.getElementById('unlock-password')).not.toBeNull();
  });

  it('提醒本身失败也不能挡住锁定', async () => {
    const client = await setup();
    vi.spyOn(client, 'takeBackupReminder').mockRejectedValue(new Error('boom'));

    hidePage();

    expect(await screen.findByTestId('lock-reason')).toHaveTextContent('系统锁屏');
    expect(document.getElementById('unlock-password')).not.toBeNull();
  });
});
