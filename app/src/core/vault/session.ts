/**
 * 会话与自动锁定、冷却策略。
 *
 * 约束：
 * - 时间通过注入的 `now()` 获取，禁止在核心逻辑里直接调用 `Date.now()`，保证可测试。
 * - 锁定时必须清空 DEK 与恢复流程中的临时密钥（`zeroize` + 置空引用）。
 * - 主密码与恢复密钥共用防暴力策略，但失败次数分开统计（SDD §5.2）。
 */

import { AppError, errors } from '../errors';
import { constantTimeEqual, zeroize } from '../crypto/random';
import { base64ToBytes } from '../crypto/encoding';
import { ARGON2_PARAMS_V1, resolveArgon2Params, type Argon2Params } from '../crypto/kdf';
import { assertMasterPassword } from './policy';
import { recoveryKeyFromCode } from './recovery';
import {
  createDek,
  createKeyslots,
  deriveKekFromPassword,
  rewrapPasswordSlot,
  rewrapRecoverySlot,
  unwrapDek,
  unwrapDekWithRecoveryKey,
  type KeyslotsBundle,
} from './keyslots';
import type { AutoLockPolicy, LockReason, SessionSnapshot, SessionStatus } from './types';

/** 各档位对应的自动锁定超时（毫秒）；`null` 表示只在开机周期内有效。 */
export const AUTO_LOCK_TIMEOUT_MS: Readonly<Record<AutoLockPolicy, number | null>> = Object.freeze({
  immediate: 0,
  '5m': 5 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  boot: null,
});

/** 默认自动锁定档位（PRD Q3 定案）。 */
export const DEFAULT_AUTO_LOCK_POLICY: AutoLockPolicy = '30m';

/** 连续失败多少次进入冷却。 */
export const MAX_FAILED_ATTEMPTS = 5;

/** 冷却起步时长（毫秒）。 */
export const COOLDOWN_BASE_MS = 30 * 1000;

/** 冷却上限（毫秒）。 */
export const COOLDOWN_MAX_MS = 5 * 60 * 1000;

/** 全部自动锁定档位。 */
export const AUTO_LOCK_POLICIES: readonly AutoLockPolicy[] = ['immediate', '5m', '30m', '4h', 'boot'];

/** 会话依赖。 */
export interface VaultSessionOptions {
  /** 注入时钟，测试可完全控制。 */
  now: () => number;
  /** 已存在的密钥槽；未初始化为 null。 */
  keyslots?: KeyslotsBundle | null;
  /** 自动锁定档位，默认 30 分钟。 */
  autoLockPolicy?: AutoLockPolicy;
  /** 主密码派生参数。 */
  passwordParams?: Argon2Params;
  /** 恢复密钥派生参数。 */
  recoveryParams?: Argon2Params;
  /** 锁定时回调（用于清理剪贴板任务、UI 状态）。 */
  onLock?: (reason: LockReason) => void;
}

/** 重设主密码入参。 */
export interface ResetMasterPasswordInput {
  recoveryCode: string;
  newPassword: string;
  hint?: string | null;
}

/** 用恢复密钥（`.kirk` 路径）重设主密码的入参。 */
export interface ResetMasterPasswordByKeyInput {
  recoveryKey: Uint8Array;
  newPassword: string;
  hint?: string | null;
}

/** 恢复码校验通过的回执（不携带任何密钥）。 */
export interface RecoveryVerified {
  verified: true;
}

/** 根据连续冷却次数计算冷却时长：30s → 60s → 120s → 240s → 300s（封顶）。 */
export function cooldownDurationForStrike(strike: number): number {
  if (strike <= 0) {
    return 0;
  }
  const exponential = COOLDOWN_BASE_MS * 2 ** (strike - 1);
  return Math.min(exponential, COOLDOWN_MAX_MS);
}

/** 会话状态机。 */
export class VaultSession {
  private keyslots: KeyslotsBundle | null;

  private dek: Uint8Array | null = null;

  /** `null` 表示不按时间自动锁定（boot 档位）。 */
  private unlockedUntil: number | null = null;

  private passwordFailures = 0;

  private recoveryFailures = 0;

  /** 已进入冷却的次数，用于递增时长。 */
  private cooldownStrikes = 0;

  private cooldownUntil: number | null = null;

  private policy: AutoLockPolicy;

