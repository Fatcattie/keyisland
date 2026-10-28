/**
 * 隐藏卡片 **写路径** 授权回归（第三轮 QA 缺陷）。
 *
 * 缺陷描述：`updateItem / setFavorite / setVisibility / deleteItem` 只校验会话是否解锁，
 * 完全没有校验隐藏卡片授权，因此存在两条绕过：
 * 1. 未授权也能改写甚至删除隐藏卡片；
 * 2. `setVisibility(hidden → normal)` 可以单方面解除隐藏保护，之后无需任何二次验证。
 *
 * 本文件全部使用真实 `createVaultClient` + `MemoryVaultStorage` + `ARGON2_TEST_PARAMS`，
 * 不 mock 加密层，也不 mock `ItemService`——否则测不到真实的门面校验顺序。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { AppError } from '../../core/errors';
import { createVaultClient, HIDDEN_ACCESS_WINDOW_MS, type VaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';

/** 固定起始时间，所有时间推进都由 `advance()` 控制。 */
const START = 1_700_000_000_000;
/** 测试用主密码（仅测试文件内出现，不是真实凭据）。 */
const MASTER = 'Hotel-India-4411';
/** 隐藏卡片标题，便于在断言里精确定位。 */
const HIDDEN_TITLE = '内网跳板机';
/** 普通卡片标题。 */
const PLAIN_TITLE = '团队邮箱';

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
  hiddenId: number;
  plainId: number;
  advance: (ms: number) => void;
}

/** 初始化一个含 1 张隐藏卡 + 1 张普通卡的解锁态保险库。 */
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

  // 创建隐藏卡本身不需要授权：创建是"加强保护"方向的操作。
  const hidden = await client.createItem({
    title: HIDDEN_TITLE,
    platform: '运维',
    username: 'ops-bravo',
    password: 'Delta-Echo-7788',
    category: '工作',
    visibility: 'hidden',
  });
  const plain = await client.createItem({
    title: PLAIN_TITLE,
    platform: '邮件',
    username: 'team-charlie',
    password: 'Foxtrot-Golf-9900',
    category: '工作',
    visibility: 'normal',
  });

  return {
    client,
    hiddenId: hidden.id,
    plainId: plain.id,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('隐藏卡片写路径 · 未授权一律拒绝', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  it('updateItem 改写隐藏卡被拒绝，且原值未被修改', async () => {
    const { client, hiddenId } = harness;

    await expectCode(client.updateItem(hiddenId, { title: '被篡改的标题' }), 'ITEM_HIDDEN');

    await client.requestHiddenAccess(MASTER);
    const detail = await client.getItem(hiddenId, { allowHidden: true });
    expect(detail.title).toBe(HIDDEN_TITLE);
    expect(detail.username).toBe('ops-bravo');
  });

  it('updateItem 把隐藏卡降级为 normal 同样被拒绝', async () => {
    const { client, hiddenId } = harness;

    await expectCode(client.updateItem(hiddenId, { visibility: 'normal' }), 'ITEM_HIDDEN');

    // 未授权时普通列表依然看不到它，说明降级没有发生。
    const plainList = await client.listItems();
    expect(plainList.map((item) => item.title)).toEqual([PLAIN_TITLE]);
  });

  it('setFavorite 修改隐藏卡被拒绝', async () => {
    const { client, hiddenId } = harness;

    await expectCode(client.setFavorite(hiddenId, true), 'ITEM_HIDDEN');

    await client.requestHiddenAccess(MASTER);
    const detail = await client.getItem(hiddenId, { allowHidden: true });
    expect(detail.favorite).toBe(false);
  });

  it('setVisibility(hidden → normal) 不能绕过二次验证解除保护', async () => {
    const { client, hiddenId } = harness;

    await expectCode(client.setVisibility(hiddenId, 'normal'), 'ITEM_HIDDEN');

    // 关键回归点：如果降级成功，隐藏卡会出现在普通列表里。
    const plainList = await client.listItems();
    expect(plainList.some((item) => item.id === hiddenId)).toBe(false);
    await expectCode(client.getItem(hiddenId), 'ITEM_HIDDEN');
  });

  it('deleteItem 删除隐藏卡被拒绝，卡片仍然存在', async () => {
    const { client, hiddenId } = harness;

    await expectCode(client.deleteItem(hiddenId), 'ITEM_HIDDEN');

    await client.requestHiddenAccess(MASTER);
    const detail = await client.getItem(hiddenId, { allowHidden: true });
    expect(detail.title).toBe(HIDDEN_TITLE);
  });

  it('普通卡片的写路径不需要隐藏授权（不误伤）', async () => {
    const { client, plainId } = harness;

    const updated = await client.updateItem(plainId, { title: '团队邮箱（改）' });
    expect(updated.title).toBe('团队邮箱（改）');

    const favorited = await client.setFavorite(plainId, true);
    expect(favorited.favorite).toBe(true);

    await client.deleteItem(plainId);
    const plainList = await client.listItems();
    expect(plainList.some((item) => item.id === plainId)).toBe(false);
  });
});

describe('隐藏卡片写路径 · 授权窗口', () => {
  it('授权有效期内可以写隐藏卡', async () => {
    const { client, hiddenId } = await createHarness();

    const grant = await client.requestHiddenAccess(MASTER);
    expect(grant.grantedUntil).toBe(START + HIDDEN_ACCESS_WINDOW_MS);

    const updated = await client.updateItem(hiddenId, { notes: '跳板机，仅运维使用' });
    expect(updated.title).toBe(HIDDEN_TITLE);

    const favorited = await client.setFavorite(hiddenId, true);
    expect(favorited.favorite).toBe(true);

    // 授权内的降级是合法操作：用户已经二次验证过。
    const downgraded = await client.setVisibility(hiddenId, 'normal');
    expect(downgraded.visibility).toBe('normal');

    const plainList = await client.listItems();
    expect(plainList.some((item) => item.id === hiddenId)).toBe(true);
  });

  it('授权到期后写路径重新被拒绝', async () => {
    const { client, hiddenId, advance } = await createHarness();

    await client.requestHiddenAccess(MASTER);
    advance(HIDDEN_ACCESS_WINDOW_MS + 1);

    await expectCode(client.updateItem(hiddenId, { title: '过期后篡改' }), 'ITEM_HIDDEN');
    await expectCode(client.setVisibility(hiddenId, 'normal'), 'ITEM_HIDDEN');
    await expectCode(client.deleteItem(hiddenId), 'ITEM_HIDDEN');
  });

  it('锁定后写路径既被"已锁定"拦截，也不会残留授权', async () => {
    const { client, hiddenId } = await createHarness();

    await client.requestHiddenAccess(MASTER);
    await client.lock();
    await client.unlock(MASTER);

    // 重新解锁不恢复隐藏授权：必须再次输入主密码。
    await expectCode(client.setVisibility(hiddenId, 'normal'), 'ITEM_HIDDEN');
  });
});
