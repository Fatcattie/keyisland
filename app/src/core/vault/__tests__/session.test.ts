import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../crypto';
import { createRecoveryMaterial } from '../recovery';
import {
  COOLDOWN_BASE_MS,
  COOLDOWN_MAX_MS,
  MAX_FAILED_ATTEMPTS,
  VaultSession,
  cooldownDurationForStrike,
  createVaultSession,
} from '../session';
import type { AutoLockPolicy } from '../types';

const MASTER_PASSWORD = 'Master-Pass-1';
const NEW_PASSWORD = 'Master-Pass-2';
const WRONG_PASSWORD = 'Wrong-Pass-9';
const INVALID_RECOVERY_CODE = 'A'.repeat(32);

interface SessionFixture {
  session: VaultSession;
  advance: (ms: number) => void;
  recoveryCode: string;
  recoveryKey: Uint8Array;
}

/** 构造一个已初始化并处于解锁态的会话。 */
async function setupSession(policy: AutoLockPolicy = '30m'): Promise<SessionFixture> {
  let current = 1_700_000_000_000;
  const now = () => current;
  const advance = (ms: number) => {
    current += ms;
  };
  const material = await createRecoveryMaterial(now());
  const session = createVaultSession({
    now,
    autoLockPolicy: policy,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
  });
  await session.initialize({
    masterPassword: MASTER_PASSWORD,
    recoveryKey: material.recoveryKey,
    recoveryCode: material.code,
  });
  return { session, advance, recoveryCode: material.code, recoveryKey: material.recoveryKey };
}

