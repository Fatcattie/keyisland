/**
 * 对抗性测试 · 密文与 AAD 篡改（SDD §4.2）。
 *
 * 验证目标：证明 AES-256-GCM 的认证边界真实生效——
 * 任何 1 bit 密文改动、任何 AAD 字段改动、任何密文搬移都必须失败，
 * 而不是"写了个加密函数就算完"。
 *
 * 本文件不修改业务代码，仅作为外部攻击者视角调用公开 API。
 */

import { describe, expect, it } from 'vitest';
import {
  ENCRYPTED_FIELD_VERSION,
  GCM_NONCE_LENGTH,
  buildFieldAad,
  decryptField,
  encryptField,
  type EncryptedField,
} from '../../src/core/crypto/aead';
import { base64ToBytes, bytesToBase64 } from '../../src/core/crypto/encoding';
import { randomBytes } from '../../src/core/crypto/random';
import { decryptItem, encryptItem } from '../../src/core/vault/item-codec';
import type { ItemPlain } from '../../src/core/vault/types';

/** 固定 DEK，避免每个用例重复派生（本文件不涉及 KDF）。 */
const DEK = randomBytes(32);

/** 字段 AAD：schemaVersion=1, itemId=7, fieldName=password。 */
const FIELD_AAD = buildFieldAad(1, 7, 'password');

/** 翻转密文中指定位置的 1 个 bit。 */
function flipCiphertextBit(field: EncryptedField, index: number): EncryptedField {
  const bytes = base64ToBytes(field.ciphertext);
  const offset = index % bytes.length;
  bytes[offset] ^= 0x01;
  return { ...field, ciphertext: bytesToBase64(bytes) };
}

/** 构造虚构资产（不涉及任何真实账号）。 */
function makeItem(overrides: Partial<ItemPlain> = {}): ItemPlain {
  return {
    id: 1,
    title: '示例站点',
    platform: 'example.test',
    url: 'https://example.test',
    appPath: null,
    username: 'alice@example.test',
    password: 'Fixture-Pass-1!',
    notes: null,
    category: '其他',
    tags: [],
    visibility: 'normal',
    favorite: false,
    passwordUpdatedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('对抗性 · 密文篡改', () => {
  it('翻转任意位置的 1 bit 都导致认证失败', async () => {
    const field = await encryptField('Fixture-Secret-Value', DEK, FIELD_AAD);
    const size = base64ToBytes(field.ciphertext).length;
    // 覆盖首字节、次字节、中位、GCM tag 尾部
    for (const index of [0, 1, Math.floor(size / 2), size - 1]) {
      await expect(decryptField(flipCiphertextBit(field, index), DEK, FIELD_AAD)).rejects.toMatchObject({
        code: 'CRYPTO_FAILED',
      });
    }
  });

  it('截断密文（丢掉 GCM tag 尾部）失败', async () => {
    const field = await encryptField('Fixture-Secret-Value', DEK, FIELD_AAD);
    const bytes = base64ToBytes(field.ciphertext);
    const truncated = bytes.subarray(0, bytes.length - 4);

    await expect(
      decryptField({ ...field, ciphertext: bytesToBase64(truncated) }, DEK, FIELD_AAD),
    ).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
  });

  it('AAD 的 itemId 不匹配（跨资产搬移）失败', async () => {
    const field = await encryptField('Fixture-Secret-Value', DEK, FIELD_AAD);

    await expect(
      decryptField(field, DEK, buildFieldAad(1, 8, 'password')),
    ).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
  });

  it('AAD 的 fieldName 不匹配（字段互换）失败', async () => {
    const field = await encryptField('Fixture-Secret-Value', DEK, FIELD_AAD);

    await expect(
      decryptField(field, DEK, buildFieldAad(1, 7, 'username')),
    ).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
  });

  it('AAD 的 schemaVersion 不匹配失败', async () => {
    const field = await encryptField('Fixture-Secret-Value', DEK, FIELD_AAD);

    await expect(
      decryptField(field, DEK, buildFieldAad(2, 7, 'password')),
    ).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
  });

  it('用错误 DEK 解密失败', async () => {
    const field = await encryptField('Fixture-Secret-Value', DEK, FIELD_AAD);

    await expect(decryptField(field, randomBytes(32), FIELD_AAD)).rejects.toMatchObject({
      code: 'CRYPTO_FAILED',
    });
  });

  it('nonce 长度不是 12 字节时被拒绝（不做"尽力而为"的解密）', async () => {
    const field = await encryptField('Fixture-Secret-Value', DEK, FIELD_AAD);
    const nonce = base64ToBytes(field.nonce);
    const shortNonce = bytesToBase64(nonce.subarray(0, GCM_NONCE_LENGTH - 1));

    await expect(decryptField({ ...field, nonce: shortNonce }, DEK, FIELD_AAD)).rejects.toMatchObject({
      code: 'CRYPTO_FAILED',
    });
  });

  it('每次加密的 nonce 都不同且长度固定 12 字节（64 次无重复）', async () => {
    const nonces = new Set<string>();
    for (let index = 0; index < 64; index += 1) {
      const field = await encryptField(`Fixture-Value-${index}`, DEK, FIELD_AAD);
      const bytes = base64ToBytes(field.nonce);
      expect(bytes.length).toBe(GCM_NONCE_LENGTH);
      nonces.add(field.nonce);
    }
    // nonce 复用会让 GCM 直接崩掉机密性，这里要求 64 次全不重复
    expect(nonces.size).toBe(64);
  });

  it('密文记录包含版本与算法标识，版本被改写后拒绝解密', async () => {
    const field = await encryptField('Fixture-Secret-Value', DEK, FIELD_AAD);
    expect(field.v).toBe(ENCRYPTED_FIELD_VERSION);
    expect(field.alg).toBe('AES-256-GCM');

    await expect(decryptField({ ...field, v: 2 }, DEK, FIELD_AAD)).rejects.toMatchObject({
      code: 'UNSUPPORTED_VERSION',
    });
    await expect(decryptField({ ...field, alg: 'AES-256-CBC' }, DEK, FIELD_AAD)).rejects.toMatchObject({
      code: 'UNSUPPORTED_VERSION',
    });
  });
});

describe('对抗性 · 密文搬移（AAD 绑定资产与字段）', () => {
  it('把 A 资产的密文挂到 B 资产 id 上，decryptItem 失败', async () => {
    const record = await encryptItem(makeItem({ id: 1 }), DEK);
    // 攻击者只能改明文元数据（id），密文原封不动
    const moved = { ...record, id: 2 };

    await expect(decryptItem(moved, DEK)).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
  });

  it('同一资产内 username / password 密文互换失败', async () => {
    const record = await encryptItem(makeItem({ id: 3 }), DEK);
    const swapped = {
      ...record,
      usernameEnc: record.passwordEnc,
      passwordEnc: record.usernameEnc,
    };

    await expect(decryptItem(swapped, DEK)).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
  });

  it('把 password 密文塞进 notes 字段失败', async () => {
    const record = await encryptItem(makeItem({ id: 4 }), DEK);
    const forged = { ...record, notesEnc: record.passwordEnc };

    await expect(decryptItem(forged, DEK)).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
  });

  it('正常资产可正确往返（对照组，避免"全部失败"的假阳性）', async () => {
    const item = makeItem({ id: 5, notes: 'Fixture note' });
    const record = await encryptItem(item, DEK);
    const restored = await decryptItem(record, DEK);

    expect(restored.username).toBe(item.username);
    expect(restored.password).toBe(item.password);
    expect(restored.notes).toBe('Fixture note');
  });
});
