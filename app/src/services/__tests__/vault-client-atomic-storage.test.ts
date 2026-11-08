/**
 * 任务 1 / 任务 5：多键写入原子化 + 资产增量写入。
 *
 * 真实的 SQLite 事务（断电、连接关闭、逐阶段故障）由 `src-tauri/src/storage.rs`
 * 的 Rust 测试覆盖；这里验证门面层**如何使用**原子接口：
 * - 覆盖导入、初始化、重设主密码只发一次原子提交，失败时旧库与旧会话保持一致；
 * - 提交成功后"重启"（新客户端读同一份存储）能用备份的主密码解锁；
 * - 单卡修改只加密、只写那一张卡片；失败时内存回滚，不出现内存/磁盘分叉；
 * - 并发修改同一张卡片不会因为乱序落盘而丢失；锁定后排队中的写入不再执行。
 */

import { describe, expect, it, vi } from 'vitest';
import { ARGON2_TEST_PARAMS, randomBytes } from '../../core/crypto';
import * as codec from '../../core/vault/item-codec';
import { ItemService } from '../../core/vault/items';
import { MemoryVaultStorage, type VaultStorage } from '../storage';
import { createVaultClient } from '../vault-client';
import { FaultyStorage } from './support/fakes';

const MASTER = 'Atomic-Master-1';
const OTHER_MASTER = 'Atomic-Other-2';
const BACKUP_PASSWORD = 'Atomic-Backup-3';

function makeClient(storage: VaultStorage) {
  return createVaultClient({
    storage,
    now: () => 1_700_000_000_000,
    clipboard: { write: async () => {}, read: async () => null, clear: async () => {} },
    clipboardTtlMs: 30_000,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
  });
}

/** 一份来自"另一台机器"的备份：主密码 OTHER_MASTER，两张卡片。 */
async function makeForeignBackup(): Promise<string> {
  const source = makeClient(new MemoryVaultStorage());
  await source.initialize({ masterPassword: OTHER_MASTER });
  await source.createItem({ title: '备份卡 A', username: 'a@example.test', password: 'Backup-A-1!' });
  await source.createItem({ title: '备份卡 B', username: 'b@example.test', password: 'Backup-B-2!' });
  const backup = await source.exportBackup(BACKUP_PASSWORD);
  await source.dispose();
  return backup;
}

