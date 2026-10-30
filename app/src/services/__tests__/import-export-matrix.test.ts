/**
 * 导入导出链路的验收矩阵：CSV / `.kia` / `.kib` × 状态。
 *
 * **为什么单独一个文件**：0.1.9 → 0.1.13 连发五个补丁版，漏掉的都是「某条路径
 * 在某个状态下没人走过」。零散用例只证明了各自的 happy path 与个别错误分支，
 * 没有一张按路径 × 状态的表，所以「改完 A 路径顺手动了共享函数、B 路径塌了」
 * 这种回归只能靠人肉想起来。这里每条状态一个 it，失败时一眼看出是哪一格塌了。
 *
 * **三条路径的语义差异（不要混，混了就是数据事故）**：
 * - CSV：明文进、只追加、按内容签名去重、可指定默认分类与隐私档位；
 * - `.kia`：密文包进、只追加、按内容签名去重、跨库主密码可以不同；
 * - `.kib`：完整库（含密钥槽），`overwrite` 需当前主密码二次确认，
 *   `merge` 要求同 DEK 世系，冲突时保留当前库版本。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { AppError } from '../../core/errors';
import { previewCsvImport } from '../../core/vault/csv-import';
import { MemoryVaultStorage } from '../storage';
import { createVaultClient, type VaultClient } from '../vault-client';

const MASTER = 'KeyIsland-test-Password-42!';
const OTHER = 'Another-Vault-Password-99!';
const WEAK_ENOUGH = 'Pass-1-Aa1!';

function newClient(storage: MemoryVaultStorage = new MemoryVaultStorage()): VaultClient {
  return createVaultClient({
    storage,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
  });
}

/** 断言抛出指定错误码（可选断言 messageKey）。 */
async function expectCode(promise: Promise<unknown>, code: string, messageKey?: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(AppError.isAppError(error)).toBe(true);
    const appError = error as AppError;
    expect(appError.code).toBe(code);
    if (messageKey !== undefined) {
      expect(appError.messageKey).toBe(messageKey);
    }
    return;
  }
  throw new Error(`期望抛出 ${code}，但调用成功返回`);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const CSV_ONE_ROW = ['name,username,password', `GitHub,octocat,${WEAK_ENOUGH}`].join('\n');

describe('验收矩阵 · CSV 导入', () => {
  it('空输入返回 0/0，且不碰库', async () => {
    const client = newClient();
    await client.initialize({ masterPassword: MASTER });
    await client.createItem({ title: 'Keep', username: 'u', password: WEAK_ENOUGH });

    await expect(client.importCsvItems([])).resolves.toEqual({ inserted: 0, skipped: 0 });
    await expect(client.listItems()).resolves.toHaveLength(1);
  });

  it('同一批里两条一模一样的行，只插入一条', async () => {
    const client = newClient();
    await client.initialize({ masterPassword: MASTER });
    const csv = ['name,username,password', `GitHub,octocat,${WEAK_ENOUGH}`, `GitHub,octocat,${WEAK_ENOUGH}`].join('\n');
    const items = previewCsvImport(csv).items;
    // 预览层不做去重（它只负责解析），去重发生在写入层。
    expect(items).toHaveLength(2);

    await expect(client.importCsvItems(items)).resolves.toEqual({ inserted: 1, skipped: 1 });
    await expect(client.listItems()).resolves.toHaveLength(1);
  });

  it('选了隐藏档位后，能认出库里已存在的隐藏卡片（不造看不见的重复）', async () => {
    const client = newClient();
    await client.initialize({ masterPassword: MASTER });
    await client.createItem({
      title: 'GitHub',
      username: 'octocat',
      password: WEAK_ENOUGH,
      visibility: 'hidden',
    });

    const items = previewCsvImport(CSV_ONE_ROW, undefined, { defaultVisibility: 'hidden' }).items;
    // 隐藏卡片不参与列表展示，但参与去重比对——否则用户会得到一张自己看不见的重复卡。
    await expect(client.importCsvItems(items)).resolves.toEqual({ inserted: 0, skipped: 1 });
  });

  it('档位不同就不算重复：同样的账号密码，普通与隐藏各留一张', async () => {
    const client = newClient();
    await client.initialize({ masterPassword: MASTER });
    await client.createItem({ title: 'GitHub', username: 'octocat', password: WEAK_ENOUGH });

    const items = previewCsvImport(CSV_ONE_ROW, undefined, { defaultVisibility: 'hidden' }).items;
    await expect(client.importCsvItems(items)).resolves.toEqual({ inserted: 1, skipped: 0 });
  });
});

// ---------------------------------------------------------------------------
// .kia
// ---------------------------------------------------------------------------

