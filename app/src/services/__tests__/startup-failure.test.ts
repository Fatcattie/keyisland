/**
 * 启动失败探测（`readStartupFailure`）。
 *
 * 这一层是「启动失败不可见」的修复点之一：Rust 把原因挂到 `AppState` 上，
 * 前端必须能**稳定地**把它读出来并收窄成已知分类。三条契约：
 *
 * 1. 正常启动返回 null（不能让失败屏挡住正常用户）；
 * 2. 已知分类原样透传 code / detail / dbPath（detail 是用户唯一的线索）；
 * 3. 未知 code 落到 `unknown` 而不是 null——分类不认识不等于没失败；
 * 4. 探测本身失败返回 null——探测不能成为新的启动失败来源。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { normalizeStartupCode, readStartupFailure } from '../tauri-storage';

/** 模拟跑在 Tauri 壳里。 */
function enterDesktopShell(): void {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
}

/** 模拟浏览器环境。 */
function leaveDesktopShell(): void {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

describe('readStartupFailure', () => {
  beforeEach(() => {
    enterDesktopShell();
    invokeMock.mockReset();
  });

  afterEach(() => {
    leaveDesktopShell();
  });

  it('正常启动返回 null', async () => {
    invokeMock.mockResolvedValue(null);
    await expect(readStartupFailure()).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledWith('startup_failure');
  });

  it('密钥丢失：code / detail / dbPath 全部透传', async () => {
    invokeMock.mockResolvedValue({
      code: 'missing_key',
      detail: '数据库里已有数据，但系统凭据管理器里找不到对应的密钥。',
      dbPath: 'C:\\Users\\tester\\AppData\\Roaming\\com.keyisland.desktop\\vault.db',
    });

    const failure = await readStartupFailure();

    expect(failure).toEqual({
      code: 'missing_key',
      detail: '数据库里已有数据，但系统凭据管理器里找不到对应的密钥。',
      dbPath: 'C:\\Users\\tester\\AppData\\Roaming\\com.keyisland.desktop\\vault.db',
    });
  });

  it('未知分类归为 unknown，但保留具体原因', async () => {
    invokeMock.mockResolvedValue({ code: 'brand_new_reason', detail: '磁盘只读', dbPath: null });

    const failure = await readStartupFailure();

    // 关键：不能因为 code 不认识就返回 null——那等于把原因吞掉，又回到"静默失败"。
    expect(failure?.code).toBe('unknown');
    expect(failure?.detail).toBe('磁盘只读');
  });

  it('缺字段时不抛错：detail 退化为空串、dbPath 退化为 null', async () => {
    invokeMock.mockResolvedValue({ code: 'database' });

    const failure = await readStartupFailure();

    expect(failure).toEqual({ code: 'database', detail: '', dbPath: null });
  });

  it('命令不存在（老版本壳）返回 null，不把应用挡在门外', async () => {
    invokeMock.mockRejectedValue(new Error('unknown command: startup_failure'));
    await expect(readStartupFailure()).resolves.toBeNull();
  });

  it('浏览器环境不调用 IPC', async () => {
    leaveDesktopShell();
    await expect(readStartupFailure()).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('normalizeStartupCode', () => {
  it('已知分类原样返回', () => {
    for (const code of ['missing_key', 'credential', 'data_dir', 'database'] as const) {
      expect(normalizeStartupCode(code)).toBe(code);
    }
  });

  it('非字符串 / 空值 / 未知值一律 unknown', () => {
    for (const value of [undefined, null, 42, {}, '', 'MISSING_KEY']) {
      expect(normalizeStartupCode(value)).toBe('unknown');
    }
  });
});