describe('会话状态机', () => {
  it('初始化后为解锁态并持有密钥', async () => {
    const { session } = await setupSession();
    const snapshot = session.snapshot();

    expect(snapshot.status).toBe('unlocked');
    expect(snapshot.autoLockPolicy).toBe('30m');
    expect(session.hasKeyMaterial()).toBe(true);
    expect(session.requireDek()).toHaveLength(32);
  });

  it('默认 30 分钟内保持解锁，到期自动锁定并清空密钥', async () => {
    const { session, advance } = await setupSession();

    advance(29 * 60 * 1000);
    expect(session.status()).toBe('unlocked');

    advance(60 * 1000);
    expect(session.status()).toBe('locked');
    expect(session.hasKeyMaterial()).toBe(false);
    expect(() => session.requireDek()).toThrowError(expect.objectContaining({ code: 'VAULT_LOCKED' }));
  });

  it('支持 immediate / 5m / 4h / boot 档位', async () => {
    const immediate = await setupSession('immediate');
    // immediate 档位下解锁到期时间等于当前时刻，下一次状态检查即锁定。
    expect(immediate.session.status()).toBe('locked');
    expect(immediate.session.hasKeyMaterial()).toBe(false);

    const fiveMinutes = await setupSession('5m');
    fiveMinutes.advance(5 * 60 * 1000);
    expect(fiveMinutes.session.status()).toBe('locked');

    const fourHours = await setupSession('4h');
    fourHours.advance(3 * 60 * 60 * 1000);
    expect(fourHours.session.status()).toBe('unlocked');
    fourHours.advance(60 * 60 * 1000);
    expect(fourHours.session.status()).toBe('locked');

    const boot = await setupSession('boot');
    boot.advance(30 * 24 * 60 * 60 * 1000);
    expect(boot.session.status()).toBe('unlocked');
    expect(boot.session.snapshot().unlockedUntil).toBeNull();
  });

  it('手动锁定清空密钥并记录原因', async () => {
    const { session } = await setupSession();
    const snapshot = session.lock('manual');

    expect(snapshot.status).toBe('locked');
    expect(snapshot.unlockedUntil).toBeNull();
    expect(session.hasKeyMaterial()).toBe(false);
    expect(session.getLastLockReason()).toBe('manual');
  });

  it('锁定后 touch 不会复活会话', async () => {
    const { session } = await setupSession();
    session.lock('system_lock');
    session.touch();
    expect(session.status()).toBe('locked');
  });

  it('未初始化时状态为 uninitialized 且拒绝解锁', async () => {
    const session = createVaultSession({ now: () => 0, passwordParams: ARGON2_TEST_PARAMS });
    expect(session.status()).toBe('uninitialized');
    await expect(session.unlock(MASTER_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_NOT_INITIALIZED',
    });
  });

  it('重复初始化被拒绝', async () => {
    const { session, recoveryCode } = await setupSession();
    await expect(
      session.initialize({
        masterPassword: MASTER_PASSWORD,
        recoveryKey: new Uint8Array(32),
        recoveryCode,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_ALREADY_INITIALIZED' });
  });

  it('弱主密码不能完成初始化', async () => {
    const session = createVaultSession({ now: () => 0, passwordParams: ARGON2_TEST_PARAMS });
    await expect(
      session.initialize({
        masterPassword: 'short',
        recoveryKey: new Uint8Array(32),
        recoveryCode: 'x',
      }),
    ).rejects.toMatchObject({ code: 'PASSWORD_WEAK' });
  });
});

describe('解锁与冷却', () => {
  it('正确密码解锁，错误密码返回 AUTH_INVALID', async () => {
    const { session } = await setupSession();
    session.lock('manual');

    await expect(session.unlock(WRONG_PASSWORD)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    await expect(session.unlock(MASTER_PASSWORD)).resolves.toMatchObject({ status: 'unlocked' });
  });

  it('连续 5 次失败进入 30 秒冷却', async () => {
    const { session } = await setupSession();
    session.lock('manual');

    for (let attempt = 1; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await expect(session.unlock(WRONG_PASSWORD)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
      expect(session.snapshot().status).toBe('locked');
    }
    await expect(session.unlock(WRONG_PASSWORD)).rejects.toMatchObject({ code: 'AUTH_INVALID' });

    const snapshot = session.snapshot();
    expect(snapshot.status).toBe('cooling_down');
    expect(snapshot.failedAttempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(snapshot.cooldownRemainingMs).toBe(COOLDOWN_BASE_MS);
  });

  it('冷却期内拒绝任何凭据尝试', async () => {
    const { session } = await setupSession();
    session.lock('manual');
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await expect(session.unlock(WRONG_PASSWORD)).rejects.toBeTruthy();
    }

    await expect(session.unlock(MASTER_PASSWORD)).rejects.toMatchObject({ code: 'AUTH_COOLDOWN' });
    await expect(session.recover(INVALID_RECOVERY_CODE)).rejects.toMatchObject({
      code: 'AUTH_COOLDOWN',
    });
  });

  it('冷却到期后可以用正确密码解锁', async () => {
    const { session, advance } = await setupSession();
    session.lock('manual');
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await expect(session.unlock(WRONG_PASSWORD)).rejects.toBeTruthy();
    }

    advance(COOLDOWN_BASE_MS);
    await expect(session.unlock(MASTER_PASSWORD)).resolves.toMatchObject({ status: 'unlocked' });
    expect(session.snapshot().failedAttempts).toBe(0);
  });

  it('冷却时长递增并封顶 5 分钟', async () => {
    const { session, advance } = await setupSession();
    session.lock('manual');

    const durations: number[] = [];
    for (let round = 0; round < 6; round += 1) {
      for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
        await expect(session.unlock(WRONG_PASSWORD)).rejects.toBeTruthy();
      }
      const snapshot = session.snapshot();
      expect(snapshot.status).toBe('cooling_down');
      durations.push(snapshot.cooldownRemainingMs);
      advance(snapshot.cooldownRemainingMs);
      expect(session.status()).toBe('locked');
    }

    expect(durations).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
    expect(durations[5]).toBe(COOLDOWN_MAX_MS);
  });

  it('冷却时长计算函数单调递增且封顶', () => {
    const values = [1, 2, 3, 4, 5, 6, 10].map((strike) => cooldownDurationForStrike(strike));
    expect(values).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  });

  it('主密码与恢复密钥失败次数分别计数，但共用冷却策略', async () => {
    const { session } = await setupSession();
    session.lock('manual');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(session.unlock(WRONG_PASSWORD)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(session.recover(INVALID_RECOVERY_CODE)).rejects.toMatchObject({
        code: 'RECOVERY_INVALID',
      });
    }

    const snapshot = session.snapshot();
    expect(snapshot.passwordFailures).toBe(3);
    expect(snapshot.recoveryFailures).toBe(2);
    expect(snapshot.status).toBe('cooling_down');
  });
});

describe('恢复流程', () => {
  it('恢复码校验通过但不进入解锁态', async () => {
    const { session, recoveryCode } = await setupSession();
    session.lock('manual');

    await expect(session.recover(recoveryCode)).resolves.toEqual({ verified: true });
    expect(session.status()).toBe('locked');
    expect(session.hasKeyMaterial()).toBe(false);
  });

  it('错误恢复码返回 RECOVERY_INVALID 且不计为成功', async () => {
    const { session } = await setupSession();
    session.lock('manual');

    await expect(session.recover(INVALID_RECOVERY_CODE)).rejects.toMatchObject({
      code: 'RECOVERY_INVALID',
    });
    expect(session.snapshot().recoveryFailures).toBe(1);
    expect(session.status()).toBe('locked');
  });

  it('重设主密码后旧密码失效、新密码可用、恢复码仍有效', async () => {
    const { session, recoveryCode } = await setupSession();

    const snapshot = await session.resetMasterPassword({
      recoveryCode,
      newPassword: NEW_PASSWORD,
    });
    expect(snapshot.status).toBe('locked');
    expect(session.hasKeyMaterial()).toBe(false);

    await expect(session.unlock(MASTER_PASSWORD)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    await expect(session.unlock(NEW_PASSWORD)).resolves.toMatchObject({ status: 'unlocked' });

    session.lock('manual');
    await expect(session.recover(recoveryCode)).resolves.toEqual({ verified: true });
  });

  it('重设主密码时弱密码被拒绝', async () => {
    const { session, recoveryCode } = await setupSession();
    await expect(
      session.resetMasterPassword({ recoveryCode, newPassword: 'weak' }),
    ).rejects.toMatchObject({ code: 'PASSWORD_WEAK' });
  });

  it('重设主密码时错误恢复码被拒绝', async () => {
    const { session } = await setupSession();
    await expect(
      session.resetMasterPassword({
        recoveryCode: INVALID_RECOVERY_CODE,
        newPassword: NEW_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_INVALID' });
  });

  it('轮换恢复密钥后旧码失效、主密码仍可用', async () => {
    const { session, recoveryCode } = await setupSession();
    const nextMaterial = await createRecoveryMaterial(1_700_000_500_000);

    await session.rotateRecoveryKey(nextMaterial.recoveryKey);
    session.lock('manual');

    await expect(session.recover(recoveryCode)).rejects.toMatchObject({ code: 'RECOVERY_INVALID' });
    await expect(session.recover(nextMaterial.code)).resolves.toEqual({ verified: true });
    await expect(session.unlock(MASTER_PASSWORD)).resolves.toMatchObject({ status: 'unlocked' });
  });

  it('dispose 清空密钥与密钥槽', async () => {
    const { session } = await setupSession();
    session.dispose();

    expect(session.hasKeyMaterial()).toBe(false);
    expect(session.getKeyslots()).toBeNull();
    expect(session.status()).toBe('uninitialized');
  });
});
