import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { MemoryVaultStorage } from '../storage';
import { createVaultClient } from '../vault-client';

const PASSWORD = 'KeyIsland-test-Password-42!';

describe('VaultClient asset bundle migration', () => {
  it('re-encrypts across vaults, appends new items, and skips exact duplicates', async () => {
    const source = createVaultClient({ storage: new MemoryVaultStorage(), passwordParams: ARGON2_TEST_PARAMS, recoveryParams: ARGON2_TEST_PARAMS });
    await source.initialize({ masterPassword: PASSWORD });
    await source.createItem({ title: 'GitHub', platform: '开发', username: 'octocat', password: 'secret', url: 'https://github.com' });
    const bundle = await source.exportAssetBundle(PASSWORD);

    const target = createVaultClient({ storage: new MemoryVaultStorage(), passwordParams: ARGON2_TEST_PARAMS, recoveryParams: ARGON2_TEST_PARAMS });
    await target.initialize({ masterPassword: 'Different-target-password-42!' });
    await target.createItem({ title: 'Keep me', username: 'local', password: 'local-secret' });

    await expect(target.previewAssetBundle(PASSWORD, bundle)).resolves.toEqual({ total: 1, inserted: 1, skipped: 0 });
    await expect(target.listItems()).resolves.toHaveLength(1);

    const first = await target.importAssetBundle(PASSWORD, bundle);
    expect(first).toEqual({ inserted: 1, skipped: 0 });
    const second = await target.importAssetBundle(PASSWORD, bundle);
    expect(second).toEqual({ inserted: 0, skipped: 1 });

    const items = await target.listItems();
    expect(items.map((item) => item.title).sort()).toEqual(['GitHub', 'Keep me']);
    await expect(target.revealPassword(items.find((item) => item.title === 'GitHub')!.id)).resolves.toBe('secret');
  });

  it('does not import anything with a wrong password', async () => {
    const source = createVaultClient({ storage: new MemoryVaultStorage(), passwordParams: ARGON2_TEST_PARAMS, recoveryParams: ARGON2_TEST_PARAMS });
    await source.initialize({ masterPassword: PASSWORD });
    await source.createItem({ title: 'GitHub', username: 'octocat', password: 'secret' });
    const bundle = await source.exportAssetBundle(PASSWORD);

    const target = createVaultClient({ storage: new MemoryVaultStorage(), passwordParams: ARGON2_TEST_PARAMS, recoveryParams: ARGON2_TEST_PARAMS });
    await target.initialize({ masterPassword: 'Different-target-password-42!' });
    await expect(target.importAssetBundle('wrong-password', bundle)).rejects.toThrow();
    await expect(target.listItems()).resolves.toHaveLength(0);
  });
});
