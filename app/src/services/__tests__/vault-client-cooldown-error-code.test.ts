/**
 * 冷却期错误码回归（存量缺陷修复：`requireItemService()` 统一分辨状态）。
 *
 * 背景：连续输错主密码进入冷却后，会话被强制锁定（DEK 已清）。此前
 * `requireItemService()` 把 `session.status()` 的返回值丢掉、只看到
 * `itemService === null` 就报 `VAULT_LOCKED`——用户该看到"请 N 秒后再试"，
 * 实际看到"已锁定"，而解锁在冷却期同样被拒，提示会把用户带进死胡同。
 * 批量删除修过一次（在各路径抄前置判断），但 update/delete/favorite/
 * visibility 四条路径漂移在外，仍是旧行为。
 *
 * 本文件的契约：
 * 1. 冷却期内**所有**资产路径都报 `AUTH_COOLDOWN`，不是 `VAULT_LOCKED`；
 * 2. 冷却期内任何写路径都不能真正改动数据（先拒后做，不是做一半再拒）；
 * 3. 不过度矫正：普通锁定态（无冷却）仍然报 `VAULT_LOCKED`。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { AppError } from '../../core/errors';
import { COOLDOWN_BASE_MS, MAX_FAILED_ATTEMPTS } from '../../core/vault/session';
import { createVaultClient, type VaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';

const NOW = 1_700_000_000_000;
const MASTER = 'Alpha-Bravo-7788';
const WRONG = 'Charlie-Delta-9900';

/** 断言 Promise 抛出指定错误码。 */
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

interface Harness {
  client: VaultClient;
  itemId: number;
  advance: (ms: number) => void;
}

/** 建库、解锁、造一张卡片。 */
async function createHarness(): Promise<Harness> {
  let now = NOW;
  const client = createVaultClient({
    storage: new MemoryVaultStorage(),
    now: () => now,
    clipboard: new FakeClipboardPort(),
    autoLockPolicy: '30m',
    clipboardTtlMs: 30 * 1000,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
  });
  await client.initialize({ masterPassword: MASTER });
  const item = await client.createItem({
    title: '冷却回归卡片',
    username: 'cooldown@example.test',
    password: 'Value-Cooldown-1',
  });
  return {
    client,
    itemId: item.id,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** 用错误的隐藏授权申请把会话打进冷却（不改变会话解锁状态之外的 anything）。 */
async function enterCooldown(client: VaultClient): Promise<void> {
  for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
    await expectCode(client.requestHiddenAccess(WRONG), 'AUTH_INVALID');
  }
  expect((await client.status()).status).toBe('cooling_down');
}

describe('VaultClient · 冷却期错误码（存量缺陷回归）', () => {
  it('冷却期内所有资产路径都报 AUTH_COOLDOWN，不是 VAULT_LOCKED', async () => {
    const { client, itemId } = await createHarness();
    await enterCooldown(client);

    await expectCode(client.listItems(), 'AUTH_COOLDOWN');
    await expectCode(client.searchItems({}), 'AUTH_COOLDOWN');
    await expectCode(client.getRecentItems(), 'AUTH_COOLDOWN');
    await expectCode(client.getItem(itemId), 'AUTH_COOLDOWN');
    await expectCode(client.createItem({ title: 'x', username: 'y', password: 'z' }), 'AUTH_COOLDOWN');
    await expectCode(client.updateItem(itemId, { title: '被篡改' }), 'AUTH_COOLDOWN');
    await expectCode(client.deleteItem(itemId), 'AUTH_COOLDOWN');
    await expectCode(client.setFavorite(itemId, true), 'AUTH_COOLDOWN');
    await expectCode(client.setVisibility(itemId, 'hidden'), 'AUTH_COOLDOWN');
    await expectCode(client.copyPassword(itemId), 'AUTH_COOLDOWN');
    await expectCode(client.deleteItems([itemId], MASTER), 'AUTH_COOLDOWN');
  });

  it('冷却期内的写入一张都没生效：等冷却过去再解锁，数据原样', async () => {
    const { client, itemId, advance } = await createHarness();
    await enterCooldown(client);

    // 逐个尝试改动/删除，全部应被冷却拒绝。
    await expectCode(client.updateItem(itemId, { title: '被篡改' }), 'AUTH_COOLDOWN');
    await expectCode(client.setFavorite(itemId, true), 'AUTH_COOLDOWN');
    await expectCode(client.setVisibility(itemId, 'hidden'), 'AUTH_COOLDOWN');
    await expectCode(client.deleteItem(itemId), 'AUTH_COOLDOWN');

    // 冷却期会话是锁着的，此刻读列表本来就会报错，不能用来验数据——
    // 必须等冷却过去、用正确密码解锁后再验（这与批量删除测试踩过同一个坑）。
    advance(COOLDOWN_BASE_MS + 1_000);
    await client.unlock(MASTER);

    const items = await client.listItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(itemId);
    expect(items[0].title).toBe('冷却回归卡片');
    expect(items[0].favorite).toBe(false);
    expect(items[0].visibility).toBe('normal');
  });

  it('不过度矫正：普通锁定态（无冷却）仍然报 VAULT_LOCKED', async () => {
    const { client, itemId } = await createHarness();

    await client.lock('manual');
    await expectCode(client.listItems(), 'VAULT_LOCKED');
    await expectCode(client.updateItem(itemId, { title: 'x' }), 'VAULT_LOCKED');
    await expectCode(client.setFavorite(itemId, true), 'VAULT_LOCKED');

    // 解锁后恢复正常，没有被冷却逻辑误伤。
    await client.unlock(MASTER);
    expect(await client.listItems()).toHaveLength(1);
  });
});
