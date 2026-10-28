/**
 * 冷却期错误码**确定性**回归。
 *
 * 背景：QA 复验时观察到"同一份代码、同一条用例，多次运行交替出现
 * `VAULT_LOCKED` 与 `AUTH_COOLDOWN`"。这可能来自两种原因，必须分清：
 *
 * A. 观测发生在修复落地之前（修复前 `internalDeleteItems` 直接走
 *    `requireItemService()`，冷却被误报成 VAULT_LOCKED）；
 * B. 修复后仍存在竞态——例如锁清理是异步的，`session.status()` 在不同时刻
 *    看到不同的状态。
 *
 * 本用例把同一场景连跑多次，每一次都断言错误码。**只要出现一次不一致就失败**，
 * 这样 B 无处藏身。同时它是回归保护：将来谁把冷却前置判断删掉，这里会红。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { AppError } from '../../core/errors';
import { createVaultClient, type VaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';

const START = 1_700_000_000_000;
const MASTER = 'Sierra-Tango-6677';
const WRONG = 'Uniform-Victor-9911';

/** 连跑次数：足够让偶发竞态现身，又不至于把测试拖长。 */
const RUNS = 6;

/** 单轮：建库 → 造 3 张卡 → 连续输错到冷却 → 用正确密码再删一次。 */
async function runOnce(): Promise<string> {
  let now = START;
  const client: VaultClient = createVaultClient({
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
      title: `稳定-${index}`,
      platform: '示例',
      username: `u-${index}@example.test`,
      password: `Whiskey-Xray-${index}000`,
    });
    ids.push(summary.id);
  }

  // 连续失败到触发冷却（MAX_FAILED_ATTEMPTS = 5）。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await client.deleteItems(ids, WRONG);
      throw new Error('第 ' + attempt + ' 次用错误密码竟然删成功了');
    } catch (caught) {
      expect(AppError.isAppError(caught)).toBe(true);
      expect((caught as AppError).code).toBe('AUTH_INVALID');
    }
  }

  // 冷却中即使密码正确，也必须拿到同一个错误码。
  try {
    await client.deleteItems(ids, MASTER);
    throw new Error('冷却期用正确密码竟然删成功了');
  } catch (caught) {
    expect(AppError.isAppError(caught)).toBe(true);
    return (caught as AppError).code;
  } finally {
    await client.dispose();
  }
}

describe('批量删除 · 冷却期错误码确定性', () => {
  it(`连续 ${RUNS} 轮都返回 AUTH_COOLDOWN，不是 VAULT_LOCKED`, async () => {
    const codes: string[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      codes.push(await runOnce());
    }

    // 逐轮记录，失败时能直接看到是哪一轮跑偏。
    expect(codes).toEqual(Array.from({ length: RUNS }, () => 'AUTH_COOLDOWN'));
  }, 120_000);

  it('冷却期数据一张不少（冷却过去解锁后核对）', async () => {
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
        title: `完好-${index}`,
        platform: '示例',
        username: `v-${index}@example.test`,
        password: `Yankee-Zulu-${index}000`,
      });
      ids.push(summary.id);
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(client.deleteItems(ids, WRONG)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    }
    await expect(client.deleteItems(ids, MASTER)).rejects.toMatchObject({ code: 'AUTH_COOLDOWN' });

    // 推进到冷却结束，用正确密码解锁后核对：三张都在，一张没少。
    now += 31 * 1000;
    await client.unlock(MASTER);
    const list = await client.listItems();
    expect(list.map((item) => item.id).sort()).toEqual([...ids].sort());
    await client.dispose();
  }, 120_000);
});
