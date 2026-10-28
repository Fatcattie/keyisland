/**
 * 恢复密钥找回后的**持久化**回归（PRD FR-08.3 验收要点）。
 *
 * 已有的 `vault-client.test.ts` 覆盖了"重设后数据完整、旧密码失效"，但那条用例
 * 全程只用一个 client 实例——会话对象在内存里换掉密钥槽就能让断言全绿，
 * **不证明新密钥槽真的写进了存储**。而 `persistAfterPasswordReset` 是整条找回
 * 流程里唯一碰盘的地方：它要是悄悄失败，用户重启应用后会发现新密码打不开、
 * 旧密码也失效了，整库锁死。
 *
 * 所以这里的关键手法是**模拟重启**：同一个 `MemoryVaultStorage` 实例上
 * 新建一个 `createVaultClient`，只继承磁盘状态、不继承任何内存状态。
 *
 * 覆盖 FR-08 验收要点中的三条：
 * - 「用恢复密钥可完整解库并重设主密码，旧主密码失效、数据零丢失」的**重启后**版本；
 * - 「重设后备份导出/恢复正常」；
 * - 「恢复密钥保持有效」（PRD 8.3 原文：重设主密码后恢复密钥保持有效）。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { createVaultClient, type VaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';
import type { AppError } from '../../core/errors';

const MASTER = 'Alpha-Bravo-7788';
const NEW_MASTER = 'Charlie-Delta-9900';
const NOW = Date.now();

/** 建库并造一张卡，返回 client、存储与恢复码（存储要留着给"重启"用）。 */
async function setup(): Promise<{
  storage: MemoryVaultStorage;
  client: VaultClient;
  recoveryCode: string;
  itemId: number;
}> {
  const storage = new MemoryVaultStorage();
  const client = createVaultClient({
    storage,
    now: () => NOW,
    clipboard: new FakeClipboardPort(),
    clipboardTtlMs: 30_000,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
  });
  const initialized = await client.initialize({ masterPassword: MASTER, hint: '老提示' });
  const item = await client.createItem({
    title: '重启后还要在',
    username: 'user@example.com',
    password: 'pw-123456',
  });
  return { storage, client, recoveryCode: initialized.recoveryCode, itemId: item.id };
}

