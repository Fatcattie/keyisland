/**
 * 遮罩（`masked`）可见性档位的安全守卫。
 *
 * 复用 `requestHiddenAccess`（主密码验证 → 120s 授权）作为"显示账密"的开关：
 * - `masked` 卡片留在普通列表（不像 `hidden` 那样被排除）；
 * - 但复制 / 预览 / 读详情 / 改可见性（含 masked → normal）都需要有效授权，
 *   否则抛 `ITEM_HIDDEN`；
 * - 授权过期后守卫重新生效。
 *
 * 同时覆盖需求 1 的边界：会话锁定后（DEK 已擦除）复制普通卡片抛 `VAULT_LOCKED`。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';
import { AppError } from '../../core/errors';
import type { VaultClient } from '../vault-client';

const MASTER_PASSWORD = 'Test-Master-Password-9';

/** 可注入时钟。 */
function createClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_000;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

async function boot(): Promise<{ client: VaultClient; clock: ReturnType<typeof createClock> }> {
  const clock = createClock();
  const client = createVaultClient({
    storage: new MemoryVaultStorage(),
    now: clock.now,
    clipboard: new FakeClipboardPort(),
  });
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  await client.unlock(MASTER_PASSWORD);
  return { client, clock };
}

let client: VaultClient;
let clock: ReturnType<typeof createClock>;

beforeEach(async () => {
  const ctx = await boot();
  client = ctx.client;
  clock = ctx.clock;
});

afterEach(async () => {
  await client.dispose().catch(() => {});
});

describe('遮罩卡片 · 列表包含与守卫', () => {
  it('masked 卡片出现在普通列表（不像 hidden 那样被排除）', async () => {
    const masked = await client.createItem({
      title: '遮罩卡',
      username: 'alice',
      password: 's3cret',
      visibility: 'masked',
    });
    const list = await client.listItems({});
    expect(list.some((item) => item.id === masked.id)).toBe(true);
  });

  it('未授权时复制遮罩卡密码抛 ITEM_HIDDEN', async () => {
    const masked = await client.createItem({
      title: '遮罩卡',
      username: 'alice',
      password: 's3cret',
      visibility: 'masked',
    });
    await expect(client.copyPassword(masked.id)).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.code === 'ITEM_HIDDEN',
    );
  });

  it('未授权时预览遮罩卡密码抛 ITEM_HIDDEN', async () => {
    const masked = await client.createItem({
      title: '遮罩卡',
      username: 'alice',
      password: 's3cret',
      visibility: 'masked',
    });
    await expect(client.revealPassword(masked.id)).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.code === 'ITEM_HIDDEN',
    );
  });

  it('未授权时读取遮罩卡详情抛 ITEM_HIDDEN', async () => {
    const masked = await client.createItem({
      title: '遮罩卡',
      username: 'alice',
      password: 's3cret',
      visibility: 'masked',
    });
    await expect(client.getItem(masked.id)).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.code === 'ITEM_HIDDEN',
    );
  });

  it('未授权时将 masked 改为 normal 抛 ITEM_HIDDEN（防止单方面解除保护）', async () => {
    const masked = await client.createItem({
      title: '遮罩卡',
      username: 'alice',
      password: 's3cret',
      visibility: 'masked',
    });
    await expect(client.setVisibility(masked.id, 'normal')).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.code === 'ITEM_HIDDEN',
    );
  });

  it('授权后复制 / 预览 / 读详情 / 改可见性均放行', async () => {
    const masked = await client.createItem({
      title: '遮罩卡',
      username: 'alice',
      password: 's3cret',
      visibility: 'masked',
    });
    await client.requestHiddenAccess(MASTER_PASSWORD);

    const receipt = await client.copyPassword(masked.id);
    expect(receipt.field).toBe('password');

    const plain = await client.revealPassword(masked.id);
    expect(plain).toBe('s3cret');

    const detail = await client.getItem(masked.id);
    expect(detail.username).toBe('alice');

    const summary = await client.setVisibility(masked.id, 'normal');
    expect(summary.visibility).toBe('normal');
  });

  it('授权过期后守卫重新生效', async () => {
    const masked = await client.createItem({
      title: '遮罩卡',
      username: 'alice',
      password: 's3cret',
      visibility: 'masked',
    });
    const grant = await client.requestHiddenAccess(MASTER_PASSWORD);
    expect(await client.revealPassword(masked.id)).toBe('s3cret');

    // 推进时钟越过授权窗口。
    clock.advance(grant.grantedUntil - clock.now() + 1);
    await expect(client.revealPassword(masked.id)).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.code === 'ITEM_HIDDEN',
    );
  });

  it('快照暴露 hiddenAccessUntil，授权后非零、过期后回 null', async () => {
    await client.requestHiddenAccess(MASTER_PASSWORD);
    expect((await client.status()).hiddenAccessUntil).not.toBeNull();

    clock.advance(120_000 + 1);
    expect((await client.status()).hiddenAccessUntil).toBeNull();
  });
});