  /** 系统锁屏 / 休眠时是否立即锁定（PRD FR-01，默认开）。 */
  private lockOnSystemLock = true;

  private lastLockReason: LockReason | null = null;

  private readonly now: () => number;

  private readonly onLock: ((reason: LockReason) => void) | undefined;

  private readonly passwordParams: Argon2Params;

  private readonly recoveryParams: Argon2Params;

  constructor(options: VaultSessionOptions) {
    this.now = options.now;
    this.keyslots = options.keyslots ?? null;
    this.policy = options.autoLockPolicy ?? DEFAULT_AUTO_LOCK_POLICY;
    this.passwordParams = options.passwordParams ?? ARGON2_PARAMS_V1;
    this.recoveryParams = options.recoveryParams ?? ARGON2_PARAMS_V1;
    this.onLock = options.onLock;
  }

  /** 当前是否持有 DEK（锁定时必须为 false）。 */
  hasKeyMaterial(): boolean {
    return this.dek !== null;
  }

  /** 最近一次锁定原因，仅用于 UI 提示。 */
  getLastLockReason(): LockReason | null {
    return this.lastLockReason;
  }

  /** 读取密钥槽副本（用于持久化）。 */
  getKeyslots(): KeyslotsBundle | null {
    return this.keyslots;
  }

  /** 外部注入/替换密钥槽（初始化或从存储加载）。 */
  setKeyslots(bundle: KeyslotsBundle | null): void {
    this.keyslots = bundle;
  }

  /** 读取当前自动锁定档位。 */
  getAutoLockPolicy(): AutoLockPolicy {
    return this.policy;
  }

  /** 切换自动锁定档位；已解锁时会按新档位重算到期时间。 */
  setAutoLockPolicy(policy: AutoLockPolicy): void {
    this.policy = policy;
    if (this.dek !== null) {
      this.unlockedUntil = this.computeUnlockedUntil();
    }
  }

  /** 系统锁屏 / 休眠时是否立即锁定（PRD FR-01）。 */
  getLockOnSystemLock(): boolean {
    return this.lockOnSystemLock;
  }

  /**
   * 切换"系统锁屏立即锁定"开关。
   *
   * 只改策略，不动会话状态：关掉开关不会顺带解锁，打开也不会立刻锁定——
   * 用户改设置这个动作本身不该产生副作用。
   */
  setLockOnSystemLock(enabled: boolean): void {
    this.lockOnSystemLock = enabled;
  }

  /** 当前状态（会自动处理超时锁定）。 */
  status(): SessionStatus {
    if (this.keyslots === null) {
      return 'uninitialized';
    }
    const now = this.now();
    if (this.cooldownUntil !== null && now < this.cooldownUntil) {
      return 'cooling_down';
    }
    if (this.cooldownUntil !== null && now >= this.cooldownUntil) {
      // 冷却结束，恢复为可尝试状态。
      this.cooldownUntil = null;
    }
    if (this.dek !== null && this.unlockedUntil !== null && now >= this.unlockedUntil) {
      this.lock('timeout');
    }
    return this.dek !== null ? 'unlocked' : 'locked';
  }

  /** 生成对外的会话快照。 */
  snapshot(): SessionSnapshot {
    const status = this.status();
    const now = this.now();
    return {
      status,
      unlockedUntil: this.dek !== null ? this.unlockedUntil : null,
      failedAttempts: this.passwordFailures,
      passwordFailures: this.passwordFailures,
      recoveryFailures: this.recoveryFailures,
      cooldownUntil: status === 'cooling_down' ? this.cooldownUntil : null,
      cooldownRemainingMs:
        status === 'cooling_down' && this.cooldownUntil !== null
          ? Math.max(0, this.cooldownUntil - now)
          : 0,
      autoLockPolicy: this.policy,
      lockOnSystemLock: this.lockOnSystemLock,
      lockReason: this.lastLockReason,
      // 隐私访问授权由门面维护，此处恒为 null；`VaultSession` 不持有该状态。
      hiddenAccessUntil: null,
    };
  }

  /**
   * 读取当前会话 DEK。
   * 返回内部引用而不是副本，是为了避免额外的密钥副本驻留内存；
   * 调用方不得修改或长期持有。
   */
  requireDek(): Uint8Array {
    this.status();
    if (this.dek === null) {
      throw errors.vaultLocked();
    }
    return this.dek;
  }

