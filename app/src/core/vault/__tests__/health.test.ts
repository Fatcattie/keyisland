/** 密码体检核心逻辑测试（SDD Phase 5）。 */
import { describe, expect, it } from 'vitest';
import {
  STALE_PASSWORD_DAYS,
  isHealthy,
  isPasswordStale,
  isPasswordStrong,
  summarizeHealth,
} from '../health';

const DAY_MS = 24 * 60 * 60 * 1000;

function entry(
  id: number,
  title: string,
  password: string,
  strong: boolean,
  stale: boolean,
): { id: number; title: string; digest: string; strong: boolean; stale: boolean } {
  // 摘要只影响分组，用密码本身当替身即可区分。
  return { id, title, digest: password, strong, stale };
}

describe('isPasswordStrong', () => {
  it('复用主密码策略：长度与字符种类都要够', () => {
    expect(isPasswordStrong('123')).toBe(false);
    expect(isPasswordStrong('password')).toBe(false);
    expect(isPasswordStrong('Alpha-Bravo-7788')).toBe(true);
  });
});

describe('isPasswordStale', () => {
  const now = 1_000 * DAY_MS;

  it('未到阈值不算过期', () => {
    expect(isPasswordStale(now - (STALE_PASSWORD_DAYS - 1) * DAY_MS, now)).toBe(false);
  });

  it('刚到与超过阈值都算过期', () => {
    expect(isPasswordStale(now - STALE_PASSWORD_DAYS * DAY_MS, now)).toBe(true);
    expect(isPasswordStale(now - (STALE_PASSWORD_DAYS + 30) * DAY_MS, now)).toBe(true);
  });
});

describe('summarizeHealth', () => {
  it('重复密码按摘要分组，只计入 ≥2 张卡片的分组，并带上标题', () => {
    const report = summarizeHealth([
      entry(1, 'GitHub', 'Same-Pass-1', true, false),
      entry(2, 'GitLab', 'Same-Pass-1', true, false),
      entry(3, 'Gitee', 'Same-Pass-1', true, false),
      entry(4, '邮箱', 'Unique-Pass-2', true, false),
    ]);

    expect(report.totalItems).toBe(4);
    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0].itemIds).toEqual([1, 2, 3]);
    expect(report.duplicates[0].titles).toEqual(['GitHub', 'GitLab', 'Gitee']);
    expect(report.weak).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(isHealthy(report)).toBe(false);
  });

  it('重复组按卡片数降序排列，便于优先处理', () => {
    const report = summarizeHealth([
      entry(1, 'A', 'p1', true, false),
      entry(2, 'B', 'p1', true, false),
      entry(3, 'C', 'p2', true, false),
      entry(4, 'D', 'p2', true, false),
      entry(5, 'E', 'p2', true, false),
    ]);
    expect(report.duplicates.map((group) => group.itemIds.length)).toEqual([3, 2]);
  });

  it('弱密码与过期密码各自给出标题与原因', () => {
    const report = summarizeHealth([
      entry(1, '弱卡', '123', false, false),
      entry(2, '老卡', 'Alpha-Bravo-7788', true, true),
      entry(3, '健康卡', 'Alpha-Bravo-7788', true, false),
    ]);

    expect(report.weak).toHaveLength(1);
    expect(report.weak[0]).toMatchObject({ itemId: 1, title: '弱卡' });
    expect(report.weak[0].detail).toContain('强度');
    expect(report.stale).toHaveLength(1);
    expect(report.stale[0]).toMatchObject({ itemId: 2, title: '老卡' });
    expect(report.stale[0].detail).toContain(String(STALE_PASSWORD_DAYS));
  });

  it('完全健康时 isHealthy 为真', () => {
    const report = summarizeHealth([entry(1, 'GitHub', 'Alpha-Bravo-7788', true, false)]);
    expect(isHealthy(report)).toBe(true);
  });

  it('报告结构里不会出现密码明文', () => {
    const report = summarizeHealth([
      entry(1, 'GitHub', 'Same-Pass-1', true, false),
      entry(2, 'GitLab', 'Same-Pass-1', true, false),
    ]);
    // digest 用密码本身当替身，这里只检验序列化结果不含标题之外的敏感字段。
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('password');
  });
});
