/**
 * 门面 `readClipboardText()` 的归一化契约。
 *
 * 接口文档写的是「无权限或读不到时返回 null（**不抛错**）」。但端口实现是可能抛错的：
 * - `BrowserClipboardPort.read()` 自己 try/catch 后返回 null；
 * - 测试替身 `FakeClipboardPort.read()` 在 `denyRead = true` 时**直接抛错**；
 * - 未来的 Tauri 实现同样可能抛。
 *
 * 所以归一化必须发生在门面这一层。否则每个 UI 调用点都要各自 try/catch，
 * 漏写一处就是一次未处理的 Promise 拒绝——用户点了"粘贴"什么都不会发生，
 * 也没有任何提示（QA 复验抓到的缺陷）。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { createVaultClient, type VaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';

const MASTER = 'Uniform-Victor-4455';

/** 建库。 */
async function setup(): Promise<{ client: VaultClient; clipboard: FakeClipboardPort }> {
  const clipboard = new FakeClipboardPort();
  const client = createVaultClient({
    storage: new MemoryVaultStorage(),
    clipboard,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
    autoLockPolicy: '30m',
  });
  await client.initialize({ masterPassword: MASTER });
  return { client, clipboard };
}

describe('VaultClient.readClipboardText', () => {
  it('读到内容时原样返回', async () => {
    const { client, clipboard } = await setup();
    clipboard.value = 'hello-from-clipboard';

    expect(await client.readClipboardText()).toBe('hello-from-clipboard');
  });

  it('端口抛错时归一化为 null，不向外抛', async () => {
    const { client, clipboard } = await setup();
    clipboard.denyRead = true;

    // 关键是"不抛"：调用方（编辑器粘贴按钮）没有 try/catch。
    await expect(client.readClipboardText()).resolves.toBeNull();
  });

  it('剪贴板为空字符串时返回空字符串，由 UI 决定怎么提示', async () => {
    const { client, clipboard } = await setup();
    clipboard.value = '';

    // 空串与"读不到"是两种语义，门面不把它们混为一谈。
    expect(await client.readClipboardText()).toBe('');
  });
});
