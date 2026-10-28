/**
 * 对抗性测试 · 会话状态机与冷却边界（SDD §5.2 / FR-05）。
 *
 * 重点验证：
 * - 改主密码后旧密码必须失效、恢复码必须仍有效；
 * - 轮换恢复码后旧码必须失效、主密码必须仍有效；
 * - 冷却期不得被任何入口（unlock / recover / resetMasterPassword）绕过；
 * - 锁定时 DEK 必须真的被清零，而不是只把引用置空；
 * - 恢复码校验成功不得把会话置为 unlocked。
 *
 * 所有 Argon2 派生复用项目已有的 `ARGON2_TEST_PARAMS`，避免整套跑几十分钟。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../src/core/crypto';
import { AppError } from '../../src/core/errors';
import { createRecoveryMaterial, type KirkFile } from '../../src/core/vault/recovery';
import {
  COOLDOWN_BASE_MS,
  COOLDOWN_MAX_MS,
  MAX_FAILED_ATTEMPTS,
  VaultSession,
  cooldownDurationForStrike,
} from '../../src/core/vault/session';
import type { AutoLockPolicy, LockReason } from '../../src/core/vault/types';
import { createDek, createKeyslots } from '../../src/core/vault/keyslots';

const MASTER_PASSWORD = 'Fixture-Master-1';
const NEXT_PASSWORD = 'Fixture-Master-2';
const NOW = 1_700_000_000_000;

interface RecoveryMaterial {
  code: string;
  recoveryKey: Uint8Array;
  kirk: KirkFile;
  kirkJson: string;
}

interface Harness {
  session: VaultSession;
  material: RecoveryMaterial;
  clock: { t: number };
}

/** 构造已初始化并处于解锁态的会话。 */
async function createHarness(
  options: {
    autoLockPolicy?: AutoLockPolicy;
    onLock?: (reason: LockReason) => void;
  } = {},
): Promise<Harness> {
  const clock = { t: NOW };
  const session = new VaultSession({
    now: () => clock.t,
    autoLockPolicy: options.autoLockPolicy ?? '30m',
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
    onLock: options.onLock,
  });
  const material = await createRecoveryMaterial(clock.t);
  await session.initialize({
    masterPassword: MASTER_PASSWORD,
    recoveryKey: material.recoveryKey,
    recoveryCode: material.code,
  });
  return { session, material, clock };
}

/** 断言 Promise 以指定错误码失败。 */
async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('对抗性 · 改密与恢复码轮换', () => {
  it('改主密码后：旧主密码失效、新主密码可用、恢复码仍能通过校验', async () => {
    const { session, material } = await createHarness();

    const afterReset = await session.resetMasterPassword({
      recoveryCode: material.code,
      newPassword: NEXT_PASSWORD,
    });
    expect(afterReset.status).toBe('locked');
    expect(session.hasKeyMaterial()).toBe(false);

    await expectErrorCode(session.unlock(MASTER_PASSWORD), 'AUTH_INVALID');

    const unlocked = await session.unlock(NEXT_PASSWORD);
    expect(unlocked.status).toBe('unlocked');

    // B 槽未被改写，恢复码必须仍然有效
    await expect(session.recover(material.code)).resolves.toEqual({ verified: true });
  });

  it('轮换恢复码后：旧恢复码失效、新恢复码可用、主密码仍可用', async () => {
    const { session, material } = await createHarness();
    const nextMaterial = await createRecoveryMaterial(NOW + 1);

    await session.rotateRecoveryKey(nextMaterial.recoveryKey);

    // 旧恢复码（原 B 槽）必须失效
    await expectErrorCode(session.recover(material.code), 'RECOVERY_INVALID');
    // 新恢复码可用
    await expect(session.recover(nextMaterial.code)).resolves.toEqual({ verified: true });
    // A 槽未被改写，主密码仍可用
    await expect(session.unlock(MASTER_PASSWORD)).resolves.toMatchObject({ status: 'unlocked' });
  });

  it('恢复码校验成功不会进入解锁态，也不留下密钥材料', async () => {
    const { session, material } = await createHarness();
    session.lock('manual');

    await expect(session.recover(material.code)).resolves.toEqual({ verified: true });
    expect(session.status()).toBe('locked');
    expect(session.hasKeyMaterial()).toBe(false);
  });

  it('错误恢复码返回 RECOVERY_INVALID，且不会解锁', async () => {
    const { session } = await createHarness();
    session.lock('manual');
    const wrong = (await createRecoveryMaterial(NOW + 3)).code;

    await expectErrorCode(session.recover(wrong), 'RECOVERY_INVALID');
    expect(session.status()).toBe('locked');
  });
});

