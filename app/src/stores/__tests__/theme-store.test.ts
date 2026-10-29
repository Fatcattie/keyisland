/**
 * 主题 store 的契约测试。
 *
 * 重点不是"能切"，而是三条容易回退的约定：
 * 1. 用户选过就以用户为准（不被系统偏好覆盖）；
 * 2. 切换要**同时**写 `<html>` 的类、`data-theme` 与 `color-scheme`；
 * 3. 落盘失败不能把切换本身弄挂（隐私模式下 localStorage 会抛）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  readStoredTheme,
  resolveInitialTheme,
  THEME_STORAGE_KEY,
  useThemeStore,
} from '../theme-store';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
});

describe('主题读取', () => {
  it('没存过时返回 null', () => {
    expect(readStoredTheme()).toBeNull();
  });

  it('存过 dark 时以用户选择为准', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(readStoredTheme()).toBe('dark');
    expect(resolveInitialTheme()).toBe('dark');
  });

  it('存了非法值当作没存过（不让脏数据把界面弄成没主题）', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(readStoredTheme()).toBeNull();
  });
});

describe('applyTheme', () => {
  it('深色：加 dark 类、写 data-theme 与 color-scheme', () => {
    applyTheme('dark');
    const root = document.documentElement;
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
  });

  it('浅色：去掉 dark 类', () => {
    applyTheme('dark');
    applyTheme('light');
    const root = document.documentElement;
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.dataset.theme).toBe('light');
    expect(root.style.colorScheme).toBe('light');
  });
});

describe('useThemeStore', () => {
  it('setMode 同时落盘与写 html', () => {
    useThemeStore.getState().setMode('dark');
    expect(useThemeStore.getState().mode).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggle 在两种模式之间翻转', () => {
    useThemeStore.getState().setMode('light');
    useThemeStore.getState().toggle();
    expect(useThemeStore.getState().mode).toBe('dark');
    useThemeStore.getState().toggle();
    expect(useThemeStore.getState().mode).toBe('light');
  });

  it('落盘抛错时切换仍然生效', () => {
    const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(() => useThemeStore.getState().setMode('dark')).not.toThrow();
      expect(useThemeStore.getState().mode).toBe('dark');
    } finally {
      spy.mockRestore();
    }
  });
});
