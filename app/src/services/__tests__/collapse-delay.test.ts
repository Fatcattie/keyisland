/**
 * 收起延时的持久化与校验（PRD FR-02「鼠标离开 2 秒后自动收起」，
 * SDD §6.5「生产默认 2s，并允许用户在设置中配置」）。
 *
 * 契约：
 * 1. 新库默认 2000ms；
 * 2. 改完写进元数据，重启后沿用（否则设置页改过的档位每次重启都静默回到 2 秒）；
 * 3. 非档位值报 VALIDATION_FAILED 且不落盘；
 * 4. 未初始化时报 VAULT_NOT_INITIALIZED（不能假装存下了）。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { AppError } from '../../core/errors';
import { createVaultClient, type VaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';

const NOW = 1_700_000_000_000;
const MASTER = 'Alpha-Bravo-7788';

function makeClient(storage: MemoryVaultStorage): VaultClient {
  return createVaultClient({
    storage,
    now: () => NOW,
    clipboard: new FakeClipboardPort(),
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
    autoLockPolicy: '30m',
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('FR-02 · 收起延时', () => {
  it('新库默认 2 秒', async () => {
    const client = makeClient(new MemoryVaultStorage());
    await client.initialize({ masterPassword: MASTER });

    expect(await client.getCollapseDelay()).toBe(2000);
  });

  it('改完写进元数据：重建门面后沿用', async () => {
    const storage = new MemoryVaultStorage();
    const first = makeClient(storage);
    await first.initialize({ masterPassword: MASTER });
    await first.setCollapseDelay(500);

    const second = makeClient(storage);
    expect(await second.getCollapseDelay()).toBe(500);
  });

  it('非档位值报 VALIDATION_FAILED，且不落盘', async () => {
    const client = makeClient(new MemoryVaultStorage());
    await client.initialize({ masterPassword: MASTER });

    await expectCode(client.setCollapseDelay(1500), 'VALIDATION_FAILED');
    await expectCode(client.setCollapseDelay(0), 'VALIDATION_FAILED');
    await expectCode(client.setCollapseDelay(Number.NaN), 'VALIDATION_FAILED');

    expect(await client.getCollapseDelay()).toBe(2000);
  });

  it('未初始化时写延时报 VAULT_NOT_INITIALIZED', async () => {
    const client = makeClient(new MemoryVaultStorage());

    // 读：没有元数据，返回默认值即可（岛在解锁前就要能收起）。
    expect(await client.getCollapseDelay()).toBe(2000);
    await expectCode(client.setCollapseDelay(500), 'VAULT_NOT_INITIALIZED');
  });
});
