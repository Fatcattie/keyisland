/**
 * 初始化原子性回归测试（QA 验收 P2-1）。
 *
 * 缺陷：`initialize` 在 `saveKeyslots` 成功、`saveItems` 失败时只回滚内存，
 * 磁盘上残留一个用户从未拿到恢复码的密钥槽；用户重试会生成新 DEK 覆盖旧槽，
 * 第一次展示的恢复码直接失效。
 *
 * 期望：失败即"全无痕"——存储被清空、加载标记复位、会话回到 uninitialized，
 * 且同一个 client 可以立即重试成功。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { AppError } from '../../core/errors';
import { createVaultClient, type VaultClient } from '../vault-client';
import { FaultyStorage, FakeClipboardPort } from './support/fakes';

const NOW = 1_700_000_000_000;

/** 测试用主密码（与生产无关）。 */
const MASTER = 'Alpha-Bravo-7788';

/** 断言 Promise 抛出指定错误码。 */
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(AppError.isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code}，但调用成功返回`);
}

/** 建立被测 client。 */
function createClient(storage: FaultyStorage): VaultClient {
  return createVaultClient({
    storage,
    now: () => NOW,
    clipboard: new FakeClipboardPort(),
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
  });
}

describe('初始化原子性（P2-1）', () => {
  it('saveItems 失败后存储不留密钥槽，状态回到 uninitialized', async () => {
    const storage = new FaultyStorage();
    storage.failures.add('saveItems');
    const client = createClient(storage);

    await expectCode(client.initialize({ masterPassword: MASTER }), 'STORAGE_FAILED');

    // 关键断言：磁盘上不能残留任何已写入的密钥槽。
    expect(await storage.loadKeyslots()).toBeNull();
    expect(await storage.loadMeta()).toBeNull();
    expect(await storage.loadItems()).toHaveLength(0);

    const snapshot = await client.status();
    expect(snapshot.status).toBe('uninitialized');
    expect(snapshot.passwordFailures).toBe(0);
  });

  it('saveItems 失败后同一个 client 可以立即重试成功', async () => {
    const storage = new FaultyStorage();
    storage.failures.add('saveItems');
    const client = createClient(storage);

    await expectCode(client.initialize({ masterPassword: MASTER }), 'STORAGE_FAILED');

    // 故障恢复后重试：必须拿到完整可用的恢复材料。
    storage.failures.clear();
    const result = await client.initialize({ masterPassword: MASTER });
    expect(result.recoveryCode.length).toBeGreaterThan(0);
    expect(result.kirkFile.magic).toBe('KIRK1');
    expect((await client.status()).status).toBe('unlocked');

    // 重试后磁盘上的密钥槽可用新密码解锁。
    const keyslots = await storage.loadKeyslots();
    expect(keyslots).not.toBeNull();

    await client.lock('manual');
    const unlocked = await client.unlock(MASTER);
    expect(unlocked.status).toBe('unlocked');
  });

  it('saveKeyslots 本身失败时不产生任何残留', async () => {
    const storage = new FaultyStorage();
    storage.failures.add('saveKeyslots');
    const client = createClient(storage);

    await expectCode(client.initialize({ masterPassword: MASTER }), 'STORAGE_FAILED');
    expect(await storage.loadKeyslots()).toBeNull();
    expect((await client.status()).status).toBe('uninitialized');
  });
});
