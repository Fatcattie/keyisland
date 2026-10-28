/**
 * 会话加固回归测试。
 *
 * 对应 QA 独立验收提出的：
 * - P1-1：解锁必须按密钥槽持久化的 KDF 参数派生；
 * - P2-3：进入冷却时必须强制锁定（`auth_cooldown`）；
 * - P2-5：初始化的恢复码与恢复密钥必须来自同一份材料。
 *
 * 这里刻意不复用 `session.test.ts` 的 fixture：本文件关注"参数来源"与
 * "状态迁移"的对抗性组合，独立构造更直观，也避免与既有用例互相牵连。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_PARAMS_V1, ARGON2_TEST_PARAMS } from '../../crypto/kdf';
import { AppError } from '../../errors';
import type { KeyslotsBundle } from '../keyslots';
import { createRecoveryMaterial } from '../recovery';
import { MAX_FAILED_ATTEMPTS, createVaultSession, type VaultSession } from '../session';
import type { LockReason } from '../types';

const NOW = 1_700_000_000_000;

/** 测试用主密码（与生产无关，仅用于派生）。 */
const MASTER = 'Alpha-Bravo-7788';
/** 一个必然不匹配的凭据。 */
const WRONG = 'Charlie-Delta-9900';
/** 32 个 Crockford Base32 字符，格式合法但内容错误。 */
const WRONG_CODE = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

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

/** 断言同步调用抛出指定错误码。 */
function expectSyncCode(operation: () => unknown, code: string): void {
  let thrown: unknown = null;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(AppError.isAppError(thrown)).toBe(true);
  expect((thrown as AppError).code).toBe(code);
}

/** 用给定参数建库，返回密钥槽。 */
async function createKeyslotsWith(passwordParams: typeof ARGON2_PARAMS_V1): Promise<KeyslotsBundle> {
  const material = await createRecoveryMaterial(NOW);
  const session = createVaultSession({
    now: () => NOW,
    passwordParams,
    recoveryParams: ARGON2_TEST_PARAMS,
    autoLockPolicy: 'boot',
  });
  const { keyslots } = await session.initialize({
    masterPassword: MASTER,
    recoveryKey: material.recoveryKey,
    recoveryCode: material.code,
  });
  return keyslots;
}

describe('会话加固 · 解锁按密钥槽参数派生（P1-1）', () => {
  it('16 MiB 建槽、会话配置 64 MiB 时仍能解锁', async () => {
    const keyslots = await createKeyslotsWith(ARGON2_TEST_PARAMS);
    // 前提：槽内记录的是建槽时的参数，而不是会话构造参数。
    expect(keyslots.password.kdfParams.memoryKiB).toBe(ARGON2_TEST_PARAMS.memoryKiB);

    const session = createVaultSession({
      now: () => NOW,
      keyslots,
      passwordParams: ARGON2_PARAMS_V1,
      recoveryParams: ARGON2_PARAMS_V1,
      autoLockPolicy: 'boot',
    });

    const snapshot = await session.unlock(MASTER);
    expect(snapshot.status).toBe('unlocked');
    expect(session.hasKeyMaterial()).toBe(true);
  });

  it('64 MiB 建槽、会话配置 16 MiB 时仍能解锁', async () => {
    const keyslots = await createKeyslotsWith(ARGON2_PARAMS_V1);
    expect(keyslots.password.kdfParams.memoryKiB).toBe(ARGON2_PARAMS_V1.memoryKiB);

    const session = createVaultSession({
      now: () => NOW,
      keyslots,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
      autoLockPolicy: 'boot',
    });

    const snapshot = await session.unlock(MASTER);
    expect(snapshot.status).toBe('unlocked');
  });

  it('A 槽 slot 字段被篡改时拒绝解锁，且不计入密码失败次数', async () => {
    const keyslots = await createKeyslotsWith(ARGON2_TEST_PARAMS);
    const tampered: KeyslotsBundle = {
      ...keyslots,
      password: { ...keyslots.password, slot: 'recovery' },
    };

    const session = createVaultSession({
      now: () => NOW,
      keyslots: tampered,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
      autoLockPolicy: 'boot',
    });

    await expectCode(session.unlock(MASTER), 'VALIDATION_FAILED');
    // 元数据损坏属于"配置错误"，不应让用户以为是密码错了。
    expect(session.snapshot().passwordFailures).toBe(0);
    expect(session.hasKeyMaterial()).toBe(false);
  });
});

