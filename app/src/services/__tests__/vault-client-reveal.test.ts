/**
 * `revealPassword` 门面 API 回归测试（Phase 2 新增）。
 *
 * 语义要求：
 * - `normal` 可读；
 * - `username_only` 抛 `ITEM_HIDDEN`（该档位靠复制取用，不允许预览）；
 * - `hidden` 无授权抛 `ITEM_HIDDEN`；
 * - `hidden` 持有效授权 + `allowHidden` 可读。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { createVaultClient, type VaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';

const NOW = Date.now();

/** 测试用主密码（与生产无关）。 */
const MASTER = 'Alpha-Bravo-7788';

/** 断言 Promise 抛出指定错误码。 */
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code}，但调用成功返回`);
}

/** 建库并返回 client 与三张不同档位的卡片 id。 */
async function setup(): Promise<{
  client: VaultClient;
  normalId: number;
  usernameOnlyId: number;
  hiddenId: number;
}> {
  const client = createVaultClient({
    storage: new MemoryVaultStorage(),
    now: () => NOW,
    clipboard: new FakeClipboardPort(),
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
  });
  await client.initialize({ masterPassword: MASTER });

  const normal = await client.createItem({
    title: '普通卡',
    username: 'user-alpha',
    password: 'Value-Alpha-1',
  });
  const usernameOnly = await client.createItem({
    title: '仅账号卡',
    username: 'user-bravo',
    password: 'Value-Bravo-2',
    visibility: 'username_only',
  });
  const hidden = await client.createItem({
    title: '隐藏卡',
    username: 'user-charlie',
    password: 'Value-Charlie-3',
    visibility: 'hidden',
  });

  return {
    client,
    normalId: normal.id,
    usernameOnlyId: usernameOnly.id,
    hiddenId: hidden.id,
  };
}

describe('VaultClient.revealPassword', () => {
  it('normal 档位可直接读取明文', async () => {
    const { client, normalId } = await setup();
    await expect(client.revealPassword(normalId)).resolves.toBe('Value-Alpha-1');
  });

  it('username_only 档位拒绝预览', async () => {
    const { client, usernameOnlyId } = await setup();
    await expectCode(client.revealPassword(usernameOnlyId), 'ITEM_HIDDEN');
  });

  it('hidden 档位无授权时拒绝预览', async () => {
    const { client, hiddenId } = await setup();
    await expectCode(client.revealPassword(hiddenId, { allowHidden: true }), 'ITEM_HIDDEN');
  });

  it('hidden 档位持有授权后可读取明文', async () => {
    const { client, hiddenId } = await setup();
    await client.requestHiddenAccess(MASTER);
    await expect(client.revealPassword(hiddenId, { allowHidden: true })).resolves.toBe(
      'Value-Charlie-3',
    );
  });
});
