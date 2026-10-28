/**
 * 剪贴板「关闭自动清理」档位回归（PRD FR-05：10–120s 可调，**可关闭**）。
 *
 * 钉四件事：
 * 1. `ttlMs === 0` 是合法值，不再抛 `clipboard_invalid_ttl`；
 * 2. 关闭档**不排定时器**——推进时间后剪贴板内容必须原样留着；
 * 3. 关闭档仍然登记在 `pending` 里：锁定时 `cancelAll({ clearIfOwned: true })`
 *    要能按归属清掉它。"不自动清"不等于"锁定了还留着"；
 * 4. 校验分两层：服务层只拦负数/非有限值（内部调用方要用 5s 这类短时长），
 *    10–120s 区间只由设置层 `setClipboardTtl` 执行。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { AppError } from '../../core/errors';
import { ClipboardService, type ClipboardServiceOptions } from '../clipboard';
import { createVaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';
import { DEFAULT_CLIPBOARD_TTL_MS } from '../../core/vault/types';

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

/** 可控时钟 + 同步定时器替身。 */
function setup(overrides: Partial<ClipboardServiceOptions> = {}): {
  service: ClipboardService;
  port: FakeClipboardPort;
  advance: (ms: number) => void;
} {
  let current = 1_700_000_000_000;
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const port = new FakeClipboardPort();
  const service = new ClipboardService({
    port,
    now: () => current,
    schedule: (callback, delayMs) => {
      const id = nextId++;
      timers.set(id, callback);
      void delayMs;
      return id;
    },
    cancel: (handle) => {
      timers.delete(handle as number);
    },
    ...overrides,
  });
  return {
    service,
    port,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('ClipboardService · 关闭自动清理（ttlMs = 0）', () => {
  it('ttlMs = 0 不再抛 invalid_ttl，回执标记 autoClear = false', async () => {
    const { service, port } = setup();

    const receipt = await service.copyWithTtl('Zulu-Yankee-1234', 0);

    expect(receipt.autoClear).toBe(false);
    expect(receipt.ttlMs).toBe(0);
    expect(port.value).toBe('Zulu-Yankee-1234');
  });

  it('关闭档不排定时器：推进任意长时间内容都还在', async () => {
    const { service, port, advance } = setup();
    await service.copyWithTtl('Kilo-Lima-5678', 0);

    advance(60 * 60 * 1000);

    // 关键断言：没有"到点清空"这回事，内容原样留着。
    expect(port.value).toBe('Kilo-Lima-5678');
    expect(port.clearCount).toBe(0);
  });

  it('关闭档在锁定时仍按归属清掉', async () => {
    const { service, port, advance } = setup();
    await service.copyWithTtl('Mike-November-9012', 0);
    advance(10 * 60 * 1000);

    await service.cancelAll({ clearIfOwned: true });

    expect(port.value).toBe('');
    expect(port.clearCount).toBe(1);
  });

  it('正常档仍然照旧自动清理，行为没被关闭档带坏', async () => {
    const { service, port } = setup();

    const receipt = await service.copyWithTtl('Oscar-Papa-3456', DEFAULT_CLIPBOARD_TTL_MS);

    expect(receipt.autoClear).toBe(true);
    expect(receipt.expiresAt).toBeGreaterThan(0);
    expect(port.value).toBe('Oscar-Papa-3456');
  });

  it('服务层只拦负数与非有限值：短/长 TTL 是内部调用方的合法用法', async () => {
    const { service } = setup();

    // 服务层**不套** 10–120s 区间：那是用户设置档位的约束（`setClipboardTtl`），
    // 内部调用方与测试常用 1s/5s 这类短时长验证清理路径，收紧到 10s 会全拒掉。
    // 区间回归见本文件「门面层」describe 与 vault-client-phase2-fixes.test.ts。
    const short = await service.copyWithTtl('a-secret', 5_000);
    expect(short.autoClear).toBe(true);
    const long = await service.copyWithTtl('a-secret', 300_000);
    expect(long.autoClear).toBe(true);

    // 注意：`errors.validationFailed(msgKey)` 对外的 `code` 是 `VALIDATION_FAILED`，
    // `error.clipboard_invalid_ttl` 只是给 i18n 用的 messageKey，不是错误码。
    for (const bad of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      await expect(service.copyWithTtl('a-secret', bad)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        messageKey: 'error.clipboard_invalid_ttl',
      });
    }
  });

  it('不传 ttlMs 时用默认 30 秒档，且标记为会自动清理', async () => {
    const { service, port } = setup();
    const receipt = await service.copyWithTtl('Quebec-Romeo-7890');

    expect(receipt.autoClear).toBe(true);
    expect(receipt.ttlMs).toBe(DEFAULT_CLIPBOARD_TTL_MS);
    expect(port.value).toBe('Quebec-Romeo-7890');
  });
});

/**
 * 门面层：设置档位的区间校验 + 「关闭」跨重启回读。
 *
 * 回读是这里的主角：meta 里存的 `clipboardTtlMs` 原来是 `> 0` 才采纳，
 * 用户设的 `0`（关闭）会被当成无效值丢掉，重启后静默变回 30 秒自动清理——
 * 用户以为自己关掉了，其实没有。用同一份 storage 重建 client 来钉死它。
 */
describe('VaultClient · 关闭档的持久化与设置区间', () => {
  const MASTER = 'Kilo-Lima-3311';
  const START = 1_700_000_000_000;

  /** 新建保险库：建库、解锁、造一张卡。 */
  async function bootstrap(storage: MemoryVaultStorage, now: () => number) {
    const client = createVaultClient({
      storage,
      now,
      clipboard: new FakeClipboardPort(),
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
      autoLockPolicy: '30m',
    });
    await client.initialize({ masterPassword: MASTER });
    const summary = await client.createItem({
      title: 'TTL-关闭-1',
      platform: '示例',
      username: 'ttl@example.test',
      password: 'Zulu-Yankee-0001',
    });
    return { client, id: summary.id };
  }

  /** 打开已存在的保险库：只解锁，不再 initialize（否则 VAULT_ALREADY_INITIALIZED）。 */
  async function reopen(storage: MemoryVaultStorage, now: () => number) {
    const client = createVaultClient({
      storage,
      now,
      clipboard: new FakeClipboardPort(),
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
      autoLockPolicy: '30m',
    });
    await client.unlock(MASTER);
    return client;
  }

  it('setClipboardTtl(0) 成功，且跨"重启"回读仍是 0（不会被 > 0 丢掉）', async () => {
    let now = START;
    const storage = new MemoryVaultStorage();
    const first = await bootstrap(storage, () => now);

    await first.client.setClipboardTtl(0);

    // 同一份 storage 重建 client = 应用重启。
    const second = await reopen(storage, () => now);
    const receipt = await second.copyPassword(first.id);

    expect(receipt.ttlMs).toBe(0);
    expect(receipt.autoClear).toBe(false);
  });

  it('设置层收紧区间：5 秒与 121 秒被拒，10/120 秒与关闭档放行', async () => {
    let now = START;
    const storage = new MemoryVaultStorage();
    const { client } = await bootstrap(storage, () => now);

    await expectCode(client.setClipboardTtl(5_000), 'VALIDATION_FAILED');
    await expectCode(client.setClipboardTtl(121_000), 'VALIDATION_FAILED');
    await expectCode(client.setClipboardTtl(-1), 'VALIDATION_FAILED');
    await expectCode(client.setClipboardTtl(Number.NaN), 'VALIDATION_FAILED');

    await client.setClipboardTtl(10_000);
    await client.setClipboardTtl(120_000);
    await client.setClipboardTtl(0);
  });
});
