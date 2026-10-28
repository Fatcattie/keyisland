/**
 * 资产记录与明文结构之间的加解密转换。
 * 加密边界集中在这里，确保 `items.ts` 只处理内存明文，`storage.ts` 只处理密文。
 */

import { buildFieldAad, decryptField, encryptField } from '../crypto/aead';
import { SCHEMA_VERSION, type EncryptedItemRecord, type ItemPlain } from './types';

/** 明文资产 → 落盘密文记录。 */
export async function encryptItem(item: ItemPlain, dek: Uint8Array): Promise<EncryptedItemRecord> {
  const usernameEnc = await encryptField(
    item.username,
    dek,
    buildFieldAad(SCHEMA_VERSION, item.id, 'username'),
  );
  const passwordEnc = await encryptField(
    item.password,
    dek,
    buildFieldAad(SCHEMA_VERSION, item.id, 'password'),
  );
  const notesEnc =
    item.notes === null
      ? null
      : await encryptField(item.notes, dek, buildFieldAad(SCHEMA_VERSION, item.id, 'notes'));

  return {
    id: item.id,
    title: item.title,
    platform: item.platform,
    url: item.url,
    appPath: item.appPath,
    category: item.category,
    tags: [...item.tags],
    visibility: item.visibility,
    favorite: item.favorite,
    usernameEnc,
    passwordEnc,
    notesEnc,
    passwordUpdatedAt: item.passwordUpdatedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    strength: item.strength,
  };
}

/** 落盘密文记录 → 明文资产；AAD 不匹配或密文被篡改时抛 `CRYPTO_FAILED`。 */
export async function decryptItem(record: EncryptedItemRecord, dek: Uint8Array): Promise<ItemPlain> {
  const username = await decryptField(
    record.usernameEnc,
    dek,
    buildFieldAad(SCHEMA_VERSION, record.id, 'username'),
  );
  const password = await decryptField(
    record.passwordEnc,
    dek,
    buildFieldAad(SCHEMA_VERSION, record.id, 'password'),
  );
  const notes =
    record.notesEnc === null
      ? null
      : await decryptField(record.notesEnc, dek, buildFieldAad(SCHEMA_VERSION, record.id, 'notes'));

  return {
    id: record.id,
    title: record.title,
    platform: record.platform,
    url: record.url,
    appPath: record.appPath,
    username,
    password,
    notes,
    category: record.category,
    tags: [...record.tags],
    visibility: record.visibility,
    favorite: record.favorite,
    passwordUpdatedAt: record.passwordUpdatedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    strength: record.strength,
  };
}
