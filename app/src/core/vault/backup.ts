/**
 * KIB1 加密备份编解码（SDD §9）。
 *
 * 备份外层只保存格式元数据与 AES-GCM 密文；资产、密钥槽和偏好均在
 * payload 内加密。备份密码不写入文件，导入失败不会产生任何明文回退。
 */

import { errors } from '../errors';
import {
  ARGON2_PARAMS_V1,
  GCM_NONCE_LENGTH,
  base64ToBytes,
  bytesToBase64,
  bytesToUtf8,
  deriveKey,
  encryptBytes,
  decryptBytes,
  randomBytes,
  utf8ToBytes,
  zeroize,
  type Argon2Params,
} from '../crypto';
import type { EncryptedItemRecord, ItemPlain, RecentEntry } from './types';
import type { KeyslotRecord, KeyslotsBundle } from './keyslots';
import type { VaultMeta } from '../../services/storage';

export const BACKUP_MAGIC = 'KIB1';
export const BACKUP_VERSION = 1;
const BACKUP_SALT_LENGTH = 16;
const BACKUP_AAD = `${BACKUP_MAGIC}|${BACKUP_VERSION}`;

export interface BackupPayload {
  schemaVersion: number;
  items: EncryptedItemRecord[];
  keyslots: KeyslotsBundle;
  meta: VaultMeta;
  recency: RecentEntry[];
}

export interface BackupEnvelope {
  magic: typeof BACKUP_MAGIC;
  version: typeof BACKUP_VERSION;
  kdfParams: Argon2Params;
  salt: string;
  nonce: string;
  payload: string;
}

function parseEnvelope(input: string): BackupEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw errors.validationFailed('error.backup_invalid');
  }
  if (typeof value !== 'object' || value === null) {
    throw errors.validationFailed('error.backup_invalid');
  }
  const candidate = value as Partial<BackupEnvelope>;
  if (
    candidate.magic !== BACKUP_MAGIC ||
    candidate.version !== BACKUP_VERSION ||
    typeof candidate.salt !== 'string' ||
    typeof candidate.nonce !== 'string' ||
    typeof candidate.payload !== 'string' ||
    typeof candidate.kdfParams !== 'object' ||
    candidate.kdfParams === null
  ) {
    throw errors.validationFailed('error.backup_invalid');
  }
  return candidate as BackupEnvelope;
}

function validatePayload(value: unknown): BackupPayload {
  if (typeof value !== 'object' || value === null) {
    throw errors.validationFailed('error.backup_invalid');
  }
  const candidate = value as Partial<BackupPayload>;
  if (
    typeof candidate.schemaVersion !== 'number' ||
    !Array.isArray(candidate.items) ||
    typeof candidate.keyslots !== 'object' ||
    candidate.keyslots === null ||
    typeof candidate.meta !== 'object' ||
    candidate.meta === null ||
    !Array.isArray(candidate.recency)
  ) {
    throw errors.validationFailed('error.backup_invalid');
  }
  return candidate as BackupPayload;
}

/** 以主密码生成加密 KIB1 文件；返回值可直接写入用户选定的文件。 */
export async function exportBackup(
  password: string,
  payload: BackupPayload,
  params: Argon2Params = ARGON2_PARAMS_V1,
): Promise<string> {
  if (password.length === 0) {
    throw errors.validationFailed('error.backup_password_required');
  }
  const salt = randomBytes(BACKUP_SALT_LENGTH);
  const nonce = randomBytes(GCM_NONCE_LENGTH);
  let key: Uint8Array | null = null;
  try {
    key = await deriveKey(password, salt, params);
    const encrypted = await encryptBytes(key, utf8ToBytes(JSON.stringify(payload)), BACKUP_AAD);
    // encryptBytes 生成随机 nonce；KIB 的 envelope 需要显式保存它。
    return JSON.stringify({
      magic: BACKUP_MAGIC,
      version: BACKUP_VERSION,
      kdfParams: params,
      salt: bytesToBase64(salt),
      nonce: bytesToBase64(encrypted.nonce),
      payload: bytesToBase64(encrypted.ciphertext),
    } satisfies BackupEnvelope);
  } finally {
    zeroize(key, salt, nonce);
  }
}

/** 解密并校验 KIB1 文件；密码错误、篡改、格式错误统一为 BACKUP_INVALID。 */
export async function importBackup(password: string, input: string): Promise<BackupPayload> {
  if (password.length === 0) {
    throw errors.validationFailed('error.backup_password_required');
  }
  const envelope = parseEnvelope(input);
  let salt: Uint8Array | null = null;
  let nonce: Uint8Array | null = null;
  let key: Uint8Array | null = null;
  try {
    salt = base64ToBytes(envelope.salt);
    nonce = base64ToBytes(envelope.nonce);
    if (salt.length !== BACKUP_SALT_LENGTH || nonce.length !== GCM_NONCE_LENGTH) {
      throw errors.validationFailed('error.backup_invalid');
    }
    key = await deriveKey(password, salt, envelope.kdfParams);
    const plaintext = await decryptBytes(key, nonce, base64ToBytes(envelope.payload), BACKUP_AAD);
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytesToUtf8(plaintext));
    } catch {
      throw errors.validationFailed('error.backup_invalid');
    }
    return validatePayload(decoded);
  } catch {
    throw errors.validationFailed('error.backup_invalid');
  } finally {
    zeroize(salt, nonce, key);
  }
}

