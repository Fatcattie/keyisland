/**
 * 存储端口。
 *
 * 本轮只实现 `MemoryVaultStorage`：
 * - 应用重启后数据消失，仅用于开发态与测试。
 * - 明确禁止用 localStorage / sessionStorage 保存密码、密钥或密文（SDD §0.3）。
 * - Phase 1.5 迁移 SQLCipher 时，`VaultStorage` 的接口语义必须保持不变（见 ADR-010）。
 */

import { errors } from '../core/errors';
import { SCHEMA_VERSION, type AutoLockPolicy, type EncryptedItemRecord, type RecentEntry } from '../core/vault/types';
import type { KeyslotsBundle } from '../core/vault/keyslots';
import { isKeyslotsBundle } from '../core/vault/keyslots';
import type { HotzoneAlign } from '../lib/hotzone';

/** 应用元数据（不含任何密钥或明文）。 */
export interface VaultMeta {
  schemaVersion: number;
  autoLockPolicy: AutoLockPolicy;
  clipboardTtlMs: number;
  /** 密码提示：仅用于回忆，不参与解密（SDD §4.5）。 */
  hint: string | null;
  /**
   * 系统锁屏 / 休眠时是否立即锁定（PRD FR-01，默认开）。
   *
   * **可选是刻意的**：这是后来加进元数据的字段，早于它落盘的记录里没有这一项。
   * 读取方一律按 `!== false` 解释（缺省 = 开），而不是 `=== true`——后者会把
   * 老数据静默降级成"关"，那正好是用户最不希望发生的安全降级。
   */
  lockOnSystemLock?: boolean;
  /**
   * 上次成功导出加密备份的时间（PRD FR-06「超过 7 天未备份时轻提示」）。
   * `null` = 从未备份；字段缺失（老记录）按 `null` 处理。
   */
  lastBackupAt?: number | null;
  /**
   * 上次弹出备份提醒的时间，用于"当日只提醒一次"。
   *
   * 存元数据而不是内存变量：用户一天里反复锁定/解锁很常见，只放内存的话
   * 刷新一次就又提醒一遍，"轻提示"变成骚扰。
   */
  lastBackupReminderAt?: number | null;
  /**
   * 顶部热区宽度（px）与水平位置（PRD FR-02「默认宽约 300px，可配置宽度与位置」）。
   *
   * 可选，理由同 `lockOnSystemLock`：这是后加的字段，老记录里没有。读取方一律走
   * `resolveHotzone()`——它逐字段回落（宽度非法回落 300、位置非法回落 center），
   * 不会因为一个字段坏了就把整份配置丢掉。
   */
  hotzoneWidthPx?: number;
  hotzoneAlign?: HotzoneAlign;
  /**
   * 展开态「鼠标离开后收起」的延时（ms，PRD FR-02 / SDD §6.5「默认 2s，可配置」）。
   *
   * 可选：老记录里没有这一项，读取方走 `resolveCollapseDelay()` 回落到 2000。
   * 折叠胶囊态的 250ms **不受它影响**，理由见 `lib/timing.ts`。
   */
  collapseDelayMs?: number;
  /**
   * 展开态「停留时长」（ms）：无操作多久之后自动隐藏。
   *
   * 与 `collapseDelayMs` 分开：前者由**空闲**触发（指针停在岛上也照样收），
   * 后者只由"指针离开"触发。可选，读取方走 `resolveDwellDelay()` 回落 10 秒。
   */
  dwellDelayMs?: number;
  /**
   * 应用内快捷键自定义（NFR 可用性：「可在设置中查看与自定义」）。
   *
   * 存的是**文本形式**（`'Ctrl+Enter'`）而不是解析后的结构：文本是人也能读、
   * 也能直接改的格式，落盘后排查"用户到底设成了什么"不用反序列化。
   * 只存可配置的那四个动作，固定项（↑↓/Esc）不占空间——理由见 `lib/shortcuts.ts`。
   *
   * 可选：老记录里没有这一项，读取方走 `resolveShortcuts()` 逐字段回落。
   */
  shortcuts?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

/**
 * 数据文件位置描述（PRD FR-06「设置页展示数据文件路径与打开所在文件夹」）。
 *
 * 诚实原则：当前内存存储**没有**文件路径，也不假装有——`displayPath` 为 null、
 * `canReveal` 为 false，UI 据此禁用"打开所在文件夹"并说明原因。等 SQLCipher
 * 落库实现返回真实路径与可打开状态，UI 无需改动即自动生效。
 */
export interface StorageLocation {
  kind: 'memory' | 'file';
  /** 人类可读的数据文件路径；内存存储为 null。 */
  displayPath: string | null;
  /** 是否存在可打开的系统文件夹（内存存储没有）。 */
  canReveal: boolean;
}

/** 存储端口。 */
export interface VaultStorage {
  loadKeyslots(): Promise<KeyslotsBundle | null>;
  saveKeyslots(keyslots: KeyslotsBundle): Promise<void>;
  loadItems(): Promise<EncryptedItemRecord[]>;
  saveItems(records: EncryptedItemRecord[]): Promise<void>;
  loadMeta(): Promise<VaultMeta | null>;
  saveMeta(meta: VaultMeta): Promise<void>;
  loadRecency(): Promise<RecentEntry[]>;
  saveRecency(entries: RecentEntry[]): Promise<void>;
  /** 清空全部数据（销毁流程或测试重置）。 */
  clear(): Promise<void>;
  /** 数据文件位置描述（PRD FR-06 设置页展示用）。 */
  describeStorage(): Promise<StorageLocation>;
}

/** 深拷贝辅助：防止外部修改内存存储内部状态。 */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 内存实现。 */
export class MemoryVaultStorage implements VaultStorage {
  private keyslots: KeyslotsBundle | null = null;

