/**
 * KIA1 加密资产转移包。
 *
 * 与 KIB1 完整库备份不同：这里只放资产内容，不放 keyslots、恢复密钥、库元数据
 * 或原始 id。导入时必须用当前库主密码解密，再由当前库 DEK 重新加密并追加。
 */

import { errors } from '../errors';
import {
  ARGON2_PARAMS_V1,
  deriveKey,
  type Argon2Params,
} from '../crypto/kdf';
import {
  GCM_NONCE_LENGTH,
  base64ToBytes,
  bytesToBase64,
  bytesToUtf8,
  encryptBytes,
  decryptBytes,
  randomBytes,
  utf8ToBytes,
  zeroize,
} from '../crypto';
import type { CreateItemInput, ItemPlain, Visibility } from './types';

export const ASSET_TRANSFER_MAGIC = 'KIA1';
export const ASSET_TRANSFER_VERSION = 1;
const ASSET_TRANSFER_SALT_LENGTH = 16;
const ASSET_TRANSFER_AAD = `${ASSET_TRANSFER_MAGIC}|${ASSET_TRANSFER_VERSION}`;

/** 不携带源库 id/时间戳的可迁移资产。 */
export interface AssetTransferItem {
  title: string;
  platform: string | null;
  url: string | null;
  appPath: string | null;
  username: string;
  password: string;
  notes: string | null;
  category: string;
  tags: string[];
  visibility: Visibility;
  favorite: boolean;
}

export interface AssetTransferPayload {
  schemaVersion: number;
  items: AssetTransferItem[];
}

export interface AssetTransferEnvelope {
  magic: typeof ASSET_TRANSFER_MAGIC;
  version: typeof ASSET_TRANSFER_VERSION;
  kdfParams: Argon2Params;
  salt: string;
  nonce: string;
  payload: string;
}

function parseEnvelope(input: string): AssetTransferEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw errors.validationFailed('error.backup_invalid');
  }
  if (typeof value !== 'object' || value === null) {
    throw errors.validationFailed('error.backup_invalid');
  }
  const candidate = value as Partial<AssetTransferEnvelope>;
  if (
    candidate.magic !== ASSET_TRANSFER_MAGIC ||
    candidate.version !== ASSET_TRANSFER_VERSION ||
    typeof candidate.salt !== 'string' ||
    typeof candidate.nonce !== 'string' ||
    typeof candidate.payload !== 'string' ||
    typeof candidate.kdfParams !== 'object' ||
    candidate.kdfParams === null
  ) {
    throw errors.validationFailed('error.backup_invalid');
  }
  return candidate as AssetTransferEnvelope;
}

function validateItem(value: unknown): AssetTransferItem {
  if (typeof value !== 'object' || value === null) {
    throw errors.validationFailed('error.backup_invalid');
  }
  const item = value as Partial<AssetTransferItem>;
  if (
    typeof item.title !== 'string' ||
    typeof item.username !== 'string' ||
    typeof item.password !== 'string' ||
    typeof item.category !== 'string' ||
    !Array.isArray(item.tags) ||
    typeof item.visibility !== 'string' ||
    typeof item.favorite !== 'boolean'
  ) {
    throw errors.validationFailed('error.backup_invalid');
  }
  return {
    title: item.title,
    platform: item.platform ?? null,
    url: item.url ?? null,
    appPath: item.appPath ?? null,
    username: item.username,
    password: item.password,
    notes: item.notes ?? null,
    category: item.category,
    tags: item.tags.filter((tag): tag is string => typeof tag === 'string'),
    visibility: item.visibility as Visibility,
    favorite: item.favorite,
  };
}

function validatePayload(value: unknown): AssetTransferPayload {
  if (typeof value !== 'object' || value === null) {
    throw errors.validationFailed('error.backup_invalid');
  }
  const candidate = value as Partial<AssetTransferPayload>;
  if (typeof candidate.schemaVersion !== 'number' || !Array.isArray(candidate.items)) {
    throw errors.validationFailed('error.backup_invalid');
  }
  return {
    schemaVersion: candidate.schemaVersion,
    items: candidate.items.map(validateItem),
  };
}

export function toAssetTransferItem(item: ItemPlain): AssetTransferItem {
  return {
    title: item.title,
    platform: item.platform,
    url: item.url,
    appPath: item.appPath,
    username: item.username,
    password: item.password,
    notes: item.notes,
    category: item.category,
    tags: [...item.tags],
    visibility: item.visibility,
    favorite: item.favorite,
  };
}

export function toCreateItemInput(item: AssetTransferItem): CreateItemInput {
  return {
    title: item.title,
    platform: item.platform,
    url: item.url,
    appPath: item.appPath,
    username: item.username,
    password: item.password,
    notes: item.notes,
    category: item.category,
    tags: [...item.tags],
    visibility: item.visibility,
    favorite: item.favorite,
  };
}

export async function exportAssetTransfer(
  password: string,
  payload: AssetTransferPayload,
  params: Argon2Params = ARGON2_PARAMS_V1,
): Promise<string> {
  if (password.length === 0) {
    throw errors.validationFailed('error.password_required');
  }
  const salt = randomBytes(ASSET_TRANSFER_SALT_LENGTH);
  let key: Uint8Array | null = null;
  try {
    key = await deriveKey(password, salt, params);
    const encrypted = await encryptBytes(
      key,
      utf8ToBytes(JSON.stringify(payload)),
      ASSET_TRANSFER_AAD,
    );
    return JSON.stringify({
      magic: ASSET_TRANSFER_MAGIC,
      version: ASSET_TRANSFER_VERSION,
      kdfParams: params,
      salt: bytesToBase64(salt),
      nonce: bytesToBase64(encrypted.nonce),
      payload: bytesToBase64(encrypted.ciphertext),
    } satisfies AssetTransferEnvelope);
  } finally {
    zeroize(key, salt);
  }
}

export async function importAssetTransfer(
  password: string,
  input: string,
): Promise<AssetTransferPayload> {
  if (password.length === 0) {
    throw errors.validationFailed('error.password_required');
  }
  const envelope = parseEnvelope(input);
  let salt: Uint8Array | null = null;
  let nonce: Uint8Array | null = null;
  let key: Uint8Array | null = null;
  try {
    salt = base64ToBytes(envelope.salt);
    nonce = base64ToBytes(envelope.nonce);
    if (salt.length !== ASSET_TRANSFER_SALT_LENGTH || nonce.length !== GCM_NONCE_LENGTH) {
      throw errors.validationFailed('error.backup_invalid');
    }
    key = await deriveKey(password, salt, envelope.kdfParams);
    const plaintext = await decryptBytes(
      key,
      nonce,
      base64ToBytes(envelope.payload),
      ASSET_TRANSFER_AAD,
    );
    return validatePayload(JSON.parse(bytesToUtf8(plaintext)));
  } catch {
    throw errors.validationFailed('error.backup_invalid');
  } finally {
    zeroize(salt, nonce, key);
  }
}

export function isAssetTransferEnvelope(input: string): boolean {
  try {
    return parseEnvelope(input).magic === ASSET_TRANSFER_MAGIC;
  } catch {
    return false;
  }
}
