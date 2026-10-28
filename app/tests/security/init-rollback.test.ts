/**
 * 对抗性测试 · 初始化失败回滚（SDD §5.4 / 存储一致性）。
 *
 * 验证目标：初始化是"内存 + 磁盘"两步写。任何一步写失败，
 * 都不能留下"能解锁但库里没有槽"或"库里有槽但内存没有"的半状态。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../src/core/crypto';
import type { KeyslotsBundle } from '../../src/core/vault/keyslots';
import type { AutoLockPolicy, EncryptedItemRecord, RecentEntry } from '../../src/core/vault/types';
import { MemoryVaultStorage, type StorageLocation, type VaultMeta, type VaultStorage } from '../../src/services/storage';
import { createVaultClient } from '../../src/services/vault-client';

const NOW = 1_700_000_000_000;
const MASTER_PASSWORD = 'Fixture-Master-1';

type FailableOperation =
  | 'loadKeyslots'
  | 'saveKeyslots'
  | 'saveMeta'
  | 'saveItems'
  | 'saveRecency';

/** 可注入故障的存储实现，其余行为与内存实现一致。 */
class FaultyStorage implements VaultStorage {
  readonly inner = new MemoryVaultStorage();

  readonly failures = new Set<FailableOperation>();

  private ensure(operation: FailableOperation): void {
    if (this.failures.has(operation)) {
      throw new Error(`injected failure: ${operation}`);
    }
  }

  async loadKeyslots(): Promise<KeyslotsBundle | null> {
    this.ensure('loadKeyslots');
    return this.inner.loadKeyslots();
  }

  async saveKeyslots(keyslots: KeyslotsBundle): Promise<void> {
    this.ensure('saveKeyslots');
    return this.inner.saveKeyslots(keyslots);
  }

  async loadItems(): Promise<EncryptedItemRecord[]> {
    return this.inner.loadItems();
  }

  async saveItems(records: EncryptedItemRecord[]): Promise<void> {
    this.ensure('saveItems');
    return this.inner.saveItems(records);
  }

  async loadMeta(): Promise<VaultMeta | null> {
    return this.inner.loadMeta();
  }

  async saveMeta(meta: VaultMeta): Promise<void> {
    this.ensure('saveMeta');
    return this.inner.saveMeta(meta);
  }

  async loadRecency(): Promise<RecentEntry[]> {
    return this.inner.loadRecency();
  }

  async saveRecency(entries: RecentEntry[]): Promise<void> {
    this.ensure('saveRecency');
    return this.inner.saveRecency(entries);
  }

  async clear(): Promise<void> {
    return this.inner.clear();
  }

  async describeStorage(): Promise<StorageLocation> {
    return this.inner.describeStorage();
  }
}

function createClient(storage: VaultStorage) {
  return createVaultClient({
    storage,
    now: () => NOW,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
    autoLockPolicy: '30m' as AutoLockPolicy,
  });
}

describe('对抗性 · 初始化写入失败回滚', () => {
  it('saveKeyslots 失败：报 STORAGE_FAILED，内存回到未初始化，磁盘不留槽', async () => {
    const storage = new FaultyStorage();
    storage.failures.add('saveKeyslots');
    const client = createClient(storage);

    await expect(client.initialize({ masterPassword: MASTER_PASSWORD })).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
    });

    expect((await client.status()).status).toBe('uninitialized');
    expect(await storage.loadKeyslots()).toBeNull();
    await client.dispose();
  });

  it('失败后重试可以正常完成初始化（不残留半状态）', async () => {
    const storage = new FaultyStorage();
    storage.failures.add('saveKeyslots');
    const client = createClient(storage);

    await expect(client.initialize({ masterPassword: MASTER_PASSWORD })).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
    });

    storage.failures.delete('saveKeyslots');
    const result = await client.initialize({ masterPassword: MASTER_PASSWORD });
    expect(result.session.status).toBe('unlocked');
    expect(await storage.loadKeyslots()).not.toBeNull();
    await client.dispose();
  });

  // 期望：初始化要么全成功、要么全无痕；实际：keyslots 与 meta 已落盘，
  // 用户重试会生成新 DEK 并覆盖旧槽，导致第一次展示的恢复码失效（QA 报告 P2-1）。
  it('saveItems 失败后磁盘不应残留已写入的密钥槽（P2-1 回归）', async () => {
    const storage = new FaultyStorage();
    storage.failures.add('saveItems');
    const client = createClient(storage);

    await expect(client.initialize({ masterPassword: MASTER_PASSWORD })).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
    });
    expect((await client.status()).status).toBe('uninitialized');
    await client.dispose();

    // 修复前：keyslots 与 meta 已落盘，用户拿到的新恢复码对不上磁盘；修复后全空。
    // P2-1 回归：初始化必须原子，失败后磁盘上不得残留任何半成品。
    expect(await storage.loadKeyslots()).toBeNull();
    expect(await storage.loadMeta()).toBeNull();
    expect(await storage.loadItems()).toEqual([]);
    expect(await storage.loadRecency()).toEqual([]);

    const reloaded = createClient(storage);
    expect((await reloaded.status()).status).toBe('uninitialized');
    await reloaded.dispose();
  });

  it('loadKeyslots 失败：状态查询报 STORAGE_FAILED，而不是假装未初始化', async () => {
    const storage = new FaultyStorage();
    storage.failures.add('loadKeyslots');
    const client = createClient(storage);

    await expect(client.status()).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await client.dispose();
  });

  it('初始化成功后再初始化：报 VAULT_ALREADY_INITIALIZED', async () => {
    const storage = new FaultyStorage();
    const client = createClient(storage);
    await client.initialize({ masterPassword: MASTER_PASSWORD });

    await expect(client.initialize({ masterPassword: MASTER_PASSWORD })).rejects.toMatchObject({
      code: 'VAULT_ALREADY_INITIALIZED',
    });
    await client.dispose();
  });
});
