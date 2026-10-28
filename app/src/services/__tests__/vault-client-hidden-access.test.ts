/**
 * 隐藏卡片二次认证授权回归测试（QA 验收 P2-2 / 前置给 Phase 2 的授权 API）。
 *
 * 契约：
 * - `requestHiddenAccess(password)` 只校验主密码，不改变会话状态，返回 120 秒窗口；
 * - 未授权时 `listItems/searchItems({ includeHidden: true })` 抛 `ITEM_HIDDEN`；
 * - `getItem/copyPassword/copyUsername` 支持 `{ allowHidden: true }`，同样需要授权；
 * - 锁定（含自动锁定与冷却强制锁定）与到期都会撤销授权；
 * - 授权失败计入既有密码失败计数，因此不能用来绕过冷却。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { AppError } from '../../core/errors';
import { MAX_FAILED_ATTEMPTS } from '../../core/vault/session';
import { MemoryVaultStorage } from '../storage';
import {
  HIDDEN_ACCESS_WINDOW_MS,
  createVaultClient,
  type VaultClient,
} from '../vault-client';
import { FakeClipboardPort } from './support/fakes';

const NOW = 1_700_000_000_000;

/** 测试用主密码（与生产无关）。 */
const MASTER = 'Alpha-Bravo-7788';
/** 一个必然不匹配的凭据。 */
const WRONG = 'Charlie-Delta-9900';