  /** 续期：用户产生有效活动时调用。 */
  touch(): void {
    if (this.dek !== null) {
      this.unlockedUntil = this.computeUnlockedUntil();
    }
  }

  /**
   * 初始化会话：创建双密钥槽并直接进入解锁态。
   * 返回恢复码与 `.kirk` 内容，由上层展示给用户离线保存。
   *
   * 恢复码与恢复密钥必须来自同一份材料（P2-5）：否则用户按 UI 抄下恢复码、
   * 之后用该码重设主密码会永远失败，而磁盘里存的是另一把恢复密钥。
   */
  async initialize(input: {
    masterPassword: string;
    recoveryKey: Uint8Array;
    recoveryCode: string;
  }): Promise<{ keyslots: KeyslotsBundle }> {
    if (this.keyslots !== null) {
      throw errors.vaultAlreadyInitialized();
    }
    assertMasterPassword(input.masterPassword);
    await this.assertRecoveryMaterialConsistent(input.recoveryCode, input.recoveryKey);

    const dek = createDek();
    const keyslots = await createKeyslots({
      dek,
      masterPassword: input.masterPassword,
      recoveryKey: input.recoveryKey,
      now: this.now(),
      passwordParams: this.passwordParams,
      recoveryParams: this.recoveryParams,
    });
    this.keyslots = keyslots;
    this.dek = dek;
    this.passwordFailures = 0;
    this.recoveryFailures = 0;
    this.cooldownStrikes = 0;
    this.cooldownUntil = null;
    this.unlockedUntil = this.computeUnlockedUntil();
    return { keyslots };
  }

  /**
   * 用主密码解锁。
   *
   * 关键（P1-1）：派生参数必须来自密钥槽自身持久化的 `record.kdfParams`，
   * 而不是会话构造参数。会话参数只用于**写入新槽**（初始化、改主密码），
   * 否则未来调参（如 v2 提高内存成本）会让所有旧库无法解锁。
   */
  async unlock(password: string): Promise<SessionSnapshot> {
    if (this.keyslots === null) {
      throw errors.vaultNotInitialized();
    }
    this.assertNotCoolingDown();
    const record = this.keyslots.password;
    if (record.slot !== 'password') {
      throw errors.validationFailed('error.invalid_keyslot');
    }
    const params = resolveArgon2Params(record.kdfParams);
    const salt = base64ToBytes(record.salt);
    let kek: Uint8Array | null = null;
    let dek: Uint8Array | null = null;
    try {
      kek = await deriveKekFromPassword(password, salt, params);
      dek = await unwrapDek(record, kek);
    } catch {
      this.registerFailure('password');
      throw errors.authInvalid();
    } finally {
      zeroize(kek, salt);
    }
    if (dek === null) {
      this.registerFailure('password');
      throw errors.authInvalid();
    }
    this.adoptDek(dek);
    this.passwordFailures = 0;
    this.cooldownStrikes = 0;
    this.cooldownUntil = null;
    return this.snapshot();
  }

  /**
   * 校验主密码但不改变会话状态（隐藏卡片二次认证，P2-2）。
   *
   * 与 `unlock()` 的区别：
   * - 成功时不写入 DEK，也不修改 `unlockedUntil`，会话状态保持不变。
   * - 失败与 `unlock()` 共用同一份密码失败计数，因此无法用这条路径绕过冷却。
   *
   * 校验完成后立即擦除派生出的 KEK 与临时 DEK。
   */
  async verifyPassword(password: string): Promise<void> {
    if (this.keyslots === null) {
      throw errors.vaultNotInitialized();
    }
    this.assertNotCoolingDown();
    const record = this.keyslots.password;
    if (record.slot !== 'password') {
      throw errors.validationFailed('error.invalid_keyslot');
    }
    const params = resolveArgon2Params(record.kdfParams);
    const salt = base64ToBytes(record.salt);
    let kek: Uint8Array | null = null;
    let dek: Uint8Array | null = null;
    try {
      kek = await deriveKekFromPassword(password, salt, params);
      dek = await unwrapDek(record, kek);
    } catch {
      this.registerFailure('password');
      throw errors.authInvalid();
    } finally {
      zeroize(kek, salt);
    }
    zeroize(dek);
    // 校验成功等价于证明持有主密码，清零失败计数是安全的。
    this.passwordFailures = 0;
    this.cooldownStrikes = 0;
    this.cooldownUntil = null;
  }

