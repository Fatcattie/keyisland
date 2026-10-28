/**
 * 服务层测试替身。
 *
 * 放在 `__tests__/support/` 下且文件名不含 `.test.`，因此不会被 vitest 收集，
 * 但仍会参与 `tsc --noEmit` 类型检查。
 */

import type { EncryptedItemRecord, RecentEntry } from '../../../core/vault/types';
import type { KeyslotsBundle } from '../../../core/vault/keyslots';
import type { ClipboardPort } from '../../clipboard';
import { MemoryVaultStorage, type StorageLocation, type VaultMeta, type VaultStorage } from '../../storage';

/** 内存剪贴板端口，记录写入/清理次数，可模拟读取被拒。 */
export class FakeClipboardPort implements ClipboardPort {
  value: string | null = null;

  writeCount = 0;

  clearCount = 0;

  /** 置为 true 时 `read()` 抛错，模拟剪贴板读取权限被拒。 */
  denyRead = false;

  async write(text: string): Promise<void> {
    this.writeCount += 1;
    this.value = text;
  }

  async read(): Promise<string | null> {
    if (this.denyRead) {
      throw new Error('clipboard read denied');
    }
    return this.value;
  }

  async clear(): Promise<void> {
    this.clearCount += 1;
    this.value = '';
  }
}

/** 可注入故障的存储实现，用于验证初始化原子性。 */
export class FaultyStorage implements VaultStorage {
  private readonly inner = new MemoryVaultStorage();

  /** 需要注入故障的方法名集合。 */
  readonly failures = new Set<string>();

  /** 抛出一次模拟故障；故障注入是"永久"的，由调用方决定何时移除。 */
  private check(operation: string): void {
    if (this.failures.has(operation)) {
      throw new Error(`模拟 ${operation} 失败`);
    }
  }

  async loadKeyslots(): Promise<KeyslotsBundle | null> {
    this.check('loadKeyslots');
    return this.inner.loadKeyslots();
  }

  async saveKeyslots(keyslots: KeyslotsBundle): Promise<void> {
    this.check('saveKeyslots');
    await this.inner.saveKeyslots(keyslots);
  }

  async loadItems(): Promise<EncryptedItemRecord[]> {
    this.check('loadItems');
    return this.inner.loadItems();
  }

  async saveItems(records: EncryptedItemRecord[]): Promise<void> {
    this.check('saveItems');
    await this.inner.saveItems(records);
  }

  async loadMeta(): Promise<VaultMeta | null> {
    this.check('loadMeta');
    return this.inner.loadMeta();
  }

  async saveMeta(meta: VaultMeta): Promise<void> {
    this.check('saveMeta');
    await this.inner.saveMeta(meta);
  }

  async loadRecency(): Promise<RecentEntry[]> {
    this.check('loadRecency');
    return this.inner.loadRecency();
  }

  async saveRecency(entries: RecentEntry[]): Promise<void> {
    this.check('saveRecency');
    await this.inner.saveRecency(entries);
  }

  async clear(): Promise<void> {
    await this.inner.clear();
  }

  async describeStorage(): Promise<StorageLocation> {
    this.check('describeStorage');
    return this.inner.describeStorage();
  }
}
