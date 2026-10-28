/**
 * Tauri 桌面壳的存储实现。
 *
 * 对应 Rust 侧 `src-tauri/src/storage.rs`：
 * - 数据落在 `%APPDATA%/com.keyisland.desktop/vault.db`（SQLite）；
 * - 每个值单独 AES-256-GCM 加密，AAD 绑定键名；
 * - 数据库密钥存 Windows 凭据管理器，**不落盘**，所以单拷走 `vault.db` 解不开。
 *
 * 接口语义与 `MemoryVaultStorage` 完全一致（ADR-010：迁移时端口不变），
 * 唯一差别是 `describeStorage()` 返回真实路径、`canReveal` 为 true。
 */

import { invoke } from '@tauri-apps/api/core';
import { errors } from '../core/errors';
import type { EncryptedItemRecord, RecentEntry } from '../core/vault/types';
import { isKeyslotsBundle, type KeyslotsBundle } from '../core/vault/keyslots';
import type { StorageLocation, VaultMeta, VaultStorage } from './storage';

/** 当前是否跑在 Tauri 壳里（浏览器里为 false，走内存存储）。 */
export function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 启动失败的原因分类。
 *
 * 与 Rust `StartupError::code()` 一一对应；`unknown` 是防御性兜底——
 * 将来 Rust 加了新分类而前端没跟上时，宁可显示"未归类的原因 + 原文"，
 * 也不要整屏退化成一句"本地存储读写失败，请重试"。
 */
export type StartupFailureCode =
  | 'missing_key'
  | 'credential'
  | 'data_dir'
  | 'database'
  | 'unknown';

export interface StartupFailure {
  code: StartupFailureCode;
  /** Rust 侧给出的中文原因，直接展示给用户。 */
  detail: string;
  /** 数据文件路径；连数据目录都定位不到时为 null。 */
  dbPath: string | null;
}

const STARTUP_CODES: readonly string[] = ['missing_key', 'credential', 'data_dir', 'database'];

/** 把 Rust 传来的 code 收窄成已知分类，未知一律落到 `unknown`。 */
export function normalizeStartupCode(value: unknown): StartupFailureCode {
  return typeof value === 'string' && STARTUP_CODES.includes(value)
    ? (value as StartupFailureCode)
    : 'unknown';
}

/**
 * 读启动失败原因；正常启动返回 null。
 *
 * 探测本身失败也返回 null：老版本壳没有这条命令、IPC 尚未就绪都会让
 * `invoke` 直接抛错。**探测不该成为新的"启动失败"来源**——那种情况交回
 * `SessionGate` 按原有路径处理，至少还能进去看到一句通用错误。
 */
export async function readStartupFailure(): Promise<StartupFailure | null> {
  if (!isDesktopShell()) {
    return null;
  }
  try {
    const raw = await invoke<{ code?: unknown; detail?: unknown; dbPath?: unknown } | null>(
      'startup_failure',
    );
    if (raw === null || typeof raw !== 'object') {
      return null;
    }
    return {
      code: normalizeStartupCode(raw.code),
      detail: typeof raw.detail === 'string' ? raw.detail : '',
      dbPath: typeof raw.dbPath === 'string' ? raw.dbPath : null,
    };
  } catch {
    return null;
  }
}

/** 打开数据文件所在文件夹。仅桌面壳可用。 */
export async function revealStorageFolder(): Promise<void> {
  if (!isDesktopShell()) {
    return;
  }
  await invoke('storage_reveal');
}

async function readJson<T>(key: string, guard?: (value: unknown) => boolean): Promise<T | null> {
  let raw: string | null;
  try {
    raw = await invoke<string | null>('storage_load', { key });
  } catch {
    throw errors.storageFailed();
  }
  if (raw === null || raw === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw errors.storageFailed();
  }
  if (guard !== undefined && !guard(parsed)) {
    throw errors.storageFailed();
  }
  return parsed as T;
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await invoke('storage_save', { key, value: JSON.stringify(value) });
  } catch {
    throw errors.storageFailed();
  }
}

export class TauriVaultStorage implements VaultStorage {
  async loadKeyslots(): Promise<KeyslotsBundle | null> {
    return readJson<KeyslotsBundle>('keyslots', isKeyslotsBundle);
  }

  async saveKeyslots(keyslots: KeyslotsBundle): Promise<void> {
    // 落盘前再校验一次：损坏的密钥槽写进去，等于把自己锁在门外。
    if (!isKeyslotsBundle(keyslots)) {
      throw errors.storageFailed();
    }
    await writeJson('keyslots', keyslots);
  }

  async loadItems(): Promise<EncryptedItemRecord[]> {
    return (await readJson<EncryptedItemRecord[]>('items', Array.isArray)) ?? [];
  }

  async saveItems(records: EncryptedItemRecord[]): Promise<void> {
    if (!Array.isArray(records)) {
      throw errors.storageFailed();
    }
    await writeJson('items', records);
  }

  async loadMeta(): Promise<VaultMeta | null> {
    return readJson<VaultMeta>('meta', (value) => typeof value === 'object' && value !== null);
  }

  async saveMeta(meta: VaultMeta): Promise<void> {
    await writeJson('meta', meta);
  }

  async loadRecency(): Promise<RecentEntry[]> {
    return (await readJson<RecentEntry[]>('recency', Array.isArray)) ?? [];
  }

  async saveRecency(entries: RecentEntry[]): Promise<void> {
    if (!Array.isArray(entries)) {
      throw errors.storageFailed();
    }
    await writeJson('recency', entries);
  }

  async clear(): Promise<void> {
    try {
      await invoke('storage_clear');
    } catch {
      throw errors.storageFailed();
    }
  }

  async describeStorage(): Promise<StorageLocation> {
    try {
      const location = await invoke<StorageLocation>('storage_describe');
      return location;
    } catch {
      // 描述失败不该阻断设置页：如实退回"未知位置"，而不是假装有路径。
      return { kind: 'memory', displayPath: null, canReveal: false };
    }
  }
}
