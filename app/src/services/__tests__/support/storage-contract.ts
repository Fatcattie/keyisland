/**
 * `VaultStorage` 端口的**共享契约测试**。
 *
 * 为什么要有它：ADR-010 要求"迁移到桌面端时端口语义不变"，但这句话在代码里
 * 没有可执行形态——内存实现和桌面实现各写各的测试，谁都可以悄悄放宽语义
 * （比如桌面版 loadItems 返回 null、或者不校验密钥槽），而两边测试都绿。
 *
 * 这里把契约写成一份断言，**两个实现跑同一份**：任何一边偏离，
 * 那一边的测试文件就会红。新增实现（如将来的 SQLCipher 版）也照此接一次。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_PARAMS_V1 } from '../../../core/crypto/kdf';
import type { KeyslotsBundle } from '../../../core/vault/keyslots';
import type { EncryptedItemRecord, RecentEntry } from '../../../core/vault/types';
import type { VaultMeta, VaultStorage } from '../../storage';

/** 与 Rust 侧 `ALLOWED_KEYS` 必须完全一致，改一边就要改另一边。 */
export const STORAGE_KEYS = ['keyslots', 'items', 'meta', 'recency'] as const;

export function makeKeyslots(): KeyslotsBundle {
  // 直接用生产参数常量，避免手抄一份后与真实参数漂移。
  const kdfParams = ARGON2_PARAMS_V1;
  return {
    password: {
      slot: 'password',
      wrappedDek: 'd3JhcHBlZA==',
      salt: 'c2FsdA==',
      nonce: 'bm9uY2U=',
      kdfParams,
      version: 1,
      updatedAt: 1_700_000_000_000,
    },
    recovery: {
      slot: 'recovery',
      wrappedDek: 'cmVjb3Zlcnk=',
      salt: 'c2FsdDI=',
      nonce: 'bm9uY2Uy',
      kdfParams,
      version: 1,
      updatedAt: 1_700_000_000_001,
    },
  };
}

export function makeItem(overrides: Partial<EncryptedItemRecord> = {}): EncryptedItemRecord {
  return {
    id: 1,
    title: '契约测试卡片',
    platform: 'example.com',
    url: 'https://example.com/login',
    appPath: null,
    category: 'login',
    tags: ['契约'],
    visibility: 'masked',
    favorite: false,
    usernameEnc: { v: 1, alg: 'AES-256-GCM', nonce: 'bm9uY2U=', ciphertext: 'Y2lwaGVy' },
    passwordEnc: { v: 1, alg: 'AES-256-GCM', nonce: 'bm9uY2U=', ciphertext: 'cGFzcw==' },
    notesEnc: null,
    passwordUpdatedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    strength: 'strong',
    ...overrides,
  };
}

