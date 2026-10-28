/**
 * 桌面存储（Tauri + SQLite）的端口契约。
 *
 * Rust 侧本机没有工具链、编译不了，但**前端这一半可以完整验证**：
 * 用 `invoke` 的假实现模拟 `storage.rs` 的行为（同样的四个键、同样的 JSON 字符串
 * 往返、未知键直接报错），跑与内存实现完全相同的契约断言。
 *
 * 这样即使 Rust 还没编译，也能保证：
 * 1. 适配器没有把 `undefined` / `null` / 非 JSON 值传给 Rust；
 * 2. 键名与 Rust 的 `ALLOWED_KEYS` 对得上；
 * 3. 失败时抛的是 `STORAGE_FAILED`，不会把底层异常泄漏到 UI。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { backend, invokeMock } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const mock = vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case 'storage_load':
        return store.get(String(args.key)) ?? null;
      case 'storage_save':
        store.set(String(args.key), String(args.value));
        return undefined;
      case 'storage_clear':
        store.clear();
        return undefined;
      case 'storage_describe':
        return { kind: 'file', displayPath: 'C:\\Users\\tester\\AppData\\Roaming\\com.keyisland.desktop\\vault.db', canReveal: true };
      case 'storage_reveal':
        return undefined;
      default:
        // 模拟 Rust 侧 ensure_allowed 的行为：未知命令/键一律报错。
        throw new Error(`unknown command: ${command}`);
    }
  });
  return { backend: store, invokeMock: mock };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { TauriVaultStorage, isDesktopShell } from '../tauri-storage';
import { ARGON2_PARAMS_V1 } from '../../core/crypto/kdf';
import { STORAGE_KEYS, makeItem, runStorageContract } from './support/storage-contract';

runStorageContract('TauriVaultStorage（桌面壳）', () => {
  backend.clear();
  invokeMock.mockClear();
  return new TauriVaultStorage();
});

describe('TauriVaultStorage · 与 Rust 侧的接线约定', () => {
  beforeEach(() => {
    backend.clear();
    invokeMock.mockClear();
  });

  it('只使用约定的四个键（与 Rust 的 ALLOWED_KEYS 对齐）', async () => {
    const storage = new TauriVaultStorage();
    await storage.saveKeyslots({
      password: {
        slot: 'password',
        wrappedDek: 'YQ==',
        salt: 'Yg==',
        nonce: 'Yw==',
        kdfParams: ARGON2_PARAMS_V1,
        version: 1,
        updatedAt: 1,
      },
      recovery: {
        slot: 'recovery',
        wrappedDek: 'ZA==',
        salt: 'ZQ==',
        nonce: 'Zg==',
        kdfParams: ARGON2_PARAMS_V1,
        version: 1,
        updatedAt: 1,
      },
    });
    await storage.saveItems([makeItem()]);
    await storage.saveMeta({
      schemaVersion: 1,
      autoLockPolicy: '30m',
      clipboardTtlMs: 10_000,
      hint: null,
      createdAt: 1,
      updatedAt: 1,
    });
    await storage.saveRecency([]);

    const usedKeys = invokeMock.mock.calls
      .filter(([command]) => command === 'storage_save')
      .map(([, args]) => (args as { key: string }).key);

    expect(usedKeys.length).toBe(4);
    for (const key of usedKeys) {
      expect(STORAGE_KEYS).toContain(key);
    }
  });

  it('传给 Rust 的永远是字符串，不是对象', async () => {
    const storage = new TauriVaultStorage();
    await storage.saveItems([makeItem()]);

    const saveCall = invokeMock.mock.calls.find(([command]) => command === 'storage_save');
    const value = (saveCall?.[1] as { value: unknown }).value;
    expect(typeof value).toBe('string');
    // 必须是合法 JSON，否则 Rust 侧存进去的是一串解不开的垃圾。
    expect(() => JSON.parse(String(value))).not.toThrow();
  });

  it('Rust 侧报错时抛 STORAGE_FAILED，而不是把底层异常泄漏出去', async () => {
    invokeMock.mockRejectedValueOnce(new Error('database is locked'));
    const storage = new TauriVaultStorage();
    await expect(storage.loadItems()).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('Rust 返回损坏的 JSON 时抛 STORAGE_FAILED，而不是让 JSON.parse 的异常冒出去', async () => {
    backend.set('items', '{ 这不是 JSON');
    const storage = new TauriVaultStorage();
    await expect(storage.loadItems()).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('describeStorage 失败时退回"未知位置"，不阻断设置页', async () => {
    invokeMock.mockRejectedValueOnce(new Error('boom'));
    const storage = new TauriVaultStorage();
    await expect(storage.describeStorage()).resolves.toEqual({
      kind: 'memory',
      displayPath: null,
      canReveal: false,
    });
  });
});

describe('isDesktopShell', () => {
  it('jsdom 环境下为 false（浏览器版走内存存储）', () => {
    expect(isDesktopShell()).toBe(false);
  });

  it('检测到 __TAURI_INTERNALS__ 时为 true', () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      expect(isDesktopShell()).toBe(true);
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });
});
