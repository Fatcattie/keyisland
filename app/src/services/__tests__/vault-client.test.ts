import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto';
import type { ClipboardPort } from '../clipboard';
import { MemoryVaultStorage } from '../storage';
import { createVaultClient, type VaultClient } from '../vault-client';

const MASTER_PASSWORD = 'Master-Pass-1';
const NEW_MASTER_PASSWORD = 'Master-Pass-2';
const PASSWORD_VALUE = 'P@ssw0rd-plain';
const USERNAME_VALUE = 'demo-user@example.test';

/** 内存剪贴板端口。 */
class FakePort implements ClipboardPort {
  content: string | null = null;

  async write(text: string): Promise<void> {
    this.content = text;
  }

  async read(): Promise<string | null> {
    return this.content;
  }

  async clear(): Promise<void> {
    this.content = null;
  }
}

interface Fixture {
  client: VaultClient;
  storage: MemoryVaultStorage;
  port: FakePort;
  advance: (ms: number) => void;
  recoveryCode: string;
}

/** 构造已初始化的客户端。 */
async function setupInitialized(): Promise<Fixture> {
  let current = 1_700_000_000_000;
  const now = () => current;
  const advance = (ms: number) => {
    current += ms;
  };
  const storage = new MemoryVaultStorage();
  const port = new FakePort();
  const client = createVaultClient({
    storage,
    now,
    clipboard: port,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
  });
  const result = await client.initialize({ masterPassword: MASTER_PASSWORD });
  return { client, storage, port, advance, recoveryCode: result.recoveryCode };
}

/** 创建一个普通资产并返回 id。 */
async function createSampleItem(
  client: VaultClient,
  title = 'GitHub',
  platform = 'GitHub',
): Promise<number> {
  const summary = await client.createItem({
    title,
    platform,
    url: 'https://example.test',
    username: USERNAME_VALUE,
    password: PASSWORD_VALUE,
    category: '开发',
    tags: ['代码'],
  });
  return summary.id;
}

describe('VaultClient · 初始化与解锁', () => {
  it('未初始化时状态为 uninitialized', async () => {
    const storage = new MemoryVaultStorage();
    const client = createVaultClient({
      storage,
      now: () => 0,
      clipboard: new FakePort(),
      passwordParams: ARGON2_TEST_PARAMS,
    });

    await expect(client.status()).resolves.toMatchObject({ status: 'uninitialized' });
    await expect(client.listItems()).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
  });

  it('初始化返回恢复码与 .kirk 内容，并进入解锁态', async () => {
    const { client } = await setupInitialized();

    const status = await client.status();
    expect(status.status).toBe('unlocked');
    await expect(client.listItems()).resolves.toEqual([]);
  });

  it('初始化结果包含恢复码与 KIRK1 文件，且不含主密码', async () => {
    const storage = new MemoryVaultStorage();
    const client = createVaultClient({
      storage,
      now: () => 1_700_000_000_000,
      clipboard: new FakePort(),
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });
    const result = await client.initialize({ masterPassword: MASTER_PASSWORD, hint: '常用的那个' });

    expect(result.recoveryCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/u);
    expect(result.kirkJson).toContain('KIRK1');
    expect(result.kirkJson).not.toContain(MASTER_PASSWORD);
    expect(result.kirkFile.magic).toBe('KIRK1');
    expect(result.session.status).toBe('unlocked');
  });

  it('弱主密码无法完成初始化', async () => {
    const client = createVaultClient({
      storage: new MemoryVaultStorage(),
      now: () => 0,
      clipboard: new FakePort(),
      passwordParams: ARGON2_TEST_PARAMS,
    });

    await expect(client.initialize({ masterPassword: 'abc' })).rejects.toMatchObject({
      code: 'PASSWORD_WEAK',
    });
    await expect(client.status()).resolves.toMatchObject({ status: 'uninitialized' });
  });

  it('重复初始化被拒绝', async () => {
    const { client } = await setupInitialized();
    await expect(client.initialize({ masterPassword: MASTER_PASSWORD })).rejects.toMatchObject({
      code: 'VAULT_ALREADY_INITIALIZED',
    });
  });

  it('错误密码解锁失败，正确密码解锁成功', async () => {
    const { client } = await setupInitialized();
    await client.lock();

    await expect(client.unlock('Wrong-Pass-9')).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    await expect(client.unlock(MASTER_PASSWORD)).resolves.toMatchObject({ status: 'unlocked' });
  });

  it('默认 30 分钟后自动锁定', async () => {
    const { client, advance } = await setupInitialized();

    advance(30 * 60 * 1000);
    await expect(client.status()).resolves.toMatchObject({ status: 'locked' });
    await expect(client.listItems()).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
  });

  it('锁定时清空剪贴板中属于自己的密码', async () => {
    const { client, port } = await setupInitialized();
    const id = await createSampleItem(client);
    await client.copyPassword(id);

    expect(port.content).toBe(PASSWORD_VALUE);
    await client.lock();
    expect(port.content).toBeNull();
  });
});