describe('验收矩阵 · .kia 资产迁移', () => {
  it('空库导出的包导入后什么都不加', async () => {
    const source = newClient();
    await source.initialize({ masterPassword: MASTER });
    const bundle = await source.exportAssetBundle(MASTER);

    const target = newClient();
    await target.initialize({ masterPassword: OTHER });
    await expect(target.importAssetBundle(MASTER, bundle)).resolves.toEqual({ inserted: 0, skipped: 0 });
    await expect(target.listItems()).resolves.toHaveLength(0);
  });

  it('包内两条完全相同的条目，只追加一条', async () => {
    const source = newClient();
    await source.initialize({ masterPassword: MASTER });
    // 源库允许同内容两张卡（createItem 不去重），导出的包里就会有两条相同条目。
    await source.createItem({ title: 'GitHub', username: 'octocat', password: WEAK_ENOUGH });
    await source.createItem({ title: 'GitHub', username: 'octocat', password: WEAK_ENOUGH });
    const bundle = await source.exportAssetBundle(MASTER);

    const target = newClient();
    await target.initialize({ masterPassword: OTHER });
    await expect(target.importAssetBundle(MASTER, bundle)).resolves.toEqual({ inserted: 1, skipped: 1 });
    await expect(target.listItems()).resolves.toHaveLength(1);
  });

  it('导入后的 id 与目标库已有 id 不冲突', async () => {
    const source = newClient();
    await source.initialize({ masterPassword: MASTER });
    await source.createItem({ title: 'FromSource', username: 'u1', password: WEAK_ENOUGH });
    const bundle = await source.exportAssetBundle(MASTER);

    const target = newClient();
    await target.initialize({ masterPassword: OTHER });
    await target.createItem({ title: 'Local', username: 'u2', password: WEAK_ENOUGH });

    await target.importAssetBundle(MASTER, bundle);
    const list = await target.listItems();
    expect(list).toHaveLength(2);
    expect(new Set(list.map((item) => item.id)).size).toBe(2);
  });

  it('未解锁时导出与导入都拒绝', async () => {
    const client = newClient();
    await client.initialize({ masterPassword: MASTER });
    await client.createItem({ title: 'GitHub', username: 'octocat', password: WEAK_ENOUGH });
    const bundle = await client.exportAssetBundle(MASTER);
    await client.lock();

    await expectCode(client.exportAssetBundle(MASTER), 'VAULT_LOCKED');
    await expectCode(client.importAssetBundle(MASTER, bundle), 'VAULT_LOCKED');
  });

  it('把完整库备份（.kib）当资产包导入会被拒绝，且库不变', async () => {
    const source = newClient();
    await source.initialize({ masterPassword: MASTER });
    await source.createItem({ title: 'GitHub', username: 'octocat', password: WEAK_ENOUGH });
    const kib = await source.exportBackup(MASTER);

    const target = newClient();
    await target.initialize({ masterPassword: OTHER });
    await target.createItem({ title: 'Local', username: 'u', password: WEAK_ENOUGH });

    await expect(target.importAssetBundle(MASTER, kib)).rejects.toThrow();
    await expect(target.listItems()).resolves.toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// .kib
// ---------------------------------------------------------------------------

describe('验收矩阵 · .kib 完整备份恢复', () => {
  /** 造一个含一张卡的备份，并返回它的文本。 */
  async function makeBackup(password = MASTER): Promise<string> {
    const source = newClient();
    await source.initialize({ masterPassword: password });
    await source.createItem({ title: 'GitHub', username: 'octocat', password: WEAK_ENOUGH });
    return source.exportBackup(password);
  }

  it('overwrite 缺少当前主密码时拒绝（二次确认不能省）', async () => {
    const kib = await makeBackup();
    const client = newClient();
    await client.initialize({ masterPassword: OTHER });

    await expectCode(
      client.importBackup({ kirkJson: kib, password: MASTER, mode: 'overwrite' }),
      'VALIDATION_FAILED',
      'error.password_required',
    );
  });

  it('overwrite 用错误主密码时拒绝，当前库内容不变', async () => {
    const kib = await makeBackup();
    const client = newClient();
    await client.initialize({ masterPassword: OTHER });
    await client.createItem({ title: 'Local', username: 'u', password: WEAK_ENOUGH });

    await expect(
      client.importBackup({
        kirkJson: kib,
        password: MASTER,
        mode: 'overwrite',
        masterPassword: 'Wrong-Password-00!',
      }),
    ).rejects.toThrow();
    await expect(client.listItems()).resolves.toHaveLength(1);
  });

  it('overwrite 成功后，库内容与主密码都换成备份里的', async () => {
    const kib = await makeBackup(MASTER);
    const storage = new MemoryVaultStorage();
    const target = newClient(storage);
    await target.initialize({ masterPassword: OTHER });
    await target.createItem({ title: 'Local', username: 'u', password: WEAK_ENOUGH });

    const result = await target.importBackup({
      kirkJson: kib,
      password: MASTER,
      mode: 'overwrite',
      masterPassword: OTHER,
    });
    expect(result).toMatchObject({ mode: 'overwrite', totalItems: 1, inserted: 1, skipped: 0 });

    // 换一个 client 读同一份存储：只能用备份库的主密码打开，说明密钥槽真的被换掉了。
    const reopened = newClient(storage);
    await reopened.unlock(MASTER);
    await expect(reopened.listItems()).resolves.toHaveLength(1);
  });

  it('merge 跨密钥世系时拒绝（密文在当前会话里解不开，不能硬合）', async () => {
    const kib = await makeBackup(MASTER);
    const client = newClient();
    await client.initialize({ masterPassword: OTHER });
    await client.createItem({ title: 'Local', username: 'u', password: WEAK_ENOUGH });

    await expectCode(
      client.importBackup({ kirkJson: kib, password: MASTER, mode: 'merge' }),
      'VALIDATION_FAILED',
      'error.backup_merge_unsupported',
    );
    await expect(client.listItems()).resolves.toHaveLength(1);
  });

  it('merge 同世系：删掉的卡片回来，还在的跳过', async () => {
    const client = newClient();
    await client.initialize({ masterPassword: MASTER });
    await client.createItem({ title: 'GitHub', username: 'octocat', password: WEAK_ENOUGH });
    await client.createItem({ title: 'GitLab', username: 'tanuki', password: WEAK_ENOUGH });
    const kib = await client.exportBackup(MASTER);

    const gitlab = (await client.listItems()).find((item) => item.title === 'GitLab');
    expect(gitlab).toBeDefined();
    await client.deleteItem(gitlab!.id);

    const result = await client.importBackup({ kirkJson: kib, password: MASTER, mode: 'merge' });
    expect(result).toMatchObject({ mode: 'merge', totalItems: 2, inserted: 1, skipped: 1, conflicts: [] });
  });

  it('两张只填了名称的卡片不算同一站点（否则恢复备份会静默丢卡）', async () => {
    const client = newClient();
    await client.initialize({ masterPassword: MASTER });
    // 最常见的填法：只填名称、账号、密码，平台和网址都留空。
    await client.createItem({ title: 'GitHub', username: 'octocat', password: WEAK_ENOUGH });
    await client.createItem({ title: 'GitLab', username: 'tanuki', password: WEAK_ENOUGH });
    const kib = await client.exportBackup(MASTER);

    for (const item of await client.listItems()) {
      await client.deleteItem(item.id);
    }

    // 修复前：两张卡都被拼成 "||其他"，被当成同一站点 → conflicts 2、inserted 0，
    // 备份里的卡一张都回不来，用户只看到一句「2 个冲突」。
    const result = await client.importBackup({ kirkJson: kib, password: MASTER, mode: 'merge' });
    expect(result).toMatchObject({ mode: 'merge', totalItems: 2, inserted: 2, skipped: 0, conflicts: [] });
  });

  it('merge 遇到同站点不同内容时保留当前库版本，并上报冲突', async () => {
    const client = newClient();
    await client.initialize({ masterPassword: MASTER });
    const created = await client.createItem({
      title: 'GitHub',
      username: 'octocat',
      password: WEAK_ENOUGH,
      url: 'https://github.com',
    });
    const kib = await client.exportBackup(MASTER);

    // 备份之后改了密码：同 url、同分类，但内容不同 → 冲突而不是覆盖。
    await client.updateItem(created.id, { password: 'Changed-2-Bb2!' });

    const result = await client.importBackup({ kirkJson: kib, password: MASTER, mode: 'merge' });
    expect(result.mode).toBe('merge');
    expect(result.conflicts).toHaveLength(1);
    expect(result.inserted).toBe(0);
    await expect(client.revealPassword(created.id)).resolves.toBe('Changed-2-Bb2!');
  });

  it('未解锁时导入被拒绝', async () => {
    const kib = await makeBackup();
    const client = newClient();
    await client.initialize({ masterPassword: OTHER });
    await client.lock();

    await expectCode(client.importBackup({ kirkJson: kib, password: MASTER, mode: 'merge' }), 'VAULT_LOCKED');
  });

  it('篡改备份文本被拒绝，且不落任何内容', async () => {
    const kib = await makeBackup();
    const envelope = JSON.parse(kib) as Record<string, unknown>;
    envelope.payload = 'AAAA';
    const tampered = JSON.stringify(envelope);

    const client = newClient();
    await client.initialize({ masterPassword: OTHER });
    await expectCode(
      client.importBackup({ kirkJson: tampered, password: MASTER, mode: 'overwrite', masterPassword: OTHER }),
      'VALIDATION_FAILED',
      'error.backup_invalid',
    );
    await expect(client.listItems()).resolves.toHaveLength(0);
  });
});
