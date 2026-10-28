/**
 * 收起时序的档位与回落（PRD FR-02「鼠标离开 2 秒后自动收起」/
 * SDD §6.5「生产默认 2s，并允许用户在设置中配置」）。
 */

import { describe, expect, it } from 'vitest';
import {
  COLLAPSE_DELAY_OPTIONS,
  DEFAULT_COLLAPSE_DELAY_MS,
  PEEK_HIDE_DELAY_MS,
  isValidCollapseDelay,
  resolveCollapseDelay,
} from '../timing';

describe('收起延时档位', () => {
  it('默认 2 秒，且在可选档位里', () => {
    expect(DEFAULT_COLLAPSE_DELAY_MS).toBe(2000);
    expect(COLLAPSE_DELAY_OPTIONS).toContain(DEFAULT_COLLAPSE_DELAY_MS);
  });

  it('胶囊态延时明显短于默认收起延时（否则会挡住页面顶部）', () => {
    expect(PEEK_HIDE_DELAY_MS).toBeLessThan(DEFAULT_COLLAPSE_DELAY_MS);
  });
});

describe('isValidCollapseDelay', () => {
  it('只认档位里的值', () => {
    for (const value of COLLAPSE_DELAY_OPTIONS) {
      expect(isValidCollapseDelay(value)).toBe(true);
    }
    expect(isValidCollapseDelay(0)).toBe(false);
    expect(isValidCollapseDelay(1500)).toBe(false);
    expect(isValidCollapseDelay(2000.5)).toBe(false);
    expect(isValidCollapseDelay('2000')).toBe(false);
    expect(isValidCollapseDelay(null)).toBe(false);
  });
});

describe('resolveCollapseDelay', () => {
  it('合法值原样返回，缺失 / 非法回落 2 秒', () => {
    expect(resolveCollapseDelay(500)).toBe(500);
    expect(resolveCollapseDelay(3000)).toBe(3000);
    expect(resolveCollapseDelay(undefined)).toBe(DEFAULT_COLLAPSE_DELAY_MS);
    expect(resolveCollapseDelay(999)).toBe(DEFAULT_COLLAPSE_DELAY_MS);
    expect(resolveCollapseDelay(Number.NaN)).toBe(DEFAULT_COLLAPSE_DELAY_MS);
  });
});
