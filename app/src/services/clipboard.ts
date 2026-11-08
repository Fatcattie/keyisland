/**
 * 剪贴板服务。
 *
 * 安全要求（SDD §7.3 / ADR-006）：
 * - 写入后只保存内容摘要，绝不保存明文。
 * - 到期时仅当剪贴板内容仍等于密岛写入的值才清理，避免误删用户新复制的内容。
 * - **读不到剪贴板时不适用上一条**：无法验证归属就强制清空。界面承诺了
 *   "N 秒后自动清空"，把密码留在剪贴板是不可恢复的泄露，而误清用户内容只是
 *   重复制一次。结果记为 `cleared-unverified`，不伪装成"已验证后清理"。
 * - **清理失败必须可观测**（任务 2）：端口的 `clear()` 抛错时不记"已清理"、不触发
 *   `onCleared`。到期清理失败会有界重试（每次重试都重新核对归属），用尽后记为
 *   `clear-failed` 并触发 `onClearFailed`，由 UI 提示用户手动清除。
 * - **新的复制取代旧任务**：同一时刻只有一个任务"拥有"剪贴板。否则 A 的到期清理
 *   在读不到剪贴板时会强制清空，把刚复制的 B 提前抹掉。
 * - 时间与定时器可注入，便于测试；核心逻辑不直接依赖真实时钟。
 * - 能力边界：清空的是系统剪贴板的**当前内容**。Windows「剪贴板历史」（Win+V）
 *   与第三方剪贴板工具可能已留存副本，这一层无法清除。
 */

import { AppError, errors, toAppError } from '../core/errors';
import { sha256Hex } from '../core/crypto/digest';
import { bytesToHex } from '../core/crypto/encoding';
import { randomBytes } from '../core/crypto/random';
import {
  DEFAULT_CLIPBOARD_TTL_MS,
  isValidClipboardTtl,
  type CopyReceipt,
  type ItemSecretFieldName,
} from '../core/vault/types';

/** 剪贴板端口：浏览器实现与未来的 Tauri 实现都遵守此接口。 */
export interface ClipboardPort {
  write(text: string): Promise<void>;
  /**
   * 读取当前剪贴板文本。
   *
   * 返回值语义**必须**区分两件事，混在一起会让自动清空静默失效：
   * - 返回 `null`：读到了，剪贴板是空的（我们写进去的密码已经不在了）；
   * - 抛错：根本读不到（权限被拒、环境不支持——桌面 WebView 里很常见）。
   *
   * 前者说明无需清理，后者说明"无法验证归属"，处置完全相反。
   */
  read(): Promise<string | null>;
  clear(): Promise<void>;
}

/** 浏览器实现（`navigator.clipboard`）。 */
export class BrowserClipboardPort implements ClipboardPort {
  async write(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      throw errors.clipboardWriteFailed();
    }
  }

  async read(): Promise<string | null> {
    // 刻意**不吞异常**。原先这里 catch 后返回 null，于是"读被拒"和"剪贴板是空的"
    // 在上层变成同一个信号，到期清理走的是"内容已不在 → 什么都不做"那条分支：
    // 密码留在剪贴板里，而界面刚刚承诺过"N 秒后自动清空"。
    // 读不到时 `navigator.clipboard` 不存在会抛 TypeError，同样归入"读不到"。
    return await navigator.clipboard.readText();
  }

  async clear(): Promise<void> {
    // 刻意**不吞异常**：原先这里 catch 掉，上层就把"没清掉"记成"已清理"。
    // 桌面 WebView 失焦、权限被拒时 writeText 都可能失败，那正是需要提示用户的时候。
    try {
      await navigator.clipboard.writeText('');
    } catch {
      throw errors.clipboardWriteFailed();
    }
  }
}

/** 创建浏览器剪贴板端口。 */
export function createBrowserClipboardPort(): ClipboardPort {
  return new BrowserClipboardPort();
}

/** 清理结果。 */
export type ClipboardClearOutcome =
  /** 核对归属后清空成功。 */
  | 'cleared'
  /** 读不到剪贴板，无法验证归属，按安全优先强制清空（且清空成功）。 */
  | 'cleared-unverified'
  /** 剪贴板已被用户换成别的内容，不动它。 */
  | 'overwritten'
  /** 剪贴板已经是空的。 */
  | 'missing'
  /** 任务被取消（锁定 / 退出时若需要清理且清理成功，同样记为取消）。 */
  | 'cancelled'
  /** 被之后的一次复制取代：剪贴板归新任务管。 */
  | 'superseded'
  /** 清理失败（重试用尽，或锁定 / 退出时清理失败）：剪贴板里**可能还留着**内容。 */
  | 'clear-failed';