describe('对抗性 · 冷却不可绕过', () => {
  it('连续 5 次失败进入冷却后，unlock / recover / resetMasterPassword 三个入口全部受限', async () => {
    const { session, material, clock } = await createHarness();
    session.lock('manual');

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await expectErrorCode(session.unlock('Fixture-Wrong-Pass'), 'AUTH_INVALID');
    }
    expect(session.status()).toBe('cooling_down');

    await expectErrorCode(session.unlock(MASTER_PASSWORD), 'AUTH_COOLDOWN');
    await expectErrorCode(session.recover(material.code), 'AUTH_COOLDOWN');
    await expectErrorCode(
      session.resetMasterPassword({ recoveryCode: material.code, newPassword: NEXT_PASSWORD }),
      'AUTH_COOLDOWN',
    );

    // 冷却结束后恢复可尝试
    clock.t += COOLDOWN_BASE_MS + 1;
    expect(session.status()).toBe('locked');
    await expect(session.recover(material.code)).resolves.toEqual({ verified: true });
  });

  it('第二轮冷却时长翻倍（30s → 60s），验证 strike 递增真实生效', async () => {
    const { session, clock } = await createHarness();
    session.lock('manual');

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await expectErrorCode(session.unlock('Fixture-Wrong-Pass'), 'AUTH_INVALID');
    }
    expect(session.snapshot().cooldownRemainingMs).toBe(COOLDOWN_BASE_MS);

    clock.t += COOLDOWN_BASE_MS + 1;
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await expectErrorCode(session.unlock('Fixture-Wrong-Pass'), 'AUTH_INVALID');
    }
    expect(session.snapshot().cooldownRemainingMs).toBe(COOLDOWN_BASE_MS * 2);
  });

  it('冷却时长从 30s 起递增并封顶 300s', () => {
    expect(cooldownDurationForStrike(0)).toBe(0);
    expect(cooldownDurationForStrike(1)).toBe(30_000);
    expect(cooldownDurationForStrike(2)).toBe(60_000);
    expect(cooldownDurationForStrike(3)).toBe(120_000);
    expect(cooldownDurationForStrike(4)).toBe(240_000);
    expect(cooldownDurationForStrike(5)).toBe(COOLDOWN_MAX_MS);
    expect(cooldownDurationForStrike(6)).toBe(COOLDOWN_MAX_MS);
    expect(cooldownDurationForStrike(50)).toBe(COOLDOWN_MAX_MS);
  });
});

