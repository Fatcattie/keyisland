/**
 * 用恢复码重新生成 `.kirk`（`exportRecoveryKirk`）。
 *
 * 契约：
 * 1. 产出的文件是**真钥匙**——拿它走 `recoverWithKirk` 必须能通过；
 * 2. 它不是轮换：旧恢复码、主密码、密钥槽都不变，会话状态也不变；
 * 3. 不写任何存储（导出是纯派生，`saveKeyslots` 坏了也必须成功）；
 * 4. 码不对 → `RECOVERY_INVALID`，且**不产出文件**（否则等于发一把假钥匙）。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { createVaultClient, type VaultClient } from '../vault-client';
import type { VaultStorage } from '../storage';
import { FaultyStorage, FakeClipboardPort } from './support/fakes';

const NOW = 1_700_000_000_000;
const MASTER = 'Alpha-Bravo-7788';

function makeClient(storage: VaultStorage): VaultClient {
  return createVaultClient({
    storage,
    now: () => NOW,
    clipboard: new FakeClipboardPort(),
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
    autoLockPolicy: '30m',
  });
}

describe('FR-08.1 · 用恢复码重新生成 .kirk', () => {
  it('产出的 .kirk 能直接用于恢复（是同一把钥匙，不是摆设）', async () => {
    const storage = new FaultyStorage();
    const client = makeClient(storage);
    const init = await client.initialize({ masterPassword: MASTER });

    const exported = await client.exportRecoveryKirk(init.recoveryCode);

    expect(exported.kirkJson).toContain('KIRK1');
    expect(exported.recoveryCode).toBe(init.recoveryCode);

    // 换一个门面读磁盘：文件必须在"另一台机器"上也能用。
    const reopened = makeClient(storage);
    await expect(reopened.recoverWithKirk(exported.kirkJson)).resolves.toMatchObject({
      verified: true,
    });
  });

  it('不是轮换：旧恢复码与主密码都继续有效，会话不被踢', async () => {
    const storage = new FaultyStorage();
    const client = makeClient(storage);
    const init = await client.initialize({ masterPassword: MASTER });

    const exported = await client.exportRecoveryKirk(init.recoveryCode);

    expect(exported.kirkJson).toContain('KIRK1');
    // 会话没被打断：导出不是高危操作。
    expect((await client.status()).status).toBe('unlocked');

    // 换一个门面读磁盘：密钥槽一个字节都没动，两把钥匙都还认。
    const reopened = makeClient(storage);
    await expect(reopened.recover(init.recoveryCode)).resolves.toMatchObject({ verified: true });
    await expect(reopened.unlock(MASTER)).resolves.toMatchObject({ status: 'unlocked' });
  });

  it('不写存储：saveKeyslots 故障时导出照样成功', async () => {
    const storage = new FaultyStorage();
    const client = makeClient(storage);
    const init = await client.initialize({ masterPassword: MASTER });

    storage.failures.add('saveKeyslots');
    storage.failures.add('saveMeta');
    const exported = await client.exportRecoveryKirk(init.recoveryCode);
    storage.failures.clear();

    expect(exported.kirkJson).toContain('KIRK1');
  });

  it('恢复码错误：报 RECOVERY_INVALID，不产出文件', async () => {
    const storage = new FaultyStorage();
    const client = makeClient(storage);
    await client.initialize({ masterPassword: MASTER });

    await expect(client.exportRecoveryKirk('0000-0000-0000-0000-0000-0000-0000-0000'))
      .rejects.toMatchObject({ code: 'RECOVERY_INVALID' });
  });

  it('恢复码写法不敏感：小写与无分隔符都能识别，回显规范化后的标准写法', async () => {
    const storage = new FaultyStorage();
    const client = makeClient(storage);
    const init = await client.initialize({ masterPassword: MASTER });

    const messy = init.recoveryCode.replace(/-/gu, '').toLowerCase();
    const exported = await client.exportRecoveryKirk(messy);

    // 回显的是规范化后的标准写法，用户能拿它和自己抄的那串逐位比对。
    expect(exported.recoveryCode).toBe(init.recoveryCode);
  });

  it('记一条 recovery.export 审计', async () => {
    const storage = new FaultyStorage();
    const client = makeClient(storage);
    const init = await client.initialize({ masterPassword: MASTER });

    await client.exportRecoveryKirk(init.recoveryCode);

    const entries = await client.getAuditLog();
    expect(entries.some((entry) => entry.action === 'recovery.export')).toBe(true);
  });
});
