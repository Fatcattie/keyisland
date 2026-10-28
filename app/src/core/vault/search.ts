/**
 * 搜索与排序。
 *
 * 性能约束（SDD §1.3：1000 条 ≤ 50 ms）：
 * - 过滤为单次 O(n) 遍历，禁止嵌套扫描或逐条解密后再全表比对。
 * - 大小写不敏感；空查询返回全部可见项。
 * - `hidden` 永不进入结果。
 */

import type { ItemFilter, ItemSummary, SortMode } from './types';
import { isPinyinQuery, pinyinCandidates } from './pinyin';

/** 排序比较器缓存，避免每次比较都构造 Intl.Collator。 */
const ALPHA_COLLATOR = new Intl.Collator('zh-Hans-CN', { sensitivity: 'base', numeric: true });

/**
 * 判断条目是否命中关键词（已归一化为小写）。
 *
 * 先做普通子串匹配，再按需做拼音匹配：
 * 查询是纯 ascii 字母/数字时，才对该条的文本字段计算拼音候选（`zw` / `zhongwen`）。
 * 拼音分支只服务检索，不参与排序，也不改变存储结构。
 */
export function matchesText(item: ItemSummary, needle: string): boolean {
  if (needle.length === 0) {
    return true;
  }
  if (item.title.toLowerCase().includes(needle)) {
    return true;
  }
  if (item.platform !== null && item.platform.toLowerCase().includes(needle)) {
    return true;
  }
  if (item.username !== undefined && item.username.toLowerCase().includes(needle)) {
    return true;
  }
  if (item.category.toLowerCase().includes(needle)) {
    return true;
  }
  for (const tag of item.tags) {
    if (tag.toLowerCase().includes(needle)) {
      return true;
    }
  }
  if (isPinyinQuery(needle)) {
    return matchesPinyin(
      needle,
      item.title,
      item.platform,
      item.username,
      item.category,
      ...item.tags,
    );
  }
  return false;
}

/** 拼音候选匹配：任一字段的全拼串或首字母串包含查询串即命中。 */
function matchesPinyin(needle: string, ...fields: ReadonlyArray<string | null | undefined>): boolean {
  for (const field of fields) {
    if (field === null || field === undefined || field.length === 0) {
      continue;
    }
    const { full, initials } = pinyinCandidates(field);
    if (full.includes(needle) || initials.includes(needle)) {
      return true;
    }
  }
  return false;
}

/** 按排序模式排序（原地排序传入数组，调用方负责传副本）。 */
function sortItems(
  items: ItemSummary[],
  sort: SortMode,
  recency: ReadonlyMap<number, number> | undefined,
): ItemSummary[] {
  if (sort === 'alpha') {
    return items.sort(
      (left, right) => ALPHA_COLLATOR.compare(left.title, right.title) || left.id - right.id,
    );
  }
  if (sort === 'recent_used') {
    return items.sort((left, right) => {
      const leftUsed = recency?.get(left.id) ?? 0;
      const rightUsed = recency?.get(right.id) ?? 0;
      return rightUsed - leftUsed || right.updatedAt - left.updatedAt || right.id - left.id;
    });
  }
  return items.sort((left, right) => right.updatedAt - left.updatedAt || right.id - left.id);
}

/**
 * 过滤并排序资产摘要。
 *
 * @param items 已解密的资产摘要（含隐藏卡片也可以传入，函数内部会过滤）。
 * @param filter 过滤条件。
 * @param recency itemId → 最近复制时间，供 `recent_used` 排序使用。
 */
export function searchItems(
  items: readonly ItemSummary[],
  filter: ItemFilter = {},
  recency?: ReadonlyMap<number, number>,
): ItemSummary[] {
  const needle = (filter.text ?? '').trim().toLowerCase();
  const category = filter.category ?? null;
  const tag = filter.tag ?? null;
  const favoriteOnly = filter.favoriteOnly === true;
  const includeHidden = filter.includeHidden === true;

  const matched: ItemSummary[] = [];
  for (const item of items) {
    // 单次遍历内完成全部判定，保持 O(n)。
    if (item.visibility === 'hidden' && !includeHidden) {
      continue;
    }
    if (favoriteOnly && !item.favorite) {
      continue;
    }
    if (category !== null && item.category !== category) {
      continue;
    }
    if (tag !== null && !item.tags.includes(tag)) {
      continue;
    }
    if (!matchesText(item, needle)) {
      continue;
    }
    matched.push(item);
  }

  return sortItems(matched, filter.sort ?? 'recent_updated', recency);
}