/** 到期清理失败后的重试间隔（ms）。次数有上限，用尽即记 `clear-failed`。 */
export const CLIPBOARD_CLEAR_RETRY_DELAYS_MS: readonly number[] = Object.freeze([1_000, 3_000, 10_000]);

/** 锁定 / 退出时的清理结果汇总。 */
export interface ClipboardCancelResult {
  /** 需要清理但没清掉的任务数；> 0 时调用方应提示用户手动清除。 */
  clearFailed: number;
}

/** 已结算的清理记录（不含明文，可安全用于 UI 事件）。 */
export interface ClipboardOutcome {
  token: string;
  outcome: ClipboardClearOutcome;
  at: number;
}

/** 待清理任务。 */
interface PendingEntry {
  receipt: CopyReceipt;
  /** 写入内容的 SHA-256 摘要。 */
  digest: string;
  timer: unknown;
  settled: boolean;
  /** 已失败的到期清理次数（用于有界重试）。 */
  failedAttempts: number;
}

/** 清理尝试的结果。 */
type ClearAttempt = 'cleared' | 'cleared-unverified' | 'overwritten' | 'missing' | 'failed';

/** 服务依赖。 */
export interface ClipboardServiceOptions {
  port: ClipboardPort;
  /** 注入时钟，默认 `Date.now`。 */
  now?: () => number;
  /** 注入定时器，默认 `setTimeout`。 */
  schedule?: (callback: () => void, delayMs: number) => unknown;
  /** 注入取消函数，默认 `clearTimeout`。 */
  cancel?: (handle: unknown) => void;
  /** 默认 TTL。 */
  defaultTtlMs?: number;
  /** 到期成功清理回调。 */
  onCleared?: (receipt: CopyReceipt) => void;
  /** 剪贴板被用户覆盖回调。 */
  onOverwritten?: (receipt: CopyReceipt) => void;
  /**
   * 清理失败回调（重试用尽，或锁定 / 退出时清理失败）。
   * 只带回执，不带明文；UI 据此提示"剪贴板未能自动清空，请手动清除"。
   */
  onClearFailed?: (receipt: CopyReceipt) => void;
  /** 重试间隔，默认 {@link CLIPBOARD_CLEAR_RETRY_DELAYS_MS}；长度即重试上限。 */
  retryDelaysMs?: readonly number[];
}

/** 剪贴板服务。 */
export class ClipboardService {
  private readonly port: ClipboardPort;

  private readonly now: () => number;

  private readonly schedule: (callback: () => void, delayMs: number) => unknown;

  private readonly cancel: (handle: unknown) => void;

  private readonly defaultTtlMs: number;

  private readonly onCleared: ((receipt: CopyReceipt) => void) | undefined;

  private readonly onOverwritten: ((receipt: CopyReceipt) => void) | undefined;

  private readonly onClearFailed: ((receipt: CopyReceipt) => void) | undefined;

  private readonly retryDelaysMs: readonly number[];

  private readonly pending = new Map<string, PendingEntry>();

  private readonly outcomes: ClipboardOutcome[] = [];

  /** 进行中的清理任务，便于测试与 UI 等待结算。 */
  private readonly inflight = new Set<Promise<void>>();

  constructor(options: ClipboardServiceOptions) {
    this.port = options.port;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel =
      options.cancel ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_CLIPBOARD_TTL_MS;
    this.onCleared = options.onCleared;
    this.onOverwritten = options.onOverwritten;
    this.onClearFailed = options.onClearFailed;
    this.retryDelaysMs = options.retryDelaysMs ?? CLIPBOARD_CLEAR_RETRY_DELAYS_MS;
  }

