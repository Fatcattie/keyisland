/**
 * 密码体检（SDD Phase 5：密码健康检查）。
 *
 * 原则：
 * - **只返回摘要，绝不返回明文**。重复密码用 SHA-256 摘要分组，调用方拿到的
 *   是 `{ digest, itemIds }`，无法反推密码本身；
 * - 结果只用于展示"哪些卡片要改密码"，不改变任何数据；
 * - 阈值集中定义，便于产品侧调整。
 */

import { assessMasterPassword } from './policy';

/** 超过这个天数未修改密码就提示轮换（约 1 年）。 */
export const STALE_PASSWORD_DAYS = 365;

/** 一天毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 一组共用同一密码的卡片。 */
export interface DuplicateGroup {
  /** 密码的 SHA-256 摘要（hex）。仅用于分组，不可反推。 */
  digest: string;
  /** 共用该密码的卡片 id。 */
  itemIds: number[];
  /** 对应卡片的标题，顺序与 `itemIds` 一致（用于展示，不含密码）。 */
  titles: string[];
}

/** 单条体检结论。 */
export interface HealthFinding {
  itemId: number;
  title: string;
  /** 摘要文案（不含密码）。 */
  detail: string;
}

/** 体检报告。 */
export interface VaultHealthReport {
  /** 参与体检的卡片总数。 */
  totalItems: number;
  /** 重复密码分组（只含 ≥2 张卡片的分组）。 */
  duplicates: DuplicateGroup[];
  /** 强度不足的密码。 */
  weak: HealthFinding[];
  /** 超过阈值未修改的密码。 */
  stale: HealthFinding[];
}

/** 判断密码强度是否可接受（复用主密码策略，允许复用同一份规则）。 */
export function isPasswordStrong(password: string): boolean {
  return assessMasterPassword(password).acceptable;
}

/** 密码是否超过 `STALE_PASSWORD_DAYS` 天未修改。 */
export function isPasswordStale(passwordUpdatedAt: number, now: number): boolean {
  return now - passwordUpdatedAt >= STALE_PASSWORD_DAYS * DAY_MS;
}

/**
 * 汇总体检结果。
 *
 * @param entries 卡片摘要 + 密码摘要 + 强度结论；由调用方（拥有 DEK 的一侧）填充。
 * @param now 注入时钟，便于测试。
 */
export function summarizeHealth(
  entries: ReadonlyArray<{ id: number; title: string; digest: string; strong: boolean; stale: boolean }>,
): VaultHealthReport {
  const byDigest = new Map<string, { ids: number[]; titles: string[] }>();
  const weak: HealthFinding[] = [];
  const stale: HealthFinding[] = [];

  for (const entry of entries) {
    const group = byDigest.get(entry.digest);
    if (group === undefined) {
      byDigest.set(entry.digest, { ids: [entry.id], titles: [entry.title] });
    } else {
      group.ids.push(entry.id);
      group.titles.push(entry.title);
    }
    if (!entry.strong) {
      weak.push({ itemId: entry.id, title: entry.title, detail: '强度不足，建议重新生成' });
    }
    if (entry.stale) {
      stale.push({ itemId: entry.id, title: entry.title, detail: `超过 ${STALE_PASSWORD_DAYS} 天未修改` });
    }
  }

  const duplicates: DuplicateGroup[] = [];
  for (const [digest, group] of byDigest) {
    if (group.ids.length >= 2) {
      duplicates.push({ digest, itemIds: group.ids, titles: group.titles });
    }
  }
  // 重复卡片数多的排前面，便于优先处理。
  duplicates.sort((a, b) => b.itemIds.length - a.itemIds.length);

  return { totalItems: entries.length, duplicates, weak, stale };
}

/** 体检是否完全健康（没有任何告警）。 */
export function isHealthy(report: VaultHealthReport): boolean {
  return report.duplicates.length === 0 && report.weak.length === 0 && report.stale.length === 0;
}
