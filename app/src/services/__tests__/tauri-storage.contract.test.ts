/**
 * 桌面存储（Tauri + SQLite）的端口契约。
 *
 * 真实 SQLite 事务由 `storage.rs` 的 Rust 测试覆盖；这里验证**前端这一半**：
 * 用 `invoke` 的假实现模拟 `storage.rs` 的行为（同样的三个单值键、每卡一行、
 * `storage_commit` 全有或全无、未知键直接报错），跑与内存实现完全相同的契约断言。
 *
 * 这样即使 Rust 还没编译，也能保证：
 * 1. 适配器没有把 `undefined` / `null` / 非 JSON 值传给 Rust；
 * 2. 键名与 Rust 的 `ALLOWED_KEYS` 对得上；
 * 3. 失败时抛的是 `STORAGE_FAILED`，不会把底层异常泄漏到 UI。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { backend, invokeMock } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const SINGLE_KEYS = ['keyslots', 'meta', 'recency'];
  const ensureKey = (key: string): void => {
    if (!SINGLE_KEYS.includes(key)) {
      throw new Error(`未知的存储键：${key}`);
    }
  };
  type Batch = {
    puts: Array<{ key: string; value: string }>;
    replaceItems: boolean;
    itemUpserts: Array<{ id: number; value: string }>;
    itemDeletes: number[];
  };
  const mock = vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case 'storage_load':
        ensureKey(String(args.key));
        return store.get(String(args.key)) ?? null;
      case 'storage_save':
        ensureKey(String(args.key));
        store.set(String(args.key), String(args.value));
        return undefined;
      case 'storage_load_items':
        return [...store.entries()]
          .filter(([key]) => key.startsWith('item:'))
          .sort(([a], [b]) => Number(a.slice(5)) - Number(b.slice(5)))
          .map(([, value]) => value);
      case 'storage_commit': {
        // 模拟 Rust 事务：先在副本上全部校验并应用，任何一步失败都不碰真实存储。
        const batch = args.batch as Batch;
        const next = new Map(store);
        if (batch.replaceItems) {
          for (const key of [...next.keys()]) {
            if (key.startsWith('item:')) next.delete(key);
          }
        }
        for (const id of batch.itemDeletes) next.delete(`item:${id}`);
        for (const put of batch.puts) {
          ensureKey(put.key);
          next.set(put.key, put.value);
        }
        for (const item of batch.itemUpserts) {
          if ((JSON.parse(item.value) as { id: number }).id !== item.id) {
            throw new Error('资产内容与行身份不一致');
          }
          next.set(`item:${item.id}`, item.value);
        }
        store.clear();
        for (const [key, value] of next) store.set(key, value);
        return undefined;
      }
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
import { STORAGE_KEYS, makeItem, makeKeyslots, makeMeta, runStorageContract } from './support/storage-contract';

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

  it('单值键只用约定的三个（与 Rust 的 ALLOWED_KEYS 对齐），资产走每卡一行', async () => {
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

    expect(usedKeys.length).toBe(3);
    for (const key of usedKeys) {
      expect(STORAGE_KEYS).toContain(key);
    }
    expect([...backend.keys()].sort()).toEqual(['item:1', 'keyslots', 'meta', 'recency']);
  });

  it('传给 Rust 的永远是字符串，不是对象', async () => {
    const storage = new TauriVaultStorage();
    await storage.saveItems([makeItem()]);

    const commitCall = invokeMock.mock.calls.find(([command]) => command === 'storage_commit');
    const batch = (commitCall?.[1] as { batch: { itemUpserts: Array<{ value: unknown }> } }).batch;
    const value = batch.itemUpserts[0]?.value;
    expect(typeof value).toBe('string');
    // 必须是合法 JSON，否则 Rust 侧存进去的是一串解不开的垃圾。
    expect(() => JSON.parse(String(value))).not.toThrow();
  });

  it('覆盖式 commit 只发一次 IPC（一个事务），不拆成多次 storage_save', async () => {
    const storage = new TauriVaultStorage();
    await storage.commit({ keyslots: makeKeyslots(), meta: makeMeta(), items: [makeItem()], recency: [] });
    const commands = invokeMock.mock.calls.map(([command]) => command);
    expect(commands).toEqual(['storage_commit']);
  });

  it('单卡修改只把那一张卡片交给 Rust', async () => {
    const storage = new TauriVaultStorage();
    await storage.saveItems([makeItem({ id: 1 }), makeItem({ id: 2 }), makeItem({ id: 3 })]);
    invokeMock.mockClear();
    await storage.applyItemChanges({ upserts: [makeItem({ id: 2, title: '改过' })], deletes: [] });
    const batch = (invokeMock.mock.calls[0]?.[1] as { batch: { itemUpserts: Array<{ id: number }>; replaceItems: boolean } })
      .batch;
    expect(batch.replaceItems).toBe(false);
    expect(batch.itemUpserts.map((item) => item.id)).toEqual([2]);
  });

  it('Rust 侧提交失败时抛 STORAGE_FAILED', async () => {
    invokeMock.mockRejectedValueOnce(new Error('disk I/O error'));
    const storage = new TauriVaultStorage();
    await expect(storage.commit({ meta: makeMeta() })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('Rust 侧报错时抛 STORAGE_FAILED，而不是把底层异常泄漏出去', async () => {
    invokeMock.mockRejectedValueOnce(new Error('database is locked'));
    const storage = new TauriVaultStorage();
    await expect(storage.loadItems()).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('Rust 返回损坏的 JSON 时抛 STORAGE_FAILED，而不是让 JSON.parse 的异常冒出去', async () => {
    backend.set('item:1', '{ 这不是 JSON');
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