  /**
   * 写入剪贴板并安排到期清理。
   *
   * @param value 要写入的明文（只在本次调用内使用，不落任何缓存）。
   * @param ttlMs 自动清理时长，默认 30 秒；**`0` 表示关闭自动清理**（PRD FR-05「可关闭」）。
   * @param field 字段标识，仅用于回执与 UI 文案。
   */
  async copyWithTtl(
    value: string,
    ttlMs: number = this.defaultTtlMs,
    field: ItemSecretFieldName = 'password',
  ): Promise<CopyReceipt> {
    if (typeof value !== 'string' || value.length === 0) {
      throw errors.validationFailed('error.clipboard_empty_value');
    }
    if (!isValidClipboardTtl(ttlMs)) {
      throw errors.validationFailed('error.clipboard_invalid_ttl');
    }

    try {
      await this.port.write(value);
    } catch (error) {
      // 端口实现可以是浏览器、Tauri 或测试替身，统一归一化为 AppError。
      throw toAppError(error, 'CLIPBOARD_WRITE_FAILED');
    }

    const autoClear = ttlMs > 0;
    const digest = await sha256Hex(value);
    const token = bytesToHex(randomBytes(8));
    const receipt: CopyReceipt = {
      token,
      field,
      expiresAt: autoClear ? this.now() + ttlMs : 0,
      ttlMs,
      autoClear,
    };
    // 先登记再定时（P2-6）：如果 `schedule` 是同步实现（立即回调，测试替身或
    // 某些平台的伪定时器），先定时会让 `handleExpiry` 在 `pending` 里找不到条目，
    // 于是本次写入永远不会被清理，密码就留在剪贴板里。
    //
    // 关闭档仍然登记：锁定时 `cancelAll({ clearIfOwned: true })` 要能按归属清掉它——
    // "不自动清"不等于"锁定了还留着"。
    // 新内容已经写进剪贴板，之前的任务不再拥有它：取消它们的定时器与重试，
    // 记为 `superseded`。否则旧任务到期时若读不到剪贴板，会强制清空——清掉的
    // 恰恰是这次刚复制的内容。
    for (const previous of this.pending.values()) {
      if (!previous.settled) {
        previous.settled = true;
        this.cancel(previous.timer);
        this.recordOutcome(previous.receipt.token, 'superseded');
      }
    }
    this.pending.clear();

    const entry: PendingEntry = { receipt, digest, timer: null, settled: false, failedAttempts: 0 };
    this.pending.set(token, entry);
    if (autoClear) {
      entry.timer = this.schedule(() => {
        this.track(this.handleExpiry(token));
      }, ttlMs);
    }
    return receipt;
  }

  /**
   * 读取当前剪贴板文本（PRD `prd.md:157` 快速粘贴用）。
   *
   * 纯透传：**不记录、不缓存、不做归属判断**，也不写任何日志——剪贴板里可能是
   * 用户刚复制的密码，落日志等于把明文写进磁盘。读不到（无权限 / 环境不支持）时
   * 返回 `null`，由调用方给提示。
   */
  async read(): Promise<string | null> {
    try {
      return await this.port.read();
    } catch {
      return null;
    }
  }

  /** 等待所有进行中的清理任务结算（测试与 UI 事件使用）。 */
  async awaitPending(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
  }

  /**
   * 取消全部待清理任务。
   *
   * @param options.clearIfOwned 为 true 时，若剪贴板内容仍属于密岛则立即清空。
   *        锁定流程应传 true（SDD §7.4），避免密码长期停留在剪贴板。
   */
  async cancelAll(options: { clearIfOwned?: boolean } = {}): Promise<ClipboardCancelResult> {
    const entries = [...this.pending.values()];
    this.pending.clear();
    let clearFailed = 0;
    for (const entry of entries) {
      if (entry.settled) {
        continue;
      }
      entry.settled = true;
      // 同时取消到期定时器与可能在排队的重试定时器（两者共用 `timer`）。
      this.cancel(entry.timer);
      if (options.clearIfOwned === true && (await this.attemptClear(entry)) === 'failed') {
        // 锁定 / 退出时不再重试：会话已经结束，没有人能接住后续结果。
        // 如实记账并通知，让 UI 提示用户手动清除。
        clearFailed += 1;
        this.recordOutcome(entry.receipt.token, 'clear-failed');
        this.notify(this.onClearFailed, entry.receipt);
        continue;
      }
      this.recordOutcome(entry.receipt.token, 'cancelled');
    }
    return { clearFailed };
  }

  /** 当前待清理任务数。 */
  pendingCount(): number {
    return this.pending.size;
  }

  /** 已结算的清理结果（新→旧）。 */
  getOutcomes(): ClipboardOutcome[] {
    return this.outcomes.map((outcome) => ({ ...outcome }));
  }

