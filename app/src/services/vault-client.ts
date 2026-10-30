/**
 * Vault 门面（`VaultClient`）。
 *
 * 职责：
 * - 把会话、密钥槽、资产、搜索、最近使用、剪贴板编排成前端可直接调用的一组 Promise API。
 * - 与 SDD §5.2 的 Tauri command 语义对齐，Phase 1.5 可用 `invoke` 实现替换而保持调用方不变。
 * - 所有错误统一为 `AppError`（code + messageKey + retryable），绝不抛裸字符串。
 *
 * 明确不返回：DEK、KEK、主密码、恢复密钥、资产密码明文。
 */

import { AppError, errors, toAppError, type ErrorCode } from '../core/errors';
import { zeroize } from '../core/crypto/random';
import { sha256Hex } from '../core/crypto/digest';
import type { Argon2Params } from '../core/crypto/kdf';
import { ARGON2_PARAMS_V1 } from '../core/crypto/kdf';
import {
  DEFAULT_AUTO_LOCK_POLICY,
  DEFAULT_CLIPBOARD_TTL_MS,
  MAX_RECENT_ITEMS,
  RecencyTracker,
  VaultSession,
  assertMasterPassword,
  createRecoveryMaterial,
  generatePassword,
  isValidClipboardTtl,
  isValidClipboardTtlSetting,
  parseKirkFile,
  recoveryKeyFromKirk,
  sanitizeJumpTarget,
  searchItems,
  AuditLog,
  type AuditEntry,
  type AutoLockPolicy,
  type CopyReceipt,
  type CreateItemInput,
  type GeneratePasswordOptions,
  type ItemDetail,
  type ItemFilter,
  type ItemSummary,
  type ItemPlain,
  type KirkFile,
  type LockReason,
  type SessionSnapshot,
  type UpdateItemInput,
  type Visibility,
} from '../core/vault';
import {
  exportAssetTransfer as encodeAssetTransfer,
  importAssetTransfer as decodeAssetTransfer,
  toAssetTransferItem,
  toCreateItemInput,
} from '../core/vault/asset-transfer';
import { requiresPrivacyAccess } from '../core/vault/types';
import { DEFAULT_CATEGORY, ItemService } from '../core/vault/items';
import { decryptItem } from '../core/vault/item-codec';
import { isPasswordStale, isPasswordStrong, summarizeHealth, type VaultHealthReport } from '../core/vault/health';
import {
  exportBackup as encodeBackup,
  importBackup as decodeBackup,
  isSameKeyLineage,
  mergeBackupItems,
  type BackupConflict,
} from '../core/vault/backup';
import { ClipboardService, createBrowserClipboardPort, type ClipboardPort } from './clipboard';
import { createDefaultMeta, type StorageLocation, type VaultMeta, type VaultStorage } from './storage';
import {
  HOTZONE_MAX_WIDTH_PX,
  HOTZONE_MIN_WIDTH_PX,
  isHotzoneAlign,
  resolveHotzone,
  type HotzoneAlign,
  type HotzoneConfig,
} from '../lib/hotzone';
import {
  DEFAULT_COLLAPSE_DELAY_MS,
  DEFAULT_DWELL_DELAY_MS,
  isValidCollapseDelay,
  isValidDwellDelay,
  resolveCollapseDelay,
  resolveDwellDelay,
} from '../lib/timing';
import {
  DEFAULT_SHORTCUTS,
  findShortcutConflict,
  isConfigurableAction,
  isValidShortcutSpec,
  parseBinding,
  resolveShortcuts,
  sameBinding,
  serializeShortcuts,
  type ShortcutAction,
  type ShortcutMap,
} from '../lib/shortcuts';

/** 初始化入参。 */
export interface InitializeVaultInput {
  masterPassword: string;
  /** 密码提示，仅用于回忆，不参与解密。 */
  hint?: string | null;
  autoLockPolicy?: AutoLockPolicy;
}

/** 初始化结果：恢复码与 `.kirk` 内容必须由用户离线保存。 */
export interface InitializeVaultResult {
  recoveryCode: string;
  kirkFile: KirkFile;
  kirkJson: string;
  session: SessionSnapshot;
}

/**
 * 轮换恢复密钥的结果（PRD FR-08.1）。
 *
 * 与初始化结果同构：新恢复码与 `.kirk` 内容只在这一次返回里存在，**不落盘**，
 * 调用方必须让用户当场离线保存。
 */
export interface RotateRecoveryKeyResult {
  recoveryCode: string;
  kirkFile: KirkFile;
  kirkJson: string;
  session: SessionSnapshot;
}

/** 备份状态（PRD FR-06「超过 7 天未备份时轻提示」）。 */
export interface BackupStatus {
  /** 上次成功导出备份的时间；`null` = 从未备份。 */
  lastBackupAt: number | null;
  /**
   * 距上次备份的天数（向下取整）。从未备份时按"库创建至今"算——
   * 刚建 5 分钟的库不该被催备份，建了 8 天还没备份的必须催。
   */
  daysSinceBackup: number;
  /** 是否已超过提醒阈值。 */
  overdue: boolean;
}

/** 热区配置的部分更新（PRD FR-02）。 */
export interface HotzoneConfigPatch {
  widthPx?: number;
  align?: HotzoneAlign;
}

/** 重设主密码入参。 */
export interface ResetPasswordRequest {
  recoveryCode: string;
  newPassword: string;
  hint?: string | null;
}

/** 用 `.kirk` 内容重设主密码的入参。 */
export interface ResetPasswordByKirkRequest {
  kirkJson: string;
  newPassword: string;
  hint?: string | null;
}

/** 恢复码校验回执。 */
export interface RecoveryVerifiedResult {
  verified: true;
}

/** 资产迁移包（`.kia`）导出选项。 */
export interface ExportAssetOptions {
  /** 只导出该分类下的卡片；省略则导出全库。 */
  category?: string;
}

/** 备份恢复模式。 */
export type BackupRestoreMode = 'overwrite' | 'merge';

/** 备份导入入参。 */
export interface ImportBackupInput {
  /** `.kib` 文件文本内容。 */
  kirkJson: string;
  /** 导出时使用的主密码；错误或篡改一律拒绝。 */
  password: string;
  /**
   * `overwrite`：二次确认后整体替换当前库；
   * `merge`：按平台/网址相同的资产作为冲突上报，其余增量插入。
   */
  mode: BackupRestoreMode;
  /**
   * 覆盖导入时需要再次输入**当前库**的主密码（SDD §9.2 的"二次确认"）。
   * 合并导入不需要：它只增量插入资产，不替换密钥槽。
   */
  masterPassword?: string;
}

/** 备份导入结果：只包含统计与冲突摘要，不含任何明文或密钥。 */
export interface ImportBackupResult {
  mode: BackupRestoreMode;
  /** 恢复后的资产总数。 */
  totalItems: number;
  /** 合并模式下新插入的资产数量。 */
  inserted: number;
  /** 合并模式下内容一致被跳过的数量。 */
  skipped: number;
  /** 合并模式下同站点冲突（保留当前库版本）。 */
  conflicts: BackupConflict[];
}

/** 批量删除结果：只包含计数与 id，不含任何明文。 */
export interface BulkDeleteResult {
  /** 实际删除的张数。 */
  deleted: number;
  /** 实际删除的 id，供 UI 清理选中态。 */
  deletedIds: number[];
}

/**
 * 隐藏卡片二次认证的授权窗口（毫秒）。
 * 120 秒足够用户在一个小列表里连续查看若干张隐藏卡片，
 * 又不至于让"刚输过密码"变成长期免检。
 */
export const HIDDEN_ACCESS_WINDOW_MS = 120 * 1000;

/** 一天的长度（毫秒），用于"当日只提醒一次"的自然日判定。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 超过这么多天没备份就提醒（PRD FR-06 定案 7 天）。 */
export const BACKUP_REMINDER_DAYS = 7;

/** 参与"完全内容"比对的字段集合（不含 id、时间戳与强度）。 */
interface ContentSignatureShape {
  title: string;
  platform: string | null;
  url: string | null;
  appPath: string | null;
  username: string;
  password: string;
  notes: string | null;
  category: string;
  tags: readonly string[];
  visibility: Visibility;
  favorite: boolean;
}

/**
 * 完全内容签名。
 *
 * 密文带随机 nonce，同一份内容两次加密的字节不同，所以去重**必须解密后按业务字段比对**。
 * 时间戳与 id 不参与：同一张卡片导入两次，内容相同就该算重复。
 */
function contentSignature(item: ContentSignatureShape): string {
  return JSON.stringify({
    title: item.title,
    platform: item.platform,
    url: item.url,
    appPath: item.appPath,
    username: item.username,
    password: item.password,
    notes: item.notes,
    category: item.category,
    tags: item.tags,
    visibility: item.visibility,
    favorite: item.favorite,
  });
}

/**
 * 待创建输入的签名。
 *
 * 先按 `ItemService.createItems` 的默认值补齐，否则"CSV 没写分类"与"库里分类是默认值"
 * 会被算成两张不同的卡片，重复导入就压不住。
 */
function signatureOfInput(input: CreateItemInput): string {
  return contentSignature({
    title: input.title,
    platform: input.platform ?? null,
    url: input.url ?? null,
    appPath: input.appPath ?? null,
    username: input.username,
    password: input.password,
    notes: input.notes ?? null,
    category: input.category ?? DEFAULT_CATEGORY,
    tags: input.tags ?? [],
    visibility: input.visibility ?? 'normal',
    favorite: input.favorite ?? false,
  });
}

/** 隐藏卡片授权的调用选项。 */
export interface HiddenAccessOptions {
  /**
   * 显式请求访问隐藏卡片。必须已通过 `requestHiddenAccess()` 取得有效授权，
   * 否则抛 `ITEM_HIDDEN`（与"卡片不存在"同码，避免泄漏隐藏卡片是否存在）。
   */
  allowHidden?: boolean;
}

/** 隐藏卡片授权结果：只暴露到期时间，不含任何密钥或明文。 */
export interface HiddenAccessGrant {
  /** 授权到期时间戳（毫秒），由注入时钟计算。 */
  grantedUntil: number;
}

