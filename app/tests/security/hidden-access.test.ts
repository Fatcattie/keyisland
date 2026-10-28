/**
 * 对抗性验收 · 隐藏卡片二次认证（P2-2 回归）。
 *
 * 攻击面：`VaultClient.requestHiddenAccess()` 是 Phase 1 新增的**唯一**特权入口，
 * 它同时触碰三条敏感链路——主密码校验、失败计数/冷却、授权窗口。
 * 任何一条被绕过，`hidden` 档位就退化成"藏起来但谁都能看"。
 *
 * 本文件只使用注入时钟与内存端口，不 sleep、不依赖真实时间。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../src/core/crypto';
import { MAX_FAILED_ATTEMPTS } from '../../src/core/vault/session';
import type { ClipboardPort } from '../../src/services/clipboard';
import { MemoryVaultStorage } from '../../src/services/storage';
import {
  HIDDEN_ACCESS_WINDOW_MS,
  createVaultClient,
  type VaultClient,
} from '../../src/services/vault-client';

/** 固定时钟起点。 */
const NOW = 1_700_000_000_000;

/** 主密码夹具（与其它安全用例保持一致的测试值）。 */
const MASTER_PASSWORD = 'Fixture-Master-1';

/** 错误密码夹具。 */
const WRONG_PASSWORD = 'Fixture-Wrong-Pass';

/** 记录写入/清空次数的剪贴板端口。 */
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

/** 创建门面 + 可拨动时钟 + 可观测剪贴板。 */
function createHarness(options: { autoLockPolicy?: 'immediate' | '5m' | '30m' | '4h' | 'boot' } = {}): Harness {
  const clock = { t: NOW };
  const port = new RecordingClipboardPort();
  const storage = new MemoryVaultStorage();
  const client = createVaultClient({
    storage,
    now: () => clock.t,
    clipboard: port,
    clipboardTtlMs: 30_000,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
    autoLockPolicy: options.autoLockPolicy ?? '30m',
  });
  return { client, clock, port, storage };
}

/** 初始化并返回一张 hidden 卡片 id。 */
async function setupHiddenItem(harness: Harness): Promise<number> {
  await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
  const created = await harness.client.createItem({
    title: '隐藏站点',
    username: 'bob@example.test',
    password: 'Hidden-Pass-1!',
    visibility: 'hidden',
  });
  return created.id;
}

