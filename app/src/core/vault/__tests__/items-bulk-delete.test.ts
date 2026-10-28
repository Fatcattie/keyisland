/**
 * 批量删除（`ItemService.deleteMany`）行为约定。
 *
 * 重点钉三件事：
 * 1. **原子性**：一次 `flush()`，不逐条写盘——否则中途抛错会留下"删了一半"的状态；
 * 2. **宽容性**：不存在的 id 静默跳过，不让一条失效输入废掉整批操作；
 * 3. **幂等性**：重复 id 只删一次，返回值里不重复。
 *
 * 门面层的"先验主密码再删"由 `vault-client-bulk-delete.test.ts` 负责，
 * 这里只测领域行为，不碰加密层。
 */

import { describe, expect, it } from 'vitest';
import { randomBytes } from '../../crypto/random';
import { ItemService } from '../items';
import { MemoryVaultStorage } from '../../../services/storage';
import type { CreateItemInput } from '../types';

/** 测试用资产输入（全部为虚构数据）。 */
const BASE_INPUT: CreateItemInput = {
  title: '示例站点',
  platform: '示例平台',
  url: 'https://example.test/login',
  appPath: null,
  username: 'demo-user@example.test',
  password: 'P@ssw0rd-plain',
  notes: '仅用于单元测试的备注',
  category: '开发',
  tags: ['测试', 'demo'],
  visibility: 'normal',
};

/** 构造资产服务。 */
function setup(): { service: ItemService; storage: MemoryVaultStorage } {
  const storage = new MemoryVaultStorage();
  const service = new ItemService({ dek: randomBytes(32), now: () => 1_700_000_000_000, store: storage });
  return { service, storage };
}

/** 连续创建 N 张卡片，返回各自的 id。 */
async function seed(service: ItemService, count: number): Promise<number[]> {
  const ids: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const summary = await service.createItem({ ...BASE_INPUT, title: `卡片-${index + 1}` });
    ids.push(summary.id);
  }
  return ids;
}

describe('ItemService.deleteMany', () => {
  it('删除指定子集，返回实际删除的 id 并保留其余卡片', async () => {
    const { service } = setup();
    const [first, second, third] = await seed(service, 3);

    const removed = await service.deleteMany([first, third]);

    expect(removed).toEqual([first, third]);
    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(second);
    // 删除后读单条必须报 not found，而不是返回空对象。
    await expect(service.getDetail(first)).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
  });

  it('不存在的 id 静默跳过，不影响其余卡片', async () => {
    const { service } = setup();
    const [first, second] = await seed(service, 2);

    const removed = await service.deleteMany([first, 999_999]);

    expect(removed).toEqual([first]);
    const list = await service.list();
    expect(list.map((item) => item.id)).toEqual([second]);
  });

  it('重复 id 只删一次，返回值不重复', async () => {
    const { service } = setup();
    const [first, second] = await seed(service, 2);

    const removed = await service.deleteMany([first, first, second, first]);

    expect(removed).toEqual([first, second]);
    expect(new Set(removed).size).toBe(removed.length);
    expect(await service.list()).toHaveLength(0);
  });

  it('全部删除后列表为空，且删除已落盘（不是只在内存里改）', async () => {
    const { service, storage } = setup();
    const ids = await seed(service, 3);

    await service.deleteMany(ids);

    expect(await service.list()).toHaveLength(0);
    // 存储层必须为空：`flush()` 是整体写盘，删干净了就一条不剩。
    expect(await storage.loadItems()).toHaveLength(0);
  });

  it('空数组不写盘、不删任何东西', async () => {
    const { service, storage } = setup();
    await seed(service, 2);

    const removed = await service.deleteMany([]);

    expect(removed).toEqual([]);
    expect(await storage.loadItems()).toHaveLength(2);
    expect(await service.list()).toHaveLength(2);
  });

  it('全部 id 都不存在时同样不写盘', async () => {
    const { service, storage } = setup();
    await seed(service, 1);

    const removed = await service.deleteMany([12345, 23456]);

    expect(removed).toEqual([]);
    expect(await storage.loadItems()).toHaveLength(1);
  });
});