describe('覆盖导入 · 原子替换', () => {
  it('只发一次 commit，不再拆成四次独立写入', async () => {
    const storage = new MemoryVaultStorage();
    const client = makeClient(storage);
    await client.initialize({ masterPassword: MASTER });
    const backup = await makeForeignBackup();

    const commit = vi.spyOn(storage, 'commit');
    const singles = [
      vi.spyOn(storage, 'saveKeyslots'),
      vi.spyOn(storage, 'saveMeta'),
      vi.spyOn(storage, 'saveItems'),
      vi.spyOn(storage, 'saveRecency'),
    ];
    await client.importBackup({ kirkJson: backup, password: BACKUP_PASSWORD, mode: 'overwrite', masterPassword: MASTER });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(Object.keys(commit.mock.calls[0]![0]).sort()).toEqual(['items', 'keyslots', 'meta', 'recency']);
    for (const spy of singles) {
      expect(spy).not.toHaveBeenCalled();
    }
    await client.dispose();
  });

  it('提交成功后"重启"：用备份的主密码解锁，资产完整；当前库主密码失效', async () => {
    const storage = new MemoryVaultStorage();
    const client = makeClient(storage);
    await client.initialize({ masterPassword: MASTER });
    await client.createItem({ title: '本机旧卡', username: 'old@example.test', password: 'Old-Card-1!' });
    const backup = await makeForeignBackup();
    await client.importBackup({ kirkJson: backup, password: BACKUP_PASSWORD, mode: 'overwrite', masterPassword: MASTER });
    await client.dispose();

    const restarted = makeClient(storage);
    expect((await restarted.status()).status).toBe('locked');
    await expect(restarted.unlock(MASTER)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    await restarted.unlock(OTHER_MASTER);
    const titles = (await restarted.listItems()).map((item) => item.title).sort();
    expect(titles).toEqual(['备份卡 A', '备份卡 B']);
    // 能解密：随便取一张的密码，证明密钥槽与资产来自同一份备份，没有混合。
    const first = (await restarted.listItems())[0]!;
    await expect(restarted.revealPassword(first.id)).resolves.toMatch(/^Backup-[AB]-/);
    await restarted.dispose();
  });

  it.each(['saveKeyslots', 'saveMeta', 'saveItems', 'saveRecency'])(
    '%s 阶段失败：磁盘仍是完整旧库，当前会话保持解锁可用',
    async (stage) => {
      const storage = new FaultyStorage();
      const client = makeClient(storage);
      await client.initialize({ masterPassword: MASTER });
      await client.createItem({ title: '本机旧卡', username: 'old@example.test', password: 'Old-Card-1!' });
      const backup = await makeForeignBackup();

      storage.failures.add(stage);
      await expect(
        client.importBackup({ kirkJson: backup, password: BACKUP_PASSWORD, mode: 'overwrite', masterPassword: MASTER }),
      ).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
      storage.failures.delete(stage);

      // 当前会话：仍解锁，仍是旧库。
      expect((await client.status()).status).toBe('unlocked');
      expect((await client.listItems()).map((item) => item.title)).toEqual(['本机旧卡']);
      await client.dispose();

      // "重启"：旧主密码能解锁，旧卡能解密；备份主密码不能解锁。
      const restarted = makeClient(storage);
      await expect(restarted.unlock(OTHER_MASTER)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
      await restarted.unlock(MASTER);
      const items = await restarted.listItems();
      expect(items.map((item) => item.title)).toEqual(['本机旧卡']);
      await expect(restarted.revealPassword(items[0]!.id)).resolves.toBe('Old-Card-1!');
      await restarted.dispose();
    },
  );
});

describe('初始化 · 原子提交', () => {
  it('初始化只发一次 commit，四段同时落盘', async () => {
    const storage = new MemoryVaultStorage();
    const commit = vi.spyOn(storage, 'commit');
    const client = makeClient(storage);
    await client.initialize({ masterPassword: MASTER });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(Object.keys(commit.mock.calls[0]![0]).sort()).toEqual(['items', 'keyslots', 'meta', 'recency']);
    await client.dispose();
  });
});

describe('资产 · 增量写入', () => {
  async function seeded(count: number) {
    const storage = new MemoryVaultStorage();
    const client = makeClient(storage);
    await client.initialize({ masterPassword: MASTER });
    await client.createItems(
      Array.from({ length: count }, (_, index) => ({
        title: `合成卡 ${index}`,
        username: `user${index}@example.test`,
        password: `Synthetic-${index}-Aa!`,
      })),
    );
    return { storage, client };
  }

  it('单卡修改只重新加密、只写入那一张卡片', async () => {
    const { storage, client } = await seeded(20);
    const target = (await client.listItems()).find((item) => item.title === '合成卡 7')!;
    const before = await storage.loadItems();

    const apply = vi.spyOn(storage, 'applyItemChanges');
    const saveItems = vi.spyOn(storage, 'saveItems');
    const encrypt = vi.spyOn(codec, 'encryptItem');
    await client.updateItem(target.id, { title: '合成卡 7（改）' });

    expect(saveItems).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0].upserts.map((record) => record.id)).toEqual([target.id]);
    expect(apply.mock.calls[0]![0].deletes).toEqual([]);
    expect(encrypt).toHaveBeenCalledTimes(1);

    // 其余 19 张卡片的密文逐字节不变（nonce 随机，重新加密过就一定不同）。
    const after = await storage.loadItems();
    const untouchedBefore = before.filter((record) => record.id !== target.id);
    const untouchedAfter = after.filter((record) => record.id !== target.id);
    expect(untouchedAfter).toEqual(untouchedBefore);
    encrypt.mockRestore();
    await client.dispose();
  });

  it('批量删除是一次原子写入；写盘失败时一张都不删，内存也回滚', async () => {
    const storage = new FaultyStorage();
    const client = makeClient(storage);
    await client.initialize({ masterPassword: MASTER });
    await client.createItems([
      { title: 'A', username: 'a@example.test', password: 'Aa-1-synthetic!' },
      { title: 'B', username: 'b@example.test', password: 'Bb-2-synthetic!' },
      { title: 'C', username: 'c@example.test', password: 'Cc-3-synthetic!' },
    ]);
    const ids = (await client.listItems()).map((item) => item.id);

    storage.failures.add('applyItemChanges');
    await expect(client.deleteItems(ids.slice(0, 2), MASTER)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    storage.failures.delete('applyItemChanges');

    expect(await client.listItems()).toHaveLength(3);
    expect(await storage.loadItems()).toHaveLength(3);
    await client.dispose();
  });

  it('修改写盘失败：内存回滚到修改前，不出现"界面是新值、磁盘是旧值"', async () => {
    const storage = new FaultyStorage();
    const client = makeClient(storage);
    await client.initialize({ masterPassword: MASTER });
    const created = await client.createItem({ title: '原名', username: 'u@example.test', password: 'Orig-1-synthetic!' });

    storage.failures.add('applyItemChanges');
    await expect(client.updateItem(created.id, { title: '新名', password: 'Next-2-synthetic!' })).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
    });
    storage.failures.delete('applyItemChanges');

    expect((await client.listItems())[0]!.title).toBe('原名');
    await expect(client.revealPassword(created.id)).resolves.toBe('Orig-1-synthetic!');
    await client.dispose();
  });
});