  private items: EncryptedItemRecord[] = [];

  private meta: VaultMeta | null = null;

  private recency: RecentEntry[] = [];

  async loadKeyslots(): Promise<KeyslotsBundle | null> {
    if (this.keyslots === null) {
      return null;
    }
    const snapshot = cloneJson(this.keyslots);
    if (!isKeyslotsBundle(snapshot)) {
      throw errors.storageFailed();
    }
    return snapshot;
  }

  async saveKeyslots(keyslots: KeyslotsBundle): Promise<void> {
    if (!isKeyslotsBundle(keyslots)) {
      throw errors.storageFailed();
    }
    this.keyslots = cloneJson(keyslots);
  }

  async loadItems(): Promise<EncryptedItemRecord[]> {
    return cloneJson(this.items);
  }

  async saveItems(records: EncryptedItemRecord[]): Promise<void> {
    if (!Array.isArray(records)) {
      throw errors.storageFailed();
    }
    this.items = cloneJson(records);
  }

  async loadMeta(): Promise<VaultMeta | null> {
    return this.meta === null ? null : cloneJson(this.meta);
  }

  async saveMeta(meta: VaultMeta): Promise<void> {
    this.meta = cloneJson(meta);
  }

  async loadRecency(): Promise<RecentEntry[]> {
    return cloneJson(this.recency);
  }

  async saveRecency(entries: RecentEntry[]): Promise<void> {
    if (!Array.isArray(entries)) {
      throw errors.storageFailed();
    }
    this.recency = cloneJson(entries);
  }

  async clear(): Promise<void> {
    this.keyslots = null;
    this.items = [];
    this.meta = null;
    this.recency = [];
  }

  async describeStorage(): Promise<StorageLocation> {
    // 内存存储没有文件路径，也没有文件夹可打开——如实报告，UI 会据此禁用按钮
    // 并解释原因，而不是显示一个假的路径。
    return { kind: 'memory', displayPath: null, canReveal: false };
  }
}

/** 创建默认元数据。 */
export function createDefaultMeta(
  now: number,
  autoLockPolicy: AutoLockPolicy,
  clipboardTtlMs: number,
  hint: string | null = null,
  lockOnSystemLock = true,
): VaultMeta {
  return {
    schemaVersion: SCHEMA_VERSION,
    autoLockPolicy,
    clipboardTtlMs,
    hint,
    lockOnSystemLock,
    lastBackupAt: null,
    lastBackupReminderAt: null,
    // 热区默认值写进新库，读取方仍走 `resolveHotzone()` 兜底——写与读两条路径
    // 都成立，才不会出现"只有新建的库有热区配置、老库没有"的割裂。
    hotzoneWidthPx: 300,
    hotzoneAlign: 'center',
    collapseDelayMs: 2000,
    dwellDelayMs: 10000,
    // 快捷键默认值**不写进**新库：四个可配置项的默认值都在 `lib/shortcuts.ts` 里，
    // 这里再抄一份就会出现两处默认值。缺字段时 `resolveShortcuts()` 自然回落，
    // 与"写了"在行为上完全一致，还省一次将来的同步。
    createdAt: now,
    updatedAt: now,
  };
}
