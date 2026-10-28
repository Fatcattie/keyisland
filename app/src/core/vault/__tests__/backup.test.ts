/** KIB1 加密备份编解码测试。 */
import { describe, expect, it } from 'vitest';
import { exportBackup, importBackup, isBackupEnvelope, type BackupPayload } from '../backup';
import { createDefaultMeta } from '../../../services/storage';
import { ARGON2_TEST_PARAMS } from '../../crypto';

const payload: BackupPayload = {
  schemaVersion: 1,
  items: [],
  keyslots: {
    password: {
      slot: 'password', wrappedDek: 'wrapped-a', salt: 'salt-a', nonce: 'nonce-a',
      kdfParams: ARGON2_TEST_PARAMS, version: 1, updatedAt: 1,
    },
    recovery: {
      slot: 'recovery', wrappedDek: 'wrapped-b', salt: 'salt-b', nonce: 'nonce-b',
      kdfParams: ARGON2_TEST_PARAMS, version: 1, updatedAt: 1,
    },
  },
  meta: createDefaultMeta(1, '30m', 30_000, 'hint'),
  recency: [],
};

describe('KIB1 加密备份', () => {
  it('可导出并用同一密码导入，文件外层不含 payload 明文', async () => {
    const backup = await exportBackup('Backup!2026', payload, ARGON2_TEST_PARAMS);
    expect(isBackupEnvelope(backup)).toBe(true);
    expect(backup).not.toContain('hint');
    await expect(importBackup('Backup!2026', backup)).resolves.toEqual(payload);
  });

  it('错误密码和篡改内容均拒绝，且不返回部分 payload', async () => {
    const backup = await exportBackup('Backup!2026', payload, ARGON2_TEST_PARAMS);
    await expect(importBackup('Wrong!2026', backup)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const envelope = JSON.parse(backup) as { payload: string };
    envelope.payload = `${envelope.payload.slice(0, -2)}AA`;
    await expect(importBackup('Backup!2026', JSON.stringify(envelope))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('拒绝非法 magic/version/JSON', async () => {
    await expect(importBackup('Backup!2026', '{}')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(importBackup('Backup!2026', '{"magic":"BAD"}')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(isBackupEnvelope('not-json')).toBe(false);
  });
});
