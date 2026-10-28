/**
 * Vault 领域类型定义。
 * 与 SDD §5.3 的 DTO 约束保持一致；前端可见结构里不出现密码明文。
 */

import type { EncryptedField, ItemSecretField } from '../crypto/aead';
import type { StrengthLevel } from './policy';
export type { StrengthLevel };

/** 数据结构版本，参与字段加密的 AAD。 */
export const SCHEMA_VERSION = 1;

/** 剪贴板默认自动清理时长（毫秒）。 */
export const DEFAULT_CLIPBOARD_TTL_MS = 30 * 1000;

/**
 * 剪贴板自动清理的可选时长（PRD FR-05：「默认 30s，10–120s 可调，**可关闭**」）。
 *
 * `0` 是合法的"关闭"档，不是非法值——这也是历史上把它当非法值拒绝的原因，
 * 导致 PRD 明写的"可关闭"一直没实现。
 */
export const CLIPBOARD_TTL_OPTIONS: readonly number[] = Object.freeze([
  0,
  10 * 1000,
  30 * 1000,
  60 * 1000,
  120 * 1000,
]);

/** 剪贴板自动清理的合法区间（不含"关闭"档）。 */
export const CLIPBOARD_TTL_RANGE: Readonly<{ minMs: number; maxMs: number }> = Object.freeze({
  minMs: 10 * 1000,
  maxMs: 120 * 1000,
});

/**
 * 服务层校验：`copyWithTtl` 能接受哪些时长。
 *
 * 只要求"有限且非负"——`0` 表示只写不清理（关闭档），其余正值一律放行。
 * **不在这里套 10–120s 区间**：那是用户设置档位的约束（见
 * `isValidClipboardTtlSetting`），服务内部调用方（含测试）常用 1s/2s/5s
 * 这类短时长验证清理路径，收紧到 10s 会把它们全拒掉。
 */
export function isValidClipboardTtl(ttlMs: unknown): ttlMs is number {
  return typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs >= 0;
}

/**
 * 设置层校验：用户能存进配置的清理档位（PRD「10–120 秒可调，可关闭」）。
 *
 * `0` = 关闭；否则必须是 10–120s 之间的**整数**毫秒（下拉档位之一，
 * 不接受 5s 这类低于下限的值，也不接受小数）。
 */
export function isValidClipboardTtlSetting(ttlMs: unknown): ttlMs is number {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) {
    return false;
  }
  if (ttlMs === 0) {
    return true;
  }
  return (
    Number.isInteger(ttlMs) &&
    ttlMs >= CLIPBOARD_TTL_RANGE.minMs &&
    ttlMs <= CLIPBOARD_TTL_RANGE.maxMs
  );
}

/** 卡片四档可见性（SDD §5.3，新增 `masked` 弱遮罩档）。 */
export type Visibility = 'normal' | 'username_only' | 'hidden' | 'masked';

/** 全部可见性取值，用于运行时校验。 */
export const VISIBILITY_VALUES: readonly Visibility[] = [
  'normal',
  'username_only',
  'hidden',
  'masked',
];

/**
 * 是否需要"隐私访问授权"才可读写敏感字段（账号 / 密码 / 明文详情）。
 *
 * `hidden` 与 `masked` 共用同一套授权（主密码验证 → 120s 窗口）：
 * - `hidden`：卡片不进列表与搜索，验证后才临时出现；
 * - `masked`：卡片留在列表，但账号与密码在 UI 遮罩，验证后才显示。
 *
 * 普通卡片（`normal` / `username_only`）不需要授权。
 */
export function requiresPrivacyAccess(visibility: Visibility): boolean {
  return visibility === 'hidden' || visibility === 'masked';
}

/** 允许复制的字段（备注不参与复制）。 */
export type ItemSecretFieldName = Extract<ItemSecretField, 'username' | 'password'>;

/** 列表排序方式。 */
export type SortMode = 'recent_used' | 'recent_updated' | 'alpha';

/** 会话状态。 */
export type SessionStatus = 'uninitialized' | 'locked' | 'unlocked' | 'cooling_down';

/** 自动锁定档位（PRD FR-01）。 */
export type AutoLockPolicy = 'immediate' | '5m' | '30m' | '4h' | 'boot';

/** 锁定原因，用于事件与审计（不记录敏感内容）。 */
export type LockReason =
  | 'manual'
  | 'timeout'
  | 'system_lock'
  | 'suspend'
  | 'app_exit'
  | 'recovery'
  /** 连续认证失败进入冷却时被强制锁定（P2-3）。 */
  | 'auth_cooldown';