  /**
   * 校验恢复码。只允许进入重设主密码流程，不作为日常解锁入口：
   * 成功后不保留 DEK，也不把会话置为 unlocked。
   */
  async recover(code: string): Promise<RecoveryVerified> {
    if (this.keyslots === null) {
      throw errors.vaultNotInitialized();
    }
    this.assertNotCoolingDown();
    let recoveryKey: Uint8Array | null = null;
    try {
      recoveryKey = await recoveryKeyFromCode(code);
    } catch {
      this.registerFailure('recovery');
      throw errors.recoveryInvalid();
    }
    try {
      return await this.recoverWithRecoveryKey(recoveryKey);
    } finally {
      zeroize(recoveryKey);
    }
  }

  /**
   * 用 32 字节恢复密钥校验，等价于 `recover(code)`。
   * 供 `.kirk` 文件路径使用：文件里存的是恢复密钥而不是恢复码。
   */
  async recoverWithRecoveryKey(recoveryKey: Uint8Array): Promise<RecoveryVerified> {
    if (this.keyslots === null) {
      throw errors.vaultNotInitialized();
    }
    this.assertNotCoolingDown();
    let dek: Uint8Array | null = null;
    try {
      dek = await unwrapDekWithRecoveryKey(this.keyslots, recoveryKey);
    } catch {
      this.registerFailure('recovery');
      throw errors.recoveryInvalid();
    }
    zeroize(dek);
    this.recoveryFailures = 0;
    this.cooldownStrikes = 0;
    this.cooldownUntil = null;
    return { verified: true };
  }

  /**
   * 用恢复码重设主密码：只重写 A 槽，B 槽保持不变。
   * 完成后会话保持锁定，用户需用新主密码解锁。
   */
  async resetMasterPassword(input: ResetMasterPasswordInput): Promise<SessionSnapshot> {
    if (this.keyslots === null) {
      throw errors.vaultNotInitialized();
    }
    this.assertNotCoolingDown();
    assertMasterPassword(input.newPassword);
    let recoveryKey: Uint8Array | null = null;
    try {
      recoveryKey = await recoveryKeyFromCode(input.recoveryCode);
    } catch {
      this.registerFailure('recovery');
      throw errors.recoveryInvalid();
    }
    try {
      return await this.resetMasterPasswordWithRecoveryKey({
        recoveryKey,
        newPassword: input.newPassword,
        hint: input.hint ?? null,
      });
    } finally {
      zeroize(recoveryKey);
    }
  }

  /**
   * 用 32 字节恢复密钥重设主密码（`.kirk` 路径）。
   * 语义与 `resetMasterPassword` 完全一致，只是凭据形态不同。
   */
  async resetMasterPasswordWithRecoveryKey(
    input: ResetMasterPasswordByKeyInput,
  ): Promise<SessionSnapshot> {
    if (this.keyslots === null) {
      throw errors.vaultNotInitialized();
    }
    this.assertNotCoolingDown();
    assertMasterPassword(input.newPassword);

    let dek: Uint8Array | null = null;
    try {
      dek = await unwrapDekWithRecoveryKey(this.keyslots, input.recoveryKey);
    } catch {
      this.registerFailure('recovery');
      throw errors.recoveryInvalid();
    }

    if (dek === null) {
      this.registerFailure('recovery');
      throw errors.recoveryInvalid();
    }

    try {
      const passwordSlot = await rewrapPasswordSlot(dek, input.newPassword, this.now(), this.passwordParams);
      this.keyslots = { ...this.keyslots, password: passwordSlot };
      this.recoveryFailures = 0;
      this.passwordFailures = 0;
      this.cooldownStrikes = 0;
      this.cooldownUntil = null;
      // 重设后必须回到锁定态，避免旧会话残留。
      this.clearKeyMaterial('recovery');
      return this.snapshot();
    } finally {
      zeroize(dek);
    }
  }

