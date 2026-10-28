import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GENERATED_LENGTH,
  DIGIT_CHARS,
  LOWERCASE_CHARS,
  MAX_GENERATED_LENGTH,
  MIN_GENERATED_LENGTH,
  SYMBOL_CHARS,
  UPPERCASE_CHARS,
  generatePassword,
  isGenerateOptionsValid,
} from '../generator';

describe('密码生成器', () => {
  it('默认长度为 20 且使用安全字符集', () => {
    const password = generatePassword();
    const pool = LOWERCASE_CHARS + UPPERCASE_CHARS + DIGIT_CHARS;

    expect(password).toHaveLength(DEFAULT_GENERATED_LENGTH);
    for (const character of password) {
      expect(pool).toContain(character);
    }
  });

  it('长度边界 12–64 可用', () => {
    expect(generatePassword({ length: MIN_GENERATED_LENGTH })).toHaveLength(12);
    expect(generatePassword({ length: MAX_GENERATED_LENGTH })).toHaveLength(64);
  });

  it('拒绝长度小于 12、大于 64 或非整数', () => {
    expect(() => generatePassword({ length: 11 })).toThrowError(
      expect.objectContaining({ code: 'GENERATOR_INVALID' }),
    );
    expect(() => generatePassword({ length: 65 })).toThrowError(
      expect.objectContaining({ code: 'GENERATOR_INVALID' }),
    );
    expect(() => generatePassword({ length: 20.5 })).toThrowError(
      expect.objectContaining({ code: 'GENERATOR_INVALID' }),
    );
  });

  it('拒绝没有任何字符集的配置', () => {
    expect(() =>
      generatePassword({ lowercase: false, uppercase: false, digits: false, symbols: false }),
    ).toThrowError(expect.objectContaining({ code: 'GENERATOR_INVALID' }));
    expect(
      isGenerateOptionsValid({ lowercase: false, uppercase: false, digits: false, symbols: false }),
    ).toBe(false);
  });

  it('每类启用的字符至少出现一次', () => {
    for (let round = 0; round < 30; round += 1) {
      const password = generatePassword({ length: 12, symbols: true });
      expect(/[a-z]/u.test(password)).toBe(true);
      expect(/[A-Z]/u.test(password)).toBe(true);
      expect(/[0-9]/u.test(password)).toBe(true);
      expect([...password].some((character) => SYMBOL_CHARS.includes(character))).toBe(true);
    }
  });

  it('可以关闭指定字符集', () => {
    const password = generatePassword({
      length: 24,
      symbols: false,
      digits: false,
      uppercase: false,
    });
    expect(/^[a-z]+$/u.test(password)).toBe(true);
  });

  it('仅启用符号时也能生成（长度 ≥ 12）', () => {
    const password = generatePassword({
      length: 12,
      lowercase: false,
      uppercase: false,
      digits: false,
      symbols: true,
    });
    for (const character of password) {
      expect(SYMBOL_CHARS).toContain(character);
    }
  });

  it('不出现易混淆字符 I / O / l / 0 / 1', () => {
    for (let round = 0; round < 20; round += 1) {
      const password = generatePassword({ length: 64 });
      expect(/[IOl01]/u.test(password)).toBe(false);
    }
  });

  it('两次生成结果不同（CSPRNG 生效）', () => {
    expect(generatePassword({ length: 32 })).not.toBe(generatePassword({ length: 32 }));
  });
});
