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

interface Fixture {
  service: ItemService;
  storage: MemoryVaultStorage;
  dek: Uint8Array;
  advance: (ms: number) => void;
}

/** 构造资产服务。 */
function setup(): Fixture {
  let current = 1_700_000_000_000;
  const now = () => current;
  const advance = (ms: number) => {
    current += ms;
  };
  const storage = new MemoryVaultStorage();
  const dek = randomBytes(32);
  const service = new ItemService({ dek, now, store: storage });
  return { service, storage, dek, advance };
}

describe('资产 CRUD', () => {
  it('创建后可在列表中读取，摘要不含密码', async () => {
    const { service } = setup();
    const summary = await service.createItem(BASE_INPUT);

    expect(summary.id).toBe(1);
    expect(summary.title).toBe('示例站点');
    expect(summary.username).toBe('demo-user@example.test');
    expect(summary.hasUrl).toBe(true);
    expect(summary.hasAppTarget).toBe(false);
    expect(Object.keys(summary)).not.toContain('password');

    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(1);
  });

  it('详情返回备注与跳转目标，但不含密码', async () => {
    const { service } = setup();
    const created = await service.createItem(BASE_INPUT);
    const detail = await service.getDetail(created.id);

    expect(detail.notes).toBe('仅用于单元测试的备注');
    expect(detail.url).toBe('https://example.test/login');
    expect(detail.passwordUpdatedAt).toBe(1_700_000_000_000);
    expect(Object.keys(detail)).not.toContain('password');
  });

  it('必填校验：标题、账号、密码不得为空', async () => {
    const { service } = setup();

    await expect(service.createItem({ ...BASE_INPUT, title: '   ' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(service.createItem({ ...BASE_INPUT, username: '' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(service.createItem({ ...BASE_INPUT, password: '' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('长度与可见性校验', async () => {
    const { service } = setup();

    await expect(
      service.createItem({ ...BASE_INPUT, title: 'x'.repeat(121) }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service.createItem({ ...BASE_INPUT, visibility: 'secret' as unknown as 'normal' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service.createItem({ ...BASE_INPUT, tags: ['y'.repeat(33)] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('默认分类与标签归一化', async () => {
    const { service } = setup();
    const summary = await service.createItem({
      ...BASE_INPUT,
      category: null,
      tags: ['  测试  ', '测试', ''],
    });

    expect(summary.category).toBe('其他');
    expect(summary.tags).toEqual(['测试']);
  });

  it('更新字段并刷新 updatedAt；密码变更刷新 passwordUpdatedAt', async () => {
    const { service, advance } = setup();
    const created = await service.createItem(BASE_INPUT);

    advance(1000);
    const updated = await service.updateItem(created.id, { title: '新标题' });
    expect(updated.title).toBe('新标题');
    expect(updated.updatedAt).toBe(1_700_000_001_000);

    advance(1000);
    await service.updateItem(created.id, { password: 'New-P@ssw0rd' });
    const detail = await service.getDetail(created.id);
    expect(detail.passwordUpdatedAt).toBe(1_700_000_002_000);
  });

  it('密码未变化时不刷新 passwordUpdatedAt', async () => {
    const { service, advance } = setup();
    const created = await service.createItem(BASE_INPUT);

    advance(5000);
    await service.updateItem(created.id, { password: BASE_INPUT.password });
    const detail = await service.getDetail(created.id);
    expect(detail.passwordUpdatedAt).toBe(1_700_000_000_000);
  });

  it('删除后不可读取，列表为空', async () => {
    const { service } = setup();
    const created = await service.createItem(BASE_INPUT);

    await service.deleteItem(created.id);
    await expect(service.getDetail(created.id)).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
    await expect(service.deleteItem(created.id)).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
    await expect(service.list()).resolves.toEqual([]);
  });

  it('收藏与可见性设置', async () => {
    const { service } = setup();
    const created = await service.createItem(BASE_INPUT);

    const favorited = await service.setFavorite(created.id, true);
    expect(favorited.favorite).toBe(true);

    const hidden = await service.setVisibility(created.id, 'hidden');
    expect(hidden.visibility).toBe('hidden');
    await expect(service.list()).resolves.toEqual([]);
  });
});

describe('三档可见性', () => {
  it('hidden 不出现在普通列表，授权后可读取', async () => {
    const { service } = setup();
    const created = await service.createItem({ ...BASE_INPUT, visibility: 'hidden' });

    expect(await service.list()).toEqual([]);
    await expect(service.getDetail(created.id)).rejects.toMatchObject({ code: 'ITEM_HIDDEN' });

    const authorized = await service.getDetail(created.id, { allowHidden: true });
    expect(authorized.title).toBe('示例站点');
    expect(authorized.username).toBe('demo-user@example.test');
  });

  it('hidden 摘要不带账号字段（避免二次认证前泄漏）', async () => {
    const { service } = setup();
    await service.createItem({ ...BASE_INPUT, visibility: 'hidden' });

    const all = await service.list({ includeHidden: true });
    expect(all).toHaveLength(1);
    expect(all[0].username).toBeUndefined();
  });

  it('username_only 账号常显但密码不可预览，可复制', async () => {
    const { service } = setup();
    const created = await service.createItem({ ...BASE_INPUT, visibility: 'username_only' });

    const list = await service.list();
    expect(list[0].username).toBe('demo-user@example.test');

    await expect(service.revealPassword(created.id)).rejects.toMatchObject({ code: 'ITEM_HIDDEN' });
    const copied = await service.copySecret(created.id, 'password');
    expect(copied.value).toBe('P@ssw0rd-plain');
    expect(copied.visibility).toBe('username_only');
  });

  it('normal 卡片可以预览密码', async () => {
    const { service } = setup();
    const created = await service.createItem(BASE_INPUT);
    await expect(service.revealPassword(created.id)).resolves.toBe('P@ssw0rd-plain');
  });

  it('hidden 卡片复制需要授权', async () => {
    const { service } = setup();
    const created = await service.createItem({ ...BASE_INPUT, visibility: 'hidden' });

    await expect(service.copySecret(created.id, 'password')).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });
    await expect(
      service.copySecret(created.id, 'password', { allowHidden: true }),
    ).resolves.toMatchObject({ value: 'P@ssw0rd-plain' });
  });

  it('编辑时未显式传 visibility 则保持原值（降级保护）', async () => {
    const { service } = setup();
    const onlyUsername = await service.createItem({ ...BASE_INPUT, visibility: 'username_only' });
    const hidden = await service.createItem({
      ...BASE_INPUT,
      title: '隐藏卡片',
      visibility: 'hidden',
    });

    const updatedOnlyUsername = await service.updateItem(onlyUsername.id, { notes: '改备注' });
    const updatedHidden = await service.updateItem(hidden.id, { notes: '改备注' });

    expect(updatedOnlyUsername.visibility).toBe('username_only');
    expect(updatedHidden.visibility).toBe('hidden');
  });

  it('显式传入 visibility 时才改变档位', async () => {
    const { service } = setup();
    const created = await service.createItem({ ...BASE_INPUT, visibility: 'username_only' });

    const updated = await service.updateItem(created.id, { visibility: 'normal' });
    expect(updated.visibility).toBe('normal');
    await expect(service.revealPassword(created.id)).resolves.toBe('P@ssw0rd-plain');
  });
});

describe('落盘加密', () => {
  it('存储中不含账号与密码明文', async () => {
    const { service, storage } = setup();
    await service.createItem(BASE_INPUT);

    const serialized = JSON.stringify(await storage.loadItems());
    expect(serialized).not.toContain('P@ssw0rd-plain');
    expect(serialized).not.toContain('demo-user@example.test');
    expect(serialized).not.toContain('仅用于单元测试的备注');
    expect(serialized).toContain('示例站点');
  });

  it('篡改记录 id 后因 AAD 不匹配而解密失败（同一 DEK）', async () => {
    const { service, storage, dek } = setup();
    await service.createItem(BASE_INPUT);

    const records = await storage.loadItems();
    records[0] = { ...records[0], id: 99 };
    await storage.saveItems(records);

    const tampered = new ItemService({ dek, now: () => 0, store: storage });
    await expect(tampered.hydrate()).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
  });

  it('dispose 后内存明文清空，重新 hydrate 可恢复', async () => {
    const { service } = setup();
    await service.createItem(BASE_INPUT);
    expect(service.size()).toBe(1);

    service.dispose();
    expect(service.size()).toBe(0);

    await service.hydrate();
    expect(service.size()).toBe(1);
    const list = await service.list();
    expect(list[0].title).toBe('示例站点');
  });
});