/** 列表返回的资产摘要，不含密码。 */
export interface ItemSummary {
  id: number;
  title: string;
  platform: string | null;
  /**
   * 账号。`hidden` 不会出现在列表中；`masked` 会出现在列表但 UI 默认遮罩，
   * 验证主密码后才显示明文（遮罩是前端行为，摘要里仍携带该值）。
   */
  username?: string;
  category: string;
  tags: string[];
  favorite: boolean;
  visibility: Visibility;
  updatedAt: number;
  hasUrl: boolean;
  hasAppTarget: boolean;
  /**
   * 密码强度档位（粗粒度，FR-03「密码强度点」）。可选：旧记录 / 从备份恢复的
   * 记录可能缺这个字段，卡片端需优雅地不展示。在保存时由明文密码算出，不存明文。
   */
  strength?: StrengthLevel;
}

/** 详情返回结构，仍不含密码明文。 */
export interface ItemDetail extends ItemSummary {
  url: string | null;
  appPath: string | null;
  notes?: string;
  passwordUpdatedAt: number;
}

/** 内存中的明文资产（仅在解锁态存在）。 */
export interface ItemPlain {
  id: number;
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
  passwordUpdatedAt: number;
  createdAt: number;
  updatedAt: number;
  /** 密码强度档位；保存时由明文密码算出。旧记录 / 恢复的记录可能缺失。 */
  strength?: StrengthLevel;
}

/** 落盘的加密资产记录（SDD §4.3 items 表的 TS 映射）。 */
export interface EncryptedItemRecord {
  id: number;
  title: string;
  platform: string | null;
  url: string | null;
  appPath: string | null;
  category: string;
  tags: string[];
  visibility: Visibility;
  favorite: boolean;
  usernameEnc: EncryptedField;
  passwordEnc: EncryptedField;
  notesEnc: EncryptedField | null;
  passwordUpdatedAt: number;
  createdAt: number;
  updatedAt: number;
  /** 密码强度档位（明文落盘，粗粒度非敏感）；旧记录可能缺失。 */
  strength?: StrengthLevel;
}

/** 创建资产入参。 */
export interface CreateItemInput {
  title: string;
  platform?: string | null;
  url?: string | null;
  appPath?: string | null;
  username: string;
  password: string;
  notes?: string | null;
  category?: string | null;
  tags?: string[] | null;
  visibility?: Visibility;
  favorite?: boolean;
}

/** 更新资产入参；未传 `visibility` 时保持原值（降级保护）。 */
export interface UpdateItemInput {
  title?: string;
  platform?: string | null;
  url?: string | null;
  appPath?: string | null;
  username?: string;
  password?: string;
  notes?: string | null;
  category?: string | null;
  tags?: string[] | null;
  visibility?: Visibility;
  favorite?: boolean;
}

/** 列表/搜索过滤条件。 */
export interface ItemFilter {
  text?: string;
  category?: string | null;
  tag?: string | null;
  favoriteOnly?: boolean;
  sort?: SortMode;
  /** 仅隐藏卡片列表使用；普通列表必须为 false。 */
  includeHidden?: boolean;
}

/** 最近使用条目。 */
export interface RecentEntry {
  itemId: number;
  lastUsedAt: number;
}

/** 复制回执：只描述策略，不包含任何明文。 */
export interface CopyReceipt {
  token: string;
  field: ItemSecretField;
  /** 自动清理时间戳（毫秒）。`autoClear` 为 false 时无意义。 */
  expiresAt: number;
  ttlMs: number;
  /**
   * 是否安排自动清理。`false` 表示用户在设置里关掉了自动清理（`ttlMs === 0`）——
   * 此时内容会一直留在剪贴板里，直到用户自己复制别的东西或锁定会话。
   */
  autoClear: boolean;
}

/** 会话快照，等价于 SDD 的 `SessionState`。 */
export interface SessionSnapshot {
  status: SessionStatus;
  /** `null` 表示不按时间自动锁定（`boot` 档位）。 */
  unlockedUntil: number | null;
  /** 与 SDD 对齐：主密码失败次数。 */
  failedAttempts: number;
  passwordFailures: number;
  recoveryFailures: number;
  cooldownUntil: number | null;
  cooldownRemainingMs: number;
  autoLockPolicy: AutoLockPolicy;
  /**
   * 系统锁屏 / 休眠时是否立即锁定（PRD FR-01「默认开，可关」）。
   *
   * 这是设置项而非瞬时状态：切换后立即生效并写入元数据，重启后沿用。
   */
  lockOnSystemLock: boolean;
  /**
   * 最近一次锁定的原因，仅供解锁页告诉用户"为什么被锁"。
   *
   * 解锁成功 / 首次初始化后为 `null`。之所以放进快照而不是让 UI 单独查一次：
   * 解锁页只拿得到快照，多一次异步查询就多一处 act 时序与竞态。
   */
  lockReason: LockReason | null;
  /**
   * 隐私访问授权（隐藏卡片 / 遮罩卡片）的到期时间戳（毫秒）；`null` 表示当前无授权。
   *
   * 由门面维护（不在 `VaultSession` 里），附在快照上供 UI 判断卡片字段是否可显示。
   * 授权只验证主密码、不改变会话状态，到期或锁定时立即失效。
   */
  hiddenAccessUntil: number | null;
}
