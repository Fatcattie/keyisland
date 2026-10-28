/**
 * 「生成密码并复制」回归（PRD FR-02 灵动岛快捷按钮）。
 *
 * 契约：
 * 1. 生成的值真的写进了剪贴板，且符合传入的生成配置（长度/字符集）；
 * 2. 回执与复制密码同构（`field: 'password'`），UI 才能复用同一套提示文案；
 * 3. 剪贴板清理档位沿用设置（含"关闭"档 → `autoClear: false`）；
 * 4. 不要求解锁：不读写库内数据，锁定态也能用。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { createVaultClient, type VaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';

const NOW = 1_700_000_000_000;
const MASTER = 'Alpha-Bravo-7788';

/** 建库（不自动解锁）。 */
async function createHarness(): Promise<{ client: VaultClient; clipboard: FakeClipboardPort }> {
  const clipboard = new FakeClipboardPort();
  const client = createVaultClient({
    storage: new MemoryVaultStorage(),
    now: () => NOW,
    clipboard,
    autoLockPolicy: '30m',
    clipboardTtlMs: 30_000,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
  });
  await client.initialize({ masterPassword: MASTER });
  return { client, clipboard };
}

describe('VaultClient · 生成密码并复制', () => {
  it('生成的值写入剪贴板，回执与复制密码同构', async () => {
    const { client, clipboard } = await createHarness();

    const receipt = await client.copyGeneratedPassword();

    expect(clipboard.value).not.toBeNull();
    expect(clipboard.value?.length).toBeGreaterThanOrEqual(12);
    expect(receipt.field).toBe('password');
    expect(receipt.ttlMs).toBe(30_000);
    expect(receipt.autoClear).toBe(true);
    expect(receipt.expiresAt).toBe(NOW + 30_000);
  });

  it('遵循生成配置：长度与字符集被真正应用', async () => {
    const { client, clipboard } = await createHarness();

    await client.copyGeneratedPassword({ length: 24, symbols: false, uppercase: false, digits: false });

    expect(clipboard.value).toHaveLength(24);
    // 关掉大写/数字/符号后只剩小写。
    expect(clipboard.value).toMatch(/^[a-z]+$/);
  });

  it('关闭自动清理档位时回执标记 autoClear = false', async () => {
    const { client, clipboard } = await createHarness();
    await client.setClipboardTtl(0);

    const receipt = await client.copyGeneratedPassword();

    expect(receipt.autoClear).toBe(false);
    expect(receipt.ttlMs).toBe(0);
    expect(receipt.expiresAt).toBe(0);
    expect(clipboard.value).not.toBeNull();
  });

  it('锁定态也能用：不读写库内数据', async () => {
    const { client, clipboard } = await createHarness();
    await client.lock('manual');

    const receipt = await client.copyGeneratedPassword();

    expect(receipt.field).toBe('password');
    expect(clipboard.value).not.toBeNull();
  });

  it('非法生成配置被拒绝（不写剪贴板）', async () => {
    const { client, clipboard } = await createHarness();

    await expect(client.copyGeneratedPassword({ length: 2 })).rejects.toMatchObject({
      code: 'GENERATOR_INVALID',
    });
    expect(clipboard.value).toBeNull();
  });
});
