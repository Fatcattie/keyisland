/**
 * 双密钥槽：DEK 由 KEK-A（主密码）与 KEK-B（恢复密钥）分别包装。
 *
 * 设计要点（SDD §4.1）：
 * - DEK 随机生成 32 字节，是唯一真正加密数据的密钥。
 * - 每个槽有独立 salt、独立 nonce、独立 KDF 参数记录与格式版本。
 * - 改主密码只重写 A 槽；轮换恢复密钥只重写 B 槽。
 */

import { AppError, errors } from '../errors';
import {
  ARGON2_PARAMS_V1,
  DERIVED_KEY_LENGTH,
  KDF_SALT_LENGTH,
  base64ToBytes,
  bytesToBase64,
  decryptBytes,
  deriveKey,
  encryptBytes,
  randomBytes,
  resolveArgon2Params,
  zeroize,
  type Argon2Params,
} from '../crypto';

/** 密钥槽标识。 */
export type KeyslotKind = 'password' | 'recovery';

/** 密钥槽记录格式版本。 */
export const KEYSLOT_VERSION = 1;

/** DEK 长度（字节）。 */
export const DEK_LENGTH = 32;

/** 持久化的密钥槽记录（对应 SDD §4.3 keyslots 表）。 */
export interface KeyslotRecord {
  slot: KeyslotKind;
  /** Base64 编码的包装后 DEK。 */
  wrappedDek: string;
  /** Base64 编码的 KDF salt。 */
  salt: string;
  /** Base64 编码的 GCM nonce。 */
  nonce: string;
  /** 该槽独立的 KDF 参数记录。 */
  kdfParams: Argon2Params;
  version: number;
  updatedAt: number;
}

/** 两个密钥槽的集合。 */
export interface KeyslotsBundle {
  password: KeyslotRecord;
  recovery: KeyslotRecord;
}

/** 生成 32 字节 DEK。 */
export function createDek(): Uint8Array {
  return randomBytes(DEK_LENGTH);
}

/** 密钥槽包装使用的 AAD，绑定槽名与格式版本。 */
function buildKeyslotAad(slot: KeyslotKind, version: number): string {
  return `keyslot|${slot}|${version}`;
}

/** 由主密码派生 KEK-A。 */
export async function deriveKekFromPassword(
  password: string,
  salt: Uint8Array,
  params: Argon2Params,
): Promise<Uint8Array> {
  return deriveKey(password, salt, params);
}

/** 由恢复密钥（32 字节原始密钥）派生 KEK-B。 */
export async function deriveKekFromRecoveryKey(
  recoveryKey: Uint8Array,
  salt: Uint8Array,
  params: Argon2Params,
): Promise<Uint8Array> {
  if (recoveryKey.length !== DERIVED_KEY_LENGTH) {
    throw errors.recoveryCodeInvalid();
  }
  return deriveKey(recoveryKey, salt, params);
}

/**
 * 用 KEK 包装 DEK，生成可持久化的密钥槽记录。
 * salt 与 nonce 均由 CSPRNG 生成，调用方无法注入，避免 nonce 复用。
 */
export async function wrapDek(
  dek: Uint8Array,
  kek: Uint8Array,
  slot: KeyslotKind,
  kdfParams: Argon2Params,
  salt: Uint8Array,
  now: number,
): Promise<KeyslotRecord> {
  if (dek.length !== DEK_LENGTH) {
    throw errors.cryptoFailed();
  }
  if (salt.length !== KDF_SALT_LENGTH) {
    throw new AppError('VALIDATION_FAILED', 'error.invalid_salt_length', false);
  }
  const aad = buildKeyslotAad(slot, KEYSLOT_VERSION);
  const { nonce, ciphertext } = await encryptBytes(kek, dek, aad);
  return {
    slot,
    wrappedDek: bytesToBase64(ciphertext),
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(nonce),
    kdfParams,
    version: KEYSLOT_VERSION,
    updatedAt: now,
  };
}

/** 用 KEK 解包 DEK；失败统一抛 `CRYPTO_FAILED`（由调用方转成语义错误）。 */
export async function unwrapDek(record: KeyslotRecord, kek: Uint8Array): Promise<Uint8Array> {
  if (record.version !== KEYSLOT_VERSION) {
    throw errors.unsupportedVersion();
  }
  resolveArgon2Params(record.kdfParams);
  const aad = buildKeyslotAad(record.slot, record.version);
  const dek = await decryptBytes(kek, base64ToBytes(record.nonce), base64ToBytes(record.wrappedDek), aad);
  if (dek.length !== DEK_LENGTH) {
    zeroize(dek);
    throw errors.cryptoFailed();
  }
  return dek;
}

