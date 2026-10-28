/**
 * `verifyMasterPassword` 门面 API 测试（PRD FR-08.4 销毁数据前的二次认证）。
 *
 * 这条路径的存在理由：销毁全部数据是不可逆操作，而"能打开设置面板"这件事本身
 * 门槛太低——任何人走到一台已解锁的机器前都能做到。PRD 因此要求保护链里
 * 必须再输一次主密码。
 *
 * 语义约束（与 `session.verifyPassword` 对齐，多出两层门面判断）：
 * 1. 成功只证明"持有主密码"，**不**改变会话状态：不写 DEK、不续 `unlockedUntil`；
 * 2. 失败抛 `AUTH_INVALID`，且与解锁共用失败计数——不能靠它反复试探；
 * 3. 锁定态抛 `VAULT_LOCKED`（而不是让人以为"密码错了"）；
 * 4. 冷却期抛 `AUTH_COOLDOWN`：这条路径同样受防暴力破解限制。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { createVaultClient, type VaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';
import type { AppError } from '../../core/errors';

const MASTER = 'Alpha-Bravo-7788';
const NOW = Date.now();

async function buildUnlocked(): Promise<VaultClient> {
  const client = createVaultClient({
    storage: new MemoryVaultStorage(),
    now: () => NOW,
    clipboard: new FakeClipboardPort(),
    clipboardTtlMs: 30_000,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
  });
  await client.initialize({ masterPassword: MASTER });
  return client;
}

/** 取出被 reject 的 AppError（测试里大量用到错误码断言）。 */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (caught) {
    return (caught as AppError).code;
  }
  throw new Error('预期 reject，实际 resolve 了');
}

describe('verifyMasterPassword', () => {
  it('正确密码通过，且不改变会话状态', async () => {
    const client = await buildUnlocked();
    const before = await client.status();

    await client.verifyMasterPassword(MASTER);

    const after = await client.status();
    expect(after.status).toBe('unlocked');
    // 不续期：否则"验一下密码"会把自动锁定时钟一直往后推。
    expect(after.unlockedUntil).toBe(before.unlockedUntil);
  });

  it('错误密码抛 AUTH_INVALID', async () => {
    const client = await buildUnlocked();

    expect(await codeOf(client.verifyMasterPassword('not-the-password'))).toBe('AUTH_INVALID');
    // 验失败不影响会话：仍然是解锁态。
    expect((await client.status()).status).toBe('unlocked');
  });

  it('锁定态抛 VAULT_LOCKED', async () => {
    const client = await buildUnlocked();
    await client.lock('manual');

    expect(await codeOf(client.verifyMasterPassword(MASTER))).toBe('VAULT_LOCKED');
  });

  it('未初始化时抛 VAULT_NOT_INITIALIZED', async () => {
    const client = createVaultClient({
      storage: new MemoryVaultStorage(),
      now: () => NOW,
      clipboard: new FakeClipboardPort(),
      clipboardTtlMs: 30_000,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });

    expect(await codeOf(client.verifyMasterPassword(MASTER))).toBe('VAULT_NOT_INITIALIZED');
  });

  it('与解锁共用失败计数：连续错到阈值会进冷却，不能拿它当试密码的通道', async () => {
    const client = await buildUnlocked();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await codeOf(client.verifyMasterPassword(`wrong-${attempt}`))).toBe('AUTH_INVALID');
    }
    // 第 5 次失败即触发冷却（MAX_FAILED_ATTEMPTS = 5）。
    expect(await codeOf(client.verifyMasterPassword(MASTER))).toBe('AUTH_COOLDOWN');
  });

  it('连续失败不会累积成"永远解不开"：正确密码在冷却结束后仍可通过', async () => {
    const client = createVaultClient({
      storage: new MemoryVaultStorage(),
      now: () => NOW,
      clipboard: new FakeClipboardPort(),
      clipboardTtlMs: 30_000,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });
    await client.initialize({ masterPassword: MASTER });
    await client.lock('manual');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await codeOf(client.unlock(`wrong-${attempt}`))).toBe('AUTH_INVALID');
    }
    // 冷却期内的正确密码也只报冷却——这是防暴力破解该有的样子。
    expect(await codeOf(client.unlock(MASTER))).toBe('AUTH_COOLDOWN');
  });
});
