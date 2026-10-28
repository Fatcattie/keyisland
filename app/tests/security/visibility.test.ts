/**
 * 对抗性测试 · 三档可见性边界（PRD FR-03 / SDD §5.3）。
 *
 * 验证目标：
 * - `hidden` 不能通过任何"顺带"的接口（列表 / 搜索 / 最近使用 / 更新返回值）泄漏；
 * - `username_only` 不可预览密码，但允许复制密码（这正是该档位的用途）；
 * - 更新时不传 `visibility` 必须保持原值，不能被静默降级成 `normal`。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../src/core/crypto';
import { ItemService, type ItemStorePort } from '../../src/core/vault/items';
import type { EncryptedItemRecord } from '../../src/core/vault/types';
import { randomBytes } from '../../src/core/crypto/random';
import { MemoryVaultStorage } from '../../src/services/storage';
import { createVaultClient } from '../../src/services/vault-client';
import type { ClipboardPort } from '../../src/services/clipboard';

const NOW = 1_700_000_000_000;
const MASTER_PASSWORD = 'Fixture-Master-1';

/** 内存资产仓库（只存密文）。 */
class MemoryItemStore implements ItemStorePort {
  records: EncryptedItemRecord[] = [];

  async loadItems(): Promise<EncryptedItemRecord[]> {
    return JSON.parse(JSON.stringify(this.records)) as EncryptedItemRecord[];
  }

  async saveItems(records: EncryptedItemRecord[]): Promise<void> {
    this.records = JSON.parse(JSON.stringify(records)) as EncryptedItemRecord[];
  }
}

/** 构造独立的 ItemService（不经过会话，直接测领域层）。 */
function createItemService(): { service: ItemService; store: MemoryItemStore } {
  const store = new MemoryItemStore();
  const service = new ItemService({ dek: randomBytes(32), now: () => NOW, store });
  return { service, store };
}

/** 剪贴板替身：只记录写入次数与当前内容。 */
class FakeClipboardPort implements ClipboardPort {
  content: string | null = null;

  writeCount = 0;

  async write(text: string): Promise<void> {
    this.content = text;
    this.writeCount += 1;
  }

  async read(): Promise<string | null> {
    return this.content;
  }

  async clear(): Promise<void> {
    this.content = null;
  }
}

describe('对抗性 · hidden 资产不进入任何普通视图', () => {
  it('hidden 默认不在列表中，只有显式 includeHidden 才出现', async () => {
    const { service } = createItemService();
    const visible = await service.createItem({
      title: '可见站点',
      username: 'alice@example.test',
      password: 'Fixture-Pass-1!',
    });
    const hidden = await service.createItem({
      title: '隐藏站点',
      username: 'bob@example.test',
      password: 'Fixture-Pass-2!',
      visibility: 'hidden',
    });

    const defaultList = await service.list();
    expect(defaultList.map((item) => item.id)).toEqual([visible.id]);
    expect(defaultList.some((item) => item.id === hidden.id)).toBe(false);

    const hiddenList = await service.list({ includeHidden: true });
    expect(hiddenList.map((item) => item.id).sort()).toEqual([visible.id, hidden.id].sort());
  });

  it('hidden 的详情 / 摘要 / 预览 / 复制全部需要显式授权', async () => {
    const { service } = createItemService();
    const hidden = await service.createItem({
      title: '隐藏站点',
      username: 'bob@example.test',
      password: 'Fixture-Pass-2!',
      visibility: 'hidden',
    });

    await expect(service.getDetail(hidden.id)).rejects.toMatchObject({ code: 'ITEM_HIDDEN' });
    await expect(service.getSummary(hidden.id)).rejects.toMatchObject({ code: 'ITEM_HIDDEN' });
    await expect(service.revealPassword(hidden.id)).rejects.toMatchObject({ code: 'ITEM_HIDDEN' });
    await expect(service.revealUsername(hidden.id)).rejects.toMatchObject({ code: 'ITEM_HIDDEN' });
    await expect(service.copySecret(hidden.id, 'password')).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });

    // 授权后详情可用，但摘要里仍不带账号（防止通过摘要旁路泄漏）
    const detail = await service.getDetail(hidden.id, { allowHidden: true });
    expect(detail.username).toBe('bob@example.test');
    const summary = await service.getSummary(hidden.id, { allowHidden: true });
    expect(summary.username).toBeUndefined();
  });

  it('更新 hidden 资产时不传 visibility，仍保持 hidden（降级保护）', async () => {
    const { service } = createItemService();
    const hidden = await service.createItem({
      title: '隐藏站点',
      username: 'bob@example.test',
      password: 'Fixture-Pass-2!',
      visibility: 'hidden',
    });

    await service.updateItem(hidden.id, { title: '隐藏站点（改名）' });

    const list = await service.list();
    expect(list.some((item) => item.id === hidden.id)).toBe(false);
    await expect(service.getSummary(hidden.id)).rejects.toMatchObject({ code: 'ITEM_HIDDEN' });
  });

  it('改成 hidden 后从列表消失，改回 normal 后重新出现', async () => {
    const { service } = createItemService();
    const item = await service.createItem({
      title: '示例站点',
      username: 'alice@example.test',
      password: 'Fixture-Pass-1!',
    });

    await service.updateItem(item.id, { visibility: 'hidden' });
    expect((await service.list()).some((entry) => entry.id === item.id)).toBe(false);

    await service.setVisibility(item.id, 'normal');
    expect((await service.list()).some((entry) => entry.id === item.id)).toBe(true);
  });

  it('落盘记录里不出现账号与密码明文', async () => {
    const { service, store } = createItemService();
    await service.createItem({
      title: '示例站点',
      username: 'alice@example.test',
      password: 'Fixture-Pass-1!',
      notes: 'Fixture note',
    });

    const serialized = JSON.stringify(store.records);
    expect(serialized).not.toContain('Fixture-Pass-1!');
    expect(serialized).not.toContain('alice@example.test');
    expect(serialized).not.toContain('Fixture note');
  });
});