describe('ItemService · 并发与锁定', () => {
  it('并发修改同一张卡片：按发起顺序落盘，磁盘与内存都是最后一次修改', async () => {
    const storage = new MemoryVaultStorage();
    const dek = randomBytes(32);
    const service = new ItemService({ dek, now: () => 1, store: storage });
    const created = await service.createItem({ title: 'v0', username: 'u@example.test', password: 'Conc-0-synthetic!' });

    await Promise.all([
      service.updateItem(created.id, { title: 'v1' }),
      service.updateItem(created.id, { title: 'v2' }),
      service.updateItem(created.id, { title: 'v3' }),
    ]);

    expect((await service.getSummary(created.id)).title).toBe('v3');
    const reloaded = new ItemService({ dek, now: () => 1, store: storage });
    expect((await reloaded.getSummary(created.id)).title).toBe('v3');
  });

  it('并发新增不会互相覆盖（id 不撞车）', async () => {
    const storage = new MemoryVaultStorage();
    const dek = randomBytes(32);
    const service = new ItemService({ dek, now: () => 1, store: storage });
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        service.createItem({ title: `c${index}`, username: 'u@example.test', password: `Conc-${index}-synthetic!` }),
      ),
    );
    expect(await storage.loadItems()).toHaveLength(5);
  });

  it('锁定（dispose）后，排队中的写入不再执行，报 VAULT_LOCKED 且不落盘', async () => {
    const storage = new MemoryVaultStorage();
    const dek = randomBytes(32);
    const service = new ItemService({ dek, now: () => 1, store: storage });
    const created = await service.createItem({ title: '锁前', username: 'u@example.test', password: 'Lock-0-synthetic!' });
    const apply = vi.spyOn(storage, 'applyItemChanges');

    const pending = service.updateItem(created.id, { title: '锁后才执行' });
    service.dispose();

    await expect(pending).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    expect(apply).not.toHaveBeenCalled();
    expect((await storage.loadItems())[0]!.title).toBe('锁前');
  });
});
