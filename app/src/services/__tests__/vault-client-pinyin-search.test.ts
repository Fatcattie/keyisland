/**
 * 拼音搜索门面测试：证明 `VaultClient.searchItems` 真的能用拼音首字母/全拼搜到中文资产。
 */
import { describe, expect, it } from 'vitest';
import { createTestClient } from '../../features/__tests__/support/harness';

const MASTER = 'Alpha-Bravo-7788';

describe('VaultClient.searchItems · 拼音检索', () => {
  it('创建中文资产后可用首字母与全拼检索', async () => {
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER });
    const created = await client.createItem({
      title: '淘宝网',
      platform: '淘宝',
      username: 'buyer@example.com',
      password: 'Shop-Pass-1',
      category: '购物',
      tags: ['生活'],
    });

    const byInitials = await client.searchItems({ text: 'tb' });
    expect(byInitials.map((item) => item.id)).toEqual([created.id]);

    const byFull = await client.searchItems({ text: 'taobaowang' });
    expect(byFull.map((item) => item.id)).toEqual([created.id]);

    const byPlatform = await client.searchItems({ text: 'gouw' }); // 购物
    expect(byPlatform.map((item) => item.id)).toEqual([created.id]);
  });

  it('不相关的拼音不误命中，中文原名仍然可用', async () => {
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER });
    const created = await client.createItem({
      title: '淘宝网',
      username: 'buyer@example.com',
      password: 'Shop-Pass-1',
    });

    expect(await client.searchItems({ text: 'qq' })).toEqual([]);
    expect((await client.searchItems({ text: '淘宝' })).map((item) => item.id)).toEqual([created.id]);
  });

  it('隐藏卡片不会通过拼音检索泄漏', async () => {
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER });
    const created = await client.createItem({
      title: '秘密账本',
      username: 'secret@example.com',
      password: 'Hidden-Pass-1',
      visibility: 'hidden',
    });
    expect(created.visibility).toBe('hidden');

    // 首字母 mm、全拼 mimizhangben 都不应返回隐藏卡片。
    expect(await client.searchItems({ text: 'mm' })).toEqual([]);
    expect(await client.searchItems({ text: 'mimizhangben' })).toEqual([]);
    // 未授权时即使显式 includeHidden 也被拒绝（隐藏访问是独立授权，见 vault-client-hidden-access）。
    await expect(client.searchItems({ text: 'mm', includeHidden: true })).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });
  });
});
