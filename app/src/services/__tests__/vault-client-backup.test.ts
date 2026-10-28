/** VaultClient 备份导出 / 导入集成测试（SDD §9）。 */
import { describe, expect, it } from 'vitest';
import { createVaultClient } from '../vault-client';
import { FaultyStorage } from './support/fakes';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { createTestClient } from '../../features/__tests__/support/harness';

const MASTER = 'Master!2026';
const BACKUP_PASSWORD = 'Backup!2026';

describe('VaultClient 备份导出 / 导入', () => {
  it('导出 .kib 后可在另一台"机器"上覆盖导入并恢复全部资产，且导入后回到锁定态', async () => {
    const { client } = createTestClient();
    await client.initialize({ masterPassword: MASTER });
    await client.createItem({
      title: 'GitHub',
      platform: 'GitHub',
      url: 'https://github.com',
      username: 'dev@example.com',
      password: 'Pass-1-Aa1!',
      category: '开发',
      tags: ['git'],
    });
    await client.createItem({
      title: '公司邮箱',
      username: 'me@example.com',
      password: 'Pass-2-Bb2!',
      category: '工作',
      visibility: 'username_only',
    });

    const backup = await client.exportBackup(BACKUP_PASSWORD);
    // 备份文件里既不能有密码明文，也不能有账号明文。
    expect(backup).not.toContain('Pass-1-Aa1!');
    expect(backup).not.toContain('dev@example.com');

    // 模拟新库：先初始化一个空库，再用备份覆盖。
    const target = createTestClient();
    await target.client.initialize({ masterPassword: 'Another!2026' });
    const result = await target.client.importBackup({
      kirkJson: backup,
      password: BACKUP_PASSWORD,
      mode: 'overwrite',
      // 覆盖导入要验证的是"当前库"的主密码。
      masterPassword: 'Another!2026',
    });

    expect(result.mode).toBe('overwrite');
    expect(result.totalItems).toBe(2);
    // 覆盖导入后必须回到锁定态（SDD §9.2）。
    expect((await target.client.status()).status).toBe('locked');
    // 密钥槽同样来自备份：原库主密码失效，原备份主密码是导出时那个。
    await expect(target.client.unlock('Another!2026')).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    await expect(target.client.unlock(MASTER)).resolves.toMatchObject({ status: 'unlocked' });
    const restored = await target.client.listItems();
    expect(restored).toHaveLength(2);
    expect(restored.map((item) => item.title).sort()).toEqual(['GitHub', '公司邮箱']);
  });

  it('锁定态导出被拒绝', async () => {
    const { client } = createTestClient();
    await client.initialize({ masterPassword: MASTER });
    await client.lock('manual');
    await expect(client.exportBackup(BACKUP_PASSWORD)).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
  });

  it('空备份密码、错误备份密码、损坏文件一律拒绝，且当前库保持不变', async () => {
    const { client } = createTestClient();
    await client.initialize({ masterPassword: MASTER });
    await client.createItem({ title: 'GitHub', username: 'dev@example.com', password: 'Pass-1-Aa1!' });
    const backup = await client.exportBackup(BACKUP_PASSWORD);

    await expect(client.importBackup({ kirkJson: backup, password: '', mode: 'merge' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      client.importBackup({ kirkJson: backup, password: 'Wrong!2026', mode: 'merge' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const corrupted = JSON.parse(backup) as { payload: string };
    corrupted.payload = `${corrupted.payload.slice(0, -4)}AAAA`;
    await expect(
      client.importBackup({ kirkJson: JSON.stringify(corrupted), password: BACKUP_PASSWORD, mode: 'merge' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // 三次失败之后，库仍是导入前的 1 条资产。
    expect((await client.listItems()).length).toBe(1);
  });

  it('合并导入：内容一致跳过、同站点不同凭据记为冲突并保留当前版本、缺失资产按新 id 插入', async () => {
    const { client } = createTestClient();
    await client.initialize({ masterPassword: MASTER });
    await client.createItem({ title: 'GitHub', platform: 'GitHub', url: 'https://github.com', username: 'dev@example.com', password: 'Pass-1-Aa1!', category: '开发' });
    await client.createItem({ title: 'Gmail', platform: 'Gmail', url: 'https://mail.google.com', username: 'me@example.com', password: 'Pass-2-Bb2!', category: '社交' });
    const backup = await client.exportBackup(BACKUP_PASSWORD);

    // 第一轮：改动 GitHub 密码制造冲突；Gmail 内容一致。
    const github = (await client.listItems()).find((item) => item.title === 'GitHub');
    await client.updateItem(github!.id, { password: 'Different-9-Zz9!' });

    const before = await client.listItems();
    const first = await client.importBackup({ kirkJson: backup, password: BACKUP_PASSWORD, mode: 'merge' });

    expect(first.mode).toBe('merge');
    expect(first.skipped).toBe(1);
    expect(first.conflicts).toHaveLength(1);
    expect(first.conflicts[0].url).toBe('https://github.com');
    const afterFirst = await client.listItems();
    expect(afterFirst).toHaveLength(before.length);
    // 冲突项保留当前版本，备份里的旧密码没有被写回。
    const mergedGithub = afterFirst.find((item) => item.title === 'GitHub' && item.platform === 'GitHub');
    expect(mergedGithub).toBeDefined();
    await expect(client.revealPassword(mergedGithub!.id)).resolves.toBe('Different-9-Zz9!');

    // 第二轮：删掉 Gmail 后再合并 → 备份里缺失的资产按新 id 插回。
    const gmail = (await client.listItems()).find((item) => item.title === 'Gmail');
    await client.deleteItem(gmail!.id);
    const second = await client.importBackup({ kirkJson: backup, password: BACKUP_PASSWORD, mode: 'merge' });
    expect(second.inserted).toBe(1);
    const afterSecond = await client.listItems();
    expect(afterSecond).toHaveLength(before.length);
    expect(afterSecond.filter((item) => item.title === 'Gmail')).toHaveLength(1);
    // id 唯一，插入不会与现有 id 冲突。
    expect(new Set(afterSecond.map((item) => item.id)).size).toBe(afterSecond.length);
    await expect(client.revealPassword(afterSecond.find((item) => item.title === 'Gmail')!.id)).resolves.toBe('Pass-2-Bb2!');
  });

  it('跨库备份不能合并导入（DEK 世系不同），必须改用覆盖导入', async () => {
    const source = createTestClient();
    await source.client.initialize({ masterPassword: 'Source!2026' });
    await source.client.createItem({ title: 'GitHub', username: 'dev@example.com', password: 'Pass-1-Aa1!' });
    const foreign = await source.client.exportBackup(BACKUP_PASSWORD);

    const target = createTestClient();
    await target.client.initialize({ masterPassword: MASTER });
    await target.client.createItem({ title: 'Own', username: 'o@example.com', password: 'Own-1-Aa1!' });

    await expect(
      target.client.importBackup({ kirkJson: foreign, password: BACKUP_PASSWORD, mode: 'merge' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // 被拒绝后当前库不受影响。
    expect(await target.client.listItems()).toHaveLength(1);
    // 覆盖导入仍然可用。
    await expect(
      target.client.importBackup({
        kirkJson: foreign,
        password: BACKUP_PASSWORD,
        mode: 'overwrite',
        masterPassword: MASTER,
      }),
    ).resolves.toMatchObject({ mode: 'overwrite', totalItems: 1 });
  });

  it('覆盖导入必须提供当前库主密码，错误密码拒绝且不替换密钥槽', async () => {
    const { client } = createTestClient();
    await client.initialize({ masterPassword: MASTER });
    await client.createItem({ title: 'Own', username: 'o@example.com', password: 'Own-1-Aa1!' });
    const backup = await client.exportBackup(BACKUP_PASSWORD);

    // 缺主密码：直接拒绝，库里什么都没动。
    await expect(
      client.importBackup({ kirkJson: backup, password: BACKUP_PASSWORD, mode: 'overwrite' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // 错误主密码：拒绝，且当前库主密码仍然有效。
    await expect(
      client.importBackup({ kirkJson: backup, password: BACKUP_PASSWORD, mode: 'overwrite', masterPassword: 'Wrong!2026' }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    expect(await client.listItems()).toHaveLength(1);

    await client.lock('manual');
    await expect(client.unlock(MASTER)).resolves.toMatchObject({ status: 'unlocked' });
  });

  it('覆盖导入写库失败时回滚到导入前数据，并报 STORAGE_FAILED', async () => {
    const storage = new FaultyStorage();
    const faulty = createVaultClient({
      storage,
      now: () => 1_700_000_000_000,
      clipboard: { write: async () => {}, read: async () => null, clear: async () => {} },
      clipboardTtlMs: 30_000,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });
    await faulty.initialize({ masterPassword: MASTER });
    await faulty.createItem({ title: 'Own', username: 'o@example.com', password: 'Own-1-Aa1!' });
    const backup = await faulty.exportBackup(BACKUP_PASSWORD);

    // 覆盖导入会在"保存元数据"这一步失败。
    storage.failures.add('saveMeta');
    await expect(
      faulty.importBackup({
        kirkJson: backup,
        password: BACKUP_PASSWORD,
        mode: 'overwrite',
        masterPassword: MASTER,
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_FAILED' });

    storage.failures.delete('saveMeta');
    // 回滚后：资产还是导入前那一条，主密码也没被备份替换。
    const list = await faulty.listItems();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Own');
    await faulty.lock('manual');
    await expect(faulty.unlock(MASTER)).resolves.toMatchObject({ status: 'unlocked' });
  });
});
