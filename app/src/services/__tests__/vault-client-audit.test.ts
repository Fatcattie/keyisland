/**
 * 操作日志 · 门面接线（NFR 可靠性）。
 *
 * 最要紧的一条不是"记了没有"，而是**记的内容里不能有敏感信息**：
 * 日志会进设置页给人看、也可能被截图，一旦掺进密码 / 账号 / 标题，日志本身
 * 就变成泄漏源。所以这里除了断言"记了"，还要把整份日志序列化后反查明文。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { createVaultClient, type VaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';

const NOW = 1_700_000_000_000;
const MASTER = 'Alpha-Bravo-7788';
const ITEM_PASSWORD = 'Super-Secret-9999';
const ITEM_USERNAME = 'alice@example.com';
const ITEM_TITLE = 'GitHub 工作号';
const JUMP_URL = 'https://example.com/login?token=tok_live_12345#frag';

/** 建库并返回门面。 */
async function setup(): Promise<VaultClient> {
  const client = createVaultClient({
    storage: new MemoryVaultStorage(),
    now: () => NOW,
    clipboard: new FakeClipboardPort(),
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
    autoLockPolicy: 'boot',
  });
  await client.initialize({ masterPassword: MASTER });
  return client;
}

describe('操作日志 · 记录', () => {
  it('新建 / 编辑 / 删除都留痕，且按时间倒序', async () => {
    const client = await setup();
    const created = await client.createItem({
      title: ITEM_TITLE,
      username: ITEM_USERNAME,
      password: ITEM_PASSWORD,
      category: '开发',
    });
    await client.updateItem(created.id, { title: `${ITEM_TITLE} 2` });
    await client.deleteItem(created.id);

    const actions = (await client.getAuditLog()).map((entry) => entry.action);
    expect(actions.slice(0, 3)).toEqual(['item.delete', 'item.update', 'item.create']);
  });

  it('锁定记录原因（便于排查自动锁定是否误触发）', async () => {
    const client = await setup();
    await client.lock('timeout');

    const [latest] = await client.getAuditLog();
    expect(latest.action).toBe('lock');
    expect(latest.detail).toBe('timeout');
  });

  it('复制密码只记动作与资产 id', async () => {
    const client = await setup();
    const item = await client.createItem({
      title: ITEM_TITLE,
      username: ITEM_USERNAME,
      password: ITEM_PASSWORD,
      category: '开发',
    });
    await client.copyPassword(item.id);

    const entries = await client.getAuditLog();
    const copy = entries.find((entry) => entry.action === 'item.copy_password');
    expect(copy?.itemId).toBe(item.id);
    expect(copy?.detail).toBeNull();
  });

  it('整份日志里查不到密码 / 账号 / 标题', async () => {
    const client = await setup();
    const item = await client.createItem({
      title: ITEM_TITLE,
      username: ITEM_USERNAME,
      password: ITEM_PASSWORD,
      category: '开发',
    });
    await client.copyPassword(item.id);
    await client.copyUsername(item.id);
    await client.revealPassword(item.id);
    await client.exportBackup('backup-pass-1234');
    // 记账（含 backup.export 审计）发生在确认落盘之后，这里补上，
    // 让审计日志里确实存在这条记录——否则下面几条"不包含明文"的断言
    // 会因为根本没有备份记录而空过。
    await client.confirmBackupSaved();

    const serialized = JSON.stringify(await client.getAuditLog());
    expect(serialized).not.toContain(ITEM_PASSWORD);
    expect(serialized).not.toContain(ITEM_USERNAME);
    expect(serialized).not.toContain(ITEM_TITLE);
    expect(serialized).not.toContain('backup-pass-1234');
  });

  it('跳转目标裁掉查询串，token 不进日志', async () => {
    const client = await setup();
    const item = await client.createItem({
      title: ITEM_TITLE,
      username: ITEM_USERNAME,
      password: ITEM_PASSWORD,
      url: JUMP_URL,
    });
    await client.recordJump(item.id, JUMP_URL);

    const [latest] = await client.getAuditLog();
    expect(latest.action).toBe('jump');
    expect(latest.detail).toBe('https://example.com/login');
    expect(JSON.stringify(await client.getAuditLog())).not.toContain('tok_live_12345');
  });

  it('可以主动清空', async () => {
    const client = await setup();
    await client.lock('manual');
    expect((await client.getAuditLog()).length).toBeGreaterThan(0);

    await client.clearAuditLog();
    expect(await client.getAuditLog()).toEqual([]);
  });

  it('销毁数据会连日志一起清掉（销毁的语义是不留痕迹）', async () => {
    const client = await setup();
    await client.createItem({
      title: ITEM_TITLE,
      username: ITEM_USERNAME,
      password: ITEM_PASSWORD,
    });
    expect((await client.getAuditLog()).length).toBeGreaterThan(0);

    await client.resetVault();

    expect(await client.getAuditLog()).toEqual([]);
  });
});