/** 门面接口：未来由 Tauri invoke 实现同一套语义。 */
export interface VaultClient {
  status(): Promise<SessionSnapshot>;
  initialize(input: InitializeVaultInput): Promise<InitializeVaultResult>;
  unlock(password: string): Promise<SessionSnapshot>;
  lock(reason?: LockReason): Promise<SessionSnapshot>;
  recover(code: string): Promise<RecoveryVerifiedResult>;
  /** 用 `.kirk` 文件内容校验恢复凭据（与 `recover(code)` 等价）。 */
  recoverWithKirk(kirkJson: string): Promise<RecoveryVerifiedResult>;
  resetMasterPassword(input: ResetPasswordRequest): Promise<SessionSnapshot>;
  /** 用 `.kirk` 文件内容重设主密码（与 `resetMasterPassword` 等价）。 */
  resetMasterPasswordWithKirk(input: ResetPasswordByKirkRequest): Promise<SessionSnapshot>;
  /**
   * 请求隐藏卡片访问授权（P2-2）。
   * 只校验主密码，不改变会话状态；失败计入现有密码失败计数，
   * 因此连续试错同样会触发冷却与强制锁定。
   */
  requestHiddenAccess(password: string): Promise<HiddenAccessGrant>;
  listItems(filter?: ItemFilter): Promise<ItemSummary[]>;
  getItem(id: number, options?: HiddenAccessOptions): Promise<ItemDetail>;
  createItem(input: CreateItemInput): Promise<ItemSummary>;
  /** 原子批量创建：全部通过校验后整体落盘，失败时不留下部分导入。 */
  createItems(inputs: readonly CreateItemInput[]): Promise<ItemSummary[]>;
  /**
   * 导入 CSV 预览结果：只追加、不覆盖，完全相同的卡片跳过。
   * 返回新增与跳过数量，界面据此如实汇报（而不是一律说"已导入 N 张"）。
   */
  importCsvItems(inputs: readonly CreateItemInput[]): Promise<{ inserted: number; skipped: number }>;
  updateItem(id: number, input: UpdateItemInput): Promise<ItemSummary>;
  deleteItem(id: number): Promise<void>;
  /**
   * 批量删除（PRD `prd.md:138`「批量删除需输入主密码」）。
   *
   * 高危操作，必须现验主密码；主密码错误时**一张都不删**（先验后删，不是先删后验）。
   * 不存在的 id 静默跳过；`ids` 为空时直接返回 0，不消耗一次密码失败计数。
   */
  deleteItems(ids: number[], masterPassword: string): Promise<BulkDeleteResult>;
  setFavorite(id: number, favorite: boolean): Promise<ItemSummary>;
  setVisibility(id: number, visibility: Visibility): Promise<ItemSummary>;
  copyPassword(id: number, options?: HiddenAccessOptions): Promise<CopyReceipt>;
  copyUsername(id: number, options?: HiddenAccessOptions): Promise<CopyReceipt>;
  /**
   * 读取密码明文，仅供"按住预览"这类瞬时展示使用。
   *
   * 语义与 `copyPassword` 完全一致：
   * - `normal` 可读；
   * - `username_only` 抛 `ITEM_HIDDEN`（该档位靠复制取用，不允许预览）；
   * - `hidden` / `masked` 需要持有有效授权（主密码验证，120s 窗口）；
   *   `masked` 卡片留在列表但字段遮罩，授权后才显明文。
   *
   * 调用方必须在 `pointerup / pointerleave / blur / 卸载 / 锁定` 时立刻丢弃返回值，
   * 不得写入任何全局状态。
   */
  revealPassword(id: number, options?: HiddenAccessOptions): Promise<string>;
  getRecentItems(limit?: number): Promise<ItemSummary[]>;
  /**
   * 灵动岛列表：**全部可见卡片**（排除 `hidden`），最近使用过的排前面，
   * 其余按更新时间倒序。
   *
   * 为什么不是 `getRecentItems`：那份只返回"用过的"，导致主面板新建的卡片
   * 在岛里看不见，必须先在主面板复制一次才出现（线上反馈的 bug）。
   */
  getIslandItems(limit?: number): Promise<ItemSummary[]>;
  searchItems(filter: ItemFilter): Promise<ItemSummary[]>;
  generatePassword(options?: GeneratePasswordOptions): string;
  /**
   * 生成一个新密码并直接写入剪贴板（PRD FR-02 灵动岛「生成密码」快捷按钮）。
   *
   * 与 `generatePassword` 的区别：那个只返回值（供表单回填），这个走完"生成 →
   * 写剪贴板 → 登记到期清理"整条链路，返回与复制密码一致的回执。
   * 不要求解锁：不读写任何库内数据，锁定时也能用。
   */
  copyGeneratedPassword(options?: GeneratePasswordOptions): Promise<CopyReceipt>;
  /** 读取密码提示；未设置或未初始化时返回 null（不泄漏任何密钥信息）。 */
  getPasswordHint(): Promise<string | null>;
  /** 修改自动锁定档位并持久化到元数据。 */
  setAutoLockPolicy(policy: AutoLockPolicy): Promise<SessionSnapshot>;
  /** 修改剪贴板自动清理时长（毫秒）并持久化到元数据。 */
  setClipboardTtl(ttlMs: number): Promise<void>;
  /**
   * 系统锁屏 / 休眠时是否立即锁定（PRD FR-01，默认开、可关）。
   *
   * 写入元数据；切换后立即生效，不需要重启。
   */
  setLockOnSystemLock(enabled: boolean): Promise<SessionSnapshot>;
  /**
   * 系统锁屏 / 休眠事件触发的锁定（PRD FR-01）。
   *
   * 两种情况是**空操作**（返回当前快照，不清密钥、不打断会话）：
   * - 用户在设置里关掉了这个开关；
   * - 会话本来就没解锁。
   *
   * 放在门面而不是让 UI 直接调 `lock('system_lock')`：开关判断属于策略，
   * 分散到每个监听点必然漂移——有的地方判、有的地方忘判，就是"关了还会锁"。
   */
  lockForSystemEvent(): Promise<SessionSnapshot>;
  /**
   * 顶部热区配置（PRD FR-02「默认宽约 300px，可配置宽度与位置」）。
   *
   * 不要求解锁：热区在锁定态同样要能唤出解锁面板，读不到配置就会退化成
   * "锁着的时候热区失效"——那正好是用户最需要它的时刻。
   */
  getHotzoneConfig(): Promise<HotzoneConfig>;
  /**
   * 修改热区宽度 / 水平位置并持久化。
   *
   * 只接受合法区间（120–1200px）与三种位置；越界值**报错而不是静默夹取**——
   * 设置页的滑块本身就夹过，走到这里的越界值意味着调用方算错了，
   * 静默改成边界值会让这个错误永远藏起来。
   */
  setHotzoneConfig(patch: HotzoneConfigPatch): Promise<HotzoneConfig>;
  /**
   * 展开态收起延时（ms）。PRD FR-02「鼠标离开 2 秒后自动收起」，
   * SDD §6.5「生产默认 2s，并允许用户在设置中配置」。
   *
   * 不要求解锁：它是纯 UI 偏好，锁定时读不到只会让面板用默认值。
   * 折叠胶囊态的 250ms 不受它影响（见 `lib/timing.ts`）。
   */
  getCollapseDelay(): Promise<number>;
  /** 修改收起延时并持久化；只接受档位里的值，其余报错。 */
  setCollapseDelay(delayMs: number): Promise<number>;
  /**
   * 展开态「停留时长」（ms）：**无操作**多久之后自动隐藏。
   *
   * 与 `getCollapseDelay` 是两件事：收起延时只由"指针离开"触发，停留时长由
   * "空闲"触发（指针一直停在岛上也照样收）。不要求解锁，理由同上。
   */
  getDwellDelay(): Promise<number>;
  /** 修改停留时长并持久化；只接受档位里的值，其余报错。 */
  setDwellDelay(delayMs: number): Promise<number>;
  /**
   * 读取快捷键自定义（NFR 可用性）。不要求解锁：纯 UI 偏好，
   * 与 `getCollapseDelay` 同理。
   */
  getShortcuts(): Promise<ShortcutMap>;
  /**
   * 修改单个动作的组合键并持久化。
   *
   * 固定动作（↑↓/Esc）、备选列表外的取值、与别的动作重复一律报
   * `VALIDATION_FAILED`——不夹取、不静默改判，理由见 `internalSetShortcut`。
   */
  setShortcut(action: ShortcutAction, spec: string): Promise<ShortcutMap>;
  /** 恢复全部默认快捷键。 */
  resetShortcuts(): Promise<ShortcutMap>;
  /**
   * 读取系统剪贴板文本（PRD `prd.md:157`「支持从剪贴板快速粘贴账号/密码」）。
   *
   * 无权限、被拒绝或环境不支持时返回 `null`，**不抛错**——调用方据此给出提示，
   * 不该让"读不到剪贴板"变成一次异常。
   */
  readClipboardText(): Promise<string | null>;
  /**
   * 数据文件位置描述（PRD FR-06：设置页展示数据文件路径与"打开所在文件夹"）。
   *
   * 不要求解锁：这只是"数据存在哪"的描述，不含任何数据本身。内存存储返回
   * `displayPath: null / canReveal: false`，UI 据此禁用打开按钮并说明原因。
   */
  describeStorage(): Promise<StorageLocation>;
  /** 清空全部数据并回到未初始化状态（不可撤销）。 */
  resetVault(): Promise<void>;
  /**
   * 校验主密码，**不**改变会话状态（PRD FR-08.4 销毁前的二次认证）。
   *
   * 与 `unlock()` 的区别和 `requestHiddenAccess()` 一样：不写 DEK、不改
   * `unlockedUntil`；失败与解锁共用计数与冷却。区别在于它不发放任何授权，
   * 只是一个"是否持有主密码"的布尔答案——所以调用方拿到 resolve 就必须
   * 自己接着执行不可逆操作，别把"验过了"当成"已经做了"。
   */
  verifyMasterPassword(password: string): Promise<void>;
  /** 用主密码导出 `.kib` 加密备份（JSON 文本，由调用方落盘）。 */
  exportBackup(password: string): Promise<string>;
  /**
   * 确认备份文件已落盘，记账（更新 `lastBackupAt`、写 `backup.export` 审计）。
   *
   * **必须在文件真正保存成功之后调用。** 在保存失败时调用它，等于告诉应用
   * "已经备份过了"——「超过 7 天未备份」的提醒会被静默重置，而用户手上
   * 其实什么都没有。
   */
  confirmBackupSaved(): Promise<void>;
  /**
   * 密码体检：扫描全部卡片，报告重复密码 / 弱密码 / 长期未修改。
   *
   * 结果只包含 sha256 摘要与卡片 id，**不返回任何明文密码**。
   */
  auditPasswordHealth(): Promise<VaultHealthReport>;
  /** 用主密码导入 `.kib` 备份；导入后应用回到锁定态（SDD §9.2）。 */
  importBackup(input: ImportBackupInput): Promise<ImportBackupResult>;
  /** 导出只含资产的 KIA1 加密包；导入时跨库重加密追加，不触碰 keyslots。 */
  /**
   * 导出资产迁移包（`.kia`）。
   *
   * `options.category` 省略时导出全库；指定时只导出该分类下的卡片。
   * 分类过滤在**密文记录**上完成（分类是明文字段），因此隐藏卡片也会跟着
   * 自己的分类走——它们不出现在列表里，但属于这个分类就该被带走，
   * 否则用户会得到一个「少了东西」却看不出少了什么的包。
   */
  exportAssetBundle(password: string, options?: ExportAssetOptions): Promise<string>;
  previewAssetBundle(password: string, input: string): Promise<{ total: number; inserted: number; skipped: number }>;
  importAssetBundle(password: string, input: string): Promise<{ inserted: number; skipped: number }>;
  /**
   * 轮换恢复密钥（PRD FR-08.1「怀疑泄露时轮换，旧密钥立即作废」）。
   *
   * 高危操作，必须现验主密码：
   * - 只重写 B 槽，主密码与 A 槽不受影响，已解锁会话保持解锁；
   * - 旧恢复码/`.kirk` 在返回成功的那一刻起即失效；
   * - 新恢复码只在返回值里出现一次，不写任何持久化状态。
   *
   * 失败（密码错、冷却期、存储写失败）时旧恢复密钥必须仍然有效——先算新槽、
   * 后落盘，落盘失败就回滚内存里的密钥槽。
   */
  rotateRecoveryKey(masterPassword: string): Promise<RotateRecoveryKeyResult>;
  /**
   * 备份状态（PRD FR-06）：上次备份时间、距今天数、是否超过 7 天。
   *
   * 不要求解锁：这是"多久没备份"的元信息，不含任何数据本身；设置页在解锁态
   * 展示它，锁定时不该因为读不到而整块消失。
   */
  getBackupStatus(): Promise<BackupStatus>;
  /**
   * 取一次备份提醒文案（PRD FR-06「超过 7 天未备份时，当日首次锁定前轻提示一次」）。
   *
   * 一次性语义：**同一自然日内只会返回非 null 一次**，之后返回 `null`，调用方
   * 直接忽略即可。判断与记账都在门面里做——放到 UI 里就变成每个锁定入口各记一份，
   * 必然出现"一天提醒三次"或"永远不提醒"。
   */
  takeBackupReminder(): Promise<string | null>;
  /**
   * 最近的操作日志，新的在前（NFR 可靠性「操作日志本地化且不含敏感数据」）。
   *
   * 条目里只有动作、资产 id 与一段裁剪过的说明——**不含**密码、账号、标题、
   * 备注。日志会被人在设置页里读、也可能被截图，掺进明文就等于制造泄漏源。
   */
  getAuditLog(limit?: number): Promise<AuditEntry[]>;
  /** 清空操作日志（用户主动）。 */
  clearAuditLog(): Promise<void>;
  /**
   * 记录一次「跳转」（PRD 要求日志包含跳转目标）。
   *
   * 目标会先裁成 origin + pathname，query 与 hash 一律丢弃：登录链接的 query
   * 常带 token / session，原样落进日志等于把凭据抄了一份。
   */
  recordJump(itemId: number, target: string): Promise<void>;
  /** 应用退出时释放会话与剪贴板任务。 */
  dispose(): Promise<void>;
}

