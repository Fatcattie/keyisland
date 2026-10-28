/**
 * 对抗性测试 · 剪贴板隔离与锁定清理（SDD §7.3 / §7.4）。
 *
 * 验证目标：
 * - 服务内部只保存内容摘要，不保存明文；
 * - 用户覆盖剪贴板后，到期清理必须"放弃"而不是误删用户内容；
 * - 连续两次复制各自独立结算，A 的清理不得误删 B；
 * - 锁定后所有资产接口返回 VAULT_LOCKED 且不产生任何剪贴板写入。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../src/core/crypto';
import { sha256Hex } from '../../src/core/crypto/digest';
import { ClipboardService, type ClipboardPort } from '../../src/services/clipboard';
import { MemoryVaultStorage } from '../../src/services/storage';
import { createVaultClient } from '../../src/services/vault-client';

const NOW = 1_700_000_000_000;
const MASTER_PASSWORD = 'Fixture-Master-1';

/** 可手动触发的调度器，避免依赖真实时钟。 */
function createScheduler() {
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  return {
    timers,
    schedule: (callback: () => void, delay: number): unknown => {
      timers.push({ callback, delay, cancelled: false });
      return timers.length - 1;
    },
    cancel: (handle: unknown): void => {
      const timer = timers[handle as number];
      if (timer) {
        timer.cancelled = true;
      }
    },
    async fire(index: number): Promise<void> {
      timers[index].callback();
    },
  };
}

/** 剪贴板替身：模拟真实系统剪贴板。 */
class FakeClipboardPort implements ClipboardPort {
  content: string | null = null;

  writeCount = 0;

  clearCount = 0;

  async write(text: string): Promise<void> {
    this.content = text;
    this.writeCount += 1;
  }

  async read(): Promise<string | null> {
    return this.content;
  }

  async clear(): Promise<void> {
    this.content = null;
    this.clearCount += 1;
  }
}

function createClipboardService() {
  const port = new FakeClipboardPort();
  const scheduler = createScheduler();
  const service = new ClipboardService({
    port,
    now: () => NOW,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    defaultTtlMs: 30_000,
  });
  return { port, scheduler, service };
}

describe('对抗性 · 剪贴板只存摘要', () => {
  it('内部只保留 SHA-256 摘要，不保留明文', async () => {
    const { service } = createClipboardService();
    const secret = 'Fixture-Pass-9!';
    const receipt = await service.copyWithTtl(secret, 5_000);

    const internals = service as unknown as {
      pending: Map<string, { digest: string; receipt: { token: string } }>;
    };
    const entry = internals.pending.get(receipt.token);
    expect(entry).toBeDefined();
    expect(entry?.digest).toBe(await sha256Hex(secret));
    expect(entry?.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(entry?.digest).not.toBe(secret);

    // 序列化整个待清理表，也不应出现明文
    expect(JSON.stringify([...internals.pending.values()])).not.toContain(secret);
  });
});

describe('对抗性 · 覆盖与多任务隔离', () => {
  it('复制 A 后被用户覆盖为 B，A 到期不得清空 B', async () => {
    const { port, scheduler, service } = createClipboardService();
    await service.copyWithTtl('Fixture-Pass-A', 5_000);

    port.content = 'user-typed-text';
    await scheduler.fire(0);
    await service.awaitPending();

    expect(port.content).toBe('user-typed-text');
    expect(port.clearCount).toBe(0);
    expect(service.getOutcomes()[0].outcome).toBe('overwritten');
  });

  it('连续复制 A、B：A 的清理不得误删 B，B 到期才清理', async () => {
    const { port, scheduler, service } = createClipboardService();
    const first = await service.copyWithTtl('Fixture-Pass-A', 1_000);
    const second = await service.copyWithTtl('Fixture-Pass-B', 2_000);
    expect(first.token).not.toBe(second.token);

    await scheduler.fire(0);
    await service.awaitPending();
    expect(port.content).toBe('Fixture-Pass-B');
    expect(port.clearCount).toBe(0);

    await scheduler.fire(1);
    await service.awaitPending();
    expect(port.content).toBeNull();
    expect(port.clearCount).toBe(1);
  });

  it('锁定清理只清空仍属于自己的内容', async () => {
    const { port, service } = createClipboardService();
    await service.copyWithTtl('Fixture-Pass-A', 30_000);
    await service.cancelAll({ clearIfOwned: true });
    expect(port.content).toBeNull();

    await service.copyWithTtl('Fixture-Pass-B', 30_000);
    port.content = 'user-typed-text';
    await service.cancelAll({ clearIfOwned: true });
    expect(port.content).toBe('user-typed-text');
  });
});

describe('对抗性 · 锁定后接口全部关闭', () => {
  async function createLockedClient() {
    const port = new FakeClipboardPort();
    const client = createVaultClient({
      storage: new MemoryVaultStorage(),
      now: () => NOW,
      clipboard: port,
      clipboardTtlMs: 30_000,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });
    await client.initialize({ masterPassword: MASTER_PASSWORD });
    const item = await client.createItem({
      title: '示例站点',
      username: 'alice@example.test',
      password: 'Fixture-Pass-1!',
    });
    await client.lock('manual');
    return { client, port, itemId: item.id };
  }

  it('锁定后 copyPassword / copyUsername / listItems / getRecentItems 返回 VAULT_LOCKED 且不写剪贴板', async () => {
    const { client, port, itemId } = await createLockedClient();
    const writesBefore = port.writeCount;

    await expect(client.copyPassword(itemId)).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    await expect(client.copyUsername(itemId)).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    await expect(client.listItems()).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    await expect(client.getRecentItems()).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    await expect(client.getItem(itemId)).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    await expect(client.searchItems({ text: '示例' })).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    await expect(
      client.createItem({ title: '新站点', username: 'bob@example.test', password: 'Fixture-Pass-2!' }),
    ).rejects.toMatchObject({ code: 'VAULT_LOCKED' });

    expect(port.writeCount).toBe(writesBefore);
    await client.dispose();
  });

  it('复制后立刻锁定，剪贴板中的密码被立即清空', async () => {
    const port = new FakeClipboardPort();
    const client = createVaultClient({
      storage: new MemoryVaultStorage(),
      now: () => NOW,
      clipboard: port,
      clipboardTtlMs: 30_000,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });
    await client.initialize({ masterPassword: MASTER_PASSWORD });
    const item = await client.createItem({
      title: '示例站点',
      username: 'alice@example.test',
      password: 'Fixture-Pass-1!',
    });
    await client.copyPassword(item.id);
    expect(port.content).toBe('Fixture-Pass-1!');

    await client.lock('manual');
    expect(port.content).toBeNull();
    await client.dispose();
  });

  it('复制后用户覆盖，再锁定：不得清空用户内容', async () => {
    const port = new FakeClipboardPort();
    const client = createVaultClient({
      storage: new MemoryVaultStorage(),
      now: () => NOW,
      clipboard: port,
      clipboardTtlMs: 30_000,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });
    await client.initialize({ masterPassword: MASTER_PASSWORD });
    const item = await client.createItem({
      title: '示例站点',
      username: 'alice@example.test',
      password: 'Fixture-Pass-1!',
    });
    await client.copyPassword(item.id);

    port.content = 'user-typed-text';
    await client.lock('manual');
    expect(port.content).toBe('user-typed-text');
    await client.dispose();
  });
});