  /** 轮换恢复密钥：只重写 B 槽，主密码仍然有效。 */
  async rotateRecoveryKey(recoveryKey: Uint8Array): Promise<KeyslotsBundle> {
    if (this.keyslots === null) {
      throw errors.vaultNotInitialized();
    }
    const dek = this.requireDek();
    const recoverySlot = await rewrapRecoverySlot(dek, recoveryKey, this.now(), this.recoveryParams);
    this.keyslots = { ...this.keyslots, recovery: recoverySlot };
    return this.keyslots;
  }

  /** 锁定会话并清理密钥材料。 */
  lock(reason: LockReason = 'manual'): SessionSnapshot {
    this.clearKeyMaterial(reason);
    return this.snapshot();
  }

  /** 释放会话资源（应用退出时调用）。 */
  dispose(): void {
    this.clearKeyMaterial('app_exit');
    this.keyslots = null;
  }

  /** 清空密钥材料并通知上层。 */
  private clearKeyMaterial(reason: LockReason): void {
    const hadKey = this.dek !== null;
    zeroize(this.dek);
    this.dek = null;
    this.unlockedUntil = null;
    this.lastLockReason = reason;
    if (hadKey) {
      this.onLock?.(reason);
    }
  }

  /** 采用新解包的 DEK，替换并擦除旧引用。 */
  private adoptDek(dek: Uint8Array): void {
    if (this.dek !== null) {
      zeroize(this.dek);
    }
    this.dek = dek;
    this.unlockedUntil = this.computeUnlockedUntil();
    this.lastLockReason = null;
  }

  /** 计算解锁到期时间。 */
  private computeUnlockedUntil(): number | null {
    const timeout = AUTO_LOCK_TIMEOUT_MS[this.policy];
    if (timeout === null) {
      return null;
    }
    return this.now() + timeout;
  }

  /** 冷却期内拒绝任何凭据尝试。 */
  private assertNotCoolingDown(): void {
    const now = this.now();
    if (this.cooldownUntil !== null && now < this.cooldownUntil) {
      throw errors.authCooldown();
    }
    if (this.cooldownUntil !== null) {
      this.cooldownUntil = null;
    }
  }

  /**
   * 交叉校验恢复码与恢复密钥是否来自同一份材料（P2-5）。
   *
   * 采用常量时间比较，避免通过比较耗时推断前缀匹配长度；
   * 任何不一致（含恢复码格式非法）都归一化为 `VALIDATION_FAILED`，
   * 且必须在生成 DEK 之前完成，保证失败时不会产生任何密钥槽。
   */
  private async assertRecoveryMaterialConsistent(
    recoveryCode: string,
    recoveryKey: Uint8Array,
  ): Promise<void> {
    let derived: Uint8Array | null = null;
    try {
      derived = await recoveryKeyFromCode(recoveryCode);
      if (!constantTimeEqual(derived, recoveryKey)) {
        throw errors.validationFailed('error.recovery_code_mismatch');
      }
    } catch (error) {
      if (AppError.isAppError(error) && error.code === 'VALIDATION_FAILED') {
        throw error;
      }
      // 恢复码格式非法或长度不符，同样视为材料不一致。
      throw errors.validationFailed('error.recovery_code_mismatch');
    } finally {
      zeroize(derived);
    }
  }

  /**
   * 记录一次失败尝试。
   * 主密码与恢复密钥共用"每累计 5 次进入一次冷却"的策略，计数分别记录。
   *
   * 进入冷却时必须强制锁定（P2-3）：冷却的语义是"暂时禁止一切凭据尝试"，
   * 若此时仍持有 DEK，用户就能在冷却窗口内继续读写明文，
   * 冷却就只剩下"挡住输入框"的形式意义。
   */
  private registerFailure(kind: 'password' | 'recovery'): void {
    if (kind === 'password') {
      this.passwordFailures += 1;
    } else {
      this.recoveryFailures += 1;
    }
    const total = this.passwordFailures + this.recoveryFailures;
    if (total > 0 && total % MAX_FAILED_ATTEMPTS === 0) {
      this.cooldownStrikes += 1;
      this.cooldownUntil = this.now() + cooldownDurationForStrike(this.cooldownStrikes);
      if (this.dek !== null) {
        this.clearKeyMaterial('auth_cooldown');
      }
    }
  }
}

/** 创建会话实例的工厂，便于测试注入时钟。 */
export function createVaultSession(options: VaultSessionOptions): VaultSession {
  return new VaultSession(options);
}