describe('对抗性 · 锁定必须真的丢弃密钥', () => {
  it('锁定后 DEK 缓冲区被就地清零，requireDek 抛 VAULT_LOCKED', async () => {
    const { session } = await createHarness();
    const dekReference = session.requireDek();
    expect(dekReference.some((byte) => byte !== 0)).toBe(true);

    const snapshot = session.lock('manual');

    expect(snapshot.status).toBe('locked');
    expect(session.hasKeyMaterial()).toBe(false);
    expect(session.getLastLockReason()).toBe('manual');
    // 关键：不是"丢掉引用"，而是把原缓冲区清零
    expect([...dekReference].every((byte) => byte === 0)).toBe(true);

    let caught: unknown;
    try {
      session.requireDek();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('VAULT_LOCKED');
  });

  it('解锁失败不会让已锁定会话变成 unlocked', async () => {
    const { session } = await createHarness();
    session.lock('manual');

    await expectErrorCode(session.unlock('Fixture-Wrong-Pass'), 'AUTH_INVALID');
    expect(session.status()).toBe('locked');
    expect(session.hasKeyMaterial()).toBe(false);
  });

  it('超时自动锁定会触发 onLock 回调并清空密钥', async () => {
    const reasons: LockReason[] = [];
    const { session, clock } = await createHarness({
      autoLockPolicy: '5m',
      onLock: (reason) => reasons.push(reason),
    });
    const dekReference = session.requireDek();

    clock.t += 5 * 60 * 1000;
    expect(session.status()).toBe('locked');
    expect(reasons).toEqual(['timeout']);
    expect([...dekReference].every((byte) => byte === 0)).toBe(true);
  });

  it('已解锁状态下用错误密码再次 unlock：当前实现保持 unlocked（P2 观察项）', async () => {
    const { session } = await createHarness();
    await expectErrorCode(session.unlock('Fixture-Wrong-Pass'), 'AUTH_INVALID');

    // 记录当前行为：失败不清空既有会话，也不强制回锁
    expect(session.hasKeyMaterial()).toBe(true);
    expect(session.status()).toBe('unlocked');
  });

  it('已解锁会话连续失败进入冷却后必须强制锁定（P2-3 回归）', async () => {
    const { session } = await createHarness();
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await expectErrorCode(session.unlock('Fixture-Wrong-Pass'), 'AUTH_INVALID');
    }

    // P2-3 修复前：status() 先判冷却再判 DEK，对外显示冷却中却仍持有 DEK，
    // 用户可以在冷却窗口内继续读写明文，冷却只剩形式意义。
    expect(session.status()).toBe('cooling_down');
    expect(session.hasKeyMaterial()).toBe(false);
    let dekErrorCode: string | null = null;
    try {
      session.requireDek();
    } catch (error) {
      dekErrorCode = error instanceof AppError ? error.code : null;
    }
    expect(dekErrorCode).toBe('VAULT_LOCKED');
    expect(session.getLastLockReason()).toBe('auth_cooldown');
  });
});

