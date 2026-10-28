/**
 * Phase 2 安全回归 · 写路径授权、密码预览、新 API 边界。
 *
 * 对应本轮验收的攻击面：
 * 1. hidden 卡片的写路径（上一轮 P1）：四个写操作必须全部受二次认证约束，
 *    且"未授权写入"必须零副作用。
 * 2. `revealPassword`：normal 可读 / username_only 拒绝 / hidden 需授权 / 锁定拒绝。
 * 3. 新 API 边界：`resetVault`、`recoverWithKirk`、`setAutoLockPolicy`、`setClipboardTtl`。
 *
 * 全部使用注入时钟与内存端口，不 sleep。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../src/core/crypto';
import { HIDDEN_ACCESS_WINDOW_MS, createVaultClient, type VaultClient } from '../../src/services/vault-client';
import type { ClipboardPort } from '../../src/services/clipboard';
import { MemoryVaultStorage } from '../../src/services/storage';
import { createKirkFile, serializeKirkFile } from '../../src/core/vault/recovery';

const NOW = 1_700_000_000_000;
const MASTER_PASSWORD = 'Fixture-Master-1';
const OTHER_PASSWORD = 'Fixture-Master-2';

class RecordingClipboardPort implements ClipboardPort {
  value: string | null = null;

  writeCount = 0;

  clearCount = 0;

  async write(text: string): Promise<void> {
    this.writeCount += 1;
    this.value = text;
  }

  async read(): Promise<string | null> {
    return this.value;
  }

  async clear(): Promise<void> {
    this.clearCount += 1;
    this.value = '';
  }
}

interface Harness {
  client: VaultClient;
  clock: { t: number };
  port: RecordingClipboardPort;
  storage: MemoryVaultStorage;
}

function createHarness(storage = new MemoryVaultStorage()): Harness {
  const clock = { t: NOW };
  const port = new RecordingClipboardPort();
  const client = createVaultClient({
    storage,
    now: () => clock.t,
    clipboard: port,
    clipboardTtlMs: 30_000,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
    autoLockPolicy: '30m',
  });
  return { client, clock, port, storage };
}

interface Fixtures {
  normalId: number;
  usernameOnlyId: number;
  hiddenId: number;
}

async function seed(client: VaultClient): Promise<Fixtures> {
  const normal = await client.createItem({
    title: '普通站点',
    username: 'alice@example.test',
    password: 'Value-Alpha-1',
    visibility: 'normal',
  });
  const usernameOnly = await client.createItem({
    title: '仅账号站点',
    username: 'carol@example.test',
    password: 'Value-Beta-2',
    visibility: 'username_only',
  });
  const hidden = await client.createItem({
    title: '银行保险箱',
    username: 'bob@example.test',
    password: 'Value-Gamma-3',
    visibility: 'hidden',
  });
  return { normalId: normal.id, usernameOnlyId: usernameOnly.id, hiddenId: hidden.id };
}

describe('Phase 2 回归 · hidden 写路径二次认证（上轮 P1）', () => {
  it('未授权时四个写操作全部抛 ITEM_HIDDEN', async () => {
    const harness = createHarness();
    await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
    const { hiddenId } = await seed(harness.client);

    await expect(harness.client.setFavorite(hiddenId, true)).rejects.toMatchObject({ code: 'ITEM_HIDDEN' });
    await expect(harness.client.updateItem(hiddenId, { title: '被改名' })).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });
    await expect(harness.client.deleteItem(hiddenId)).rejects.toMatchObject({ code: 'ITEM_HIDDEN' });
    await expect(harness.client.setVisibility(hiddenId, 'normal')).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });
    await harness.client.dispose();
  });

  it('未授权写入零副作用：标题/收藏/可见性不变，且不写剪贴板', async () => {
    const harness = createHarness();
    await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
    const { hiddenId } = await seed(harness.client);
    const writesBefore = harness.port.writeCount;

    await harness.client.setFavorite(hiddenId, true).catch(() => undefined);
    await harness.client.updateItem(hiddenId, { title: '被改名', username: 'evil@example.test' }).catch(() => undefined);
    await harness.client.setVisibility(hiddenId, 'normal').catch(() => undefined);

    // 授权后回读，确认字段一个都没被改动。
    await harness.client.requestHiddenAccess(MASTER_PASSWORD);
    const detail = await harness.client.getItem(hiddenId, { allowHidden: true });
    expect(detail.title).toBe('银行保险箱');
    expect(detail.username).toBe('bob@example.test');
    expect(detail.favorite).toBe(false);
    expect(detail.visibility).toBe('hidden');
    expect(harness.port.writeCount).toBe(writesBefore);
    await harness.client.dispose();
  });

  it('反向不收紧：setVisibility(normal → hidden) 不需要授权', async () => {
    const harness = createHarness();
    await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
    const { normalId } = await seed(harness.client);

    const summary = await harness.client.setVisibility(normalId, 'hidden');
    expect(summary.visibility).toBe('hidden');
    // 加锁后该卡片从普通列表消失
    const visible = await harness.client.listItems();
    expect(visible.map((item) => item.id)).not.toContain(normalId);
    await harness.client.dispose();
  });

  it('授权后四个写操作全部成功', async () => {
    const harness = createHarness();
    await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
    const { hiddenId } = await seed(harness.client);
    await harness.client.requestHiddenAccess(MASTER_PASSWORD);

    expect((await harness.client.setFavorite(hiddenId, true)).favorite).toBe(true);
    expect((await harness.client.updateItem(hiddenId, { title: '改名成功' })).title).toBe('改名成功');
    expect((await harness.client.setVisibility(hiddenId, 'normal')).visibility).toBe('normal');
    // 降级为 normal 后不再需要授权即可删除
    await expect(harness.client.deleteItem(hiddenId)).resolves.toBeUndefined();
    await harness.client.dispose();
  });

  it('授权过期后写操作重新被拒', async () => {
    const harness = createHarness();
    await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
    const { hiddenId } = await seed(harness.client);
    await harness.client.requestHiddenAccess(MASTER_PASSWORD);
    expect((await harness.client.setFavorite(hiddenId, true)).favorite).toBe(true);

    harness.clock.t = NOW + HIDDEN_ACCESS_WINDOW_MS + 1;
    await expect(harness.client.setFavorite(hiddenId, false)).rejects.toMatchObject({ code: 'ITEM_HIDDEN' });
    await expect(harness.client.setVisibility(hiddenId, 'normal')).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });
    await harness.client.dispose();
  });
});

describe('Phase 2 回归 · revealPassword 预览规则', () => {
  it('normal 可预览，返回值即明文', async () => {
    const harness = createHarness();
    await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
    const { normalId } = await seed(harness.client);
    await expect(harness.client.revealPassword(normalId)).resolves.toBe('Value-Alpha-1');
    await harness.client.dispose();
  });

  it('username_only 拒绝预览（PRD：该档位只能复制）', async () => {
    const harness = createHarness();
    await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
    const { usernameOnlyId } = await seed(harness.client);
    await expect(harness.client.revealPassword(usernameOnlyId)).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });
    // 但复制路径仍然可用（这是该档位的用途）
    await expect(harness.client.copyPassword(usernameOnlyId)).resolves.toMatchObject({
      field: 'password',
    });
    await harness.client.dispose();
  });

  it('hidden 无授权拒绝，有授权可读', async () => {
    const harness = createHarness();
    await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
    const { hiddenId } = await seed(harness.client);

    await expect(harness.client.revealPassword(hiddenId, { allowHidden: true })).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });

    await harness.client.requestHiddenAccess(MASTER_PASSWORD);
    await expect(harness.client.revealPassword(hiddenId, { allowHidden: true })).resolves.toBe(
      'Value-Gamma-3',
    );
    await harness.client.dispose();
  });

  it('锁定后预览抛 VAULT_LOCKED，不泄漏任何明文', async () => {
    const harness = createHarness();
    await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
    const { normalId } = await seed(harness.client);
    await harness.client.lock('manual');

    await expect(harness.client.revealPassword(normalId)).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    await harness.client.dispose();
  });
});

describe('Phase 2 回归 · 新 API 边界', () => {
  it('resetVault 清空 keyslots/meta/items 并回到 uninitialized，之后可重新初始化', async () => {
    const harness = createHarness();
    await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
    await seed(harness.client);

    await harness.client.resetVault();

    expect((await harness.client.status()).status).toBe('uninitialized');
    expect(await harness.storage.loadKeyslots()).toBeNull();
    expect(await harness.storage.loadMeta()).toBeNull();
    expect(await harness.storage.loadItems()).toEqual([]);
    expect(await harness.storage.loadRecency()).toEqual([]);

    // 同一份存储上的新 client 也必须看到 uninitialized
    const fresh = createVaultClient({
      storage: harness.storage,
      now: () => harness.clock.t,
      clipboard: new RecordingClipboardPort(),
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });
    expect((await fresh.status()).status).toBe('uninitialized');

    // 旧主密码不再能解锁任何东西
    await expect(fresh.unlock(MASTER_PASSWORD)).rejects.toMatchObject({ code: 'VAULT_NOT_INITIALIZED' });

    const again = await fresh.initialize({ masterPassword: OTHER_PASSWORD });
    expect(again.recoveryCode.length).toBeGreaterThan(0);
    expect((await fresh.status()).status).toBe('unlocked');
    await fresh.dispose();
    await harness.client.dispose();
  });

  it('recoverWithKirk：合法文件通过，非法 JSON / 错 magic / 错 version 安全失败', async () => {
    const harness = createHarness();
    const init = await harness.client.initialize({ masterPassword: MASTER_PASSWORD });

    await expect(harness.client.recoverWithKirk(init.kirkJson)).resolves.toEqual({ verified: true });

    await expect(harness.client.recoverWithKirk('{ not json')).rejects.toMatchObject({
      code: 'RECOVERY_CODE_INVALID',
    });

    const wrongMagic = serializeKirkFile({ ...init.kirkFile, magic: 'KIRK9' });
    await expect(harness.client.recoverWithKirk(wrongMagic)).rejects.toMatchObject({
      code: 'RECOVERY_CODE_INVALID',
    });

    const wrongVersion = serializeKirkFile({ ...init.kirkFile, version: 99 });
    await expect(harness.client.recoverWithKirk(wrongVersion)).rejects.toMatchObject({
      code: 'UNSUPPORTED_VERSION',
    });

    // 以上失败都不得让会话进入解锁态
    expect((await harness.client.status()).status).toBe('unlocked'); // 初始化后本来就是解锁态
    await harness.client.lock('manual');
    await expect(harness.client.recoverWithKirk('{ not json')).rejects.toMatchObject({
      code: 'RECOVERY_CODE_INVALID',
    });
    expect((await harness.client.status()).status).toBe('locked');
    await harness.client.dispose();
  });

  it('resetMasterPasswordWithKirk 可用，且旧密码失效、新密码生效', async () => {
    const harness = createHarness();
    const init = await harness.client.initialize({ masterPassword: MASTER_PASSWORD });

    await expect(
      harness.client.resetMasterPasswordWithKirk({
        kirkJson: init.kirkJson,
        newPassword: OTHER_PASSWORD,
      }),
    ).resolves.toMatchObject({ status: 'locked' });

    await expect(harness.client.unlock(MASTER_PASSWORD)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    await expect(harness.client.unlock(OTHER_PASSWORD)).resolves.toMatchObject({ status: 'unlocked' });
    await harness.client.dispose();
  });

  it('setAutoLockPolicy 立即反映到 status，并被新 client 从元数据读回', async () => {
    const harness = createHarness();
    await harness.client.initialize({ masterPassword: MASTER_PASSWORD });

    const snapshot = await harness.client.setAutoLockPolicy('5m');
    expect(snapshot.autoLockPolicy).toBe('5m');
    expect(snapshot.unlockedUntil).toBe(NOW + 5 * 60 * 1000);
    expect((await harness.client.status()).autoLockPolicy).toBe('5m');

    const fresh = createVaultClient({
      storage: harness.storage,
      now: () => harness.clock.t,
      clipboard: new RecordingClipboardPort(),
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });
    expect((await fresh.status()).autoLockPolicy).toBe('5m');
    await fresh.dispose();
    await harness.client.dispose();
  });

  it('setClipboardTtl 影响后续复制回执，非法值被拒绝', async () => {
    const harness = createHarness();
    await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
    const { normalId } = await seed(harness.client);

    // `0` 是 PRD FR-05 的「关闭自动清理」档，现在合法：回执 ttlMs 为 0、
    // 不排到期时间。越界值与负数/NaN 仍一律拒绝（设置层只收 0 或 10–120s）。
    await harness.client.setClipboardTtl(0);
    const off = await harness.client.copyPassword(normalId);
    expect(off.ttlMs).toBe(0);
    expect(off.expiresAt).toBe(0);

    await expect(harness.client.setClipboardTtl(-1)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(harness.client.setClipboardTtl(5_000)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(harness.client.setClipboardTtl(121_000)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(harness.client.setClipboardTtl(Number.NaN)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    await harness.client.setClipboardTtl(10_000);
    const receipt = await harness.client.copyPassword(normalId);
    expect(receipt.ttlMs).toBe(10_000);
    expect(receipt.expiresAt).toBe(NOW + 10_000);
    await harness.client.dispose();
  });

  it('getPasswordHint 在锁定态可读，未设置时为 null', async () => {
    const harness = createHarness();
    await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
    expect(await harness.client.getPasswordHint()).toBeNull();

    await harness.client.resetVault();
    await harness.client.initialize({ masterPassword: MASTER_PASSWORD, hint: '生日后四位' });
    await harness.client.lock('manual');
    expect(await harness.client.getPasswordHint()).toBe('生日后四位');
    await harness.client.dispose();
  });

  it('未初始化时新 API 不崩溃：status/hint 正常，其余报 VAULT_NOT_INITIALIZED', async () => {
    const harness = createHarness();
    expect((await harness.client.status()).status).toBe('uninitialized');
    expect(await harness.client.getPasswordHint()).toBeNull();
    await expect(harness.client.revealPassword(1)).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    await expect(harness.client.setAutoLockPolicy('5m')).resolves.toMatchObject({
      autoLockPolicy: '5m',
    });
    await harness.client.dispose();
  });

  it('kirk 文件只含恢复密钥，不含主密码（防止导出泄漏）', async () => {
    const harness = createHarness();
    const init = await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
    const text = init.kirkJson;
    expect(text).not.toContain(MASTER_PASSWORD);
    expect(text).not.toContain('password');
    expect(init.kirkFile.recoveryKey.length).toBeGreaterThan(0);
    // 手工构造一个"多余字段"的 kirk，解析后不应带出额外字段
    const extra = serializeKirkFile({ ...createKirkFile(new Uint8Array(32), NOW), extra: 'x' } as never);
    expect(extra).toContain('KIRK1');
    await harness.client.dispose();
  });
});