describe('会话加固 · 冷却强制锁定（P2-3）', () => {
  /** 建立一个已解锁、可捕获锁定原因的会话。 */
  async function createUnlockedSession(): Promise<{ session: VaultSession; reasons: LockReason[] }> {
    const material = await createRecoveryMaterial(NOW);
    const reasons: LockReason[] = [];
    const session = createVaultSession({
      now: () => NOW,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
      autoLockPolicy: 'boot',
      onLock: (reason) => reasons.push(reason),
    });
    await session.initialize({
      masterPassword: MASTER,
      recoveryKey: material.recoveryKey,
      recoveryCode: material.code,
    });
    return { session, reasons };
  }

  it('已解锁会话连续失败进入冷却时立即清除 DEK', async () => {
    const { session, reasons } = await createUnlockedSession();
    expect(session.hasKeyMaterial()).toBe(true);

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await expectCode(session.unlock(WRONG), 'AUTH_INVALID');
    }

    expect(session.status()).toBe('cooling_down');
    expect(session.hasKeyMaterial()).toBe(false);
    expect(session.getLastLockReason()).toBe('auth_cooldown');
    expect(reasons).toContain('auth_cooldown');
    // 冷却期内数据不可读，requireDek 必须拒绝。
    expectSyncCode(() => session.requireDek(), 'VAULT_LOCKED');
    // 冷却期内连正确凭据也被拒绝。
    await expectCode(session.unlock(MASTER), 'AUTH_COOLDOWN');
  });

  it('主密码与恢复密钥失败共用冷却阈值，同样触发强制锁定', async () => {
    const { session } = await createUnlockedSession();
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS - 1; attempt += 1) {
      await expectCode(session.unlock(WRONG), 'AUTH_INVALID');
    }
    // 尚未达到阈值：会话仍然可用。
    expect(session.hasKeyMaterial()).toBe(true);
    expect(session.status()).toBe('unlocked');

    // 第 5 次失败来自恢复密钥路径，仍应触发同一冷却。
    await expectCode(session.recover(WRONG_CODE), 'RECOVERY_INVALID');
    expect(session.status()).toBe('cooling_down');
    expect(session.hasKeyMaterial()).toBe(false);
  });
});

describe('会话加固 · 恢复材料一致性（P2-5）', () => {
  it('恢复码与恢复密钥不匹配时拒绝初始化且不产生密钥槽', async () => {
    const first = await createRecoveryMaterial(NOW);
    const second = await createRecoveryMaterial(NOW);
    const session = createVaultSession({
      now: () => NOW,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });

    await expectCode(
      session.initialize({
        masterPassword: MASTER,
        recoveryKey: first.recoveryKey,
        recoveryCode: second.code,
      }),
      'VALIDATION_FAILED',
    );
    expect(session.getKeyslots()).toBeNull();
    expect(session.hasKeyMaterial()).toBe(false);
    expect(session.status()).toBe('uninitialized');
  });

  it('恢复码格式非法时同样拒绝初始化且不产生密钥槽', async () => {
    const material = await createRecoveryMaterial(NOW);
    const session = createVaultSession({
      now: () => NOW,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });

    await expectCode(
      session.initialize({
        masterPassword: MASTER,
        recoveryKey: material.recoveryKey,
        recoveryCode: 'not-a-valid-recovery-code',
      }),
      'VALIDATION_FAILED',
    );
    expect(session.getKeyslots()).toBeNull();
  });

  it('匹配的恢复材料可以正常初始化，且该恢复码能解开 B 槽', async () => {
    const material = await createRecoveryMaterial(NOW);
    const session = createVaultSession({
      now: () => NOW,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });

    const { keyslots } = await session.initialize({
      masterPassword: MASTER,
      recoveryKey: material.recoveryKey,
      recoveryCode: material.code,
    });
    expect(keyslots.password.slot).toBe('password');
    expect(keyslots.recovery.slot).toBe('recovery');

    // 交叉校验不能误伤正常流程：同一份材料必须能通过恢复校验。
    const verified = await session.recover(material.code);
    expect(verified.verified).toBe(true);
  });
});