/** 断言 Promise 抛出指定错误码。 */
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(AppError.isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code}，但调用成功返回`);
}

/** 测试环境。 */
interface Harness {
  client: VaultClient;
  clipboard: FakeClipboardPort;
  hiddenId: number;
  visibleId: number;
  advance: (ms: number) => void;
}

/** 建立"已解锁 + 一张常显卡 + 一张隐藏卡"的环境。 */
async function createHarness(): Promise<Harness> {
  let now = NOW;
  const clipboard = new FakeClipboardPort();
  const client = createVaultClient({
    storage: new MemoryVaultStorage(),
    now: () => now,
    clipboard,
    autoLockPolicy: '30m',
    clipboardTtlMs: 30 * 1000,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
  });
  await client.initialize({ masterPassword: MASTER });

  const visible = await client.createItem({
    title: '常显卡片',
    username: 'alpha',
    password: 'Value-Alpha-1',
  });
  const hidden = await client.createItem({
    title: '隐藏卡片',
    username: 'bravo',
    password: 'Value-Bravo-2',
    visibility: 'hidden',
  });

  return {
    client,
    clipboard,
    hiddenId: hidden.id,
    visibleId: visible.id,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('隐藏卡片授权 · 列表与搜索', () => {
  it('未授权时 includeHidden 被拒绝，普通列表不含隐藏卡', async () => {
    const { client, hiddenId, visibleId } = await createHarness();

    await expectCode(client.listItems({ includeHidden: true }), 'ITEM_HIDDEN');
    await expectCode(client.searchItems({ includeHidden: true }), 'ITEM_HIDDEN');

    const plain = await client.listItems();
    expect(plain.map((item) => item.id)).toEqual([visibleId]);
    expect(plain.some((item) => item.id === hiddenId)).toBe(false);
  });

  it('授权后可以列出并搜索到隐藏卡，窗口为 120 秒', async () => {
    const { client, hiddenId } = await createHarness();

    const grant = await client.requestHiddenAccess(MASTER);
    expect(grant.grantedUntil).toBe(NOW + HIDDEN_ACCESS_WINDOW_MS);

    const listed = await client.listItems({ includeHidden: true });
    expect(listed.some((item) => item.id === hiddenId)).toBe(true);

    const found = await client.searchItems({ text: '隐藏', includeHidden: true });
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(hiddenId);
  });

  it('错误密码不发放授权，且计入既有密码失败计数', async () => {
    const { client } = await createHarness();

    await expectCode(client.requestHiddenAccess(WRONG), 'AUTH_INVALID');
    expect((await client.status()).passwordFailures).toBe(1);

    // 失败后仍然没有授权。
    await expectCode(client.listItems({ includeHidden: true }), 'ITEM_HIDDEN');
  });
});

describe('隐藏卡片授权 · 详情与复制', () => {
  it('getItem 访问隐藏卡需要有效授权', async () => {
    const { client, hiddenId } = await createHarness();

    await expectCode(client.getItem(hiddenId, { allowHidden: true }), 'ITEM_HIDDEN');
    // 不传 allowHidden 同样被拒（与"卡片不存在"同码，不泄漏存在性）。
    await expectCode(client.getItem(hiddenId), 'ITEM_HIDDEN');

    await client.requestHiddenAccess(MASTER);
    const detail = await client.getItem(hiddenId, { allowHidden: true });
    expect(detail.title).toBe('隐藏卡片');
    expect(detail.username).toBe('bravo');
    expect(detail.visibility).toBe('hidden');
  });

  it('copyPassword / copyUsername 访问隐藏卡需要有效授权', async () => {
    const { client, clipboard, hiddenId } = await createHarness();

    await expectCode(client.copyPassword(hiddenId, { allowHidden: true }), 'ITEM_HIDDEN');
    await expectCode(client.copyUsername(hiddenId, { allowHidden: true }), 'ITEM_HIDDEN');

    await client.requestHiddenAccess(MASTER);
    const receipt = await client.copyPassword(hiddenId, { allowHidden: true });
    expect(receipt.field).toBe('password');
    expect(clipboard.value).toBe('Value-Bravo-2');

    await client.copyUsername(hiddenId, { allowHidden: true });
    expect(clipboard.value).toBe('bravo');
  });
});

describe('隐藏卡片授权 · 失效与冷却', () => {
  it('超过 120 秒后授权自动失效', async () => {
    const { client, hiddenId, advance } = await createHarness();
    await client.requestHiddenAccess(MASTER);

    advance(HIDDEN_ACCESS_WINDOW_MS - 1);
    // 窗口内必须**真的**能读到隐藏卡；只断言"返回数组"的话，空数组也会绿。
    const withinWindow = await client.listItems({ includeHidden: true });
    expect(withinWindow.map((item) => item.id)).toContain(hiddenId);

    advance(1);
    await expectCode(client.listItems({ includeHidden: true }), 'ITEM_HIDDEN');
  });

  it('手动锁定会立即撤销授权', async () => {
    const { client } = await createHarness();
    await client.requestHiddenAccess(MASTER);

    await client.lock('manual');
    await client.unlock(MASTER);
    await expectCode(client.listItems({ includeHidden: true }), 'ITEM_HIDDEN');
  });

  it('自动锁定超时同样撤销授权', async () => {
    const { client, advance } = await createHarness();
    await client.requestHiddenAccess(MASTER);

    advance(30 * 60 * 1000 + 1);
    expect((await client.status()).status).toBe('locked');

    await client.unlock(MASTER);
    await expectCode(client.listItems({ includeHidden: true }), 'ITEM_HIDDEN');
  });

  it('连续错误密码触发冷却并强制锁定，授权路径无法绕过', async () => {
    const { client } = await createHarness();

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await expectCode(client.requestHiddenAccess(WRONG), 'AUTH_INVALID');
    }

    const snapshot = await client.status();
    expect(snapshot.status).toBe('cooling_down');
    expect(snapshot.cooldownRemainingMs).toBeGreaterThan(0);

    // 冷却时 DEK 已被清除，资产接口一律拒绝。错误码必须是 AUTH_COOLDOWN 而不是
    // VAULT_LOCKED：用户此刻最需要的信息是"还要等 N 秒"，"已锁定"会让人以为重新
    // 输入主密码就能进——而解锁在冷却期同样被拒，只会造成二次困惑。
    await expectCode(client.listItems(), 'AUTH_COOLDOWN');
    await expectCode(client.listItems({ includeHidden: true }), 'AUTH_COOLDOWN');
    await expectCode(client.requestHiddenAccess(MASTER), 'AUTH_COOLDOWN');
  });
});
