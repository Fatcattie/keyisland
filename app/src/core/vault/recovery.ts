/**
 * 恢复码与 `.kirk` 恢复密钥文件。
 *
 * 格式决策（见 ADR-011）：
 * - 恢复码使用 Crockford Base32 字母表（去掉 I / L / O / U 等易混淆字符）。
 * - 恢复码承载 20 字节（160 bit）随机秘密，编码为 32 个字符，按 8 组 4 位展示。
 * - 32 字节的"恢复密钥" = SHA-256(20 字节秘密)，因此恢复码与 `.kirk` 完全等价。
 * - 校验策略：字母表 + 长度 + 归一化做格式校验；错误但格式合法的码会在
 *   GCM 解包阶段被认证标签拒绝，等价于密码学校验和。
 */

import { errors } from '../errors';
import { base64ToBytes, bytesToBase64, sha256 } from '../crypto';
import { randomBytes } from '../crypto/random';

/** 恢复码字母表（Crockford Base32，无 I/L/O/U）。 */
export const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 恢复秘密长度（字节）。 */
export const RECOVERY_SECRET_LENGTH = 20;

/** 恢复码字符数（不含分隔符）。 */
export const RECOVERY_CODE_LENGTH = 32;

/** 恢复码分组大小。 */
export const RECOVERY_GROUP_SIZE = 4;

/** 恢复密钥长度（字节）。 */
export const RECOVERY_KEY_LENGTH = 32;

/** `.kirk` 文件魔数。 */
export const KIRK_MAGIC = 'KIRK1';

/** `.kirk` 文件格式版本。 */
export const KIRK_VERSION = 1;

/** `.kirk` 文件结构：只包含恢复密钥，绝不含主密码。 */
export interface KirkFile {
  magic: string;
  version: number;
  createdAt: number;
  /** Base64 编码的 32 字节恢复密钥。 */
  recoveryKey: string;
  /** 可选备注，便于用户识别文件来源。 */
  label?: string;
}

/** 归一化恢复码：去分隔符、统一大写、修正 Crockford 易混淆字符。 */
export function normalizeRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s\-_]/gu, '')
    .replace(/O/gu, '0')
    .replace(/[IL]/gu, '1')
    .replace(/U/gu, 'V');
}

/** 判断恢复码格式是否合法（长度与字母表）。 */
export function isValidRecoveryCodeFormat(code: string): boolean {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length !== RECOVERY_CODE_LENGTH) {
    return false;
  }
  for (const character of normalized) {
    if (!RECOVERY_ALPHABET.includes(character)) {
      return false;
    }
  }
  return true;
}

/** 生成 20 字节恢复秘密。 */
export function generateRecoverySecret(): Uint8Array {
  return randomBytes(RECOVERY_SECRET_LENGTH);
}

/** 把字节编码为 Crockford Base32 字符串（不带分组）。 */
function encodeBase32(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += RECOVERY_ALPHABET[(buffer >> bits) & 0b11111];
    }
  }
  if (bits > 0) {
    output += RECOVERY_ALPHABET[(buffer << (5 - bits)) & 0b11111];
  }
  return output;
}

/** 解码 Crockford Base32 字符串为字节。 */
function decodeBase32(text: string, byteLength: number): Uint8Array {
  const output = new Uint8Array(byteLength);
  let buffer = 0;
  let bits = 0;
  let cursor = 0;
  for (const character of text) {
    const value = RECOVERY_ALPHABET.indexOf(character);
    if (value < 0) {
      throw errors.recoveryCodeInvalid();
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (cursor < byteLength) {
        output[cursor] = (buffer >> bits) & 0xff;
        cursor += 1;
      }
    }
  }
  if (cursor !== byteLength) {
    throw errors.recoveryCodeInvalid();
  }
  return output;
}

/** 把 20 字节秘密编码为带分组的恢复码，例如 `XXXX-XXXX-...`。 */
export function encodeRecoveryCode(secret: Uint8Array): string {
  if (secret.length !== RECOVERY_SECRET_LENGTH) {
    throw errors.recoveryCodeInvalid();
  }
  const raw = encodeBase32(secret);
  const groups: string[] = [];
  for (let index = 0; index < raw.length; index += RECOVERY_GROUP_SIZE) {
    groups.push(raw.slice(index, index + RECOVERY_GROUP_SIZE));
  }
  return groups.join('-');
}

/** 把恢复码解码回 20 字节秘密；格式非法时抛 `RECOVERY_CODE_INVALID`。 */
export function decodeRecoveryCode(code: string): Uint8Array {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length !== RECOVERY_CODE_LENGTH) {
    throw errors.recoveryCodeInvalid();
  }
  return decodeBase32(normalized, RECOVERY_SECRET_LENGTH);
}

