/**
 * 随机数与内存清理工具。
 * 所有随机性必须来自 CSPRNG（`crypto.getRandomValues`），禁止 `Math.random()`。
 */

import { AppError } from '../errors';

/** 生成指定长度的安全随机字节。 */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length <= 0) {
    throw new AppError('INTERNAL_ERROR', 'error.invalid_random_length', false);
  }
  const output = new Uint8Array(length);
  globalThis.crypto.getRandomValues(output);
  return output;
}

/**
 * 生成 [0, maxExclusive) 内的安全随机整数。
 * 使用拒绝采样消除取模偏差（密码生成器、字符选择必须无偏）。
 */
export function randomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new AppError('INTERNAL_ERROR', 'error.invalid_random_bound', false);
  }
  if (maxExclusive === 1) {
    return 0;
  }
  // 取能覆盖 maxExclusive 的最小字节数，再按拒绝采样丢弃越界值。
  const bytesNeeded = Math.ceil(Math.log2(maxExclusive) / 8) || 1;
  const maxValue = 256 ** bytesNeeded;
  const limit = maxValue - (maxValue % maxExclusive);
  const buffer = new Uint8Array(bytesNeeded);
  for (;;) {
    globalThis.crypto.getRandomValues(buffer);
    let value = 0;
    for (const byte of buffer) {
      value = value * 256 + byte;
    }
    if (value < limit) {
      return value % maxExclusive;
    }
  }
}

/** 常量时间比较，避免通过提前返回泄漏前缀匹配长度。 */
export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

/**
 * 尽力擦除敏感字节。
 * 注意：JS 无法保证 GC 与字符串不可变，这是"尽力而为"的缓解措施；
 * 真正的可验证擦除依赖 Phase 1.5 的 Rust `zeroize`（见 ADR-010）。
 */
export function zeroize(...buffers: Array<Uint8Array | null | undefined>): void {
  for (const buffer of buffers) {
    if (buffer) {
      buffer.fill(0);
    }
  }
}