describe('VaultClient · 资产与搜索', () => {
  it('创建、读取、更新、删除全流程', async () => {
    const { client } = await setupInitialized();
    const id = await createSampleItem(client);

    const list = await client.listItems();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('GitHub');
    expect(Object.keys(list[0])).not.toContain('password');

    const detail = await client.getItem(id);
    expect(detail.url).toBe('https://example.test');
    expect(Object.keys(detail)).not.toContain('password');

    const updated = await client.updateItem(id, { title: 'GitHub 工作号' });
    expect(updated.title).toBe('GitHub 工作号');

    await client.deleteItem(id);
    await expect(client.getItem(id)).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
    await expect(client.listItems()).resolves.toEqual([]);
  });

  it('搜索大小写不敏感且支持排序', async () => {
    const { client } = await setupInitialized();
    await createSampleItem(client, 'GitHub');
    await createSampleItem(client, '淘宝', '淘宝网');

    const result = await client.searchItems({ text: 'github' });
    expect(result.map((item) => item.title)).toEqual(['GitHub']);

    const alpha = await client.listItems({ sort: 'alpha' });
    expect(alpha).toHaveLength(2);
  });

  it('校验错误统一为 AppError', async () => {
    const { client } = await setupInitialized();
    await expect(
      client.createItem({ title: '', username: 'x', password: 'y' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('收藏与可见性设置', async () => {
    const { client } = await setupInitialized();
    const id = await createSampleItem(client);

    await expect(client.setFavorite(id, true)).resolves.toMatchObject({ favorite: true });
    await expect(client.setVisibility(id, 'username_only')).resolves.toMatchObject({
      visibility: 'username_only',
    });
  });

  it('生成器无需解锁即可使用', async () => {
    const { client } = await setupInitialized();
    await client.lock();

    const password = client.generatePassword({ length: 16, symbols: true });
    expect(password).toHaveLength(16);
    expect(() => client.generatePassword({ length: 4 })).toThrowError(
      expect.objectContaining({ code: 'GENERATOR_INVALID' }),
    );
  });
});

describe('VaultClient · 复制与最近使用', () => {
  it('复制密码写入剪贴板并返回 TTL 回执', async () => {
    const { client, port } = await setupInitialized();
    const id = await createSampleItem(client);

    const receipt = await client.copyPassword(id);
    expect(port.content).toBe(PASSWORD_VALUE);
    expect(receipt.field).toBe('password');
    expect(receipt.ttlMs).toBe(30_000);
    expect(receipt.token).toHaveLength(16);
  });

  it('复制账号写入账号值', async () => {
    const { client, port } = await setupInitialized();
    const id = await createSampleItem(client);

    const receipt = await client.copyUsername(id);
    expect(port.content).toBe(USERNAME_VALUE);
    expect(receipt.field).toBe('username');
  });

  it('最近使用按复制时间倒序且最多 6 条', async () => {
    const { client, advance } = await setupInitialized();
    const ids: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      ids.push(await createSampleItem(client, `站点-${index}`));
      advance(10);
    }

    for (const id of ids) {
      await client.copyPassword(id);
      advance(10);
    }

    const recent = await client.getRecentItems();
    expect(recent).toHaveLength(6);
    expect(recent.map((item) => item.id)).toEqual(ids.slice(2).reverse());
  });

  it('删除资产后清理最近使用', async () => {
    const { client } = await setupInitialized();
    const id = await createSampleItem(client);
    await client.copyPassword(id);
    expect(await client.getRecentItems()).toHaveLength(1);

    await client.deleteItem(id);
    await expect(client.getRecentItems()).resolves.toEqual([]);
  });

  it('隐藏卡片不进入列表、搜索与最近使用，复制需授权', async () => {
    const { client } = await setupInitialized();
    const hidden = await client.createItem({
      title: '隐藏卡片',
      username: USERNAME_VALUE,
      password: PASSWORD_VALUE,
      visibility: 'hidden',
    });

    await expect(client.listItems()).resolves.toEqual([]);
    await expect(client.searchItems({ text: '隐藏' })).resolves.toEqual([]);
    await expect(client.getRecentItems()).resolves.toEqual([]);
    await expect(client.copyPassword(hidden.id)).rejects.toMatchObject({ code: 'ITEM_HIDDEN' });
    await expect(client.getItem(hidden.id)).rejects.toMatchObject({ code: 'ITEM_HIDDEN' });
  });

  it('改为隐藏后从最近使用中移除', async () => {
    const { client } = await setupInitialized();
    const id = await createSampleItem(client);
    await client.copyPassword(id);
    expect(await client.getRecentItems()).toHaveLength(1);

    await client.setVisibility(id, 'hidden');
    await expect(client.getRecentItems()).resolves.toEqual([]);
    await expect(client.listItems()).resolves.toEqual([]);
  });
});

describe('VaultClient · 恢复流程', () => {
  it('恢复码重设主密码后数据完整、旧密码失效', async () => {
    const { client, recoveryCode } = await setupInitialized();
    const id = await createSampleItem(client);

    await expect(client.recover(recoveryCode)).resolves.toEqual({ verified: true });

    const snapshot = await client.resetMasterPassword({
      recoveryCode,
      newPassword: NEW_MASTER_PASSWORD,
      hint: '新的提示',
    });
    expect(snapshot.status).toBe('locked');

    await expect(client.unlock(MASTER_PASSWORD)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    await expect(client.unlock(NEW_MASTER_PASSWORD)).resolves.toMatchObject({ status: 'unlocked' });

    const list = await client.listItems();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
    await expect(client.copyPassword(id)).resolves.toMatchObject({ field: 'password' });
  });

  it('错误恢复码被拒绝', async () => {
    const { client } = await setupInitialized();
    await expect(client.recover('A'.repeat(32))).rejects.toMatchObject({ code: 'RECOVERY_INVALID' });
  });

  it('dispose 后回到未初始化状态', async () => {
    const { client } = await setupInitialized();
    await client.dispose();

    await expect(client.status()).resolves.toMatchObject({ status: 'uninitialized' });
  });
});
