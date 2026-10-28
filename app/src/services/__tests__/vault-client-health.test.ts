/**
 * `auditPasswordHealth` 门面测试。
 *
 * 覆盖：重复分组、弱密码、长期未修改、锁定态拒绝，以及"报告不含明文"。
 */
import { describe, expect, it } from 'vitest';
import { createTestClient } from '../../features/__tests__/support/harness';
import { STALE_PASSWORD_DAYS } from '../../core/vault/health';

const MASTER = 'Alpha-Bravo-7788';
const SHARED = 'Same-Pass-1';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('VaultClient.auditPasswordHealth', () => {
  it('解锁态返回重复分组与标题，锁定态抛 VAULT_LOCKED', async () => {
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER });
    await client.createItem({ title: 'GitHub', username: 'dev@example.com', password: SHARED });
    await client.createItem({ title: 'GitLab', username: 'dev@example.com', password: SHARED });
    await client.createItem({ title: '邮箱', username: 'me@example.com', password: 'Unique-Pass-2' });

    const report = await client.auditPasswordHealth();
    expect(report.totalItems).toBe(3);
    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0].itemIds).toHaveLength(2);
    expect(report.duplicates[0].titles).toEqual(['GitHub', 'GitLab']);
    expect(report.weak).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(SHARED);

    await client.lock('manual');
    await expect(client.auditPasswordHealth()).rejects.toThrow();
  });

  it('弱密码被标出', async () => {
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER });
    await client.createItem({ title: '弱卡', username: 'weak@example.com', password: '123' });

    const report = await client.auditPasswordHealth();
    expect(report.weak).toHaveLength(1);
    expect(report.weak[0].title).toBe('弱卡');
    expect(JSON.stringify(report)).not.toContain('123');
  });

  it('超过阈值未修改的密码被标出（注入时钟推进）', async () => {
    const { client, advance } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER });
    await client.createItem({ title: '老卡', username: 'old@example.com', password: 'Old-Pass-1' });

    const before = await client.auditPasswordHealth();
    expect(before.stale).toEqual([]);

    advance((STALE_PASSWORD_DAYS + 10) * DAY_MS);
    const after = await client.auditPasswordHealth();
    expect(after.stale).toHaveLength(1);
    expect(after.stale[0].title).toBe('老卡');
  });
});