export function makeMeta(overrides: Partial<VaultMeta> = {}): VaultMeta {
  return {
    schemaVersion: 1,
    autoLockPolicy: '30m',
    clipboardTtlMs: 10_000,
    hint: '常用的那句歌词',
    lockOnSystemLock: true,
    lastBackupAt: null,
    lastBackupReminderAt: null,
    hotzoneWidthPx: 300,
    hotzoneAlign: 'center',
    collapseDelayMs: 2000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function makeRecency(): RecentEntry[] {
  return [
    { itemId: 1, lastUsedAt: 1_700_000_000_000 },
    { itemId: 2, lastUsedAt: 1_700_000_000_500 },
  ];
}

/**
 * 注册一整套端口契约断言。
 *
 * @param label  实现名称，用于 describe 标题
 * @param create 每次调用返回一个**全新的空实现**（测试之间不共享状态）
 */
export function runStorageContract(label: string, create: () => VaultStorage | Promise<VaultStorage>): void {
  describe(`VaultStorage 契约 · ${label}`, () => {
    it('空库：密钥槽与元数据为 null，列表为空数组（不是 null）', async () => {
      const storage = await create();
      await expect(storage.loadKeyslots()).resolves.toBeNull();
      await expect(storage.loadMeta()).resolves.toBeNull();
      await expect(storage.loadItems()).resolves.toEqual([]);
      await expect(storage.loadRecency()).resolves.toEqual([]);
    });

    it('密钥槽：写入后可原样读回', async () => {
      const storage = await create();
      const keyslots = makeKeyslots();
      await storage.saveKeyslots(keyslots);
      await expect(storage.loadKeyslots()).resolves.toEqual(keyslots);
    });

    it('密钥槽：结构不合法时拒绝写入，而不是把坏数据落盘', async () => {
      const storage = await create();
      await expect(storage.saveKeyslots({ password: {} } as KeyslotsBundle)).rejects.toMatchObject({
        code: 'STORAGE_FAILED',
      });
      // 拒绝之后库里必须还是空的，不能留下半截数据。
      await expect(storage.loadKeyslots()).resolves.toBeNull();
    });

    it('条目：写入后可原样读回（含可选字段与加密字段结构）', async () => {
      const storage = await create();
      const items = [makeItem(), makeItem({ id: 2, title: '第二张', notesEnc: null })];
      await storage.saveItems(items);
      await expect(storage.loadItems()).resolves.toEqual(items);
    });

    it('条目：第二次保存是整体替换，不是追加', async () => {
      const storage = await create();
      await storage.saveItems([makeItem(), makeItem({ id: 2 })]);
      await storage.saveItems([makeItem({ id: 3 })]);
      const loaded = await storage.loadItems();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.id).toBe(3);
    });

    it('元数据：写入后可原样读回', async () => {
      const storage = await create();
      const meta = makeMeta();
      await storage.saveMeta(meta);
      await expect(storage.loadMeta()).resolves.toEqual(meta);
    });

    it('最近使用：写入后可原样读回，且顺序保持不变', async () => {
      const storage = await create();
      const recency = makeRecency();
      await storage.saveRecency(recency);
      await expect(storage.loadRecency()).resolves.toEqual(recency);
    });

    it('读出来的是副本：改返回值不会污染存储内部', async () => {
      const storage = await create();
      await storage.saveItems([makeItem()]);
      const first = await storage.loadItems();
      first.push(makeItem({ id: 99 }));
      first[0]!.title = '被篡改';
      const second = await storage.loadItems();
      expect(second).toHaveLength(1);
      expect(second[0]?.title).toBe('契约测试卡片');
    });

    it('写进去的是快照：改调用方对象不会影响已存数据', async () => {
      const storage = await create();
      const items = [makeItem()];
      await storage.saveItems(items);
      items[0]!.title = '事后改名';
      items.push(makeItem({ id: 42 }));
      const loaded = await storage.loadItems();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.title).toBe('契约测试卡片');
    });

    it('clear：四类数据全部清空，回到空库状态', async () => {
      const storage = await create();
      await storage.saveKeyslots(makeKeyslots());
      await storage.saveItems([makeItem()]);
      await storage.saveMeta(makeMeta());
      await storage.saveRecency(makeRecency());

      await storage.clear();

      await expect(storage.loadKeyslots()).resolves.toBeNull();
      await expect(storage.loadMeta()).resolves.toBeNull();
      await expect(storage.loadItems()).resolves.toEqual([]);
      await expect(storage.loadRecency()).resolves.toEqual([]);
    });

    it('describeStorage：返回合法形状，不抛错', async () => {
      const storage = await create();
      const location = await storage.describeStorage();
      expect(['memory', 'file']).toContain(location.kind);
      expect(typeof location.canReveal).toBe('boolean');
      expect(location.displayPath === null || typeof location.displayPath === 'string').toBe(true);
      // 诚实原则：能打开文件夹的，必须给出路径；给不出路径的，不能声称能打开。
      if (location.canReveal) {
        expect(location.displayPath).not.toBeNull();
      }
    });
  });
}
