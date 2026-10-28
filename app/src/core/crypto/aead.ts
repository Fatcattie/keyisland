/**
 * AES-256-GCM 字段加密。
 *
 * 关键约束（SDD §4.2）：
 * - 每次加密独立随机 12 字节 nonce，禁止复用。
 * - AAD 绑定 `schemaVersion|itemId|fieldName`，防止密文在字段/资产之间搬移。
 * - 解密失败一律归一化为 `CRYPTO_FAILED`，不区分"标签不匹配"与"密钥错误"。
 */

import { AppError, errors } from '../errors';
import { base64ToBytes, bytesToBase64, bytesToUtf8, toArrayBuffer, utf8ToBytes } from './encoding';
import { randomBytes } from './random';

/** GCM 推荐的 nonce 长度（字节）。 */
export const GCM_NONCE_LENGTH = 12;

/** 字段加密算法标识。 */
export const FIELD_CIPHER = 'AES-256-GCM';

/** 密文记录格式版本。 */
export const ENCRYPTED_FIELD_VERSION = 1;

/** 序列化到存储的加密字段结构。 */
export interface EncryptedField {
  /** 格式版本。 */
  readonly v: number;
  /** 算法标识，便于未来算法迁移。 */
  readonly alg: string;
  /** Base64 编码的 12 字节 nonce。 */
  readonly nonce: string;
  /** Base64 编码的密文（含 GCM tag）。 */
  readonly ciphertext: string;
}

/** 资产中需要加密的字段名。 */
export type ItemSecretField = 'username' | 'password' | 'notes';

/** 构造字段 AAD：绑定 schema 版本、资产 id 与字段名。 */
export function buildFieldAad(schemaVersion: number, itemId: number, fieldName: ItemSecretField): string {
  return `${schemaVersion}|${itemId}|${fieldName}`;
}

/** 导入原始 AES-GCM 密钥（32 字节）。 */
async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.length !== 32) {
    throw errors.cryptoFailed();
  }
  try {
    return await globalThis.crypto.subtle.importKey('raw', toArrayBuffer(rawKey), { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
  } catch {
    throw errors.cryptoFailed();
  }
}

/** 低层加密：返回 nonce 与密文字节。 */
export async function encryptBytes(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: string,
): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }> {
  const cryptoKey = await importAesKey(key);
  const nonce = randomBytes(GCM_NONCE_LENGTH);
  try {
    const ciphertext = await globalThis.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(utf8ToBytes(aad)),
        tagLength: 128,
      },
      cryptoKey,
      toArrayBuffer(plaintext),
    );
    return { nonce, ciphertext: new Uint8Array(ciphertext) };
  } catch {
    throw errors.cryptoFailed();
  }
}

/** 低层解密：AAD 或密文被篡改时抛 `CRYPTO_FAILED`。 */
export async function decryptBytes(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: string,
): Promise<Uint8Array> {
  if (nonce.length !== GCM_NONCE_LENGTH) {
    throw errors.cryptoFailed();
  }
  const cryptoKey = await importAesKey(key);
  try {
    const plaintext = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(utf8ToBytes(aad)),
        tagLength: 128,
      },
      cryptoKey,
      toArrayBuffer(ciphertext),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw errors.cryptoFailed();
  }
}

/** 加密单个文本字段，产出可持久化的记录。 */
export async function encryptField(
  plaintext: string,
  dek: Uint8Array,
  aad: string,
): Promise<EncryptedField> {
  const { nonce, ciphertext } = await encryptBytes(dek, utf8ToBytes(plaintext), aad);
  return {
    v: ENCRYPTED_FIELD_VERSION,
    alg: FIELD_CIPHER,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
  };
}

/** 解密单个文本字段。 */
export async function decryptField(
  field: EncryptedField,
  dek: Uint8Array,
  aad: string,
): Promise<string> {
  if (field.v !== ENCRYPTED_FIELD_VERSION || field.alg !== FIELD_CIPHER) {
    throw errors.unsupportedVersion();
  }
  const nonce = base64ToBytes(field.nonce);
  const ciphertext = base64ToBytes(field.ciphertext);
  const plaintext = await decryptBytes(dek, nonce, ciphertext, aad);
  return bytesToUtf8(plaintext);
}

/** 断言错误类型为 CRYPTO_FAILED，供测试与上层判断。 */
export function isCryptoFailure(error: unknown): boolean {
  return AppError.isAppError(error) && error.code === 'CRYPTO_FAILED';
}