describe('对抗性 · 参数版本化（跨版本解锁）', () => {
  /**
   * 期望行为（SDD §4.2）：KDF 参数随密钥槽持久化，解锁必须以记录中的参数为准，
   * 否则"未来调参 = 旧库全部打不开"。
   *
   * 当前实现 `session.unlock()` 使用会话构造参数而不是 `record.kdfParams`，
   * 因此这里用 it.fails 固化为已知缺陷（详见 QA 报告 P1-1）。
   */
  it('会话解锁应使用密钥槽持久化的 KDF 参数（P1-1 回归）', async () => {
    const { session } = await createHarness();
    const keyslots = session.getKeyslots();

    // 模拟"未来版本把内存成本从 16 MiB 调到 32 MiB"，参数版本仍是 1
    const futureParams = { ...ARGON2_TEST_PARAMS, memoryKiB: 32 * 1024 };
    const upgraded = new VaultSession({
      now: () => NOW,
      keyslots,
      passwordParams: futureParams,
      recoveryParams: futureParams,
    });

    // 若实现仍用会话构造参数派生 KEK，32 MiB 与 16 MiB 派生结果不同，会报 AUTH_INVALID。
    await expect(upgraded.unlock(MASTER_PASSWORD)).resolves.toMatchObject({ status: 'unlocked' });
    expect(upgraded.hasKeyMaterial()).toBe(true);
  });

  it('反向：64 MiB 建槽 + 16 MiB 会话参数同样能解锁（参数只认密钥槽记录）', async () => {
    const material = await createRecoveryMaterial(NOW, '反向用例');
    const slotParams = { ...ARGON2_TEST_PARAMS, memoryKiB: 64 * 1024 };
    const keyslots = await createKeyslots({
      dek: createDek(),
      masterPassword: MASTER_PASSWORD,
      recoveryKey: material.recoveryKey,
      now: NOW,
      passwordParams: slotParams,
      recoveryParams: slotParams,
    });
    expect(keyslots.password.kdfParams.memoryKiB).toBe(64 * 1024);

    const downgraded = new VaultSession({
      now: () => NOW,
      keyslots,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });

    await expect(downgraded.unlock(MASTER_PASSWORD)).resolves.toMatchObject({ status: 'unlocked' });
  });

  it('密钥槽被掉包（password 位置放的是 recovery 记录）时拒绝解锁', async () => {
    const { session } = await createHarness();
    const keyslots = session.getKeyslots();
    expect(keyslots).not.toBeNull();
    if (keyslots === null) {
      throw new Error('unreachable');
    }

    const swapped = {
      password: { ...keyslots.recovery },
      recovery: { ...keyslots.password },
    };
    const victim = new VaultSession({ now: () => NOW, keyslots: swapped });

    await expect(victim.unlock(MASTER_PASSWORD)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      messageKey: 'error.invalid_keyslot',
    });
    expect(victim.hasKeyMaterial()).toBe(false);
  });

  it('对照组：按记录参数解包（unwrapDekWithPassword）可以成功，证明缺陷在会话层而非密钥槽层', async () => {
    const { session } = await createHarness();
    const keyslots = session.getKeyslots();
    expect(keyslots).not.toBeNull();
    if (keyslots === null) {
      throw new Error('unreachable');
    }

    // 与上面同一份 keyslots、同一个密码，只是改用记录里的参数派生
    const { unwrapDekWithPassword } = await import('../../src/core/vault/keyslots');
    const dek = await unwrapDekWithPassword(keyslots, MASTER_PASSWORD);
    expect(dek.length).toBe(32);
  });
});

describe('对抗性 · 初始化恢复材料一致性（P2-5）', () => {
  it('恢复码与恢复密钥不匹配：拒绝初始化，且一个密钥槽都不产生', async () => {
    const materialA = await createRecoveryMaterial(NOW, '材料 A');
    const materialB = await createRecoveryMaterial(NOW, '材料 B');
    const session = new VaultSession({
      now: () => NOW,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });

    // 用户抄下的是 A 的恢复码，但落盘会用 B 的恢复密钥 —— 必须当场拒绝。
    await expect(
      session.initialize({
        masterPassword: MASTER_PASSWORD,
        recoveryKey: materialB.recoveryKey,
        recoveryCode: materialA.code,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      messageKey: 'error.recovery_code_mismatch',
    });

    expect(session.getKeyslots()).toBeNull();
    expect(session.hasKeyMaterial()).toBe(false);
    expect(session.status()).toBe('uninitialized');

    // 校验失败不得污染状态机：紧接着用匹配的材料仍能正常初始化。
    const ok = await session.initialize({
      masterPassword: MASTER_PASSWORD,
      recoveryKey: materialB.recoveryKey,
      recoveryCode: materialB.code,
    });
    expect(ok.keyslots.password.slot).toBe('password');
    expect(ok.keyslots.recovery.slot).toBe('recovery');
  });

  it('恢复码格式非法：同样归一到 VALIDATION_FAILED，不产生密钥槽', async () => {
    const material = await createRecoveryMaterial(NOW, '材料');
    const session = new VaultSession({
      now: () => NOW,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });

    await expect(
      session.initialize({
        masterPassword: MASTER_PASSWORD,
        recoveryKey: material.recoveryKey,
        recoveryCode: 'NOT-A-RECOVERY-CODE',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(session.getKeyslots()).toBeNull();
    expect(session.status()).toBe('uninitialized');
  });
});
