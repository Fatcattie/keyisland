/**
 * 搜索与筛选的验收矩阵（客户端层）。
 *
 * core 的 `search.test.ts` 已经把匹配与排序算法覆盖得比较完整，这里不重复造轮子，
 * 只盯**下游那层容易漏的交叉契约**：
 *
 * 1. 遮罩卡片的账号必须在 `searchItems` **之前**被抹掉——否则"搜账号子串能命中
 *    某张遮罩卡"本身就泄露了它的账号；
 * 2. 抹掉之后，标题/平台/分类/标签仍要能搜到它（遮罩卡是可见的，只是账号看不见）；
 * 3. `includeHidden` 必须过授权，且授权不会顺带让 hidden 卡出现在普通列表里；
 * 4. 多个过滤维度是 **AND**，不是"任意命中"。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { AppError } from '../../core/errors';
import { MemoryVaultStorage } from '../storage';
import { createVaultClient, type VaultClient } from '../vault-client';

const MASTER = 'KeyIsland-test-Password-42!';
const PWD = 'Pass-1-Aa1!';

function newClient(): VaultClient {
  return createVaultClient({
    storage: new MemoryVaultStorage(),
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(AppError.isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code}，但调用成功返回`);
}

/** 一个含四类卡片的库：遮罩、隐藏、普通、以及一张用于组合过滤的。 */
async function seed(client: VaultClient): Promise<void> {
  await client.initialize({ masterPassword: MASTER });
  await client.createItem({
    title: 'MaskedCard',
    username: 'secret-user@example.test',
    password: PWD,
    visibility: 'masked',
    category: '开发',
    tags: ['work'],
    favorite: true,
  });
  await client.createItem({
    title: 'HiddenCard',
    username: 'ghost@example.test',
    password: PWD,
    visibility: 'hidden',
    category: '开发',
    tags: ['work'],
    favorite: true,
  });
  await client.createItem({
    title: 'PlainCard',
    username: 'plain-user@example.test',
    password: PWD,
    category: '购物',
    tags: ['life'],
  });
}

describe('验收矩阵 · 搜索 × 隐私', () => {
  it('未授权时，遮罩卡的账号不出现在列表摘要里', async () => {
    const client = newClient();
    await seed(client);

    const list = await client.listItems();
    const masked = list.find((item) => item.title === 'MaskedCard');
    expect(masked).toBeDefined();
    expect(masked!.visibility).toBe('masked');
    expect(masked!.username).toBeUndefined();
  });

  it('未授权时用账号子串搜不到遮罩卡（否则搜索本身就是泄露渠道）', async () => {
    const client = newClient();
    await seed(client);

    await expect(client.listItems({ text: 'secret-user' })).resolves.toHaveLength(0);
    await expect(client.listItems({ text: 'secret' })).resolves.toHaveLength(0);
  });

  it('未授权时仍可用标题/分类/标签搜到遮罩卡', async () => {
    const client = newClient();
    await seed(client);

    await expect(client.listItems({ text: 'Masked' })).resolves.toHaveLength(1);
    await expect(client.listItems({ category: '开发' })).resolves.toHaveLength(1);
    await expect(client.listItems({ tag: 'work' })).resolves.toHaveLength(1);
  });

  it('授权后遮罩卡的账号恢复可见，且可用账号搜到', async () => {
    const client = newClient();
    await seed(client);
    await client.requestHiddenAccess(MASTER);

    const list = await client.listItems();
    expect(list.find((item) => item.title === 'MaskedCard')!.username).toBe('secret-user@example.test');
    await expect(client.listItems({ text: 'secret-user' })).resolves.toHaveLength(1);
  });

  it('includeHidden 未授权时报 ITEM_HIDDEN', async () => {
    const client = newClient();
    await seed(client);

    await expectCode(client.listItems({ includeHidden: true }), 'ITEM_HIDDEN');
  });

  it('授权并显式 includeHidden 才看得到隐藏卡；普通列表始终不含它', async () => {
    const client = newClient();
    await seed(client);
    await client.requestHiddenAccess(MASTER);

    // 授权本身不等于"自动放行"：普通列表仍然只有遮罩卡与普通卡。
    const normal = await client.listItems();
    expect(normal.map((item) => item.title).sort()).toEqual(['MaskedCard', 'PlainCard']);

    const withHidden = await client.listItems({ includeHidden: true });
    expect(withHidden.map((item) => item.title).sort()).toEqual([
      'HiddenCard',
      'MaskedCard',
      'PlainCard',
    ]);
  });

  it('只收藏筛选不会把隐藏卡带出来', async () => {
    const client = newClient();
    await seed(client);

    const favorites = await client.listItems({ favoriteOnly: true });
    expect(favorites.map((item) => item.title)).toEqual(['MaskedCard']);
  });

  it('多个维度是 AND 关系，不是任意命中', async () => {
    const client = newClient();
    await seed(client);

    // 开发 + work + 收藏 + 文本：只剩遮罩卡。
    await expect(
      client.listItems({ category: '开发', tag: 'work', favoriteOnly: true, text: 'Masked' }),
    ).resolves.toHaveLength(1);
    // 分类对、文本对，但收藏条件不满足 → 空。
    await expect(client.listItems({ category: '购物', text: 'Plain', favoriteOnly: true })).resolves.toHaveLength(0);
    // 文本命中普通卡，但分类是开发 → 空。
    await expect(client.listItems({ category: '开发', text: 'plain-user' })).resolves.toHaveLength(0);
  });
});