describe('对抗性 · username_only 档位', () => {
  it('不可预览密码，但可预览账号、可复制密码', async () => {
    const { service } = createItemService();
    const item = await service.createItem({
      title: '只显示账号',
      username: 'carol@example.test',
      password: 'Fixture-Pass-3!',
      visibility: 'username_only',
    });

    await expect(service.revealPassword(item.id)).rejects.toMatchObject({ code: 'ITEM_HIDDEN' });
    await expect(service.revealUsername(item.id)).resolves.toBe('carol@example.test');

    // 复制路径是 username_only 的设计用途，必须允许
    const secret = await service.copySecret(item.id, 'password');
    expect(secret.value).toBe('Fixture-Pass-3!');
    expect(secret.visibility).toBe('username_only');

    // 列表可见且带账号
    const list = await service.list();
    const summary = list.find((entry) => entry.id === item.id);
    expect(summary?.username).toBe('carol@example.test');
  });

  it('normal 档位可以预览密码（对照组）', async () => {
    const { service } = createItemService();
    const item = await service.createItem({
      title: '普通站点',
      username: 'dave@example.test',
      password: 'Fixture-Pass-4!',
    });

    await expect(service.revealPassword(item.id)).resolves.toBe('Fixture-Pass-4!');
  });
});

describe('对抗性 · 门面层不得泄漏 hidden', () => {
  interface ClientHarness {
    client: ReturnType<typeof createVaultClient>;
    port: FakeClipboardPort;
  }

  async function createClientHarness(): Promise<ClientHarness> {
    const port = new FakeClipboardPort();
    const client = createVaultClient({
      storage: new MemoryVaultStorage(),
      now: () => NOW,
      clipboard: port,
      clipboardTtlMs: 30_000,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });
    await client.initialize({ masterPassword: MASTER_PASSWORD });
    return { client, port };
  }

  it('hidden 不出现在 listItems / searchItems / getRecentItems 中', async () => {
    const { client } = await createClientHarness();
    try {
      const item = await client.createItem({
        title: '示例站点',
        username: 'alice@example.test',
        password: 'Fixture-Pass-1!',
      });
      // 先复制一次，让它进入最近使用
      await client.copyPassword(item.id);
      expect((await client.getRecentItems()).map((entry) => entry.id)).toEqual([item.id]);

      await client.setVisibility(item.id, 'hidden');

      expect((await client.listItems()).some((entry) => entry.id === item.id)).toBe(false);
      expect((await client.searchItems({ text: '示例站点' })).some((entry) => entry.id === item.id)).toBe(
        false,
      );
      expect((await client.getRecentItems()).some((entry) => entry.id === item.id)).toBe(false);
    } finally {
      await client.dispose();
    }
  });

  it('直接创建的 hidden 资产同样不出现在普通视图', async () => {
    const { client } = await createClientHarness();
    try {
      const hidden = await client.createItem({
        title: '隐藏站点',
        username: 'bob@example.test',
        password: 'Fixture-Pass-2!',
        visibility: 'hidden',
      });

      expect((await client.listItems()).some((entry) => entry.id === hidden.id)).toBe(false);
      expect((await client.searchItems({ text: '隐藏' })).some((entry) => entry.id === hidden.id)).toBe(
        false,
      );
      expect((await client.getRecentItems()).some((entry) => entry.id === hidden.id)).toBe(false);
    } finally {
      await client.dispose();
    }
  });

  it('hidden 复制被拒绝且不产生剪贴板写入', async () => {
    const { client, port } = await createClientHarness();
    try {
      const hidden = await client.createItem({
        title: '隐藏站点',
        username: 'bob@example.test',
        password: 'Fixture-Pass-2!',
        visibility: 'hidden',
      });
      const before = port.writeCount;

      await expect(client.copyPassword(hidden.id)).rejects.toMatchObject({ code: 'ITEM_HIDDEN' });
      await expect(client.copyUsername(hidden.id)).rejects.toMatchObject({ code: 'ITEM_HIDDEN' });
      expect(port.writeCount).toBe(before);
    } finally {
      await client.dispose();
    }
  });

  it('listItems({ includeHidden: true }) 需二次认证：无授权抛 ITEM_HIDDEN，授权后可列出（P2-2 回归）', async () => {
    const { client } = await createClientHarness();
    try {
      const hidden = await client.createItem({
        title: '隐藏站点',
        username: 'bob@example.test',
        password: 'Fixture-Pass-2!',
        visibility: 'hidden',
      });

      // P2-2 回归：无授权时必须抛 ITEM_HIDDEN，绝不能静默返回空数组
      // （空数组会让调用方误判为"没有隐藏卡片"，把授权缺失掩盖成正常状态）。
      await expect(client.listItems({ includeHidden: true })).rejects.toMatchObject({
        code: 'ITEM_HIDDEN',
      });

      const grant = await client.requestHiddenAccess(MASTER_PASSWORD);
      expect(grant.grantedUntil).toBe(NOW + 120_000);
      expect(Object.keys(grant)).toEqual(['grantedUntil']);

      const listed = await client.listItems({ includeHidden: true });
      expect(listed.map((entry) => entry.id)).toContain(hidden.id);
      // 摘要仍然不带账号，泄漏面限于"存在性"
      expect(listed.find((entry) => entry.id === hidden.id)?.username).toBeUndefined();
    } finally {
      await client.dispose();
    }
  });
});
