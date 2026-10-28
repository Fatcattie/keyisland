/**
 * Argon2id 密钥派生。
 *
 * 参数集中定义并版本化（SDD §4.2）：参数不允许由 UI 决定，
 * 未来调参必须新增版本并保持旧版本可解析，否则旧库无法解锁。
 */

import { argon2id } from 'hash-wasm';
import { AppError, errors } from '../errors';
import { utf8ToBytes } from './encoding';

/** 单次派生产出的密钥长度（字节）。 */
export const DERIVED_KEY_LENGTH = 32;

/** 密钥槽 salt 长度（字节）。 */
export const KDF_SALT_LENGTH = 16;

/** Argon2id 参数记录，随密钥槽一起持久化。 */
export interface Argon2Params {
  /** 参数集版本，用于未来迁移。 */
  readonly version: number;
  readonly algorithm: 'argon2id';
  /** 内存成本，单位 KiB。 */
  readonly memoryKiB: number;
  /** 迭代次数（time cost）。 */
  readonly iterations: number;
  /** 并行度。 */
  readonly parallelism: number;
  /** 输出长度，固定 32 字节。 */
  readonly hashLength: number;
  /** 建议的 salt 长度。 */
  readonly saltLength: number;
}

/** 生产参数 v1：64 MiB / 3 次迭代 / 1 并行。 */
export const ARGON2_PARAMS_V1: Argon2Params = Object.freeze({
  version: 1,
  algorithm: 'argon2id',
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
  hashLength: DERIVED_KEY_LENGTH,
  saltLength: KDF_SALT_LENGTH,
});

/**
 * 测试与低配环境参数：16 MiB / 2 次迭代。
 * 仅用于单元测试与开发态，绝不可用于生产密钥槽。
 */
export const ARGON2_TEST_PARAMS: Argon2Params = Object.freeze({
  version: 1,
  algorithm: 'argon2id',
  memoryKiB: 16384,
  iterations: 2,
  parallelism: 1,
  hashLength: DERIVED_KEY_LENGTH,
  saltLength: KDF_SALT_LENGTH,
});

/**
 * 参数合法区间（P2-4）。
 *
 * 为什么需要上界：密钥槽元数据是可以被篡改的输入，若只校验下界，
 * 攻击者把 `memoryKiB` 改成 4 GiB 或把 `iterations` 改成 10 万，
 * 就能让客户端在解锁时被"合法地"拖死（内存耗尽 / 长时间占用）。
 * 上界一旦越界即视为不支持的版本，绝不做"尽力派生"。
 */
export const ARGON2_PARAM_LIMITS = Object.freeze({
  /** 内存成本下界（KiB）。 */
  memoryKiBMin: 8,
  /** 内存成本上界（KiB）= 1 GiB。 */
  memoryKiBMax: 1024 * 1024,
  /** 迭代次数下界。 */
  iterationsMin: 1,
  /** 迭代次数上界。 */
  iterationsMax: 10,
  /** 并行度下界。 */
  parallelismMin: 1,
  /** 并行度上界。 */
  parallelismMax: 8,
  /** salt 长度必须精确等于 16 字节。 */
  saltLength: KDF_SALT_LENGTH,
});

/** 判断是否为有限数值，避免 NaN / Infinity 绕过区间比较。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 运行时校验参数记录结构，防止被篡改的元数据导致不可控派生。
 * 所有数值都必须落在 `ARGON2_PARAM_LIMITS` 的闭区间内，越界即不合法。
 */
export function isArgon2Params(value: unknown): value is Argon2Params {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.version !== 'number' || candidate.algorithm !== 'argon2id') {
    return false;
  }
  if (
    !isFiniteNumber(candidate.memoryKiB) ||
    candidate.memoryKiB < ARGON2_PARAM_LIMITS.memoryKiBMin ||
    candidate.memoryKiB > ARGON2_PARAM_LIMITS.memoryKiBMax
  ) {
    return false;
  }
  if (
    !isFiniteNumber(candidate.iterations) ||
    candidate.iterations < ARGON2_PARAM_LIMITS.iterationsMin ||
    candidate.iterations > ARGON2_PARAM_LIMITS.iterationsMax
  ) {
    return false;
  }
  if (
    !isFiniteNumber(candidate.parallelism) ||
    candidate.parallelism < ARGON2_PARAM_LIMITS.parallelismMin ||
    candidate.parallelism > ARGON2_PARAM_LIMITS.parallelismMax
  ) {
    return false;
  }
  if (!isFiniteNumber(candidate.hashLength) || candidate.hashLength !== DERIVED_KEY_LENGTH) {
    return false;
  }
  if (!isFiniteNumber(candidate.saltLength) || candidate.saltLength !== ARGON2_PARAM_LIMITS.saltLength) {
    return false;
  }
  return true;
}

/** 解析持久化的参数记录，失败抛出 UNSUPPORTED_VERSION。 */
export function resolveArgon2Params(value: unknown): Argon2Params {
  if (!isArgon2Params(value)) {
    throw errors.unsupportedVersion();
  }
  if (value.version !== ARGON2_PARAMS_V1.version) {
    throw errors.unsupportedVersion();
  }
  return value;
}

/**
 * 用 Argon2id 派生 32 字节密钥。
 *
 * @param password 主密码（UTF-8 字符串）或恢复密钥（原始字节）。
 * @param salt 每个密钥槽独立的随机 salt，至少 8 字节。
 * @param params 版本化参数集，默认生产参数 v1。
 */
export async function deriveKey(
  password: string | Uint8Array,
  salt: Uint8Array,
  params: Argon2Params = ARGON2_PARAMS_V1,
): Promise<Uint8Array> {
  const resolved = resolveArgon2Params(params);
  if (salt.length < 8) {
    throw new AppError('VALIDATION_FAILED', 'error.kdf_salt_too_short', false);
  }
  try {
    const result = await argon2id({
      password: typeof password === 'string' ? utf8ToBytes(password) : password,
      salt,
      parallelism: resolved.parallelism,
      iterations: resolved.iterations,
      memorySize: resolved.memoryKiB,
      hashLength: resolved.hashLength,
      outputType: 'binary',
    });
    const bytes = typeof result === 'string' ? utf8ToBytes(result) : new Uint8Array(result);
    if (bytes.length !== resolved.hashLength) {
      throw errors.cryptoFailed();
    }
    return bytes;
  } catch (error) {
    if (AppError.isAppError(error)) {
      throw error;
    }
    // 不透传 hash-wasm 内部错误信息，避免泄漏派生细节。
    throw errors.cryptoFailed();
  }
}
