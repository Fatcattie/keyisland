/**
 * 热区配置的持久化与校验（PRD FR-02「默认宽约 300px，可配置宽度与位置」）。
 *
 * 契约：
 * 1. 新库默认 300px 居中；
 * 2. 改完写进元数据，重启（同一份存储重建门面）后沿用；
 * 3. 越界 / 非整数宽度、非法位置**报错**而不是静默夹取——设置页的滑块已经夹过，
 *    走到这里的越界值说明调用方算错了；
 * 4. 部分更新：只改位置不动宽度；
 * 5. 未初始化时没有"配置"可写，必须报 VAULT_NOT_INITIALIZED。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { AppError } from '../../core/errors';
import { createVaultClient, type VaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';

const NOW = 1_700_000_000_000;
const MASTER = 'Alpha-Bravo-7788';

function makeClient(storage: MemoryVaultStorage): VaultClient {
  return createVaultClient({
    storage,
    now: () => NOW,
    clipboard: new FakeClipboardPort(),
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
    autoLockPolicy: '30m',
  });
}

/** 断言抛出的是指定错误码。 */
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('FR-02 · 热区配置', () => {
  it('新库默认 300px 居中', async () => {
    const client = makeClient(new MemoryVaultStorage());
    await client.initialize({ masterPassword: MASTER });

    expect(await client.getHotzoneConfig()).toEqual({ widthPx: 300, align: 'center' });
  });

  it('改完写进元数据：重建门面（模拟重启）后仍生效', async () => {
    const storage = new MemoryVaultStorage();
    const first = makeClient(storage);
    await first.initialize({ masterPassword: MASTER });

    await first.setHotzoneConfig({ widthPx: 480, align: 'left' });

    const second = makeClient(storage);
    expect(await second.getHotzoneConfig()).toEqual({ widthPx: 480, align: 'left' });
  });

  it('部分更新：只改位置时宽度保持不变', async () => {
    const client = makeClient(new MemoryVaultStorage());
    await client.initialize({ masterPassword: MASTER });

    await client.setHotzoneConfig({ widthPx: 600 });
    expect(await client.setHotzoneConfig({ align: 'right' })).toEqual({
      widthPx: 600,
      align: 'right',
    });
  });

  it('越界 / 非整数宽度报 VALIDATION_FAILED，且不落盘', async () => {
    const client = makeClient(new MemoryVaultStorage());
    await client.initialize({ masterPassword: MASTER });

    await expectCode(client.setHotzoneConfig({ widthPx: 100 }), 'VALIDATION_FAILED');
    await expectCode(client.setHotzoneConfig({ widthPx: 1300 }), 'VALIDATION_FAILED');
    await expectCode(client.setHotzoneConfig({ widthPx: 300.5 }), 'VALIDATION_FAILED');

    // 三次失败之后仍是默认值：失败不能留下半截状态。
    expect(await client.getHotzoneConfig()).toEqual({ widthPx: 300, align: 'center' });
  });

  it('非法位置报 VALIDATION_FAILED', async () => {
    const client = makeClient(new MemoryVaultStorage());
    await client.initialize({ masterPassword: MASTER });

    await expectCode(
      client.setHotzoneConfig({ align: 'middle' as unknown as 'center' }),
      'VALIDATION_FAILED',
    );
  });

  it('未初始化时写配置报 VAULT_NOT_INITIALIZED（不能假装存下了）', async () => {
    const client = makeClient(new MemoryVaultStorage());

    // 读：没有元数据，返回默认值即可（热区在解锁前就要能用）。
    expect(await client.getHotzoneConfig()).toEqual({ widthPx: 300, align: 'center' });
    await expectCode(client.setHotzoneConfig({ widthPx: 400 }), 'VAULT_NOT_INITIALIZED');
  });
});
