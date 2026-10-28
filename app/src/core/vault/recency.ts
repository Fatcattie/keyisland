/**
 * 最近使用（灵动岛横条）。
 *
 * 规则（PRD FR-02）：
 * - 最多 6 张，按最近复制时间倒序。
 * - 只包含 `normal` / `username_only`，`hidden` 永不进入。
 * - 删除资产时清理对应记录。
 */

import type { RecentEntry, Visibility } from './types';

/** 最近使用最大条数。 */
export const MAX_RECENT_ITEMS = 6;

/** 最近使用跟踪器（纯内存，随会话存在）。 */
export class RecencyTracker {
  private entries: RecentEntry[];

  private readonly now: () => number;

  constructor(options: { now: () => number; initial?: RecentEntry[] }) {
    this.now = options.now;
    this.entries = this.normalize(options.initial ?? []);
  }

  /** 记录一次复制行为；隐藏卡片直接忽略。 */
  recordUse(itemId: number, visibility: Visibility): RecentEntry[] {
    if (visibility === 'hidden') {
      return this.list();
    }
    const lastUsedAt = this.now();
    const rest = this.entries.filter((entry) => entry.itemId !== itemId);
    this.entries = [{ itemId, lastUsedAt }, ...rest].slice(0, MAX_RECENT_ITEMS);
    return this.list();
  }

  /** 删除资产时清理。 */
  remove(itemId: number): RecentEntry[] {
    this.entries = this.entries.filter((entry) => entry.itemId !== itemId);
    return this.list();
  }

  /** 移除已不可见（被改为 hidden 或已删除）的条目。 */
  prune(visibleItemIds: ReadonlySet<number>): RecentEntry[] {
    this.entries = this.entries.filter((entry) => visibleItemIds.has(entry.itemId));
    return this.list();
  }

  /** 返回副本，按最近使用时间倒序。 */
  list(): RecentEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** 返回 itemId → lastUsedAt 的索引，供搜索排序使用。 */
  index(): Map<number, number> {
    const map = new Map<number, number>();
    for (const entry of this.entries) {
      map.set(entry.itemId, entry.lastUsedAt);
    }
    return map;
  }

  /** 序列化为可持久化的数组。 */
  toJSON(): RecentEntry[] {
    return this.list();
  }

  /** 从存储数据恢复，容忍脏数据。 */
  static fromJSON(value: unknown, now: () => number): RecencyTracker {
    return new RecencyTracker({ now, initial: parseRecentEntries(value) });
  }

  /** 去重、排序、截断。 */
  private normalize(entries: RecentEntry[]): RecentEntry[] {
    const seen = new Set<number>();
    const result: RecentEntry[] = [];
    for (const entry of entries) {
      if (seen.has(entry.itemId)) {
        continue;
      }
      seen.add(entry.itemId);
      result.push({ itemId: entry.itemId, lastUsedAt: entry.lastUsedAt });
    }
    result.sort((left, right) => right.lastUsedAt - left.lastUsedAt);
    return result.slice(0, MAX_RECENT_ITEMS);
  }
}

/** 解析持久化的最近使用记录，过滤非法项。 */
export function parseRecentEntries(value: unknown): RecentEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: RecentEntry[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const candidate = item as Partial<RecentEntry>;
    if (
      typeof candidate.itemId === 'number' &&
      Number.isInteger(candidate.itemId) &&
      candidate.itemId > 0 &&
      typeof candidate.lastUsedAt === 'number' &&
      Number.isFinite(candidate.lastUsedAt)
    ) {
      result.push({ itemId: candidate.itemId, lastUsedAt: candidate.lastUsedAt });
    }
  }
  return result;
}