describe('需求 1 · 锁定后禁止复制 / 存储', () => {
  it('会话锁定后复制普通卡片抛 VAULT_LOCKED（DEK 已擦除）', async () => {
    const normal = await client.createItem({
      title: '普通卡',
      username: 'bob',
      password: 'pw',
    });
    await client.lock('manual');
    await expect(client.copyPassword(normal.id)).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.code === 'VAULT_LOCKED',
    );
  });

  it('锁定后创建卡片抛 VAULT_LOCKED', async () => {
    await client.lock('manual');
    await expect(
      client.createItem({ title: 'x', username: 'u', password: 'p' }),
    ).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.code === 'VAULT_LOCKED',
    );
  });
});

describe('遮罩卡片 · 账号不在列表与搜索中泄露', () => {
  it('未授权时列表不含 masked 账号，按账号搜索也搜不到', async () => {
    const { client } = await boot();
    const masked = await client.createItem({
      title: '遮罩泄露检查',
      username: 'leak_probe_user',
      password: 'probe-pass',
      visibility: 'masked',
    });

    const list = await client.listItems({});
    const found = list.find((item) => item.id === masked.id);
    expect(found).toBeDefined();
    // 数据层不携带账号，避免 devtools / props 读取。
    expect(found?.username).toBeUndefined();

    // 搜索层同样不能命中：否则搜账号看卡片是否出现即可反推。
    const searched = await client.listItems({ text: 'leak_probe_user' });
    expect(searched.some((item) => item.id === masked.id)).toBe(false);

    await client.dispose().catch(() => {});
  });

  it('授权后列表恢复 masked 账号，且可按账号搜索', async () => {
    const { client } = await boot();
    const masked = await client.createItem({
      title: '遮罩恢复检查',
      username: 'restore_probe_user',
      password: 'probe-pass',
      visibility: 'masked',
    });

    await client.requestHiddenAccess(MASTER_PASSWORD);
    const list = await client.listItems({});
    const found = list.find((item) => item.id === masked.id);
    expect(found?.username).toBe('restore_probe_user');

    const searched = await client.listItems({ text: 'restore_probe_user' });
    expect(searched.some((item) => item.id === masked.id)).toBe(true);

    await client.dispose().catch(() => {});
  });
});

describe('遮罩卡片 · 最近使用不泄露账号', () => {
  it('未授权时最近使用不含 masked 账号；授权后恢复', async () => {
    const masked = await client.createItem({
      title: '最近使用泄露检查',
      username: 'recent_probe_user',
      password: 'probe-pass',
      visibility: 'masked',
    });

    // 授权后复制一次，令其进入"最近使用"。
    await client.requestHiddenAccess(MASTER_PASSWORD);
    await client.copyPassword(masked.id);

    // 授权过期：卡片仍应在最近使用里，但账号必须被抹掉。
    clock.advance(120_001);
    const recent = await client.getRecentItems();
    const found = recent.find((item) => item.id === masked.id);
    expect(found).toBeDefined();
    expect(found?.username).toBeUndefined();

    // 重新授权后恢复账号。
    await client.requestHiddenAccess(MASTER_PASSWORD);
    const recentAgain = await client.getRecentItems();
    expect(recentAgain.find((item) => item.id === masked.id)?.username).toBe('recent_probe_user');
  });
});

describe('遮罩卡片 · 收藏不要求重新验证', () => {
  it('未授权也能收藏 masked 卡片，且返回摘要不带账号', async () => {
    const masked = await client.createItem({
      title: '收藏检查',
      username: 'fav_probe_user',
      password: 'probe-pass',
      visibility: 'masked',
    });
    const updated = await client.setFavorite(masked.id, true);
    expect(updated.favorite).toBe(true);
    // 返回值同样不能带账号（否则收藏接口成了账号泄露旁路）。
    expect(updated.username).toBeUndefined();
  });
});
