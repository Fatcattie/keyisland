/**
 * 批量删除的**安全顺序**回归（门面层）。
 *
 * 核心约定只有一条，但它决定这个功能是"便利"还是"灾难"：
 *
 * > **必须先校验主密码，再动数据。**
 *
 * 如果实现写反（先删后验），一次输错密码就会把卡片永久删掉——而删除不可恢复，
 * 恢复码也救不回来。因此本文件用"密码错 → 一张都没少"作为第一优先级断言。
 *
 * 另外钉两条旁路防护：
 * - 失败计数必须与 `unlock()` 共用（否则可以用批量删除无限次试密码）；
 * - 空集合不得触发校验（否则会被用来探测/消耗失败计数）。
 *
 * 全部走真实 `createVaultClient` + `MemoryVaultStorage` + `ARGON2_TEST_PARAMS`，
 * 不 mock 加密层与 `ItemService`。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { AppError } from '../../core/errors';
import { COOLDOWN_BASE_MS } from '../../core/vault/session';
import { createVaultClient, type VaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';

/** 固定起始时间，时间推进由 `advance()` 控制。 */
const START = 1_700_000_000_000;
/** 测试用主密码（仅测试文件内出现，不是真实凭据）。 */
const MASTER = 'Kilo-Lima-3311';
/** 一个必然不匹配的凭据。 */
const WRONG = 'Mike-November-9911';

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

interface Harness {
  client: VaultClient;
  ids: number[];
  advance: (ms: number) => void;
}

/** 初始化保险库并创建 3 张卡片。 */
async function createHarness(): Promise<Harness> {
  let now = START;
  const client = createVaultClient({
    storage: new MemoryVaultStorage(),
    now: () => now,
    clipboard: new FakeClipboardPort(),
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
    autoLockPolicy: '30m',
  });
  await client.initialize({ masterPassword: MASTER });

  const ids: number[] = [];
  for (let index = 1; index <= 3; index += 1) {
    const summary = await client.createItem({
      title: `批量-${index}`,
      platform: '示例',
      username: `user-${index}@example.test`,
      password: `Zulu-Yankee-${index}000`,
    });
    ids.push(summary.id);
  }

  return {
    client,
    ids,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('VaultClient.deleteItems', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  it('密码错误时抛 AUTH_INVALID，且一张卡片都没删', async () => {
    const { client, ids } = harness;

    await expectCode(client.deleteItems(ids, WRONG), 'AUTH_INVALID');

    const list = await client.listItems();
    expect(list).toHaveLength(3);
    expect(list.map((item) => item.id).sort()).toEqual([...ids].sort());
  });

  it('密码正确才删除，返回实际删除的 id 与张数', async () => {
    const { client, ids } = harness;

    const result = await client.deleteItems([ids[0], ids[2]], MASTER);

    expect(result.deleted).toBe(2);
    expect([...result.deletedIds].sort()).toEqual([ids[0], ids[2]].sort());
    const list = await client.listItems();
    expect(list.map((item) => item.id)).toEqual([ids[1]]);
  });

  it('删除后最近使用列表不再含被删卡片', async () => {
    const { client, ids } = harness;
    // 先复制一次，让卡片进入最近使用。
    await client.copyPassword(ids[0]);
    expect((await client.getRecentItems()).map((item) => item.id)).toContain(ids[0]);

    await client.deleteItems([ids[0]], MASTER);

    expect((await client.getRecentItems()).map((item) => item.id)).not.toContain(ids[0]);
  });

  it('失败计数与 unlock 共用，不能成为无限试密码的旁路', async () => {
    const { client, ids } = harness;

    await expectCode(client.deleteItems(ids, WRONG), 'AUTH_INVALID');

    // 门面把失败登记进了同一份计数器：这正是"共用"的可见证据。
    const snapshot = await client.status();
    expect(snapshot.failedAttempts).toBeGreaterThan(0);
    // 数据仍在。
    expect(await client.listItems()).toHaveLength(3);
  });

  it('锁定态一律拒绝，且不做任何删除', async () => {
    const { client, ids } = harness;
    await client.lock('manual');

    await expectCode(client.deleteItems(ids, MASTER), 'VAULT_LOCKED');

    // 重新解锁后数据必须完好无损。
    await client.unlock(MASTER);
    expect(await client.listItems()).toHaveLength(3);
  });

  it('空集合不校验密码，也不消耗失败计数', async () => {
    const { client } = harness;

    // 用错误密码调空集合：如果实现先验密码，这里会抛 AUTH_INVALID。
    const result = await client.deleteItems([], WRONG);

    expect(result.deleted).toBe(0);
    expect(result.deletedIds).toEqual([]);
    const snapshot = await client.status();
    expect(snapshot.failedAttempts).toBe(0);
    expect(snapshot.status).toBe('unlocked');
    expect(await client.listItems()).toHaveLength(3);
  });

  it('重复 id 只删一次，deletedIds 不重复', async () => {
    const { client, ids } = harness;

    const result = await client.deleteItems([ids[0], ids[0], ids[0]], MASTER);

    expect(result.deleted).toBe(1);
    expect(result.deletedIds).toEqual([ids[0]]);
    expect(await client.listItems()).toHaveLength(2);
  });

  it('冷却期报 AUTH_COOLDOWN 而不是 VAULT_LOCKED，且一张不删', async () => {
    const { client, ids, advance } = harness;

    // 连续输错到触发冷却：会话会被强制锁定（DEK 已清），但 cooldownUntil 仍在。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expectCode(client.deleteItems(ids, WRONG), 'AUTH_INVALID');
    }

    // 此刻即使拿着**正确**主密码，也必须报 AUTH_COOLDOWN。
    // 若走 `requireItemService()` 兜底，会误报成 VAULT_LOCKED——用户只看到"已锁定"，
    // 完全不知道要等多久，而批量删除弹窗靠这个错误码展示剩余秒数。
    await expectCode(client.deleteItems(ids, MASTER), 'AUTH_COOLDOWN');
    const snapshot = await client.status();
    expect(snapshot.cooldownRemainingMs).toBeGreaterThan(0);

    // 冷却期会话是锁着的，此刻读列表本来就会报 VAULT_LOCKED，不能用来验数据完整性。
    // 等冷却过去、用正确密码解锁后再查：一张都没少才算真的没删。
    advance(COOLDOWN_BASE_MS + 1000);
    await client.unlock(MASTER);
    expect(await client.listItems()).toHaveLength(3);
    expect((await client.listItems()).map((item) => item.id).sort()).toEqual([...ids].sort());
  });
});
