/**
 * 密码生成器（PRD FR-04.1 基础版）。
 *
 * 约束：
 * - 必须使用 CSPRNG（`randomInt` 基于 `crypto.getRandomValues` + 拒绝采样）。
 * - 长度 12–64；至少启用一类字符；每类启用字符至少出现一次。
 * - 拒绝明显弱配置（长度 < 12、无字符集、非整数长度）。
 */

import { errors } from '../errors';
import { randomInt } from '../crypto/random';

/** 生成密码最小长度。 */
export const MIN_GENERATED_LENGTH = 12;

/** 生成密码最大长度。 */
export const MAX_GENERATED_LENGTH = 64;

/** 默认长度。 */
export const DEFAULT_GENERATED_LENGTH = 20;

/** 小写字母池（去掉易混淆的 l）。 */
export const LOWERCASE_CHARS = 'abcdefghijkmnopqrstuvwxyz';

/** 大写字母池（去掉易混淆的 I、O）。 */
export const UPPERCASE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** 数字池（去掉易混淆的 0、1）。 */
export const DIGIT_CHARS = '23456789';

/** 符号池（兼顾主流网站可接受范围）。 */
export const SYMBOL_CHARS = '!@#$%^&*()-_=+[]{};:,.?';

/** 生成选项。 */
export interface GeneratePasswordOptions {
  length?: number;
  lowercase?: boolean;
  uppercase?: boolean;
  digits?: boolean;
  symbols?: boolean;
}

/** 归一化后的生成配置。 */
interface ResolvedOptions {
  length: number;
  pools: string[];
}

/** 校验并归一化配置，非法配置抛 `GENERATOR_INVALID`。 */
function resolveOptions(options: GeneratePasswordOptions): ResolvedOptions {
  const length = options.length ?? DEFAULT_GENERATED_LENGTH;
  if (!Number.isInteger(length)) {
    throw errors.generatorInvalid('error.generator_length_integer');
  }
  if (length < MIN_GENERATED_LENGTH) {
    throw errors.generatorInvalid('error.generator_length_too_short');
  }
  if (length > MAX_GENERATED_LENGTH) {
    throw errors.generatorInvalid('error.generator_length_too_long');
  }

  const pools: string[] = [];
  if (options.lowercase !== false) {
    pools.push(LOWERCASE_CHARS);
  }
  if (options.uppercase !== false) {
    pools.push(UPPERCASE_CHARS);
  }
  if (options.digits !== false) {
    pools.push(DIGIT_CHARS);
  }
  if (options.symbols === true) {
    pools.push(SYMBOL_CHARS);
  }

  if (pools.length === 0) {
    throw errors.generatorInvalid('error.generator_no_charset');
  }
  if (pools.length > length) {
    throw errors.generatorInvalid('error.generator_length_too_short');
  }
  return { length, pools };
}

/** 从字符池中安全取一个字符。 */
function pickCharacter(pool: string): string {
  return pool[randomInt(pool.length)];
}

/** 原地 Fisher–Yates 洗牌，随机源为 CSPRNG。 */
function shuffle(characters: string[]): void {
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    const temporary = characters[index];
    characters[index] = characters[swapIndex];
    characters[swapIndex] = temporary;
  }
}

/**
 * 生成随机密码。
 * 先保证每个启用的字符类至少一个字符，再用合并字符池填满剩余长度。
 */
export function generatePassword(options: GeneratePasswordOptions = {}): string {
  const { length, pools } = resolveOptions(options);
  const combined = pools.join('');

  const characters: string[] = [];
  for (const pool of pools) {
    characters.push(pickCharacter(pool));
  }
  while (characters.length < length) {
    characters.push(pickCharacter(combined));
  }
  shuffle(characters);
  return characters.join('');
}

/** 评估生成配置是否可用，供 UI 提前禁用按钮。 */
export function isGenerateOptionsValid(options: GeneratePasswordOptions = {}): boolean {
  try {
    resolveOptions(options);
    return true;
  } catch {
    return false;
  }
}
