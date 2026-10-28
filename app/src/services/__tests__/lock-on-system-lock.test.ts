/**
 * 系统锁屏 / 休眠立即锁定（PRD FR-01「默认开，可关」）。
 *
 * 契约：
 * 1. 默认开：初始化后的快照里 `lockOnSystemLock === true`；
 * 2. 关掉之后 `lockForSystemEvent()` 必须是**真空操作**——不擦密钥、不掉解锁态，
 *    而不是"锁了但提示语不一样"；
 * 3. 开着时锁定原因为 `system_lock`，且数据确实读不到（要重新解锁）；
 * 4. 开关写入元数据，重启后沿用；
 * 5. 早于该字段的老元数据缺 `lockOnSystemLock` 时按"开"解释（安全设置不能静默降级）。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { createVaultClient, type VaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';

const NOW = 1_700_000_000_000;
const MASTER = 'Alpha-Bravo-7788';

/** 建一个绑定给定存储的门面（同一份存储可反复建，用来模拟"重启"）。 */
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

describe('FR-01 · 系统锁屏 / 休眠立即锁定', () => {
  it('默认开启', async () => {
    const client = makeClient(new MemoryVaultStorage());
    await client.initialize({ masterPassword: MASTER });

    expect((await client.status()).lockOnSystemLock).toBe(true);
  });

  it('开启时：系统事件锁定，原因为 system_lock，数据需重新解锁', async () => {
    const client = makeClient(new MemoryVaultStorage());
    await client.initialize({ masterPassword: MASTER });

    const snapshot = await client.lockForSystemEvent();

    expect(snapshot.status).toBe('locked');
    expect(snapshot.lockReason).toBe('system_lock');
    await expect(client.listItems()).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
  });

  it('关闭时：真空操作——仍是解锁态，数据照读，锁定原因不被写脏', async () => {
    const client = makeClient(new MemoryVaultStorage());
    await client.initialize({ masterPassword: MASTER });
    await client.setLockOnSystemLock(false);

    const snapshot = await client.lockForSystemEvent();

    expect(snapshot.status).toBe('unlocked');
    expect(snapshot.lockReason).toBeNull();
    // 真正的证据：密钥还在，能读到数据（不是"看起来没锁"）。
    await expect(client.listItems()).resolves.toEqual([]);
  });

  it('已锁定时是空操作：不覆盖上一次的锁定原因', async () => {
    const client = makeClient(new MemoryVaultStorage());
    await client.initialize({ masterPassword: MASTER });
    await client.lock('manual');

    const snapshot = await client.lockForSystemEvent();

    expect(snapshot.status).toBe('locked');
    expect(snapshot.lockReason).toBe('manual');
  });

  it('开关写入元数据：重启后沿用关闭状态', async () => {
    const storage = new MemoryVaultStorage();
    const client = makeClient(storage);
    await client.initialize({ masterPassword: MASTER });
    await client.setLockOnSystemLock(false);

    expect((await storage.loadMeta())?.lockOnSystemLock).toBe(false);

    // 同一份存储、新的门面 = 重启。解锁后再触发系统事件，验证开关真的被沿用：
    // 只看快照字段是不够的，必须看行为。
    const reopened = makeClient(storage);
    await reopened.unlock(MASTER);
    expect((await reopened.lockForSystemEvent()).status).toBe('unlocked');
  });

  it('老元数据缺该字段时按"开"解释，不静默降级', async () => {
    const storage = new MemoryVaultStorage();
    const client = makeClient(storage);
    await client.initialize({ masterPassword: MASTER });

    // 模拟这条元数据早于本字段落盘：手动抹掉再存回去。
    const meta = await storage.loadMeta();
    expect(meta).not.toBeNull();
    delete meta?.lockOnSystemLock;
    await storage.saveMeta(meta!);

    const reopened = makeClient(storage);
    expect((await reopened.status()).lockOnSystemLock).toBe(true);
  });
});
