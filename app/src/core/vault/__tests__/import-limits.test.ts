/**
 * 任务 4：导入资源上限。
 *
 * 覆盖：限制以内、恰好边界、超过边界、损坏文件、粘贴绕过 UI 直接走领域入口；
 * 被拒时当前库（资产、密钥槽、元数据）保持原样，之后仍可继续操作。
 */

import { describe, expect, it, vi } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../crypto';
import * as kdf from '../../crypto/kdf';
import { exportAssetTransfer, importAssetTransfer } from '../asset-transfer';
import { exportBackup, importBackup, type BackupPayload } from '../backup';
import { parseCsvRows, previewCsvImport } from '../csv-import';
import {
  IMPORT_LIMITS,
  assertFileWithinLimit,
  assertTextWithinLimit,
  isImportKdfWithinLimit,
} from '../import-limits';
import { parseKirkFile } from '../recovery';
import { readTextFile } from '../../../lib/read-text-file';
import { MemoryVaultStorage } from '../../../services/storage';
import { createVaultClient } from '../../../services/vault-client';

const PASSWORD = 'Limits-Backup-1';

describe('上限判定 · 边界', () => {
  it('文本：恰好等于上限放行，多 1 个字符拒绝', () => {
    expect(() => assertTextWithinLimit('x'.repeat(100), 100)).not.toThrow();
    expect(() => assertTextWithinLimit('x'.repeat(101), 100)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED', messageKey: 'error.import_too_large' }),
    );
  });

  it('文件：按 File.size 判定，恰好等于上限放行，多 1 字节拒绝', () => {
    expect(() => assertFileWithinLimit({ size: 100 }, 100)).not.toThrow();
    expect(() => assertFileWithinLimit({ size: 101 }, 100)).toThrow(
      expect.objectContaining({ messageKey: 'error.import_too_large' }),
    );
    expect(() => assertFileWithinLimit({ size: Number.NaN }, 100)).toThrow();
  });

  it('KDF：默认参数与测试参数在导入上限内；超过 256 MiB 内存、10 轮、8 线程的被拒', () => {
    expect(isImportKdfWithinLimit(kdf.ARGON2_PARAMS_V1)).toBe(true);
    expect(isImportKdfWithinLimit(ARGON2_TEST_PARAMS)).toBe(true);
    expect(isImportKdfWithinLimit({ ...kdf.ARGON2_PARAMS_V1, memoryKiB: IMPORT_LIMITS.kdfMemoryKiBMax })).toBe(true);
    expect(isImportKdfWithinLimit({ ...kdf.ARGON2_PARAMS_V1, memoryKiB: IMPORT_LIMITS.kdfMemoryKiBMax + 1 })).toBe(false);
    expect(isImportKdfWithinLimit({ ...kdf.ARGON2_PARAMS_V1, iterations: 11 })).toBe(false);
    expect(isImportKdfWithinLimit({ ...kdf.ARGON2_PARAMS_V1, parallelism: 9 })).toBe(false);
  });
});

describe('文件读取 · 读之前先拒绝', () => {
  it('超限文件一个字节都不读', async () => {
    const text = vi.fn(async () => 'never');
    const file = { size: IMPORT_LIMITS.backupMaxBytes + 1, text } as unknown as File;
    await expect(readTextFile(file, IMPORT_LIMITS.backupMaxBytes)).rejects.toMatchObject({
      messageKey: 'error.import_too_large',
    });
    expect(text).not.toHaveBeenCalled();
  });

  it('恰好等于上限的文件照常读取', async () => {
    const text = vi.fn(async () => 'content');
    const file = { size: IMPORT_LIMITS.backupMaxBytes, text } as unknown as File;
    await expect(readTextFile(file, IMPORT_LIMITS.backupMaxBytes)).resolves.toBe('content');
  });
});

