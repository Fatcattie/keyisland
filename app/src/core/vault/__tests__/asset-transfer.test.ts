import { describe, expect, it } from 'vitest';
import { exportAssetTransfer, importAssetTransfer, isAssetTransferEnvelope } from '../asset-transfer';
import { ARGON2_TEST_PARAMS } from '../../crypto/kdf';

describe('KIA1 encrypted asset transfer', () => {
  const payload = {
    schemaVersion: 1,
    items: [
      {
        title: 'GitHub',
        platform: '开发',
        url: 'https://github.com',
        appPath: null,
        username: 'octocat',
        password: 'secret',
        notes: 'private',
        category: '开发',
        tags: ['常用'],
        visibility: 'normal' as const,
        favorite: false,
      },
    ],
  };

  it('round-trips with the export password and exposes no plaintext fields', async () => {
    const encoded = await exportAssetTransfer('master-password', payload, ARGON2_TEST_PARAMS);
    expect(isAssetTransferEnvelope(encoded)).toBe(true);
    expect(encoded).toContain('KIA1');
    expect(encoded).not.toContain('octocat');
    expect(encoded).not.toContain('secret');
    await expect(importAssetTransfer('master-password', encoded)).resolves.toEqual(payload);
  });

  it('rejects the wrong password and tampered ciphertext', async () => {
    const encoded = await exportAssetTransfer('master-password', payload, ARGON2_TEST_PARAMS);
    await expect(importAssetTransfer('wrong-password', encoded)).rejects.toThrow();
    const tampered = encoded.replace(/"payload":"[^"]+"/, '"payload":"AAAA"');
    await expect(importAssetTransfer('master-password', tampered)).rejects.toThrow();
  });
});