/** 模拟应用重启：同一块存储、全新的 client（内存状态全部丢掉）。 */
function restart(storage: MemoryVaultStorage): VaultClient {
  return createVaultClient({
    storage,
    now: () => NOW,
    clipboard: new FakeClipboardPort(),
    clipboardTtlMs: 30_000,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (caught) {
    return (caught as AppError).code;
  }
  throw new Error('预期 reject，实际 resolve 了');
}

describe('恢复密钥找回 · 持久化与备份（FR-08 验收）', () => {
  it('重设主密码后重启应用：新密码能解锁，旧密码失效，数据零丢失', async () => {
    const { storage, client, recoveryCode, itemId } = await setup();

    await expect(client.recover(recoveryCode)).resolves.toEqual({ verified: true });
    await client.resetMasterPassword({ recoveryCode, newPassword: NEW_MASTER, hint: '新提示' });

    // 重启：只继承磁盘状态。
    const afterRestart = restart(storage);
    expect((await afterRestart.status()).status).toBe('locked');

    // 新密码必须能打开——这条不过就意味着找回流程把库锁死了。
    await expect(afterRestart.unlock(NEW_MASTER)).resolves.toMatchObject({ status: 'unlocked' });
    const list = await afterRestart.listItems();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(itemId);
    expect(list[0].title).toBe('重启后还要在');

    // 旧密码在重启后同样失效（不是只在原实例里失效）。
    await afterRestart.lock('manual');
    expect(await codeOf(afterRestart.unlock(MASTER))).toBe('AUTH_INVALID');
  });

  it('重设主密码后重启：提示已更新，且不影响解密', async () => {
    const { storage, client, recoveryCode } = await setup();

    await client.resetMasterPassword({ recoveryCode, newPassword: NEW_MASTER, hint: '新提示' });

    const afterRestart = restart(storage);
    await afterRestart.unlock(NEW_MASTER);
    // 提示只是帮助回忆的元数据，改它不应该动加密层。
    expect(await afterRestart.getPasswordHint()).toBe('新提示');
  });

  it('重设主密码后重启：恢复密钥仍然有效，可再次找回', async () => {
    const { storage, client, recoveryCode } = await setup();

    await client.resetMasterPassword({ recoveryCode, newPassword: NEW_MASTER });

    const afterRestart = restart(storage);
    // PRD 8.3：「同步重写 KEK-A 槽……恢复密钥保持有效」。
    await expect(afterRestart.recover(recoveryCode)).resolves.toEqual({ verified: true });
    const third = 'Echo-Foxtrot-3344';
    await expect(
      afterRestart.resetMasterPassword({ recoveryCode, newPassword: third }),
    ).resolves.toMatchObject({ status: 'locked' });

    await expect(restart(storage).unlock(third)).resolves.toMatchObject({ status: 'unlocked' });
  });

  it('重设主密码后：导出的备份可在新库覆盖导入并恢复正常（FR-08 验收）', async () => {
    const { client, recoveryCode, itemId } = await setup();

    await client.resetMasterPassword({ recoveryCode, newPassword: NEW_MASTER });
    // 重设后会话是锁着的（PRD 8.3「回到锁定态」），导出前要用新密码解开。
    await client.unlock(NEW_MASTER);
    // 用新密码导出一份备份。
    const backupJson = await client.exportBackup('backup-secret');
    expect(backupJson.length).toBeGreaterThan(0);

    // 另一台"机器"：先初始化出自己的库（覆盖导入要求提供**当前库**主密码），
    // 再用备份整体替换。替换后密钥槽来自备份，所以解锁要用源库的新主密码。
    const other = createVaultClient({
      storage: new MemoryVaultStorage(),
      now: () => NOW,
      clipboard: new FakeClipboardPort(),
      clipboardTtlMs: 30_000,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });
    const targetMaster = 'Target-Master-1234';
    await other.initialize({ masterPassword: targetMaster });

    const result = await other.importBackup({
      kirkJson: backupJson,
      password: 'backup-secret',
      mode: 'overwrite',
      masterPassword: targetMaster,
    });

    expect(result.totalItems).toBe(1);
    await expect(other.unlock(NEW_MASTER)).resolves.toMatchObject({ status: 'unlocked' });
    const list = await other.listItems();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(itemId);
  });

  it('重设前的旧备份仍可用新主密码覆盖导入（如实记录：会把旧密码槽带回来）', async () => {
    const { storage, client, recoveryCode } = await setup();

    // 先用旧密码导一份备份——它里面装的是旧密码槽。
    const oldBackup = await client.exportBackup('backup-secret');
    await client.resetMasterPassword({ recoveryCode, newPassword: NEW_MASTER });

    // 用户主动拿旧备份覆盖导入，且能提供当前（新）主密码。
    // 导入要求解锁态——重设主密码后会话是锁着的，先用新密码解开。
    await client.unlock(NEW_MASTER);
    const result = await client.importBackup({
      kirkJson: oldBackup,
      password: 'backup-secret',
      mode: 'overwrite',
      masterPassword: NEW_MASTER,
    });
    expect(result.totalItems).toBe(1);

    // 如实记录现状：覆盖导入**整体替换**密钥槽，于是重设前的旧主密码又变得能用了，
    // 而重设后的新主密码反而失效——导入等于把库回滚到导出那一刻。
    // 这不是越权：导入需要当前主密码授权，是用户主动选择的"回到某个时间点"。
    // 但它与验收要点的"旧主密码失效"在字面上冲突，且有一个真实风险：
    // 因怀疑泄露而重设密码的用户，若之后恢复旧备份，会在不知情的情况下
    // 把可能已泄露的旧密码装回来。当前实现没有任何提示，见「尚未覆盖」第 18 条。
    await client.lock('manual');
    const afterImport = restart(storage);
    await expect(afterImport.unlock(MASTER)).resolves.toMatchObject({ status: 'unlocked' });
    await afterImport.lock('manual');
    expect(await codeOf(afterImport.unlock(NEW_MASTER))).toBe('AUTH_INVALID');
  });
});