/** 仅用于测试/文件适配器：验证输入确实是 KIB1，不解密 payload。 */
export function isBackupEnvelope(input: string): boolean {
  try {
    return parseEnvelope(input).magic === BACKUP_MAGIC;
  } catch {
    return false;
  }
}

/**
 * 判断备份能否与当前库合并。
 *
 * 备份里的资产密文是用**源库 DEK** 加密的；只有源密钥槽与当前库密钥槽逐字节
 * 相同（即同一个 DEK 世系）时，这些密文才能被当前会话解开。否则合并只会往
 * 库里塞入当前 DEK 无法解密的"坏卡片"，因此必须拒绝并提示改用覆盖导入。
 */
export function isSameKeyLineage(current: KeyslotsBundle, backup: KeyslotsBundle): boolean {
  const sameRecord = (a: KeyslotRecord, b: KeyslotRecord): boolean =>
    a.wrappedDek === b.wrappedDek && a.salt === b.salt && a.nonce === b.nonce && a.version === b.version;
  return sameRecord(current.password, backup.password) && sameRecord(current.recovery, backup.recovery);
}

/** 合并恢复的冲突项：备份内资产与当前库资产指向同一站点。 */
export interface BackupConflict {
  platform: string;
  url: string;
  /** 当前库中已存在资产的标题（摘要，不含明文）。 */
  existingTitle: string;
  /** 当前库中已存在资产的 id。 */
  existingId: number;
}

/** 合并结果。 */
export interface MergeBackupResult {
  items: EncryptedItemRecord[];
  conflicts: BackupConflict[];
  /** 备份中已存在且内容完全一致的资产数量（跳过不重复插入）。 */
  skipped: number;
  /** 实际插入的资产数量。 */
  inserted: number;
}

/**
 * 两条资产记录是否指向"同一个账号 + 同一份内容"。
 *
 * 密文不能直接比较：本项目每次写操作都会为整表重新生成 nonce，
 * 同一份明文两次落盘的密文必然不同，因此必须解密后按业务字段比对。
 */
export function samePlainContent(a: ItemPlain, b: ItemPlain): boolean {
  return (
    a.title === b.title &&
    a.platform === b.platform &&
    a.url === b.url &&
    a.appPath === b.appPath &&
    a.username === b.username &&
    a.password === b.password &&
    (a.notes ?? '') === (b.notes ?? '') &&
    a.category === b.category &&
    a.tags.join(',') === b.tags.join(',') &&
    a.visibility === b.visibility &&
    a.favorite === b.favorite
  );
}

/**
 * 合并恢复：按 item id 不直接覆盖（SDD §9.2）。
 *
 * - 明文内容完全一致 → 跳过，避免恢复后出现重复卡片；
 * - 同平台/网址但内容不同 → 记为冲突，保留当前库版本并上报，由用户决定；
 * - 其余按新 id 递增插入（不与现有 id 冲突）。
 *
 * 调用方负责提供解密能力（同 DEK 世系已在门面层校验过）。
 */
export async function mergeBackupItems(
  existing: readonly EncryptedItemRecord[],
  incoming: readonly EncryptedItemRecord[],
  decrypt: (record: EncryptedItemRecord) => Promise<ItemPlain>,
): Promise<MergeBackupResult> {
  const identity = (item: EncryptedItemRecord): string => `${item.platform ?? ''}|${item.url ?? ''}|${item.category}`;
  const existingIdentities = new Set(existing.map(identity));
  const existingPlain = new Map<number, ItemPlain>();
  for (const record of existing) {
    existingPlain.set(record.id, await decrypt(record));
  }

  const conflicts: BackupConflict[] = [];
  const seenKeys = new Set<string>();
  const merged = existing.map((item) => ({ ...item }));
  let skipped = 0;
  let inserted = 0;
  let nextId = existing.reduce((max, item) => Math.max(max, item.id), 0) + 1;

  for (const record of incoming) {
    const key = identity(record);
    const plain = await decrypt(record);
    // 当前库已有内容完全一致的资产 → 跳过。
    let identical = false;
    for (const current of existingPlain.values()) {
      if (samePlainContent(current, plain)) {
        identical = true;
        break;
      }
    }
    if (identical) {
      skipped += 1;
      continue;
    }
    // 同一站点的不同账号/密码 → 冲突，保留当前库版本并上报（同冲突只报一次）。
    if (existingIdentities.has(key)) {
      if (seenKeys.has(key)) {
        skipped += 1;
        continue;
      }
      seenKeys.add(key);
      const current = existing.find((candidate) => identity(candidate) === key);
      conflicts.push({
        platform: record.platform ?? '',
        url: record.url ?? '',
        existingTitle: current === undefined ? '' : current.title,
        existingId: current === undefined ? -1 : current.id,
      });
      continue;
    }
    merged.push({ ...record, id: nextId });
    nextId += 1;
    inserted += 1;
  }

  return { items: merged, conflicts, skipped, inserted };
}