/**
 * 由 20 字节秘密派生 32 字节恢复密钥。
 * 使用 SHA-256 而不是直接用秘密，保证恢复密钥长度与 DEK/KEK 规格一致。
 */
export async function deriveRecoveryKey(secret: Uint8Array): Promise<Uint8Array> {
  if (secret.length !== RECOVERY_SECRET_LENGTH) {
    throw errors.recoveryCodeInvalid();
  }
  return sha256(secret);
}

/** 由用户输入的恢复码得到 32 字节恢复密钥。 */
export async function recoveryKeyFromCode(code: string): Promise<Uint8Array> {
  return deriveRecoveryKey(decodeRecoveryCode(code));
}

/** 由恢复密钥（`.kirk` 中的 Base64）得到 32 字节密钥。 */
export function recoveryKeyFromKirk(kirk: KirkFile): Uint8Array {
  const bytes = base64ToBytes(kirk.recoveryKey);
  if (bytes.length !== RECOVERY_KEY_LENGTH) {
    throw errors.recoveryCodeInvalid();
  }
  return bytes;
}

/** 生成 `.kirk` 文件对象（不含主密码）。 */
export function createKirkFile(recoveryKey: Uint8Array, now: number, label?: string): KirkFile {
  if (recoveryKey.length !== RECOVERY_KEY_LENGTH) {
    throw errors.recoveryCodeInvalid();
  }
  const file: KirkFile = {
    magic: KIRK_MAGIC,
    version: KIRK_VERSION,
    createdAt: now,
    recoveryKey: bytesToBase64(recoveryKey),
  };
  if (label !== undefined) {
    file.label = label;
  }
  return file;
}

/** 序列化 `.kirk` 内容（带缩进，便于用户直接查看与打印）。 */
export function serializeKirkFile(file: KirkFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** 解析 `.kirk` 文本，校验 magic / version / 密钥长度。 */
export function parseKirkFile(text: string): KirkFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw errors.recoveryCodeInvalid();
  }
  return parseKirkFileObject(parsed);
}

/** 校验并规范化 `.kirk` 对象。 */
export function parseKirkFileObject(value: unknown): KirkFile {
  if (typeof value !== 'object' || value === null) {
    throw errors.recoveryCodeInvalid();
  }
  const candidate = value as Partial<KirkFile>;
  if (candidate.magic !== KIRK_MAGIC) {
    throw errors.recoveryCodeInvalid();
  }
  if (candidate.version !== KIRK_VERSION) {
    throw errors.unsupportedVersion();
  }
  if (typeof candidate.createdAt !== 'number' || !Number.isFinite(candidate.createdAt)) {
    throw errors.recoveryCodeInvalid();
  }
  if (typeof candidate.recoveryKey !== 'string') {
    throw errors.recoveryCodeInvalid();
  }
  const key = base64ToBytes(candidate.recoveryKey);
  if (key.length !== RECOVERY_KEY_LENGTH) {
    throw errors.recoveryCodeInvalid();
  }
  const file: KirkFile = {
    magic: KIRK_MAGIC,
    version: KIRK_VERSION,
    createdAt: candidate.createdAt,
    recoveryKey: candidate.recoveryKey,
  };
  if (typeof candidate.label === 'string' && candidate.label.length > 0) {
    file.label = candidate.label;
  }
  return file;
}

/** 一次性生成恢复码 + 恢复密钥 + `.kirk` 内容。 */
export async function createRecoveryMaterial(
  now: number,
  label?: string,
): Promise<{ code: string; recoveryKey: Uint8Array; kirk: KirkFile; kirkJson: string }> {
  const secret = generateRecoverySecret();
  try {
    const recoveryKey = await deriveRecoveryKey(secret);
    const code = encodeRecoveryCode(secret);
    const kirk = createKirkFile(recoveryKey, now, label);
    return { code, recoveryKey, kirk, kirkJson: serializeKirkFile(kirk) };
  } finally {
    secret.fill(0);
  }
}

/** 把恢复码格式化为便于抄写的分组文本。 */
export function formatRecoveryCode(code: string): string {
  const normalized = normalizeRecoveryCode(code);
  const groups: string[] = [];
  for (let index = 0; index < normalized.length; index += RECOVERY_GROUP_SIZE) {
    groups.push(normalized.slice(index, index + RECOVERY_GROUP_SIZE));
  }
  return groups.join('-');
}