describe('领域入口 · 粘贴也绕不过', () => {
  it('超大 .kib 文本在 JSON.parse 与 KDF 之前就被拒（报"太大"而不是"无效"）', async () => {
    const derive = vi.spyOn(kdf, 'deriveKey');
    const huge = '{' + ' '.repeat(IMPORT_LIMITS.backupMaxBytes) + '}';
    await expect(importBackup(PASSWORD, huge)).rejects.toMatchObject({ messageKey: 'error.import_too_large' });
    expect(derive).not.toHaveBeenCalled();
  });

  it('超大 .kia 文本同样在解析前被拒', async () => {
    const huge = 'x'.repeat(IMPORT_LIMITS.assetBundleMaxBytes + 1);
    await expect(importAssetTransfer(PASSWORD, huge)).rejects.toMatchObject({ messageKey: 'error.import_too_large' });
  });

  it('文件声明的 KDF 内存超过导入上限：不派生，直接判为无效', async () => {
    const derive = vi.spyOn(kdf, 'deriveKey');
    const envelope = JSON.stringify({
      magic: 'KIB1',
      version: 1,
      kdfParams: { ...kdf.ARGON2_PARAMS_V1, memoryKiB: 1024 * 1024 },
      salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
      nonce: 'AAAAAAAAAAAAAAAA',
      payload: 'AAAA',
    });
    await expect(importBackup(PASSWORD, envelope)).rejects.toMatchObject({ messageKey: 'error.backup_invalid' });
    expect(derive).not.toHaveBeenCalled();
  });

  it('备份内密钥槽的 KDF 超过导入上限：解密后、落盘前拒绝', async () => {
    const bloated = { ...kdf.ARGON2_PARAMS_V1, memoryKiB: 512 * 1024 };
    const slot = { wrappedDek: 'AA==', salt: 'AA==', nonce: 'AA==', kdfParams: bloated, version: 1, updatedAt: 1 };
    const payload = {
      schemaVersion: 1,
      keyslots: { password: { ...slot, slot: 'password' }, recovery: { ...slot, slot: 'recovery' } },
      meta: { schemaVersion: 1 },
      items: [],
      recency: [],
    } as unknown as BackupPayload;
    const file = await exportBackup(PASSWORD, payload, ARGON2_TEST_PARAMS);
    await expect(importBackup(PASSWORD, file)).rejects.toMatchObject({ messageKey: 'error.backup_invalid' });
  });

  it('条目数：恰好 2 万张放行，2 万零 1 张报"太多"', async () => {
    const item = {
      title: 't',
      platform: null,
      url: null,
      appPath: null,
      notes: null,
      username: 'u',
      password: 'p',
      category: '其他',
      tags: [],
      visibility: 'normal' as const,
      favorite: false,
    };
    const ok = await exportAssetTransfer(PASSWORD, { schemaVersion: 1, items: Array.from({ length: IMPORT_LIMITS.maxItems }, () => item) }, ARGON2_TEST_PARAMS);
    await expect(importAssetTransfer(PASSWORD, ok)).resolves.toMatchObject({ items: expect.any(Array) });
    const tooMany = await exportAssetTransfer(
      PASSWORD,
      { schemaVersion: 1, items: Array.from({ length: IMPORT_LIMITS.maxItems + 1 }, () => item) },
      ARGON2_TEST_PARAMS,
    );
    await expect(importAssetTransfer(PASSWORD, tooMany)).rejects.toMatchObject({
      messageKey: 'error.import_too_many_items',
    });
  }, 60_000);

  it('损坏文件：仍报"无效"，不被上限检查误判', async () => {
    await expect(importBackup(PASSWORD, '{ 坏掉的')).rejects.toMatchObject({ messageKey: 'error.backup_invalid' });
  });

  it('CSV：超大文本在逐字符解析前拒绝；数据行恰好 2 万放行，多 1 行拒绝', () => {
    expect(() => parseCsvRows('x'.repeat(IMPORT_LIMITS.csvMaxBytes + 1))).toThrow(
      expect.objectContaining({ messageKey: 'error.import_too_large' }),
    );
    const header = 'name,username,password\n';
    const rows = (count: number): string => header + 'a,b,c\n'.repeat(count);
    expect(previewCsvImport(rows(IMPORT_LIMITS.maxItems)).items).toHaveLength(IMPORT_LIMITS.maxItems);
    expect(() => previewCsvImport(rows(IMPORT_LIMITS.maxItems + 1))).toThrow(
      expect.objectContaining({ messageKey: 'error.import_too_many_items' }),
    );
  });

  it('.kirk：超过 64 KiB 的输入在解析前判为无效恢复文件', () => {
    expect(() => parseKirkFile('{' + ' '.repeat(IMPORT_LIMITS.kirkMaxBytes) + '}')).toThrow(
      expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }),
    );
  });
});

describe('被拒后当前库保持原样', () => {
  it('超大备份 / 资产包 / CSV 被拒后：资产、密钥槽、元数据不变，仍可继续操作', async () => {
    const storage = new MemoryVaultStorage();
    const client = createVaultClient({
      storage,
      clipboard: { write: async () => {}, read: async () => null, clear: async () => {} },
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });
    await client.initialize({ masterPassword: 'Limits-Master-1' });
    await client.createItem({ title: '保留', username: 'k@example.test', password: 'Keep-1-synthetic!' });
    const before = {
      keyslots: await storage.loadKeyslots(),
      meta: await storage.loadMeta(),
      items: await storage.loadItems(),
    };
    const commit = vi.spyOn(storage, 'commit');
    const apply = vi.spyOn(storage, 'applyItemChanges');

    const huge = 'x'.repeat(IMPORT_LIMITS.backupMaxBytes + 1);
    await expect(
      client.importBackup({ kirkJson: huge, password: PASSWORD, mode: 'overwrite', masterPassword: 'Limits-Master-1' }),
    ).rejects.toMatchObject({ messageKey: 'error.import_too_large' });
    await expect(client.importAssetBundle(PASSWORD, huge)).rejects.toMatchObject({
      messageKey: 'error.import_too_large',
    });
    const tooMany = Array.from({ length: IMPORT_LIMITS.maxItems + 1 }, (_, index) => ({
      title: `t${index}`,
      username: 'u',
      password: 'Synthetic-1-Aa!',
    }));
    await expect(client.importCsvItems(tooMany)).rejects.toMatchObject({ messageKey: 'error.import_too_many_items' });

    expect(commit).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(await storage.loadKeyslots()).toEqual(before.keyslots);
    expect(await storage.loadMeta()).toEqual(before.meta);
    expect(await storage.loadItems()).toEqual(before.items);
    // 界面仍可继续操作。
    await expect(
      client.createItem({ title: '之后', username: 'n@example.test', password: 'Next-2-synthetic!' }),
    ).resolves.toMatchObject({ title: '之后' });
    await client.dispose();
  });
});
