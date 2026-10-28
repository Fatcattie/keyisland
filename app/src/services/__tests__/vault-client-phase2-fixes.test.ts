/**
 * QA 第三轮 P2 收尾的回归用例（服务层）。
 *
 * 覆盖三条：
 * 1. `setClipboardTtl` 修改后必须能跨"重启"回读（同一份 storage 重建 client）；
 * 2. `resetVault` 在锁定态必须拒绝，且不得清掉任何数据；
 * 3. `allowHidden: true` 只对真正的 `hidden` 资产要求授权，普通卡片不被误伤。
 *
 * 全部使用真实 client + `MemoryVaultStorage` + `ARGON2_TEST_PARAMS`，不 mock 加密层。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { AppError } from '../../core/errors';
import { createVaultClient, type VaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';

const START = 1_700_000_000_000;
const MASTER = 'Kilo-Lima-3355';

/** 断言抛出指定 `AppError.code`。 */
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(AppError.isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code}，但调用成功返回了`);
}

/** 用同一份 storage 造 client，模拟"关闭应用再打开"。 */
function createClient(storage: MemoryVaultStorage, clipboard: FakeClipboardPort): VaultClient {
  return createVaultClient({
    storage,
    now: () => START,
    clipboard,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
    autoLockPolicy: '30m',
  });
}

describe('设置持久化 · 剪贴板 TTL 跨重启回读', () => {
  it('修改 TTL 后新建 client 仍沿用新值', async () => {
    const storage = new MemoryVaultStorage();

    const first = createClient(storage, new FakeClipboardPort());
    await first.initialize({ masterPassword: MASTER });
    const seeded = await first.createItem({
      title: '团队邮箱',
      username: 'team-kilo',
      password: 'November-Oscar-1122',
    });
    await first.setClipboardTtl(120_000);
    await first.dispose();

    // 模拟重启：同一份 storage，新的 client 实例。
    const clipboard = new FakeClipboardPort();
    const second = createClient(storage, clipboard);
    await second.unlock(MASTER);

    const receipt = await second.copyPassword(seeded.id);
    expect(receipt.ttlMs).toBe(120_000);
    expect(receipt.expiresAt).toBe(START + 120_000);
    expect(clipboard.value).toBe('November-Oscar-1122');
  });

  it('未改过 TTL 时仍是默认 30 秒', async () => {
    const storage = new MemoryVaultStorage();
    const first = createClient(storage, new FakeClipboardPort());
    await first.initialize({ masterPassword: MASTER });
    const seeded = await first.createItem({
      title: '团队邮箱',
      username: 'team-kilo',
      password: 'November-Oscar-1122',
    });
    await first.dispose();

    const second = createClient(storage, new FakeClipboardPort());
    await second.unlock(MASTER);
    const receipt = await second.copyPassword(seeded.id);
    expect(receipt.ttlMs).toBe(30_000);
  });

  it('非法 TTL 被拒绝，且不会写坏已有配置', async () => {
    const storage = new MemoryVaultStorage();
    const client = createClient(storage, new FakeClipboardPort());
    await client.initialize({ masterPassword: MASTER });

    // `0` 现在是合法的「关闭自动清理」档（PRD FR-05），不再视为非法；
    // 真正要拒的是负数、NaN 与越界值（低于 10s / 高于 120s）。
    await expectCode(client.setClipboardTtl(Number.NaN), 'VALIDATION_FAILED');
    await expectCode(client.setClipboardTtl(-1), 'VALIDATION_FAILED');
    await expectCode(client.setClipboardTtl(5_000), 'VALIDATION_FAILED');
    await expectCode(client.setClipboardTtl(121_000), 'VALIDATION_FAILED');

    const seeded = await client.createItem({
      title: '团队邮箱',
      username: 'team-kilo',
      password: 'November-Oscar-1122',
    });
    const receipt = await client.copyPassword(seeded.id);
    expect(receipt.ttlMs).toBe(30_000);
  });
});

describe('清空全部数据 · 必须处于解锁态', () => {
  it('锁定态调用 resetVault 被拒绝，数据完好', async () => {
    const storage = new MemoryVaultStorage();
    const client = createClient(storage, new FakeClipboardPort());
    await client.initialize({ masterPassword: MASTER });
    await client.createItem({
      title: '团队邮箱',
      username: 'team-kilo',
      password: 'November-Oscar-1122',
    });

    await client.lock('manual');
    await expectCode(client.resetVault(), 'VAULT_LOCKED');

    // 重新解锁后数据仍在：锁定态的破坏性调用必须零副作用。
    await client.unlock(MASTER);
    const list = await client.listItems();
    expect(list.map((item) => item.title)).toEqual(['团队邮箱']);
    expect((await client.status()).status).toBe('unlocked');
  });

  it('冷却态调用 resetVault 同样被拒绝', async () => {
    const storage = new MemoryVaultStorage();
    const client = createClient(storage, new FakeClipboardPort());
    await client.initialize({ masterPassword: MASTER });
    await client.lock('manual');

    await expectCode(client.resetVault(), 'VAULT_LOCKED');
    expect((await client.status()).status).toBe('locked');
  });

  it('解锁态可以清空，并回到未初始化', async () => {
    const storage = new MemoryVaultStorage();
    const client = createClient(storage, new FakeClipboardPort());
    await client.initialize({ masterPassword: MASTER });
    await client.createItem({
      title: '团队邮箱',
      username: 'team-kilo',
      password: 'November-Oscar-1122',
    });

    await client.resetVault();
    expect((await client.status()).status).toBe('uninitialized');
    expect(await client.getPasswordHint()).toBeNull();
  });
});

describe('allowHidden 语义 · 只对 hidden 资产要求授权', () => {
  it('普通卡片传 allowHidden: true 不需要授权', async () => {
    const client = createClient(new MemoryVaultStorage(), new FakeClipboardPort());
    await client.initialize({ masterPassword: MASTER });
    const normal = await client.createItem({
      title: '团队邮箱',
      username: 'team-kilo',
      password: 'November-Oscar-1122',
      visibility: 'normal',
    });

    const detail = await client.getItem(normal.id, { allowHidden: true });
    expect(detail.title).toBe('团队邮箱');
    expect(detail.visibility).toBe('normal');

    const revealed = await client.revealPassword(normal.id, { allowHidden: true });
    expect(revealed).toBe('November-Oscar-1122');

    const receipt = await client.copyUsername(normal.id, { allowHidden: true });
    expect(receipt.field).toBe('username');
  });

  it('hidden 卡片传 allowHidden: true 仍然需要授权', async () => {
    const client = createClient(new MemoryVaultStorage(), new FakeClipboardPort());
    await client.initialize({ masterPassword: MASTER });
    const hidden = await client.createItem({
      title: '内网跳板机',
      username: 'ops-kilo',
      password: 'Papa-Quebec-3344',
      visibility: 'hidden',
    });

    await expectCode(client.getItem(hidden.id, { allowHidden: true }), 'ITEM_HIDDEN');
    await expectCode(client.revealPassword(hidden.id, { allowHidden: true }), 'ITEM_HIDDEN');
    await expectCode(client.copyPassword(hidden.id, { allowHidden: true }), 'ITEM_HIDDEN');

    await client.requestHiddenAccess(MASTER);
    const detail = await client.getItem(hidden.id, { allowHidden: true });
    expect(detail.visibility).toBe('hidden');
    expect(await client.revealPassword(hidden.id, { allowHidden: true })).toBe('Papa-Quebec-3344');
  });

  it('不存在的 id 依然报 ITEM_NOT_FOUND（不因 allowHidden 变成 ITEM_HIDDEN）', async () => {
    const client = createClient(new MemoryVaultStorage(), new FakeClipboardPort());
    await client.initialize({ masterPassword: MASTER });

    await expectCode(client.getItem(9999, { allowHidden: true }), 'ITEM_NOT_FOUND');
  });
});
