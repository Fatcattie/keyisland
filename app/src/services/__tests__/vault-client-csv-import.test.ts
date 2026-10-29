import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { previewCsvImport } from '../../core/vault/csv-import';
import { MemoryVaultStorage } from '../storage';
import { createVaultClient } from '../vault-client';

const PASSWORD = 'KeyIsland-test-Password-42!';

const CSV = [
  'name,username,password,url',
  'GitHub,octocat,Pass-1-Aa1!,https://github.com',
  'GitLab,tanuki,Pass-2-Bb2!,https://gitlab.com',
].join('\n');

function newClient(): ReturnType<typeof createVaultClient> {
  return createVaultClient({
    storage: new MemoryVaultStorage(),
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
  });
}

describe('VaultClient CSV import', () => {
  it('同一个 CSV 导入两次不会把卡片翻倍', async () => {
    const client = newClient();
    await client.initialize({ masterPassword: PASSWORD });
    const items = previewCsvImport(CSV).items;

    await expect(client.importCsvItems(items)).resolves.toEqual({ inserted: 2, skipped: 0 });
    // 第二次全部命中已有内容：既不新增，也不报错。
    await expect(client.importCsvItems(items)).resolves.toEqual({ inserted: 0, skipped: 2 });
    await expect(client.listItems()).resolves.toHaveLength(2);
  });

  it('只跳过完全相同的卡片，内容有差异仍作为新卡追加', async () => {
    const client = newClient();
    await client.initialize({ masterPassword: PASSWORD });
    await client.createItem({ title: 'GitHub', username: 'octocat', password: 'Pass-1-Aa1!' });

    const items = previewCsvImport(CSV).items;
    const result = await client.importCsvItems(items);

    // GitHub 那条 CSV 带了 url，与原卡片内容不同 → 追加；GitLab 是新的 → 追加。
    expect(result).toEqual({ inserted: 2, skipped: 0 });
    const list = await client.listItems();
    expect(list).toHaveLength(3);

    // 原卡片没有被覆盖：两张 GitHub 里仍有一张没有 url。
    const githubs = list.filter((item) => item.title === 'GitHub');
    expect(githubs).toHaveLength(2);
    const details = await Promise.all(githubs.map((item) => client.getItem(item.id)));
    const untouched = details.filter((detail) => detail.url === null);
    expect(untouched).toHaveLength(1);
    await expect(client.revealPassword(untouched[0].id)).resolves.toBe('Pass-1-Aa1!');
  });

  it('未解锁时拒绝导入，且不写入任何内容', async () => {
    const client = newClient();
    await client.initialize({ masterPassword: PASSWORD });
    await client.lock();

    await expect(client.importCsvItems(previewCsvImport(CSV).items)).rejects.toThrow();
    await client.unlock(PASSWORD);
    await expect(client.listItems()).resolves.toHaveLength(0);
  });
});
