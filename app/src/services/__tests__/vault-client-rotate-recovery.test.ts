/**
 * 恢复密钥轮换（PRD FR-08.1「怀疑泄露时轮换」）。
 *
 * 契约：
 * 1. 轮换成功后旧恢复码**立即**失效、新恢复码可用，主密码与已解锁会话不受影响；
 * 2. 必须现验主密码：密码错 → `AUTH_INVALID`，且旧恢复码仍然有效（不能因为
 *    一次失败的轮换就把用户仅有的找回通道弄废）；
 * 3. 锁定态拒绝（`VAULT_LOCKED`）；
 * 4. 落盘失败要**回滚内存里的密钥槽**——否则内存是"新码可用、旧码已废"、磁盘还是
 *    旧槽，用户手上那张新码永远对不上，等于凭空丢一条找回通道。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { createVaultClient, type VaultClient } from '../vault-client';
import type { VaultStorage } from '../storage';
import { FaultyStorage, FakeClipboardPort } from './support/fakes';

const NOW = 1_700_000_000_000;
const MASTER = 'Alpha-Bravo-7788';
const OTHER = 'Charlie-Delta-9900';

/** 绑定给定存储的门面；同一份存储可反复建，用来模拟"重启"。 */
function makeClient(storage: VaultStorage): VaultClient {
  return createVaultClient({
    storage,
    now: () => NOW,
    clipboard: new FakeClipboardPort(),
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
    autoLockPolicy: '30m',
  });
}

describe('FR-08.1 · 恢复密钥轮换', () => {
  it('轮换成功：新码生效、旧码立即失效、主密码不受影响', async () => {
    const storage = new FaultyStorage();
    const client = makeClient(storage);
    const init = await client.initialize({ masterPassword: MASTER });

    const rotated = await client.rotateRecoveryKey(MASTER);

    expect(rotated.recoveryCode).not.toBe(init.recoveryCode);
    expect(rotated.kirkJson.length).toBeGreaterThan(0);
    // 轮换不打断会话：用户不用重新解锁。
    expect(rotated.session.status).toBe('unlocked');

    // 换一个门面读磁盘，验证"作废旧密钥"是真落盘了，而不只是内存里的假象。
    const reopened = makeClient(storage);
    await expect(reopened.recover(init.recoveryCode)).rejects.toMatchObject({
      code: 'RECOVERY_INVALID',
    });
    await expect(reopened.recover(rotated.recoveryCode)).resolves.toMatchObject({ verified: true });
    // 主密码仍然是日常入口。
    await expect(reopened.unlock(MASTER)).resolves.toMatchObject({ status: 'unlocked' });
  });

  it('主密码错误：拒绝轮换，旧恢复码仍然有效', async () => {
    const storage = new FaultyStorage();
    const client = makeClient(storage);
    const init = await client.initialize({ masterPassword: MASTER });

    await expect(client.rotateRecoveryKey(OTHER)).rejects.toMatchObject({ code: 'AUTH_INVALID' });

    // 关键：失败不能有任何副作用。
    await expect(client.recover(init.recoveryCode)).resolves.toMatchObject({ verified: true });
  });

  it('锁定态拒绝轮换', async () => {
    const storage = new FaultyStorage();
    const client = makeClient(storage);
    await client.initialize({ masterPassword: MASTER });
    await client.lock('manual');

    await expect(client.rotateRecoveryKey(MASTER)).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
  });

  it('落盘失败：报 STORAGE_FAILED，并回滚内存密钥槽（旧码仍可用）', async () => {
    const storage = new FaultyStorage();
    const client = makeClient(storage);
    const init = await client.initialize({ masterPassword: MASTER });

    storage.failures.add('saveKeyslots');
    await expect(client.rotateRecoveryKey(MASTER)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    storage.failures.delete('saveKeyslots');

    // 同一个门面（内存已回滚）与新建门面（磁盘）都应仍认旧码。
    await expect(client.recover(init.recoveryCode)).resolves.toMatchObject({ verified: true });
    const reopened = makeClient(storage);
    await expect(reopened.recover(init.recoveryCode)).resolves.toMatchObject({ verified: true });
  });
});
