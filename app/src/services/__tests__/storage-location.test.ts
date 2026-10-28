/**
 * 数据文件位置描述回归（PRD FR-06：设置页展示数据文件路径与"打开所在文件夹"）。
 *
 * 契约：
 * 1. `MemoryVaultStorage.describeStorage()` 如实报告"内存、无路径、不可打开"——
 *    不返回假路径，UI 才能据此禁用按钮并解释原因；
 * 2. 门面 `describeStorage()` **不要求解锁**：位置描述不含任何数据本身，
 *    锁定态读一下"数据存在哪"不该被 VAULT_LOCKED 挡住；
 * 3. 存储故障经 `guard()` 归一化为 AppError，不把原始 Error 抛给 UI。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { AppError } from '../../core/errors';
import { createVaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort, FaultyStorage } from './support/fakes';

const NOW = 1_700_000_000_000;
const MASTER = 'Alpha-Bravo-7788';

describe('StorageLocation · 数据文件位置描述', () => {
  it('内存存储如实报告：无路径、不可打开', async () => {
    const location = await new MemoryVaultStorage().describeStorage();

    expect(location.kind).toBe('memory');
    expect(location.displayPath).toBeNull();
    expect(location.canReveal).toBe(false);
  });

  it('门面在锁定态也能读位置（不要求解锁）', async () => {
    const client = createVaultClient({
      storage: new MemoryVaultStorage(),
      now: () => NOW,
      clipboard: new FakeClipboardPort(),
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
      autoLockPolicy: '30m',
    });

    // 未初始化、未解锁，都不该被挡住。
    const location = await client.describeStorage();
    expect(location).toEqual({ kind: 'memory', displayPath: null, canReveal: false });

    await client.initialize({ masterPassword: MASTER });
    expect(await client.describeStorage()).toEqual(location);
  });

  it('存储故障归一化为 AppError，不把原始 Error 抛给 UI', async () => {
    const storage = new FaultyStorage();
    storage.failures.add('describeStorage');
    const client = createVaultClient({
      storage,
      now: () => NOW,
      clipboard: new FakeClipboardPort(),
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
      autoLockPolicy: '30m',
    });

    await expect(client.describeStorage()).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    // 归一化后的对象必须是 AppError 实例，UI 的 describeError 才能取到文案。
    await client.describeStorage().catch((error: unknown) => {
      expect(AppError.isAppError(error)).toBe(true);
    });
  });
});