/** 门面依赖。 */
export interface VaultClientOptions {
  storage: VaultStorage;
  /** 注入时钟，测试必须使用。 */
  now?: () => number;
  /** 注入剪贴板端口，默认使用浏览器实现。 */
  clipboard?: ClipboardPort;
  autoLockPolicy?: AutoLockPolicy;
  clipboardTtlMs?: number;
  passwordParams?: Argon2Params;
  recoveryParams?: Argon2Params;
}

/** 统一异常归一化，保证门面只抛 AppError。 */
async function guard<T>(operation: () => Promise<T>, fallback: ErrorCode = 'INTERNAL_ERROR'): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toAppError(error, fallback);
  }
}

/** 创建 Vault 门面。 */
export function createVaultClient(options: VaultClientOptions): VaultClient {
  const storage = options.storage;
  const clock = options.now ?? (() => Date.now());
  /** 剪贴板 TTL 可在设置面板调整，因此是可变的。 */
  let clipboardTtlMs = options.clipboardTtlMs ?? DEFAULT_CLIPBOARD_TTL_MS;

  const clipboard = new ClipboardService({
    port: options.clipboard ?? createBrowserClipboardPort(),
    now: clock,
    defaultTtlMs: clipboardTtlMs,
  });

  let itemService: ItemService | null = null;
  let recency = new RecencyTracker({ now: clock });
  let meta: VaultMeta | null = null;
  let loaded = false;
  /**
   * 展开态收起延时（PRD FR-02 / SDD §6.5「默认 2s，可配置」）。
   *
   * 与 `clipboardTtlMs` 一样是"设置面板改、运行期生效"的可变量：读元数据回填，
   * 写入时同步更新。放内存而不是每次现读 meta，是因为它被热区监听闭包引用，
   * 现读会让闭包依赖一个每次都变的字段。
   */
  let collapseDelayMs = DEFAULT_COLLAPSE_DELAY_MS;
  /**
   * 展开态停留时长（无操作多久自动隐藏）。
   *
   * 与 `collapseDelayMs` 分开存：两者触发条件不同（空闲 vs 指针离开），
   * 合并成一个值必然有一方的语义被牺牲。
   */
  let dwellDelayMs = DEFAULT_DWELL_DELAY_MS;
  /**
   * 快捷键自定义（NFR 可用性）。与 `collapseDelayMs` 同理是"设置面板改、运行期
   * 生效"的可变量：读元数据回填，写入时同步更新。
   *
   * 存解析后的结构而不是文本：键盘事件处理是同步路径（每次 keydown 都要比一次），
   * 现解析会让每次按键都做一遍字符串切分。落盘的仍是文本（`meta.shortcuts`）。
   */
  let shortcuts: ShortcutMap = DEFAULT_SHORTCUTS;
  /**
   * 操作日志（NFR 可靠性）。只在内存里，容量 200 条环形缓冲；
   * 条目里不含密码 / 账号 / 标题，见 `core/vault/audit.ts` 的约束说明。
   */
  const audit = new AuditLog({ now: clock });
  /** 锁定清理（剪贴板读取 + 清空）是异步的，用 Promise 追踪以便 await。 */
  let lockCleanup: Promise<void> | null = null;
  /** 隐藏卡片授权到期时间；`null` 表示当前无授权。 */
  let hiddenAccessUntil: number | null = null;

  /** 撤销隐藏卡片授权（锁定、释放、到期）。 */
  function clearHiddenAccess(): void {
    hiddenAccessUntil = null;
  }

  /** 当前是否持有有效的隐藏卡片授权（顺带处理到期）。 */
  function hasHiddenAccess(): boolean {
    if (hiddenAccessUntil === null) {
      return false;
    }
    if (clock() >= hiddenAccessUntil) {
      // 授权已过期：立即清除，避免后续请求误用。
      hiddenAccessUntil = null;
      return false;
    }
    return true;
  }

  /** 需要授权但当前没有时抛 `ITEM_HIDDEN`。 */
  function requireHiddenAccess(): void {
    if (!hasHiddenAccess()) {
      throw errors.itemHidden();
    }
  }

  /**
   * 未持有隐私授权时，抹掉 `masked` 摘要的账号。
   *
   * 否则账号会从三条路泄露：①列表/最近使用的摘要数据层；②`searchItems` 会匹配
   * `username`，搜某个账号看卡片是否出现即可反推；③渲染进 props 可被 devtools 读取。
   * 授权生效后重新拉取即恢复；`hidden` 卡片本就不带账号，无需处理。
   */
  function redactMaskedUsername(item: ItemSummary): ItemSummary {
    if (item.visibility === 'masked' && !hasHiddenAccess()) {
      return { ...item, username: undefined };
    }
    return item;
  }

  const session = new VaultSession({
    now: clock,
    autoLockPolicy: options.autoLockPolicy ?? DEFAULT_AUTO_LOCK_POLICY,
    passwordParams: options.passwordParams ?? ARGON2_PARAMS_V1,
    recoveryParams: options.recoveryParams ?? ARGON2_PARAMS_V1,
    onLock: () => {
      // 锁定时：清空内存明文缓存，并取消剪贴板任务（内容仍属于密岛则立即清空）。
      itemService?.dispose();
      itemService = null;
      // 任何锁定（含冷却强制锁定）都必须撤销隐藏卡片授权（P2-2）。
      clearHiddenAccess();
      lockCleanup = clipboard.cancelAll({ clearIfOwned: true });
    },
  });

  /** 等待锁定清理完成。 */
  async function awaitLockCleanup(): Promise<void> {
    const pending = lockCleanup;
    lockCleanup = null;
    if (pending !== null) {
      await pending;
    }
  }

  /** 首次访问时从存储加载密钥槽、元数据与最近使用。 */
  async function ensureLoaded(): Promise<void> {
    if (loaded) {
      return;
    }
    let keyslots;
    let metaRecord;
    let recent;
    try {
      keyslots = await storage.loadKeyslots();
      metaRecord = await storage.loadMeta();
      recent = await storage.loadRecency();
    } catch {
      throw errors.storageFailed();
    }
    session.setKeyslots(keyslots);
    meta = metaRecord;
    recency = new RecencyTracker({ now: clock, initial: recent });
    if (metaRecord !== null) {
      session.setAutoLockPolicy(metaRecord.autoLockPolicy);
      // 剪贴板 TTL 同样要回读：否则设置面板改过的值重启后会静默回落到默认 30 秒。
      // 复制路径始终显式传入 `clipboardTtlMs`，因此只需恢复这个变量。
      //
      // **必须是 `isValidClipboardTtl` 而不是 `> 0`**：`0` 是合法的"关闭自动清理"档。
      // 用 `> 0` 会把用户设的"关闭"当成无效值丢掉，重启后静默变回 30 秒自动清理——
      // 用户以为自己关掉了，其实没有，这是比"设置不生效"更危险的方向。
      if (isValidClipboardTtl(metaRecord.clipboardTtlMs)) {
        clipboardTtlMs = metaRecord.clipboardTtlMs;
      }
      // 系统锁屏锁定开关（FR-01）同样要回读。用 `!== false` 而不是 `=== true`：
      // 老元数据里没有这个字段，缺省必须解释为"开"（PRD 默认开）。
      // 写成 `=== true` 会让所有老库静默变成"关"——安全设置上的静默降级，
      // 用户永远不会发现，直到需要它的那一刻。
      session.setLockOnSystemLock(metaRecord.lockOnSystemLock !== false);
      // 收起延时同样要回读，否则设置页改过的档位重启后静默回到 2 秒。
      // 走 `resolveCollapseDelay`：老元数据没有这个字段，缺省即 2000。
      collapseDelayMs = resolveCollapseDelay(metaRecord.collapseDelayMs);
      // 停留时长同理：不回读就会让"我设了 30 秒"在重启后静默变回 10 秒。
      dwellDelayMs = resolveDwellDelay(metaRecord.dwellDelayMs);
      // 快捷键自定义同样要回读，否则用户改过的组合键重启后静默回到默认值。
      // 走 `resolveShortcuts`：老元数据没有这个字段，逐字段回落默认。
      shortcuts = resolveShortcuts(metaRecord.shortcuts);
    }
    loaded = true;
  }

  /** 创建绑定当前 DEK 的资产服务。 */
  function createItemService(): ItemService {
    const dek = session.requireDek();
    return new ItemService({
      dek,
      now: clock,
      store: {
        loadItems: () => storage.loadItems(),
        saveItems: (records) => storage.saveItems(records),
      },
    });
  }

  /**
   * 解锁态才可用的资产服务。
   *
   * `session.status()` 会顺带处理自动锁定；一旦本次调用触发锁定，`onLock` 只是把
   * 剪贴板清理排进 `lockCleanup`。因此这里必须 `await awaitLockCleanup()`，
   * 否则调用方可能观察到"会话已锁定但剪贴板尚未清空"的中间态。
   */
  async function requireItemService(): Promise<ItemService> {
    // 冷却必须先报 AUTH_COOLDOWN：连续输错主密码后会话会被强制锁定（DEK 已清），
    // 若只看 itemService === null 就报 VAULT_LOCKED，用户看到"已锁定"却不知道要等
    // 多久——而批量删除弹窗等 UI 要靠 AUTH_COOLDOWN 展示"请 N 秒后再试"。
    // 冷却是会话级状态，在这里统一分辨，全部资产路径就都报得准；`unlock()` 与
    // `requestHiddenAccess()` 在冷却期同样报 AUTH_COOLDOWN，这才是一致的行为。
    // （`internalRequestHiddenAccess` 另有"必须 unlocked"的更严要求，保留自己的判断。）
    if (session.status() === 'cooling_down') {
      throw errors.authCooldown();
    }
    const service = itemService;
    if (service === null) {
      await awaitLockCleanup();
      throw errors.vaultLocked();
    }
    return service;
  }

  /**
   * 写路径的隐藏卡片守卫。
   *
   * 读路径一直要求 `allowHidden + 有效授权`，但写路径此前完全没有校验，
   * 存在两条绕过：
   * 1. 未授权也能改写字段、改收藏、删除隐藏卡片；
   * 2. `setVisibility(hidden → normal)` 可以单方面解除隐藏保护。
   *
   * 统一规则：只要资产**当前**是 `hidden`，任何写操作都必须持有有效授权；
   * 反向（`normal → hidden`）属于加强保护，不额外要求授权。
   */
  async function requireHiddenWriteAccess(service: ItemService, id: number): Promise<void> {
    // `getSummary` 只返回摘要，不会把明文带进这条校验路径。
    const current = await service.getSummary(id, { allowHidden: true });
    if (requiresPrivacyAccess(current.visibility)) {
      requireHiddenAccess();
    }
  }

  /**
   * 读路径的隐藏授权判定。
   *
   * 旧实现只要调用方传了 `allowHidden: true` 就先 `requireHiddenAccess()`，
   * 于是"防御性传 true"的调用方在普通卡片上也会莫名收到 `ITEM_HIDDEN`。
   * 现在与写路径对齐：先看资产真实可见性，只有确实是 `hidden` 才要求授权。
   *
   * @returns 传给 `ItemService` 的 `allowHidden` 值（普通卡片恒为 false）。
   */
  async function resolveAllowHidden(service: ItemService, id: number): Promise<boolean> {
    const current = await service.getSummary(id, { allowHidden: true });
    if (!requiresPrivacyAccess(current.visibility)) {
      return false;
    }
    requireHiddenAccess();
    return true;
  }

  /** 持久化最近使用；失败不影响主流程（非敏感、可重建）。 */
  async function persistRecency(): Promise<void> {
    try {
      await storage.saveRecency(recency.toJSON());
    } catch {
      // 最近使用是派生数据，写入失败不回滚复制动作。
    }
  }

  /** 持久化元数据。 */
  async function persistMeta(): Promise<void> {
    if (meta === null) {
      return;
    }
    try {
      await storage.saveMeta(meta);
    } catch {
      throw errors.storageFailed();
    }
  }

  /** 把可见性变更同步到最近使用列表。 */
  async function syncRecencyWithVisibility(item: ItemSummary): Promise<void> {
    if (item.visibility === 'hidden') {
      recency.remove(item.id);
      await persistRecency();
    }
  }

  async function internalStatus(): Promise<SessionSnapshot> {
    await ensureLoaded();
    const snapshot = session.snapshot();
    // 若本次状态检查触发了超时锁定，等待剪贴板清理完成。
    await awaitLockCleanup();
    // 附带隐私访问授权到期时间，供 UI 判断遮罩卡片字段是否可显示。
    return { ...snapshot, hiddenAccessUntil: hasHiddenAccess() ? hiddenAccessUntil : null };
  }

  async function internalInitialize(input: InitializeVaultInput): Promise<InitializeVaultResult> {
    await ensureLoaded();
    if (session.getKeyslots() !== null) {
      throw errors.vaultAlreadyInitialized();
    }
    assertMasterPassword(input.masterPassword);

    const policy = input.autoLockPolicy ?? options.autoLockPolicy ?? DEFAULT_AUTO_LOCK_POLICY;
    const material = await createRecoveryMaterial(clock(), '密岛 KeyIsland 恢复密钥');
    try {
      const { keyslots } = await session.initialize({
        masterPassword: input.masterPassword,
        recoveryKey: material.recoveryKey,
        recoveryCode: material.code,
      });
      session.setAutoLockPolicy(policy);
      meta = createDefaultMeta(clock(), policy, clipboardTtlMs, input.hint ?? null);

      try {
        await storage.saveKeyslots(keyslots);
        await storage.saveMeta(meta);
        await storage.saveItems([]);
        await storage.saveRecency([]);
      } catch {
        // 回滚内存会话，避免"内存已初始化但存储未写入"的不一致。
        session.dispose();
        itemService = null;
        meta = null;
        clearHiddenAccess();
        // 初始化必须原子（P2-1）：`saveKeyslots` 成功而后续步骤失败时，
        // 磁盘上会残留一个用户从未拿到恢复码的密钥槽；用户重试会生成新 DEK
        // 并覆盖旧槽，第一次展示的恢复码直接失效。因此这里要显式清空存储，
        // 并把加载标记复位，让后续 `status()` 回到 uninitialized 且可重试。
        try {
          await storage.clear();
        } catch {
          // 清理失败不掩盖原始错误：向上仍报 STORAGE_FAILED，由 UI 提示重试。
        }
        loaded = false;
        throw errors.storageFailed();
      }

      itemService = createItemService();
      await itemService.hydrate();
      recency = new RecencyTracker({ now: clock });

      return {
        recoveryCode: material.code,
        kirkFile: material.kirk,
        kirkJson: material.kirkJson,
        session: session.snapshot(),
      };
    } finally {
      zeroize(material.recoveryKey);
    }
  }

  async function internalUnlock(password: string): Promise<SessionSnapshot> {
    await ensureLoaded();
    const snapshot = await session.unlock(password);
    itemService = createItemService();
    await itemService.hydrate();
    audit.record('unlock');
    return snapshot;
  }

  async function internalLock(reason: LockReason): Promise<SessionSnapshot> {
    await ensureLoaded();
    const snapshot = session.lock(reason);
    // 即便会话本来就没有 DEK（`onLock` 不会触发），也要撤销隐藏卡片授权。
    clearHiddenAccess();
    await awaitLockCleanup();
    itemService?.dispose();
    itemService = null;
    await persistRecency();
    // 锁定原因不是敏感信息，但对"为什么被锁"很有用（排查自动锁定是否误触发）。
    audit.record('lock', { detail: reason });
    return snapshot;
  }

  async function internalRecover(code: string): Promise<RecoveryVerifiedResult> {
    await ensureLoaded();
    return session.recover(code);
  }

  /** 重设主密码后的公共收尾：持久化密钥槽、更新提示、清空内存明文。 */
  async function persistAfterPasswordReset(
    snapshot: SessionSnapshot,
    hint: string | null | undefined,
  ): Promise<SessionSnapshot> {
    const keyslots = session.getKeyslots();
    if (keyslots !== null) {
      try {
        await storage.saveKeyslots(keyslots);
      } catch {
        // 回滚到存储中的旧密钥槽，避免内存与磁盘不一致。
        try {
          session.setKeyslots(await storage.loadKeyslots());
        } catch {
          session.setKeyslots(null);
        }
        throw errors.storageFailed();
      }
    }
    if (meta !== null && hint !== undefined) {
      meta = { ...meta, hint, updatedAt: clock() };
      await persistMeta();
    }
    itemService?.dispose();
    itemService = null;
    clearHiddenAccess();
    return snapshot;
  }

  async function internalResetMasterPassword(input: ResetPasswordRequest): Promise<SessionSnapshot> {
    await ensureLoaded();
    const snapshot = await session.resetMasterPassword({
      recoveryCode: input.recoveryCode,
      newPassword: input.newPassword,
      hint: input.hint ?? null,
    });
    return persistAfterPasswordReset(snapshot, input.hint);
  }

  /** `.kirk` 路径：用文件内的 32 字节恢复密钥校验。 */
  async function internalRecoverWithKirk(kirkJson: string): Promise<RecoveryVerifiedResult> {
    await ensureLoaded();
    const kirk = parseKirkFile(kirkJson);
    const recoveryKey = recoveryKeyFromKirk(kirk);
    try {
      return await session.recoverWithRecoveryKey(recoveryKey);
    } finally {
      zeroize(recoveryKey);
    }
  }

  /** `.kirk` 路径：用文件内的 32 字节恢复密钥重设主密码。 */
  async function internalResetMasterPasswordWithKirk(
    input: ResetPasswordByKirkRequest,
  ): Promise<SessionSnapshot> {
    await ensureLoaded();
    const kirk = parseKirkFile(input.kirkJson);
    const recoveryKey = recoveryKeyFromKirk(kirk);
    try {
      const snapshot = await session.resetMasterPasswordWithRecoveryKey({
        recoveryKey,
        newPassword: input.newPassword,
        hint: input.hint ?? null,
      });
      return await persistAfterPasswordReset(snapshot, input.hint);
    } finally {
      zeroize(recoveryKey);
    }
  }

  /**
   * 列出/搜索资产。
   * `includeHidden` 属于特权路径：必须先通过 `requestHiddenAccess()` 取得授权，
   * 否则抛 `ITEM_HIDDEN`（P2-2）。
   */
  async function internalListItems(filter: ItemFilter = {}): Promise<ItemSummary[]> {
    const service = await requireItemService();
    const includeHidden = filter.includeHidden === true;
    if (includeHidden) {
      requireHiddenAccess();
    }
    const all = await service.list({ includeHidden });
    // 抹账号必须发生在 `searchItems` 之前：否则搜索会先按 username 命中，
    // 结果里就泄露了"某张遮罩卡片的账号含这个子串"。
    const redacted = all.map(redactMaskedUsername);
    return searchItems(redacted, { ...filter, includeHidden }, recency.index());
  }

  async function internalGetItem(id: number, options: HiddenAccessOptions = {}): Promise<ItemDetail> {
    const service = await requireItemService();
    const current = await service.getSummary(id, { allowHidden: true });
    if (current.visibility === 'masked') {
      // 遮罩卡片留在普通列表，UI（编辑 / 揭示）取详情时不带 `allowHidden`；
      // 只需持有全局隐私授权即可，无需显式 opt-in——否则编辑遮罩卡会卡死。
      // 未授权时 `requireHiddenAccess()` 抛 `ITEM_HIDDEN`，与隐藏卡片同一套守卫。
      requireHiddenAccess();
      return service.getDetail(id, { allowHidden: true });
    }
    // `hidden` 维持原语义：必须显式 `allowHidden: true` 才放行，
    // 授权本身不等于"自动放行"（对抗性安全测试刻意守住这条边界）。
    let allowHidden = false;
    if (current.visibility === 'hidden' && options.allowHidden === true) {
      requireHiddenAccess();
      allowHidden = true;
    }
    return service.getDetail(id, { allowHidden });
  }

  async function internalCreateItem(input: CreateItemInput): Promise<ItemSummary> {
    const created = await internalCreateItems([input]);
    return created[0];
  }

  async function internalCreateItems(inputs: readonly CreateItemInput[]): Promise<ItemSummary[]> {
    const service = await requireItemService();
    const summaries = await service.createItems(inputs);
    for (const summary of summaries) {
      await syncRecencyWithVisibility(summary);
      audit.record('item.create', { itemId: summary.id });
    }
    return summaries;
  }

  async function internalUpdateItem(id: number, input: UpdateItemInput): Promise<ItemSummary> {
    const service = await requireItemService();
    // 隐藏卡片的写路径同样需要授权：否则可以绕过二次验证直接改写甚至解除隐藏。
    await requireHiddenWriteAccess(service, id);
    const summary = await service.updateItem(id, input);
    await syncRecencyWithVisibility(summary);
    audit.record('item.update', { itemId: id });
    return summary;
  }

  async function internalDeleteItem(id: number): Promise<void> {
    const service = await requireItemService();
    await requireHiddenWriteAccess(service, id);
    await service.deleteItem(id);
    recency.remove(id);
    await persistRecency();
    audit.record('item.delete', { itemId: id });
  }

  async function internalDeleteItems(ids: number[], masterPassword: string): Promise<BulkDeleteResult> {
    await ensureLoaded();
    // 冷却期报 AUTH_COOLDOWN 由 `requireItemService()` 统一负责（那里是唯一入口），
    // 这里不再重复前置判断——当初就是各处各抄一份，批量删除修了、其他四条路径漂移了。
    const service = await requireItemService();
    const unique = Array.from(new Set(ids));
    // 空集合不验密码：没必要为 0 张卡片付一次 Argon2 的开销。
    // 注意这个短路**位于 verifyPassword 之前**，是全类目唯一一条不验主密码的
    // 写入入口——已实测它探测不到会话状态（锁定态照样 VAULT_LOCKED）、不消耗
    // 失败计数、不删任何东西，因此是安全的；但顺序本身要点明，否则下一个人
    // review 时会以为这里漏了守卫（QA 复验建议 4）。
    if (unique.length === 0) {
      return { deleted: 0, deletedIds: [] };
    }
    // 批量删除是高危操作，必须现验主密码。
    // `session.verifyPassword()` 与 `unlock()` 共用失败计数与冷却，因此这条路径
    // 不能成为绕过冷却的旁路。
    await session.verifyPassword(masterPassword);
    // 主密码是根凭据，强度高于 5 分钟有效的 hidden grant，
    // 所以这里不再额外要求 `allowHidden`；隐藏卡片与普通卡片一视同仁。
    const removed = await service.deleteMany(unique);
    for (const id of removed) {
      recency.remove(id);
    }
    await persistRecency();
    // 批量删除记一条汇总：逐条记会在一次操作里刷掉十几条日志，
    // 把"最近发生了什么"淹掉。
    audit.record('item.delete', { detail: `${removed.length} 张` });
    return { deleted: removed.length, deletedIds: removed };
  }

  async function internalSetFavorite(id: number, favorite: boolean): Promise<ItemSummary> {
    const service = await requireItemService();
    const current = await service.getSummary(id, { allowHidden: true });
    // `hidden` 卡片保持原有守卫（它们本就不在未授权列表中）。
    // `masked` 收藏只翻转一个布尔值、不触碰账号/密码，无需重新验证——
    // 否则点个星就报"需要验证"，体验很差。
    if (current.visibility === 'hidden') {
      requireHiddenAccess();
    }
    const summary = await service.setFavorite(id, favorite);
    // 即便允许未授权收藏，也不能把 `masked` 的账号随返回值带出去。
    return redactMaskedUsername(summary);
  }

  async function internalSetVisibility(id: number, visibility: Visibility): Promise<ItemSummary> {
    const service = await requireItemService();
    // 当前为 hidden 时，任何可见性变更（尤其 hidden → normal）都必须先授权，
    // 否则"解除隐藏保护"会变成一次免验证的越权操作。
    await requireHiddenWriteAccess(service, id);
    const summary = await service.setVisibility(id, visibility);
    await syncRecencyWithVisibility(summary);
    return summary;
  }

  /**
   * 请求隐藏卡片访问授权（P2-2）。
   *
   * 语义约束：
   * - 只校验主密码，**不**改变会话状态（不写入 DEK、不改 `unlockedUntil`）。
   * - 失败走 `session.verifyPassword()`，与解锁共用同一份失败计数，
   *   因此不能靠"反复试隐藏卡片"绕过冷却。
   * - 授权窗口 120 秒，到期或锁定时立即失效。
   */
  async function internalRequestHiddenAccess(password: string): Promise<HiddenAccessGrant> {
    await ensureLoaded();
    // 先分辨状态：冷却必须报 AUTH_COOLDOWN（可重试提示），锁定报 VAULT_LOCKED。
    // 若直接走 `requireItemService()`，冷却期会被误报成"已锁定"。
    const status = session.status();
    if (status === 'cooling_down') {
      throw errors.authCooldown();
    }
    if (status !== 'unlocked') {
      throw errors.vaultLocked();
    }
    await session.verifyPassword(password);
    // 校验过程中若触发冷却，会话会被强制锁定，此时不应再发放授权。
    if (session.status() !== 'unlocked') {
      clearHiddenAccess();
      throw errors.vaultLocked();
    }
    hiddenAccessUntil = clock() + HIDDEN_ACCESS_WINDOW_MS;
    const grantedUntil = hiddenAccessUntil;
    return { grantedUntil };
  }

  /**
   * 校验主密码但不改变会话状态（FR-08.4 销毁数据的二次认证）。
   *
   * 复用 `session.verifyPassword()`：与解锁共用失败计数和冷却，所以
   * "销毁前要输主密码"这条不能变成绕开冷却的新通道。
   *
   * 冷却期必须先报 `AUTH_COOLDOWN`：走到 `verifyPassword` 里虽然也会抛，
   * 但那时错误信息对不上"正在重试销毁"这个上下文。
   */
  async function internalVerifyMasterPassword(password: string): Promise<void> {
    await ensureLoaded();
    const status = session.status();
    if (status === 'cooling_down') {
      throw errors.authCooldown();
    }
    // 没建库和建了库但锁着是两件事：前者该提示"还没有保险库"，
    // 提示"请先解锁"会让人去找一个不存在的解锁入口。
    if (status === 'uninitialized') {
      throw errors.vaultNotInitialized();
    }
    if (status !== 'unlocked') {
      throw errors.vaultLocked();
    }
    await session.verifyPassword(password);
    // 校验本身可能触发冷却并把会话锁掉，此时不能告诉调用方"密码是对的"。
    if (session.status() !== 'unlocked') {
      throw errors.vaultLocked();
    }
  }

  /** 复制流程：读取明文 → 写入剪贴板 → 记录摘要 → 更新最近使用。 */
  async function copyField(
    id: number,
    field: 'password' | 'username',
    options: HiddenAccessOptions = {},
  ): Promise<CopyReceipt> {
    const service = await requireItemService();
    // 隐私访问守卫（与 `internalGetItem` 同规则）：
    // - `masked`：留在普通列表，UI 复制时不带 `allowHidden`，只需全局授权；
    // - `hidden`：必须显式 `allowHidden: true` 才放行，**授权本身不等于自动放行**
    //   （对抗性安全测试守住这条边界——否则授权后不带 flag 也能复制隐藏卡）。
    const summary = await service.getSummary(id, { allowHidden: true });
    let allowHidden = false;
    if (summary.visibility === 'masked') {
      requireHiddenAccess();
      allowHidden = true;
    } else if (summary.visibility === 'hidden' && options.allowHidden === true) {
      allowHidden = await resolveAllowHidden(service, id);
    }
    const { value, visibility } = await service.copySecret(id, field, { allowHidden });
    const receipt = await clipboard.copyWithTtl(value, clipboardTtlMs, field);
    recency.recordUse(id, visibility);
    await persistRecency();
    // 只记"复制了哪个字段"，绝不记复制的内容。
    audit.record(field === 'password' ? 'item.copy_password' : 'item.copy_username', { itemId: id });
    return receipt;
  }

  async function internalCopyPassword(id: number, options: HiddenAccessOptions = {}): Promise<CopyReceipt> {
    return copyField(id, 'password', options);
  }

  async function internalCopyUsername(id: number, options: HiddenAccessOptions = {}): Promise<CopyReceipt> {
    return copyField(id, 'username', options);
  }

  /** 预览密码明文：与复制同语义，但不写剪贴板、不记录最近使用。 */
  async function internalRevealPassword(id: number, options: HiddenAccessOptions = {}): Promise<string> {
    const service = await requireItemService();
    // 隐私访问守卫与 `copyField` 同规则：`masked` 只需全局授权，`hidden` 必须显式 `allowHidden: true`。
    const summary = await service.getSummary(id, { allowHidden: true });
    let allowHidden = false;
    if (summary.visibility === 'masked') {
      requireHiddenAccess();
      allowHidden = true;
    } else if (summary.visibility === 'hidden' && options.allowHidden === true) {
      allowHidden = await resolveAllowHidden(service, id);
    }
    const value = await service.revealPassword(id, { allowHidden });
    // "看了一眼密码"和"复制走密码"同样值得留痕，且都不记内容。
    audit.record('item.reveal', { itemId: id });
    return value;
  }

  /**
   * 生成并复制（PRD FR-02 灵动岛「生成密码」）。
   *
   * 刻意不经过 `requireItemService()`：这条路径不读写库内数据，锁定时生成一个
   * 密码去别处用是合理需求。剪贴板清理档位沿用设置里的值（含"关闭"）。
   */
  async function internalCopyGeneratedPassword(
    options: GeneratePasswordOptions = {},
  ): Promise<CopyReceipt> {
    const value = generatePassword(options);
    return clipboard.copyWithTtl(value, clipboardTtlMs, 'password');
  }

  async function internalGetPasswordHint(): Promise<string | null> {
    await ensureLoaded();
    if (meta === null) {
      return null;
    }
    return meta.hint;
  }

  async function internalSetAutoLockPolicy(policy: AutoLockPolicy): Promise<SessionSnapshot> {
    await ensureLoaded();
    session.setAutoLockPolicy(policy);
    if (meta !== null) {
      meta = { ...meta, autoLockPolicy: policy, updatedAt: clock() };
      await persistMeta();
    }
    return session.snapshot();
  }

  async function internalSetClipboardTtl(ttlMs: number): Promise<void> {
    // `0` 合法：表示关闭自动清理（PRD FR-05「可关闭」）。
    // 设置层用 `isValidClipboardTtlSetting`：只接受 0 或 10–120s 的整数毫秒，
    // 即下拉档位里的值。服务层的 `isValidClipboardTtl` 更宽（任意非负有限值），
    // 因为内部调用方与测试会用 1s/5s 这类短时长验证清理路径——两套规则故意分开，
    // 不要在这里"统一"，否则要么挡住设置、要么放开越界值。
    if (!isValidClipboardTtlSetting(ttlMs)) {
      throw errors.validationFailed('error.clipboard_invalid_ttl');
    }
    await ensureLoaded();
    clipboardTtlMs = ttlMs;
    if (meta !== null) {
      meta = { ...meta, clipboardTtlMs: ttlMs, updatedAt: clock() };
      await persistMeta();
    }
  }

  /**
   * 轮换恢复密钥（PRD FR-08.1）。
   *
   * 顺序刻意是「先验密码 → 再生成新槽 → 最后落盘」：
   * - 验密码走 `session.verifyPassword`，与解锁共用失败计数与冷却，无法用这条路径绕过；
   * - 落盘失败时把内存里的密钥槽回滚成旧值，否则内存里是"新恢复码可用、旧码已废"，
   *   磁盘上却是旧槽——用户手上那张新恢复码将永远对不上，等于凭空丢了一条找回通道。
   */
  async function internalRotateRecoveryKey(masterPassword: string): Promise<RotateRecoveryKeyResult> {
    // 未解锁 / 冷却期先在这里拦下，错误码才准确（VAULT_LOCKED / AUTH_COOLDOWN）。
    await requireItemService();
    await session.verifyPassword(masterPassword);

    const previous = session.getKeyslots();
    const material = await createRecoveryMaterial(clock(), '密岛 KeyIsland 恢复密钥');
    try {
      const keyslots = await session.rotateRecoveryKey(material.recoveryKey);
      try {
        await storage.saveKeyslots(keyslots);
      } catch {
        session.setKeyslots(previous);
        throw errors.storageFailed();
      }
      audit.record('recovery.rotate');
      return {
        recoveryCode: material.code,
        kirkFile: material.kirk,
        kirkJson: material.kirkJson,
        session: session.snapshot(),
      };
    } finally {
      zeroize(material.recoveryKey);
    }
  }

  /** 备份状态：以"上次备份时间，从未备份则以库创建时间"为基准算天数。 */
  function computeBackupStatus(): BackupStatus {
    if (meta === null) {
      return { lastBackupAt: null, daysSinceBackup: 0, overdue: false };
    }
    const lastBackupAt = meta.lastBackupAt ?? null;
    const reference = lastBackupAt ?? meta.createdAt;
    const daysSinceBackup = Math.max(0, Math.floor((clock() - reference) / DAY_MS));
    return {
      lastBackupAt,
      daysSinceBackup,
      overdue: daysSinceBackup >= BACKUP_REMINDER_DAYS,
    };
  }

  async function internalGetBackupStatus(): Promise<BackupStatus> {
    await ensureLoaded();
    return computeBackupStatus();
  }

  /**
   * 取一次备份提醒（当日仅一次）。
   *
   * 记账失败不抛出：提醒是锁定流程上的附属动作，不能因为写元数据失败就让
   * "锁定"这件事失败——那等于为了提醒用户备份，先把会话留在解锁态。
   * 写失败时下次锁定会再提醒一次，宁可多一次也不吞掉安全动作。
   */
  async function internalTakeBackupReminder(): Promise<string | null> {
    await ensureLoaded();
    if (meta === null) {
      return null;
    }
    const status = computeBackupStatus();
    if (!status.overdue) {
      return null;
    }
    const now = clock();
    const lastReminder = meta.lastBackupReminderAt ?? null;
    if (lastReminder !== null && Math.floor(lastReminder / DAY_MS) === Math.floor(now / DAY_MS)) {
      return null;
    }
    meta = { ...meta, lastBackupReminderAt: now, updatedAt: now };
    try {
      await persistMeta();
    } catch {
      // 见上：不因为记账失败而打断锁定。
    }
    const days = status.lastBackupAt === null ? null : status.daysSinceBackup;
    return days === null
      ? `还没有导出过备份。现在导出一份 .kib，换台电脑或硬盘坏了才有得恢复。`
      : `已经 ${days} 天没有备份了，建议现在导出一份 .kib。`;
  }

  async function internalGetAuditLog(limit?: number): Promise<AuditEntry[]> {
    return audit.list(limit);
  }

  async function internalClearAuditLog(): Promise<void> {
    audit.clear();
  }

  async function internalRecordJump(itemId: number, target: string): Promise<void> {
    audit.record('jump', { itemId, detail: sanitizeJumpTarget(target) });
  }

  /**
   * 元数据 → 热区配置。
   *
   * 必须做这层字段名映射：元数据里是 `hotzoneWidthPx / hotzoneAlign`（带前缀，
   * 免得和别的 `widthPx` 撞名），`resolveHotzone` 吃的是 `widthPx / align`。
   * 直接把 meta 丢进去，两个字段都读不到，永远回落到 300px 居中——
   * 界面上"改了但没生效"，而且不报错，最难查。
   */
  function hotzoneFromMeta(record: VaultMeta | null): HotzoneConfig {
    return resolveHotzone({
      widthPx: record?.hotzoneWidthPx,
      align: record?.hotzoneAlign,
    });
  }

  /**
   * 顶部热区配置（FR-02）。
   *
   * 每次从 `meta` 现算，不缓存到会话里：热区是纯 UI 偏好，缓存一份就多一处
   * "改了设置但岛还是按老宽度命中"的漂移源。`resolveHotzone` 负责逐字段回落，
   * 老库（没有这两个字段）拿到的就是 300px 居中。
   */
  async function internalGetHotzoneConfig(): Promise<HotzoneConfig> {
    await ensureLoaded();
    return hotzoneFromMeta(meta);
  }

  async function internalSetHotzoneConfig(patch: HotzoneConfigPatch): Promise<HotzoneConfig> {
    if (patch.widthPx !== undefined) {
      // 越界 / 非整数一律报错，不夹取：设置页的滑块已经夹过，能走到这里的
      // 越界值说明调用方算错了，静默改成边界值等于把这个 bug 永久藏起来。
      const width = patch.widthPx;
      if (
        typeof width !== 'number' ||
        !Number.isInteger(width) ||
        width < HOTZONE_MIN_WIDTH_PX ||
        width > HOTZONE_MAX_WIDTH_PX
      ) {
        throw errors.validationFailed('error.hotzone_invalid_width');
      }
    }
    if (patch.align !== undefined && !isHotzoneAlign(patch.align)) {
      throw errors.validationFailed('error.hotzone_invalid_align');
    }
    await ensureLoaded();
    if (meta === null) {
      // 没有元数据就没有"配置"可言。直接返回一个新值会让调用方以为存下了，
      // 下次打开却回到 300px。
      throw errors.vaultNotInitialized();
    }
    const current = hotzoneFromMeta(meta);
    const next: HotzoneConfig = {
      widthPx: patch.widthPx ?? current.widthPx,
      align: patch.align ?? current.align,
    };
    if (next.widthPx === current.widthPx && next.align === current.align) {
      return next;
    }
    meta = {
      ...meta,
      hotzoneWidthPx: next.widthPx,
      hotzoneAlign: next.align,
      updatedAt: clock(),
    };
    await persistMeta();
    return next;
  }

  async function internalGetCollapseDelay(): Promise<number> {
    await ensureLoaded();
    return collapseDelayMs;
  }

  async function internalSetCollapseDelay(delayMs: number): Promise<number> {
    // 只认档位：设置页是下拉框，走到这里的非法值说明调用方算错了。
    if (!isValidCollapseDelay(delayMs)) {
      throw errors.validationFailed('error.collapse_delay_invalid');
    }
    await ensureLoaded();
    if (meta === null) {
      throw errors.vaultNotInitialized();
    }
    if (collapseDelayMs === delayMs) {
      return delayMs;
    }
    collapseDelayMs = delayMs;
    meta = { ...meta, collapseDelayMs: delayMs, updatedAt: clock() };
    await persistMeta();
    return delayMs;
  }

  async function internalGetDwellDelay(): Promise<number> {
    await ensureLoaded();
    return dwellDelayMs;
  }

  /**
   * 改停留时长。
   *
   * 与 `internalSetCollapseDelay` 同一套规则：只认档位、非法值报错不夹取、
   * 值没变就不写盘（省一次加密重写）。
   */
  async function internalSetDwellDelay(delayMs: number): Promise<number> {
    if (!isValidDwellDelay(delayMs)) {
      throw errors.validationFailed('error.dwell_delay_invalid');
    }
    await ensureLoaded();
    if (meta === null) {
      throw errors.vaultNotInitialized();
    }
    if (dwellDelayMs === delayMs) {
      return delayMs;
    }
    dwellDelayMs = delayMs;
    meta = { ...meta, dwellDelayMs: delayMs, updatedAt: clock() };
    await persistMeta();
    return delayMs;
  }

  async function internalGetShortcuts(): Promise<ShortcutMap> {
    await ensureLoaded();
    return shortcuts;
  }

  /**
   * 改一个动作的组合键（NFR 可用性「快捷键可自定义」）。
   *
   * 三道校验，全部抛 `VALIDATION_FAILED` 而不夹取：
   * 1. 动作必须可配置——固定项（↑↓/Esc）是 APG 规范要求，改了会让应用不合规；
   * 2. 取值必须在该动作的备选列表里——否则用户能设出 `Ctrl+W` 这种把自己
   *    锁在外面、或与浏览器原生行为冲突的组合；
   * 3. 不能与别的动作重复——两个动作同一个键时，先判的那个会永远赢，
   *    另一个 silently 失效，而这种失效在设置页上看不出来。
   *
   * 置灰选项只是 UI 层的便利，这里的校验才是真正的不变式。
   */
  async function internalSetShortcut(action: ShortcutAction, spec: string): Promise<ShortcutMap> {
    if (!isConfigurableAction(action)) {
      throw errors.validationFailed('error.shortcut_action_invalid');
    }
    if (!isValidShortcutSpec(action, spec)) {
      throw errors.validationFailed('error.shortcut_invalid');
    }
    const binding = parseBinding(spec);
    if (binding === null) {
      throw errors.validationFailed('error.shortcut_invalid');
    }
    await ensureLoaded();
    if (meta === null) {
      throw errors.vaultNotInitialized();
    }
    const conflict = findShortcutConflict(shortcuts, action, binding);
    if (conflict !== null) {
      throw errors.validationFailed('error.shortcut_conflict');
    }
    if (sameBinding(shortcuts[action], binding)) {
      return shortcuts;
    }
    shortcuts = { ...shortcuts, [action]: binding };
    meta = { ...meta, shortcuts: serializeShortcuts(shortcuts), updatedAt: clock() };
    await persistMeta();
    return shortcuts;
  }

  /** 恢复全部默认值（设置页「恢复默认」按钮）。 */
  async function internalResetShortcuts(): Promise<ShortcutMap> {
    await ensureLoaded();
    if (meta === null) {
      throw errors.vaultNotInitialized();
    }
    shortcuts = DEFAULT_SHORTCUTS;
    meta = { ...meta, shortcuts: undefined, updatedAt: clock() };
    await persistMeta();
    return shortcuts;
  }

  async function internalSetLockOnSystemLock(enabled: boolean): Promise<SessionSnapshot> {    await ensureLoaded();
    session.setLockOnSystemLock(enabled);
    if (meta !== null) {
      meta = { ...meta, lockOnSystemLock: enabled, updatedAt: clock() };
      await persistMeta();
    }
    return session.snapshot();
  }

  /**
   * 系统锁屏 / 休眠触发的锁定（FR-01）。
   *
   * 关掉开关时**必须真的什么都不做**：返回当前快照，不擦密钥、不写最近使用、
   * 不 dispose 资产服务。早先有些实现习惯"顺手清一下"，结果用户关了开关
   * 还是会掉解锁态，只是提示语不一样——那比不做更糟。
   */
  async function internalLockForSystemEvent(): Promise<SessionSnapshot> {
    await ensureLoaded();
    if (!session.getLockOnSystemLock() || session.status() !== 'unlocked') {
      return session.snapshot();
    }
    return internalLock('system_lock');
  }

  /**
   * 读取系统剪贴板文本。
   *
   * 直接转发到 `ClipboardPort.read()`：权限被拒、环境不支持时端口内部已经返回 `null`，
   * 这里不重复 try/catch，也不把失败包装成异常——"读不到"是正常分支，不是错误。
   * 注意不要求解锁：粘贴发生在编辑器里，此时必然已解锁；多一道 `requireItemService()`
   * 只会让"锁定后粘贴"报出与剪贴板无关的错误码。
   */
  async function internalReadClipboardText(): Promise<string | null> {
    try {
      return await clipboard.read();
    } catch {
      // 端口实现可能抛错：权限被拒、环境不支持、或测试替身主动模拟失败。
      // 接口约定是"读不到返回 null"，所以在这里统一归一化，
      // 让每个 UI 调用点不必各自 try/catch——否则一处漏写就是一次未处理的 Promise 拒绝，
      // 用户看不到任何提示（QA 复验抓到的 P2）。
      return null;
    }
  }

  /**
   * 清空全部数据（不可撤销）。
   *
   * 必须处于解锁态：清库是不可逆的破坏性操作，锁定态下（例如有人走到一台
   * 已自动锁定的机器前）不应该能用一次调用把整库抹掉。
   */
  async function internalResetVault(): Promise<void> {
    await ensureLoaded();
    session.status();
    if (session.snapshot().status !== 'unlocked') {
      await awaitLockCleanup();
      throw errors.vaultLocked();
    }
    session.dispose();
    clearHiddenAccess();
    await awaitLockCleanup();
    await clipboard.cancelAll({ clearIfOwned: true });
    itemService?.dispose();
    itemService = null;
    meta = null;
    try {
      await storage.clear();
    } catch {
      throw errors.storageFailed();
    }
    recency = new RecencyTracker({ now: clock });
    // 重新加载一次，让会话/元数据与（已清空的）存储保持一致。
    loaded = false;
    await ensureLoaded();
    // 销毁的语义是"不留痕迹"：日志本身也是痕迹，一并清掉。
    // （所以这里不记 'vault.destroy'——记了也立刻被自己删掉，属于自欺。）
    audit.clear();
  }

  /**
   * 导出 `.kib` 加密备份。
   *
   * 必须处于解锁态：备份内容包含全部资产密文与密钥槽，锁定时没有 DEK
   * 也没有资产可导出。主密码只用于派生备份密钥，不写入文件。
   *
   * **只产出密文，不记账。** 记账要等文件真的落盘，见 `confirmBackupSaved()`。
   */
  async function internalExportBackup(password: string): Promise<string> {
    await ensureLoaded();
    if (session.snapshot().status !== 'unlocked') {
      await awaitLockCleanup();
      throw errors.vaultLocked();
    }
    const keyslots = session.getKeyslots();
    if (meta === null || keyslots === null) {
      throw errors.storageFailed();
    }
    return encodeBackup(password, {
      schemaVersion: meta.schemaVersion,
      // 直接读存储里的密文记录：导出不需要 DEK，也不该再造一份明文副本。
      items: await storage.loadItems(),
      keyslots,
      meta,
      recency: recency.toJSON(),
    });
  }

  /**
   * 确认备份文件已落盘，然后记账（PRD FR-06「超过 7 天未备份」的基准）。
   *
   * 为什么要和 `exportBackup()` 分开：导出只产出一段文本，**真正写文件发生在
   * 调用方**（浏览器里是 `<a download>`，桌面版将来可能是原生保存对话框），
   * 而且这一步会失败。
   *
   * 原先记账写在 `exportBackup()` 里，只防住了"编码失败"，没防"保存失败"：
   * 下载没落盘时 `lastBackupAt` 已经被推到"刚刚"，`overdue` 归零，审计里也
   * 留下一条 `backup.export`。用户被告知保存失败、却没有被继续提醒——
   * 这是"谎报有备份"，比不提醒危险得多。
   *
   * 记账失败仍然不抛出：文件已经在调用方手里了，不该因为写元数据失败就把
   * 一次成功的导出报成失败。
   */
  async function internalConfirmBackupSaved(): Promise<void> {
    await ensureLoaded();
    if (meta === null) {
      throw errors.storageFailed();
    }
    const now = clock();
    meta = { ...meta, lastBackupAt: now, updatedAt: now };
    try {
      await persistMeta();
    } catch {
      // 忽略：见上。
    }
    audit.record('backup.export');
  }

  /**
   * 导入 `.kib` 备份。
   *
   * 语义（SDD §9.2）：
   * - 密码错误 / 文件损坏 → `BACKUP_INVALID`，当前库保持原样；
   * - `overwrite`：事务式替换——先写入全部数据，任一步失败则清空写入
   *   并保持原库不变，成功后回到锁定态；
   * - `merge`：只增量插入资产，同站点冲突上报，密钥槽与元数据不替换。
   */
  async function internalExportAssetBundle(
    password: string,
    options: ExportAssetOptions = {},
  ): Promise<string> {
    await ensureLoaded();
    if (session.snapshot().status !== 'unlocked') {
      await awaitLockCleanup();
      throw errors.vaultLocked();
    }
    await requireItemService();
    const records = await storage.loadItems();
    const category = options.category;
    const selected =
      category === undefined ? records : records.filter((record) => record.category === category);
    // 指定了分类却一张都没有：宁可当场报错，也不要导出一个空包让用户
    // 以为"迁移成功、对方就是没有卡片"。
    if (category !== undefined && selected.length === 0) {
      throw errors.validationFailed('error.export_empty');
    }
    const dek = session.requireDek();
    const items: ItemPlain[] = [];
    for (const record of selected) {
      items.push(await decryptItem(record, dek));
    }
    return encodeAssetTransfer(
      password,
      {
        schemaVersion: meta?.schemaVersion ?? 1,
        items: items.map(toAssetTransferItem),
      },
    );
  }

  /** 当前库已有内容的签名集合（需解锁）。隐藏卡片也参与比对，避免导入出"看不见的重复"。 */
  async function existingContentSignatures(): Promise<Set<string>> {
    const records = await storage.loadItems();
    const dek = session.requireDek();
    const seen = new Set<string>();
    for (const record of records) {
      seen.add(contentSignature(await decryptItem(record, dek)));
    }
    return seen;
  }

  /**
   * 过滤掉与库内已有内容（或同批更早条目）完全相同的输入。
   *
   * `seen` 会被就地更新，所以同一份文件里出现两条一模一样的记录时只保留第一条。
   */
  function selectNewItems(seen: Set<string>, inputs: readonly CreateItemInput[]): CreateItemInput[] {
    const additions: CreateItemInput[] = [];
    for (const input of inputs) {
      const key = signatureOfInput(input);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      additions.push(input);
    }
    return additions;
  }

  async function internalPrepareAssetBundle(password: string, input: string): Promise<{
    total: number;
    additions: CreateItemInput[];
    skipped: number;
    service: ItemService;
  }> {
    const payload = await decodeAssetTransfer(password, input);
    await ensureLoaded();
    if (session.snapshot().status !== 'unlocked') {
      await awaitLockCleanup();
      throw errors.vaultLocked();
    }
    const service = await requireItemService();
    const seen = await existingContentSignatures();
    const additions = selectNewItems(seen, payload.items.map(toCreateItemInput));
    return {
      total: payload.items.length,
      additions,
      skipped: payload.items.length - additions.length,
      service,
    };
  }

  /**
   * 从 CSV 预览结果批量导入。
   *
   * 与资产包迁移保持同一语义：**只追加、不覆盖**；完全相同的卡片跳过。
   * 否则同一个 CSV 选两次就会把卡片翻倍——那是用户最容易踩到的坑。
   */
  async function internalImportCsvItems(
    inputs: readonly CreateItemInput[],
  ): Promise<{ inserted: number; skipped: number }> {
    await ensureLoaded();
    if (session.snapshot().status !== 'unlocked') {
      await awaitLockCleanup();
      throw errors.vaultLocked();
    }
    if (inputs.length === 0) {
      return { inserted: 0, skipped: 0 };
    }
    const seen = await existingContentSignatures();
    const additions = selectNewItems(seen, inputs);
    const created = await internalCreateItems(additions);
    return { inserted: created.length, skipped: inputs.length - additions.length };
  }

  async function internalPreviewAssetBundle(password: string, input: string): Promise<{ total: number; inserted: number; skipped: number }> {
    const prepared = await internalPrepareAssetBundle(password, input);
    return { total: prepared.total, inserted: prepared.additions.length, skipped: prepared.skipped };
  }

  async function internalImportAssetBundle(password: string, input: string): Promise<{ inserted: number; skipped: number }> {
    const prepared = await internalPrepareAssetBundle(password, input);
    const created = await prepared.service.createItems(prepared.additions);
    for (const item of created) {
      await syncRecencyWithVisibility(item);
      audit.record('item.create', { itemId: item.id });
    }
    return { inserted: created.length, skipped: prepared.skipped };
  }

  async function internalImportBackup(input: ImportBackupInput): Promise<ImportBackupResult> {
    const payload = await decodeBackup(input.password, input.kirkJson);
    await ensureLoaded();
    const status = session.snapshot().status;
    if (status !== 'unlocked') {
      // 导入需要读取当前库以决定覆盖还是合并，未解锁时一律不允许。
      await awaitLockCleanup();
      throw errors.vaultLocked();
    }
    const keyslots = session.getKeyslots();
    const currentMeta = meta;
    if (keyslots === null || currentMeta === null) {
      throw errors.storageFailed();
    }

    if (input.mode === 'overwrite') {
      // 二次确认（SDD §9.2）：覆盖会用备份里的密钥槽整体换掉当前库，
      // 因此必须再验证一次当前库主密码，只凭"备份密码"不足以证明用户身份。
      if (typeof input.masterPassword !== 'string' || input.masterPassword.length === 0) {
        throw errors.validationFailed('error.password_required');
      }
      if (session.status() !== 'unlocked') {
        clearHiddenAccess();
        await awaitLockCleanup();
        throw errors.vaultLocked();
      }
      await session.verifyPassword(input.masterPassword);
      // 校验过程中可能触发冷却并强制锁定，此时不能继续覆盖。
      if (session.status() !== 'unlocked') {
        clearHiddenAccess();
        await awaitLockCleanup();
        throw errors.vaultLocked();
      }
      // 覆盖写入：先保留导入前的密文用于回滚，任一持久化失败都不留半库。
      const rollbackItems = await storage.loadItems();
      const rollbackRecency = recency.toJSON();
      try {
        await storage.saveKeyslots(payload.keyslots);
        await storage.saveMeta(payload.meta);
        await storage.saveItems(payload.items);
        await storage.saveRecency(payload.recency);
      } catch {
        try {
          // 回滚为导入前的库内容，保证失败后仍可用。逆序恢复：
          // 密钥槽最后写回——它是"库还能不能被打开"的最终保证。
          await storage.saveItems(rollbackItems);
          await storage.saveRecency(rollbackRecency);
          await storage.saveMeta(currentMeta);
          await storage.saveKeyslots(keyslots);
        } catch {
          // 连回滚都失败：只能报 STORAGE_FAILED，让用户重试或从备份重新导入，
          // 绝不能把半库当成成功结果返回。
          throw errors.storageFailed();
        }
        throw errors.storageFailed();
      }
      session.dispose();
      clearHiddenAccess();
      await awaitLockCleanup();
      itemService = null;
      meta = null;
      recency = new RecencyTracker({ now: clock });
      loaded = false;
      await ensureLoaded();
      return {
        mode: 'overwrite',
        totalItems: payload.items.length,
        inserted: payload.items.length,
        skipped: 0,
        conflicts: [],
      };
    }

    // 合并写入：只追加资产，密钥槽与元数据保持不变。
    // 合并要求备份与当前库同 DEK 世系，否则密文在当前会话里根本解不开。
    if (!isSameKeyLineage(keyslots, payload.keyslots)) {
      throw errors.validationFailed('error.backup_merge_unsupported');
    }
    const currentItems = await storage.loadItems();
    const dek = session.requireDek();
    const merged = await mergeBackupItems(currentItems, payload.items, (record) => decryptItem(record, dek));
    try {
      await storage.saveItems(merged.items);
    } catch {
      throw errors.storageFailed();
    }
    // 重新 hydrate 当前 itemService：否则内存里还是合并前的资产。
    itemService?.dispose();
    itemService = createItemService();
    await itemService.hydrate();
    return {
      mode: 'merge',
      totalItems: merged.items.length,
      inserted: merged.inserted,
      skipped: merged.skipped,
      conflicts: merged.conflicts,
    };
  }

  /**
   * 密码体检。
   *
   * 需要解锁态：必须解密每条记录的密码才能算摘要，而摘要只在内存里短暂存在。
   * `hidden` 卡片同样参与体检（用户在体检场景下已授权查看自己的库）。
   */
  async function internalAuditPasswordHealth(): Promise<VaultHealthReport> {
    await ensureLoaded();
    const service = await requireItemService();
    const records = await storage.loadItems();
    const dek = session.requireDek();
    const entries: Array<{ id: number; title: string; digest: string; strong: boolean; stale: boolean }> = [];
    for (const record of records) {
      const plain = await decryptItem(record, dek);
      const digest = await sha256Hex(plain.password);
      entries.push({
        id: plain.id,
        title: plain.title,
        digest,
        strong: isPasswordStrong(plain.password),
        stale: isPasswordStale(plain.passwordUpdatedAt, clock()),
      });
      // 明文字段在离开这个循环后不再被引用，交给 GC。
      void service;
    }
    return summarizeHealth(entries);
  }

  async function internalGetRecentItems(limit: number = MAX_RECENT_ITEMS): Promise<ItemSummary[]> {
    const service = await requireItemService();
    const capped = Math.max(0, Math.min(limit, MAX_RECENT_ITEMS));
    const summaries: ItemSummary[] = [];
    for (const entry of recency.list()) {
      if (summaries.length >= capped) {
        break;
      }
      try {
        // 与列表同规则：未授权时抹掉 `masked` 账号，避免"最近使用"泄露。
        summaries.push(redactMaskedUsername(await service.getSummary(entry.itemId)));
      } catch (error) {
        if (AppError.isAppError(error) && (error.code === 'ITEM_NOT_FOUND' || error.code === 'ITEM_HIDDEN')) {
          continue;
        }
        throw error;
      }
    }
    return summaries;
  }

  /** 岛列表上限：面板本身可滚动，没必要一次渲染几百条。 */
  const ISLAND_MAX_ITEMS = 50;

  /**
   * 岛列表：全部可见卡片，最近使用优先，其余按更新时间倒序。
   *
   * 排序必须"最近使用 > 更新时间"，而不是纯更新时间：岛是高频取用入口，
   * 刚复制过的卡应该回到顶部；但从没用过的新卡也不能消失（这正是原 bug）。
   */
  async function internalGetIslandItems(limit: number = ISLAND_MAX_ITEMS): Promise<ItemSummary[]> {
    const all = await internalListItems({});
    const order = new Map<number, number>();
    recency.list().forEach((entry, index) => {
      order.set(entry.itemId, index);
    });
    const ranked = all.slice().sort((left, right) => {
      const leftRank = order.get(left.id);
      const rightRank = order.get(right.id);
      if (leftRank !== undefined && rightRank !== undefined) {
        return leftRank - rightRank;
      }
      if (leftRank !== undefined) {
        return -1;
      }
      if (rightRank !== undefined) {
        return 1;
      }
      return right.updatedAt - left.updatedAt;
    });
    return ranked.slice(0, Math.max(0, limit));
  }

  async function internalSearchItems(filter: ItemFilter): Promise<ItemSummary[]> {
    return internalListItems(filter);
  }

  async function internalDispose(): Promise<void> {
    session.dispose();
    clearHiddenAccess();
    await awaitLockCleanup();
    await clipboard.cancelAll({ clearIfOwned: true });
    itemService?.dispose();
    itemService = null;
    await persistRecency();
  }

  return {
    status: () => guard(internalStatus),
    initialize: (input) => guard(() => internalInitialize(input)),
    unlock: (password) => guard(() => internalUnlock(password)),
    lock: (reason = 'manual') => guard(() => internalLock(reason)),
    recover: (code) => guard(() => internalRecover(code)),
    recoverWithKirk: (kirkJson) => guard(() => internalRecoverWithKirk(kirkJson)),
    resetMasterPassword: (input) => guard(() => internalResetMasterPassword(input)),
    resetMasterPasswordWithKirk: (input) =>
      guard(() => internalResetMasterPasswordWithKirk(input)),
    requestHiddenAccess: (password) => guard(() => internalRequestHiddenAccess(password)),
    listItems: (filter) => guard(() => internalListItems(filter)),
    getItem: (id, options) => guard(() => internalGetItem(id, options)),
    createItem: (input) => guard(() => internalCreateItem(input)),
    createItems: (inputs) => guard(() => internalCreateItems(inputs)),
    importCsvItems: (inputs) =>
      guard(async () => {
        const result = await internalImportCsvItems(inputs);
        if (result.inserted > 0) {
          audit.record('backup.import', { detail: 'csv' });
        }
        return result;
      }),
    updateItem: (id, input) => guard(() => internalUpdateItem(id, input)),
    deleteItem: (id) => guard(() => internalDeleteItem(id)),
    deleteItems: (ids, masterPassword) => guard(() => internalDeleteItems(ids, masterPassword)),
    setFavorite: (id, favorite) => guard(() => internalSetFavorite(id, favorite)),
    setVisibility: (id, visibility) => guard(() => internalSetVisibility(id, visibility)),
    copyPassword: (id, options) => guard(() => internalCopyPassword(id, options)),
    copyUsername: (id, options) => guard(() => internalCopyUsername(id, options)),
    revealPassword: (id, options) => guard(() => internalRevealPassword(id, options)),
    getRecentItems: (limit) => guard(() => internalGetRecentItems(limit)),
    getIslandItems: (limit) => guard(() => internalGetIslandItems(limit)),
    searchItems: (filter) => guard(() => internalSearchItems(filter)),
    generatePassword: (generateOptions) => generatePassword(generateOptions),
    copyGeneratedPassword: (generateOptions) => guard(() => internalCopyGeneratedPassword(generateOptions)),
    getPasswordHint: () => guard(internalGetPasswordHint),
    setAutoLockPolicy: (policy) => guard(() => internalSetAutoLockPolicy(policy)),
    setClipboardTtl: (ttlMs) => guard(() => internalSetClipboardTtl(ttlMs)),
    setLockOnSystemLock: (enabled) => guard(() => internalSetLockOnSystemLock(enabled)),
    lockForSystemEvent: () => guard(() => internalLockForSystemEvent()),
    getHotzoneConfig: () => guard(() => internalGetHotzoneConfig()),
    setHotzoneConfig: (patch) => guard(() => internalSetHotzoneConfig(patch)),
    getCollapseDelay: () => guard(internalGetCollapseDelay),
    setCollapseDelay: (delayMs) => guard(() => internalSetCollapseDelay(delayMs)),
    getDwellDelay: () => guard(internalGetDwellDelay),
    setDwellDelay: (delayMs) => guard(() => internalSetDwellDelay(delayMs)),
    getShortcuts: () => guard(internalGetShortcuts),
    setShortcut: (action, spec) => guard(() => internalSetShortcut(action, spec)),
    resetShortcuts: () => guard(internalResetShortcuts),
    rotateRecoveryKey: (masterPassword) => guard(() => internalRotateRecoveryKey(masterPassword)),
    getBackupStatus: () => guard(internalGetBackupStatus),
    takeBackupReminder: () => guard(internalTakeBackupReminder),
    getAuditLog: (limit) => guard(() => internalGetAuditLog(limit)),
    clearAuditLog: () => guard(internalClearAuditLog),
    recordJump: (itemId, target) => guard(() => internalRecordJump(itemId, target)),
    readClipboardText: () => guard(internalReadClipboardText),
    describeStorage: () =>
      guard(async () => {
        // 与其它存储路径一致：底层异常归一化为 STORAGE_FAILED，不把原始 Error 抛给 UI。
        try {
          return await storage.describeStorage();
        } catch {
          throw errors.storageFailed();
        }
      }),
    resetVault: () => guard(internalResetVault),
    verifyMasterPassword: (password) => guard(() => internalVerifyMasterPassword(password)),
    exportBackup: (password) => guard(() => internalExportBackup(password)),
    confirmBackupSaved: () => guard(internalConfirmBackupSaved),
    auditPasswordHealth: () => guard(internalAuditPasswordHealth),
    // 日志只在**导入成功**时记一条：内部实现有覆盖/合并两条返回路径，
    // 在装配层统一记比在每条 return 前各写一遍更不容易漏。
    importBackup: (input) =>
      guard(async () => {
        const result = await internalImportBackup(input);
        audit.record('backup.import', { detail: result.mode });
        return result;
      }),
    exportAssetBundle: (password, options) => guard(() => internalExportAssetBundle(password, options)),
    previewAssetBundle: (password, input) => guard(() => internalPreviewAssetBundle(password, input)),
    importAssetBundle: (password, input) =>
      guard(async () => {
        const result = await internalImportAssetBundle(password, input);
        audit.record('backup.import', { detail: 'asset_bundle' });
        return result;
      }),
    dispose: () => guard(internalDispose),
  };
}
