/**
 * 密码强度档位（FR-03 卡片「密码强度点」）。
 *
 * `passwordLevel` 复用 `assessMasterPassword` 的评分，但与主密码不同：
 * **不强制"弱则拒保存"**——卡片里存的是用户既有的密码，弱也要能保存。这里只把
 * 评分映射成弱/中/强三档。测试钉住映射的边界，避免将来改 `assessMasterPassword`
 * 的评分时，卡片档位跟着 silently 漂移。
 */

import { describe, expect, it } from 'vitest';
import { passwordLevel } from '../policy';

describe('passwordLevel', () => {
  it('过短 → 弱（不足 8 位，且单字符类）', () => {
    expect(passwordLevel('abc')).toBe('weak');
  });

  it('够长但单字符类 → 弱（acceptable 为 false 即判弱）', () => {
    expect(passwordLevel('abcdefgh')).toBe('weak');
    expect(passwordLevel('AAAAAAAA')).toBe('weak');
  });

  it('8 位 + 两类字符 → 弱（评分只有 1 分，未到中档）', () => {
    // 长度达标但只有 lower + digit 两类，score=1。
    expect(passwordLevel('abcdefg1')).toBe('weak');
  });

  it('10 位 + 三类字符 → 中（score=2）', () => {
    expect(passwordLevel('Abcdefgh12')).toBe('medium');
  });

  it('13 位 + 三类字符 → 中（score=3，仍不到强档）', () => {
    expect(passwordLevel('Abcdefghijk12')).toBe('medium');
  });

  it('17 位 + 三类字符 → 强（score=4）', () => {
    expect(passwordLevel('Abcdefghijklmno1')).toBe('strong');
  });

  it('四类的长密码 → 强', () => {
    expect(passwordLevel('Ab1!Ab1!Ab1!')).toBe('medium');
    expect(passwordLevel('Ab1!Ab1!Ab1!Ab1!')).toBe('strong');
  });

  it('全同字符 → 弱（repeated 使 acceptable 为 false）', () => {
    expect(passwordLevel('aaaaaaaa')).toBe('weak');
  });
});
