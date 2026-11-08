/**
 * 存储端口。
 *
 * 本文件提供端口定义与 `MemoryVaultStorage`：
 * - 内存实现在应用重启后数据消失，仅用于浏览器预览、开发态与测试。
 * - 明确禁止用 localStorage / sessionStorage 保存密码、密钥或密文（SDD §0.3）。
 * - 桌面实现见 `tauri-storage.ts`（SQLite + 每值 AES-256-GCM），两者的接口语义必须一致（见 ADR-010），
 * 由 `__tests__/support/storage-contract.ts` 的共享契约约束。
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
 * `canReveal` 为 false，UI 据此禁用"打开所在文件夹"并说明原因。桌面版 SQLite
 * 落库实现返回真实路径与可打开状态，UI 无需改动即自动生效。
 */
export interface StorageLocation {
  kind: 'memory' | 'file';
  /** 人类可读的数据文件路径；内存存储为 null。 */
  displayPath: string | null;
  /** 是否存在可打开的系统文件夹（内存存储没有）。 */
  canReveal: boolean;
}

/**
 * 一次**原子**写入（ADR-010 补充：多键写入必须同生同死）。
 *
 * 出现的段才会被写；未出现的段保持原样。`items` 出现时是**整体替换**
 * （库里不在列表中的卡片会被删掉），用于初始化、覆盖导入、合并导入这类
 * "整库换新"的场景；单卡增删改走 {@link ItemChangeSet}。
 *
 * 为什么不是前端 `try { saveA; saveB } catch { 反向写回 }`：补偿写入扛不住断电、
 * 进程被杀，也可能再次撞上同一个磁盘故障。新密钥槽落盘而旧资产没换，
 * 库就再也解不开了。实现方必须保证：要么全部生效，要么一个都不生效。
 */
export interface VaultWriteBatch {
  keyslots?: KeyslotsBundle;
  meta?: VaultMeta;
  /** 整体替换全部资产。 */
  items?: EncryptedItemRecord[];
  recency?: RecentEntry[];
}

/**
 * 资产增量变更：只写变化的那几张卡片（任务 5，单卡修改不重写整库）。
 *
 * 同样是原子的——批量删除 / 批量导入要么全部落盘，要么一条都不落。
 * 同一个 id 同时出现在 `upserts` 与 `deletes` 里视为调用方错误，直接拒绝。
 */
export interface ItemChangeSet {
  upserts: EncryptedItemRecord[];
  deletes: number[];
}

/** 校验写入批次的结构；任何一段不合法都整体拒绝，不落半截。 */
export function assertValidBatch(batch: VaultWriteBatch): void {
  if (batch === null || typeof batch !== 'object') {
    throw errors.storageFailed();
  }
  if (batch.keyslots !== undefined && !isKeyslotsBundle(batch.keyslots)) {
    throw errors.storageFailed();
  }
  if (batch.meta !== undefined && (batch.meta === null || typeof batch.meta !== 'object')) {
    throw errors.storageFailed();
  }
  if (batch.items !== undefined) {
    assertValidRecords(batch.items);
  }
  if (batch.recency !== undefined && !Array.isArray(batch.recency)) {
    throw errors.storageFailed();
  }
}

/** 记录 id 必须是非负安全整数：它同时是 AAD 的一部分与存储行的身份。 */
export function isValidItemId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0;
}

function assertValidRecords(records: unknown): asserts records is EncryptedItemRecord[] {
  if (!Array.isArray(records)) {
    throw errors.storageFailed();
  }
  const seen = new Set<number>();
  for (const record of records) {
    if (record === null || typeof record !== 'object' || !isValidItemId((record as EncryptedItemRecord).id)) {
      throw errors.storageFailed();
    }
    const id = (record as EncryptedItemRecord).id;
    // 同一批里出现两次同一个 id，后写的会静默盖掉先写的——这是调用方的 bug，不替它选。
    if (seen.has(id)) {
      throw errors.storageFailed();
    }
    seen.add(id);
  }
}

/** 校验增量变更的结构。 */
export function assertValidChangeSet(changes: ItemChangeSet): void {
  if (changes === null || typeof changes !== 'object' || !Array.isArray(changes.deletes)) {
    throw errors.storageFailed();
  }
  assertValidRecords(changes.upserts);
  const upsertIds = new Set(changes.upserts.map((record) => record.id));
  for (const id of changes.deletes) {
    if (!isValidItemId(id) || upsertIds.has(id)) {
      throw errors.storageFailed();
    }
  }
}

/** 存储端口。 */
export interface VaultStorage {
  loadKeyslots(): Promise<KeyslotsBundle | null>;
  saveKeyslots(keyslots: KeyslotsBundle): Promise<void>;
  loadItems(): Promise<EncryptedItemRecord[]>;
  /** 整体替换全部资产，等价于 `commit({ items: records })`。 */
  saveItems(records: EncryptedItemRecord[]): Promise<void>;
  /** 原子地写入或删除若干张卡片；未提及的卡片不被读、不被写。 */
  applyItemChanges(changes: ItemChangeSet): Promise<void>;
  /** 原子地写入多段数据（见 {@link VaultWriteBatch}）。 */
  commit(batch: VaultWriteBatch): Promise<void>;
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
    await this.commit({ items: records });
  }

  async applyItemChanges(changes: ItemChangeSet): Promise<void> {
    assertValidChangeSet(changes);
    // 先在副本上算出结果，最后一次赋值——中途抛错时 `this.items` 一点没动。
    const byId = new Map(this.items.map((record) => [record.id, record]));
    for (const id of changes.deletes) {
      byId.delete(id);
    }
    for (const record of cloneJson(changes.upserts)) {
      byId.set(record.id, record);
    }
    this.items = [...byId.values()];
  }

  async commit(batch: VaultWriteBatch): Promise<void> {
    assertValidBatch(batch);
    // 全部段先深拷贝（可能抛错的步骤都在这里），然后同步地依次赋值：
    // 赋值之间没有 await，不存在"写了一半被别的调用看到"的窗口。
    const next = {
      keyslots: batch.keyslots === undefined ? undefined : cloneJson(batch.keyslots),
      meta: batch.meta === undefined ? undefined : cloneJson(batch.meta),
      items: batch.items === undefined ? undefined : cloneJson(batch.items),
      recency: batch.recency === undefined ? undefined : cloneJson(batch.recency),
    };
    if (next.keyslots !== undefined) {
      this.keyslots = next.keyslots;
    }
    if (next.meta !== undefined) {
      this.meta = next.meta;
    }
    if (next.items !== undefined) {
      this.items = next.items;
    }
    if (next.recency !== undefined) {
      this.recency = next.recency;
    }
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