/** 创建双密钥槽：A 槽来自主密码，B 槽来自恢复密钥。 */
export async function createKeyslots(input: {
  dek: Uint8Array;
  masterPassword: string;
  recoveryKey: Uint8Array;
  now: number;
  passwordParams?: Argon2Params;
  recoveryParams?: Argon2Params;
}): Promise<KeyslotsBundle> {
  const passwordParams = input.passwordParams ?? ARGON2_PARAMS_V1;
  const recoveryParams = input.recoveryParams ?? ARGON2_PARAMS_V1;
  const passwordSalt = randomBytes(KDF_SALT_LENGTH);
  const recoverySalt = randomBytes(KDF_SALT_LENGTH);

  let kekA: Uint8Array | null = null;
  let kekB: Uint8Array | null = null;
  try {
    kekA = await deriveKekFromPassword(input.masterPassword, passwordSalt, passwordParams);
    kekB = await deriveKekFromRecoveryKey(input.recoveryKey, recoverySalt, recoveryParams);

    const password = await wrapDek(input.dek, kekA, 'password', passwordParams, passwordSalt, input.now);
    const recovery = await wrapDek(input.dek, kekB, 'recovery', recoveryParams, recoverySalt, input.now);
    return { password, recovery };
  } finally {
    zeroize(kekA, kekB, passwordSalt, recoverySalt);
  }
}

/** 用主密码解包 DEK。 */
export async function unwrapDekWithPassword(
  bundle: KeyslotsBundle,
  password: string,
): Promise<Uint8Array> {
  const record = bundle.password;
  const params = resolveArgon2Params(record.kdfParams);
  const salt = base64ToBytes(record.salt);
  let kek: Uint8Array | null = null;
  try {
    kek = await deriveKekFromPassword(password, salt, params);
    return await unwrapDek(record, kek);
  } finally {
    zeroize(kek, salt);
  }
}

/** 用恢复密钥解包 DEK。 */
export async function unwrapDekWithRecoveryKey(
  bundle: KeyslotsBundle,
  recoveryKey: Uint8Array,
): Promise<Uint8Array> {
  const record = bundle.recovery;
  const params = resolveArgon2Params(record.kdfParams);
  const salt = base64ToBytes(record.salt);
  let kek: Uint8Array | null = null;
  try {
    kek = await deriveKekFromRecoveryKey(recoveryKey, salt, params);
    return await unwrapDek(record, kek);
  } finally {
    zeroize(kek, salt);
  }
}

/**
 * 只重写 A 槽（改主密码）。B 槽保持不变，恢复密钥继续可用。
 * 使用全新 salt，避免旧 salt 下的派生结果被复用。
 */
export async function rewrapPasswordSlot(
  dek: Uint8Array,
  newPassword: string,
  now: number,
  params: Argon2Params = ARGON2_PARAMS_V1,
): Promise<KeyslotRecord> {
  const salt = randomBytes(KDF_SALT_LENGTH);
  let kek: Uint8Array | null = null;
  try {
    kek = await deriveKekFromPassword(newPassword, salt, params);
    return await wrapDek(dek, kek, 'password', params, salt, now);
  } finally {
    zeroize(kek, salt);
  }
}

/**
 * 只重写 B 槽（轮换恢复密钥）。A 槽保持不变，主密码继续可用。
 */
export async function rewrapRecoverySlot(
  dek: Uint8Array,
  newRecoveryKey: Uint8Array,
  now: number,
  params: Argon2Params = ARGON2_PARAMS_V1,
): Promise<KeyslotRecord> {
  const salt = randomBytes(KDF_SALT_LENGTH);
  let kek: Uint8Array | null = null;
  try {
    kek = await deriveKekFromRecoveryKey(newRecoveryKey, salt, params);
    return await wrapDek(dek, kek, 'recovery', params, salt, now);
  } finally {
    zeroize(kek, salt);
  }
}

/** 校验密钥槽集合结构，用于从存储加载时防御性检查。 */
export function isKeyslotsBundle(value: unknown): value is KeyslotsBundle {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<KeyslotsBundle>;
  const isRecord = (slot: unknown, kind: KeyslotKind): boolean => {
    if (typeof slot !== 'object' || slot === null) {
      return false;
    }
    const record = slot as Partial<KeyslotRecord>;
    return (
      record.slot === kind &&
      typeof record.wrappedDek === 'string' &&
      typeof record.salt === 'string' &&
      typeof record.nonce === 'string' &&
      typeof record.version === 'number' &&
      typeof record.updatedAt === 'number' &&
      typeof record.kdfParams === 'object' &&
      record.kdfParams !== null
    );
  };
  return isRecord(candidate.password, 'password') && isRecord(candidate.recovery, 'recovery');
}
