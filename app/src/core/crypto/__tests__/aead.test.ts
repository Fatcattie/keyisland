import { describe, expect, it } from 'vitest';
import {
  ENCRYPTED_FIELD_VERSION,
  buildFieldAad,
  decryptField,
  encryptField,
  type EncryptedField,
} from '../aead';
import { base64ToBytes, bytesToBase64 } from '../encoding';
import { randomBytes } from '../random';

const DEK = randomBytes(32);
const AAD = buildFieldAad(1, 42, 'password');

/** 翻转密文中的一个字节，模拟篡改。 */
function tamper(field: EncryptedField): EncryptedField {
  const bytes = base64ToBytes(field.ciphertext);
  bytes[0] ^= 0xff;
  return { ...field, ciphertext: bytesToBase64(bytes) };
}

describe('AES-256-GCM 字段加密', () => {
  it('加解密往返一致（含中文与符号）', async () => {
    const plaintext = '密岛-P@ssw0rd-中文-🔐';
    const field = await encryptField(plaintext, DEK, AAD);

    expect(field.v).toBe(ENCRYPTED_FIELD_VERSION);
    expect(field.alg).toBe('AES-256-GCM');
    expect(base64ToBytes(field.nonce).length).toBe(12);
    await expect(decryptField(field, DEK, AAD)).resolves.toBe(plaintext);
  });

  it('每次加密使用不同的随机 nonce', async () => {
    const first = await encryptField('same-plaintext', DEK, AAD);
    const second = await encryptField('same-plaintext', DEK, AAD);

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('篡改密文后解密失败', async () => {
    const field = await encryptField('sensitive-value', DEK, AAD);
    await expect(decryptField(tamper(field), DEK, AAD)).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
  });

  it('篡改 nonce 后解密失败', async () => {
    const field = await encryptField('sensitive-value', DEK, AAD);
    const nonce = base64ToBytes(field.nonce);
    nonce[0] ^= 0xff;
    await expect(
      decryptField({ ...field, nonce: bytesToBase64(nonce) }, DEK, AAD),
    ).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
  });

  it('AAD 不匹配（资产 id 不同）时解密失败，防止密文搬移', async () => {
    const field = await encryptField('sensitive-value', DEK, AAD);
    await expect(decryptField(field, DEK, buildFieldAad(1, 43, 'password'))).rejects.toMatchObject({
      code: 'CRYPTO_FAILED',
    });
  });

  it('AAD 不匹配（字段名不同）时解密失败', async () => {
    const field = await encryptField('sensitive-value', DEK, AAD);
    await expect(decryptField(field, DEK, buildFieldAad(1, 42, 'username'))).rejects.toMatchObject({
      code: 'CRYPTO_FAILED',
    });
  });

  it('错误密钥解密失败', async () => {
    const field = await encryptField('sensitive-value', DEK, AAD);
    await expect(decryptField(field, randomBytes(32), AAD)).rejects.toMatchObject({
      code: 'CRYPTO_FAILED',
    });
  });

  it('不支持的密文格式版本被拒绝', async () => {
    const field = await encryptField('sensitive-value', DEK, AAD);
    await expect(decryptField({ ...field, v: 2 }, DEK, AAD)).rejects.toMatchObject({
      code: 'UNSUPPORTED_VERSION',
    });
  });

  it('AAD 构造规则为 schemaVersion|itemId|fieldName', () => {
    expect(buildFieldAad(1, 7, 'notes')).toBe('1|7|notes');
  });
});