  /** 清空结果记录（测试与 UI 事件消费后调用）。 */
  clearOutcomes(): void {
    this.outcomes.length = 0;
  }

  /**
   * 到期处理：仅清理仍属于本次写入的内容；清理失败时有界重试。
   *
   * 任务在重试期间**仍留在 `pending` 里**：锁定 / 退出能取消它并按归属立即处理；
   * 期间再复制一次会把它标为 `superseded`，重试定时器随之取消——不会拿旧任务
   * 去清新内容。
   */
  private async handleExpiry(token: string): Promise<void> {
    const entry = this.pending.get(token);
    if (!entry || entry.settled) {
      return;
    }
    const attempt = await this.attemptClear(entry);
    // 等待期间可能已被锁定或新复制结算掉：那边已记账，这里不能再记一次。
    if (entry.settled) {
      return;
    }
    if (attempt === 'failed') {
      entry.failedAttempts += 1;
      const delay = this.retryDelaysMs[entry.failedAttempts - 1];
      if (delay !== undefined) {
        entry.timer = this.schedule(() => {
          this.track(this.handleExpiry(token));
        }, delay);
        return;
      }
      this.settle(entry, 'clear-failed');
      this.notify(this.onClearFailed, entry.receipt);
      return;
    }
    this.settle(entry, attempt);
    if (attempt === 'cleared' || attempt === 'cleared-unverified') {
      this.notify(this.onCleared, entry.receipt);
    } else if (attempt === 'overwritten') {
      this.notify(this.onOverwritten, entry.receipt);
    }
  }

  /**
   * 核对归属并尝试清空一次。
   *
   * - 读不到剪贴板（权限被拒 / 环境不支持）：无法验证归属时只能二选一——留着明文，
   *   或者清掉用户可能新复制的内容。代价不对称：留下的密码是不可恢复的泄露，误清的
   *   内容重复制一次就好。所以清，但结果记为 `cleared-unverified`，不假装"已验证"；
   * - 读到别的内容：用户已覆盖，不动；
   * - 端口 `clear()` 抛错：返回 `failed`，**绝不**报成已清理。
   */
  private async attemptClear(entry: PendingEntry): Promise<ClearAttempt> {
    let current: string | null;
    let verified = true;
    try {
      current = await this.port.read();
    } catch {
      current = null;
      verified = false;
    }
    if (verified) {
      if (current === null) {
        return 'missing';
      }
      let currentDigest: string;
      try {
        currentDigest = await sha256Hex(current);
      } catch {
        return 'failed';
      }
      if (currentDigest !== entry.digest) {
        return 'overwritten';
      }
    }
    try {
      await this.port.clear();
    } catch {
      return 'failed';
    }
    return verified ? 'cleared' : 'cleared-unverified';
  }

  /** 结算任务：移出 `pending` 并记账。 */
  private settle(entry: PendingEntry, outcome: ClipboardClearOutcome): void {
    entry.settled = true;
    this.pending.delete(entry.receipt.token);
    this.recordOutcome(entry.receipt.token, outcome);
  }

  /** 回调由 UI 提供；它抛错不能炸穿定时器回调，也不能影响已完成的记账。 */
  private notify(callback: ((receipt: CopyReceipt) => void) | undefined, receipt: CopyReceipt): void {
    try {
      callback?.(receipt);
    } catch {
      // 忽略：通知失败不改变清理结果。
    }
  }

  /** 记录结算结果，保留最近 50 条。 */
  private recordOutcome(token: string, outcome: ClipboardClearOutcome): void {
    this.outcomes.unshift({ token, outcome, at: this.now() });
    if (this.outcomes.length > 50) {
      this.outcomes.length = 50;
    }
  }

  /** 跟踪进行中的异步清理任务。 */
  private track(task: Promise<void>): void {
    // 兜底接住异常：定时器回调里的 rejection 没人 await，漏掉就是未处理的 rejection。
    const settled: Promise<void> = task
      .catch(() => undefined)
      .finally(() => {
        this.inflight.delete(settled);
      });
    this.inflight.add(settled);
  }
}

/** 断言错误是剪贴板相关错误，供测试断言使用。 */
export function isClipboardError(error: unknown): boolean {
  return (
    AppError.isAppError(error) &&
    (error.code === 'CLIPBOARD_WRITE_FAILED' || error.code === 'CLIPBOARD_READ_FAILED')
  );
}
