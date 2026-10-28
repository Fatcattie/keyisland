/**
 * 备份提醒（PRD FR-06「超过 7 天未备份时，当日首次锁定前轻提示一次」）。
 *
 * 契约：
 * 1. 刚建库不催（基准是"上次备份时间，从未备份则用库创建时间"）；
 * 2. 超过 7 天 → `overdue`，提醒文案分两种（从未备份 / 已 N 天）；
 * 3. 同一自然日只提醒一次，次日恢复；
 * 4. 导出成功即记账，`overdue` 立刻归零——提醒必须能被行动消掉，
 *    否则用户备份完了还天天被催，很快就不看了。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { createVaultClient, type VaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const MASTER = 'Alpha-Bravo-7788';

/** 时钟可推进的门面。 */
function makeClient(clock: () => number): VaultClient {
  return createVaultClient({
    storage: new MemoryVaultStorage(),
    now: clock,
    clipboard: new FakeClipboardPort(),
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
    autoLockPolicy: 'boot',
  });
}

describe('FR-06 · 备份提醒', () => {
  it('刚建库不催：未满 7 天不提醒', async () => {
    const client = makeClient(() => NOW);
    await client.initialize({ masterPassword: MASTER });

    const status = await client.getBackupStatus();
    expect(status.lastBackupAt).toBeNull();
    expect(status.daysSinceBackup).toBe(0);
    expect(status.overdue).toBe(false);
    expect(await client.takeBackupReminder()).toBeNull();
  });

  it('超过 7 天：提醒一次，同日不再重复，次日恢复', async () => {
    let now = NOW;
    const client = makeClient(() => now);
    await client.initialize({ masterPassword: MASTER });

    now += 8 * DAY;
    const status = await client.getBackupStatus();
    expect(status.overdue).toBe(true);
    expect(status.daysSinceBackup).toBe(8);

    expect(await client.takeBackupReminder()).toContain('还没有导出过备份');
    // 同一天第二次锁定不再打扰。
    expect(await client.takeBackupReminder()).toBeNull();

    now += DAY;
    expect(await client.takeBackupReminder()).not.toBeNull();
  });

  it('确认落盘后记账：overdue 归零，提醒不再触发', async () => {
    let now = NOW;
    const client = makeClient(() => now);
    await client.initialize({ masterPassword: MASTER });

    now += 9 * DAY;
    expect((await client.getBackupStatus()).overdue).toBe(true);

    await client.exportBackup('backup-pass-1234');
    // 记账在"确认文件已落盘"之后，不在导出时。
    await client.confirmBackupSaved();

    const after = await client.getBackupStatus();
    expect(after.lastBackupAt).toBe(now);
    expect(after.daysSinceBackup).toBe(0);
    expect(after.overdue).toBe(false);
    expect(await client.takeBackupReminder()).toBeNull();
  });

  it('只导出、不确认落盘：不记账，超期提醒照旧', async () => {
    let now = NOW;
    const client = makeClient(() => now);
    await client.initialize({ masterPassword: MASTER });

    now += 9 * DAY;
    await client.exportBackup('backup-pass-1234');

    // 调用方可能保存失败（下载被拦、磁盘满、用户取消对话框）。那种情况下
    // 用户手上什么都没有，绝不能记成"已备份"——否则提醒会被静默重置 7 天。
    const after = await client.getBackupStatus();
    expect(after.lastBackupAt).toBeNull();
    expect(after.overdue).toBe(true);
  });

  it('备份过之后再超期：文案带天数', async () => {
    let now = NOW;
    const client = makeClient(() => now);
    await client.initialize({ masterPassword: MASTER });
    await client.exportBackup('backup-pass-1234');
    await client.confirmBackupSaved();

    now += 9 * DAY;
    expect(await client.takeBackupReminder()).toContain('9 天');
  });
});