describe('对抗性 · 隐藏卡片授权入口 requestHiddenAccess', () => {
  it('未解锁时调用：VAULT_LOCKED，且不会留下任何授权', async () => {
    const harness = createHarness();
    const hiddenId = await setupHiddenItem(harness);
    await harness.client.lock('manual');

    await expect(harness.client.requestHiddenAccess(MASTER_PASSWORD)).rejects.toMatchObject({
      code: 'VAULT_LOCKED',
    });

    // 重新解锁后仍然没有授权：说明失败调用没有"预授权"任何东西。
    await harness.client.unlock(MASTER_PASSWORD);
    await expect(harness.client.getItem(hiddenId, { allowHidden: true })).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });
    await harness.client.dispose();
  });

  it('冷却期内调用：AUTH_COOLDOWN，不能借二次认证通道绕过冷却', async () => {
    const harness = createHarness();
    await setupHiddenItem(harness);

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await expect(harness.client.unlock(WRONG_PASSWORD)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    }
    expect((await harness.client.status()).status).toBe('cooling_down');

    // 关键：即便密码正确，冷却窗口内也必须被挡在 AUTH_COOLDOWN，而不是 AUTH_INVALID/VAULT_LOCKED。
    await expect(harness.client.requestHiddenAccess(MASTER_PASSWORD)).rejects.toMatchObject({
      code: 'AUTH_COOLDOWN',
    });
    await harness.client.dispose();
  });

  it('错误密码调用：AUTH_INVALID，不授权，且与解锁共用失败计数（第 5 次进入冷却）', async () => {
    const harness = createHarness();
    await setupHiddenItem(harness);

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS - 1; attempt += 1) {
      await expect(harness.client.requestHiddenAccess(WRONG_PASSWORD)).rejects.toMatchObject({
        code: 'AUTH_INVALID',
      });
    }

    // 4 次失败后：会话仍解锁（未到阈值），但没有任何授权。
    const beforeLast = await harness.client.status();
    expect(beforeLast.status).toBe('unlocked');
    expect(beforeLast.passwordFailures).toBe(MAX_FAILED_ATTEMPTS - 1);
    await expect(harness.client.listItems({ includeHidden: true })).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });

    // 第 5 次：必须触发冷却（证明失败被计入同一份计数，而不是被"静默吞掉"）。
    await expect(harness.client.requestHiddenAccess(WRONG_PASSWORD)).rejects.toMatchObject({
      code: 'AUTH_INVALID',
    });
    expect((await harness.client.status()).status).toBe('cooling_down');
    await harness.client.dispose();
  });

  it('授权窗口边界：119_999ms 仍有效，120_001ms 失效', async () => {
    const harness = createHarness();
    const hiddenId = await setupHiddenItem(harness);

    const grant = await harness.client.requestHiddenAccess(MASTER_PASSWORD);
    expect(grant.grantedUntil).toBe(NOW + HIDDEN_ACCESS_WINDOW_MS);

    harness.clock.t = NOW + 119_999;
    await expect(harness.client.getItem(hiddenId, { allowHidden: true })).resolves.toMatchObject({
      id: hiddenId,
    });

    harness.clock.t = NOW + 120_001;
    await expect(harness.client.getItem(hiddenId, { allowHidden: true })).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });
    await harness.client.dispose();
  });

  it('手动锁定后授权立即失效，重新解锁不会复活旧授权', async () => {
    const harness = createHarness();
    const hiddenId = await setupHiddenItem(harness);
    await harness.client.requestHiddenAccess(MASTER_PASSWORD);
    await expect(harness.client.getItem(hiddenId, { allowHidden: true })).resolves.toMatchObject({
      id: hiddenId,
    });

    await harness.client.lock('manual');
    await harness.client.unlock(MASTER_PASSWORD);
    await expect(harness.client.getItem(hiddenId, { allowHidden: true })).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });
    await harness.client.dispose();
  });

  it('超时自动锁定后授权失效（锁定由 status 触发，不靠定时器）', async () => {
    const harness = createHarness({ autoLockPolicy: '5m' });
    const hiddenId = await setupHiddenItem(harness);
    await harness.client.requestHiddenAccess(MASTER_PASSWORD);

    harness.clock.t = NOW + 5 * 60 * 1000 + 1;
    // 超时先让会话落锁，因此这一枪打中的是 VAULT_LOCKED —— 比 ITEM_HIDDEN 更严格，同样算失败。
    await expect(harness.client.getItem(hiddenId, { allowHidden: true })).rejects.toMatchObject({
      code: 'VAULT_LOCKED',
    });

    await harness.client.unlock(MASTER_PASSWORD);
    await expect(harness.client.getItem(hiddenId, { allowHidden: true })).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });
    await harness.client.dispose();
  });

  it('allowHidden: true 但无授权抛 ITEM_HIDDEN；有授权才成功', async () => {
    const harness = createHarness();
    const hiddenId = await setupHiddenItem(harness);

    await expect(harness.client.getItem(hiddenId, { allowHidden: true })).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });

    await harness.client.requestHiddenAccess(MASTER_PASSWORD);
    const detail = await harness.client.getItem(hiddenId, { allowHidden: true });
    expect(detail.id).toBe(hiddenId);
    expect(detail.visibility).toBe('hidden');
    await harness.client.dispose();
  });

  it('授权本身不等于"自动放行"：不传 allowHidden 时仍然抛 ITEM_HIDDEN', async () => {
    const harness = createHarness();
    const hiddenId = await setupHiddenItem(harness);
    await harness.client.requestHiddenAccess(MASTER_PASSWORD);

    await expect(harness.client.getItem(hiddenId)).rejects.toMatchObject({ code: 'ITEM_HIDDEN' });
    await expect(harness.client.copyPassword(hiddenId)).rejects.toMatchObject({ code: 'ITEM_HIDDEN' });
    await harness.client.dispose();
  });

  it('listItems({ includeHidden: true }) 在授权期外抛错，绝不静默返回空数组', async () => {
    const harness = createHarness();
    await setupHiddenItem(harness);

    // 反向断言：如果实现返回 []，调用方会把"没授权"误判成"没有隐藏卡片"。
    let returnedInsteadOfThrowing = false;
    try {
      const listed = await harness.client.listItems({ includeHidden: true });
      returnedInsteadOfThrowing = true;
      expect(listed).toEqual([]);
    } catch (error) {
      expect(error).toMatchObject({ code: 'ITEM_HIDDEN' });
    }
    expect(returnedInsteadOfThrowing).toBe(false);

    // 对照：普通列表无需授权即可读取。
    await expect(harness.client.listItems()).resolves.toEqual([]);
    await harness.client.dispose();
  });

  it('无授权复制 hidden 资产：抛 ITEM_HIDDEN 且一个字节都没写进剪贴板', async () => {
    const harness = createHarness();
    const hiddenId = await setupHiddenItem(harness);
    const writesBefore = harness.port.writeCount;

    await expect(harness.client.copyPassword(hiddenId, { allowHidden: true })).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });
    await expect(harness.client.copyUsername(hiddenId, { allowHidden: true })).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });

    expect(harness.port.writeCount).toBe(writesBefore);
    expect(harness.port.value).toBeNull();
    await harness.client.dispose();
  });

  it('授权不跨 dispose 存活：重建 client 必须重新认证', async () => {
    const storage = new MemoryVaultStorage();
    const clock = { t: NOW };
    const first = createVaultClient({
      storage,
      now: () => clock.t,
      clipboard: new RecordingClipboardPort(),
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });
    await first.initialize({ masterPassword: MASTER_PASSWORD });
    const created = await first.createItem({
      title: '隐藏站点',
      username: 'bob@example.test',
      password: 'Hidden-Pass-1!',
      visibility: 'hidden',
    });
    await first.requestHiddenAccess(MASTER_PASSWORD);
    await first.dispose();

    const second = createVaultClient({
      storage,
      now: () => clock.t,
      clipboard: new RecordingClipboardPort(),
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });
    await second.unlock(MASTER_PASSWORD);

    await expect(second.getItem(created.id, { allowHidden: true })).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });
    await second.dispose();
  });

  it('二次认证不改变会话状态：unlockedUntil 不被续期，也不写入新 DEK', async () => {
    const harness = createHarness();
    await setupHiddenItem(harness);
    const before = await harness.client.status();

    harness.clock.t = NOW + 60_000;
    await harness.client.requestHiddenAccess(MASTER_PASSWORD);
    const after = await harness.client.status();

    // 若 verifyPassword 误用了 adoptDek/touch，到期时间会被推后，这里就会失败。
    expect(after.unlockedUntil).toBe(before.unlockedUntil);
    expect(after.status).toBe('unlocked');
    await harness.client.dispose();
  });

  it('返回值与错误消息不泄漏主密码或派生密钥', async () => {
    const harness = createHarness();
    await setupHiddenItem(harness);

    const grant = await harness.client.requestHiddenAccess(MASTER_PASSWORD);
    expect(Object.keys(grant)).toEqual(['grantedUntil']);
    expect(JSON.stringify(grant)).not.toContain(MASTER_PASSWORD);

    let message = '';
    try {
      await harness.client.requestHiddenAccess(WRONG_PASSWORD);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(WRONG_PASSWORD);
    expect(message).not.toContain(MASTER_PASSWORD);
    await harness.client.dispose();
  });

  it('冷却到期后可以正常解锁并重新取得授权（P2-3 语义副作用回归）', async () => {
    const harness = createHarness();
    const hiddenId = await setupHiddenItem(harness);

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await expect(harness.client.unlock(WRONG_PASSWORD)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    }
    const cooling = await harness.client.status();
    expect(cooling.status).toBe('cooling_down');

    // 冷却到期：强制锁定不应把会话卡死在 cooling_down。
    harness.clock.t = NOW + (cooling.cooldownRemainingMs ?? 0) + 1;
    await expect(harness.client.unlock(MASTER_PASSWORD)).resolves.toMatchObject({ status: 'unlocked' });

    await harness.client.requestHiddenAccess(MASTER_PASSWORD);
    await expect(harness.client.getItem(hiddenId, { allowHidden: true })).resolves.toMatchObject({
      id: hiddenId,
    });
    await harness.client.dispose();
  });

  it('冷却强制锁定只清理一次剪贴板：onLock 不被重复触发', async () => {
    const harness = createHarness();
    await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
    const item = await harness.client.createItem({
      title: '普通站点',
      username: 'alice@example.test',
      password: 'Normal-Pass-1!',
      visibility: 'normal',
    });
    await harness.client.copyPassword(item.id);
    expect(harness.port.writeCount).toBe(1);

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await expect(harness.client.unlock(WRONG_PASSWORD)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    }

    // 第 5 次失败 → registerFailure → clearKeyMaterial('auth_cooldown') → onLock 一次。
    // 锁定清理是异步的，用一次 status() 把它结算掉（内部会 awaitLockCleanup）。
    expect((await harness.client.status()).status).toBe('cooling_down');
    // 若上层再补一次 cancelAll，这里就会变成 2。
    expect(harness.port.clearCount).toBe(1);
    expect(harness.port.value).toBe('');

    await harness.client.dispose();
    expect(harness.port.clearCount).toBe(1);
  });
});
