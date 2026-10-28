/**
 * 剪贴板服务。
 *
 * 安全要求（SDD §7.3 / ADR-006）：
 * - 写入后只保存内容摘要，绝不保存明文。
 * - 到期时仅当剪贴板内容仍等于密岛写入的值才清理，避免误删用户新复制的内容。
 * - **读不到剪贴板时不适用上一条**：无法验证归属就强制清空。界面承诺了
 *   "N 秒后自动清空"，把密码留在剪贴板是不可恢复的泄露，而误清用户内容只是
 *   重复制一次。结果记为 `cleared-unverified`，不伪装成"已验证后清理"。
 * - 时间与定时器可注入，便于测试；核心逻辑不直接依赖真实时钟。
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
    try {
      await navigator.clipboard.writeText('');
    } catch {
      // 清理是尽力而为，失败不向用户暴露内部细节。
    }
  }
}

/** 创建浏览器剪贴板端口。 */
export function createBrowserClipboardPort(): ClipboardPort {
  return new BrowserClipboardPort();
}

/** 清理结果。 */
export type ClipboardClearOutcome =
  | 'cleared'
  /** 读不到剪贴板，无法验证归属，按安全优先强制清空。 */
  | 'cleared-unverified'
  | 'overwritten'
  | 'missing'
  | 'cancelled';

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
}

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
    const entry: PendingEntry = { receipt, digest, timer: null, settled: false };
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
  async cancelAll(options: { clearIfOwned?: boolean } = {}): Promise<void> {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      if (entry.settled) {
        continue;
      }
      entry.settled = true;
      this.cancel(entry.timer);
      if (options.clearIfOwned === true) {
        await this.clearIfOwned(entry);
      }
      this.recordOutcome(entry.receipt.token, 'cancelled');
    }
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

  /** 到期处理：仅清理仍属于本次写入的内容。 */
  private async handleExpiry(token: string): Promise<void> {
    const entry = this.pending.get(token);
    if (!entry || entry.settled) {
      return;
    }
    entry.settled = true;
    this.pending.delete(token);

    let current: string | null;
    try {
      current = await this.port.read();
    } catch {
      // 读不到剪贴板（权限被拒 / 环境不支持）。
      //
      // 无法验证归属时只能二选一：留着明文，或者清掉用户可能新复制的内容。
      // 这两件事的代价不对称——留下的密码是不可恢复的泄露，误清的内容用户
      // 重复制一次就好。所以清。但结果记成 `cleared-unverified`，不假装
      // "已验证归属后清理"，免得事后排查时被误导成"剪贴板里早就没有了"。
      await this.tryClear();
      this.recordOutcome(token, 'cleared-unverified');
      this.onCleared?.(entry.receipt);
      return;
    }

    if (current === null) {
      this.recordOutcome(token, 'missing');
      return;
    }

    const currentDigest = await sha256Hex(current);
    if (currentDigest === entry.digest) {
      await this.tryClear();
      this.recordOutcome(token, 'cleared');
      this.onCleared?.(entry.receipt);
      return;
    }
    this.recordOutcome(token, 'overwritten');
    this.onOverwritten?.(entry.receipt);
  }

  /** 若内容仍属于本次写入则清空。 */
  private async clearIfOwned(entry: PendingEntry): Promise<void> {
    let current: string | null;
    try {
      current = await this.port.read();
    } catch {
      // 锁定时读不到剪贴板：同样强制清空。锁定场景更该清——用户刚按下"上锁"，
      // 预期就是"外面不要再留着我的密码"，此时宁可多清一次。
      await this.tryClear();
      return;
    }
    if (current === null) {
      return;
    }
    const currentDigest = await sha256Hex(current);
    if (currentDigest === entry.digest) {
      await this.tryClear();
    }
  }

  /**
   * 尽力清空。
   *
   * 端口实现可能抛错（无权限 / 环境不支持），而清理发生在定时器回调里——
   * 那里抛出的异常没人接，会变成未处理的 Promise rejection。清理失败不该
   * 连带把整个到期任务搞崩。
   */
  private async tryClear(): Promise<void> {
    try {
      await this.port.clear();
    } catch {
      // 尽力而为，失败不向用户暴露内部细节。
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
    this.inflight.add(task);
    void task.finally(() => {
      this.inflight.delete(task);
    });
  }
}

/** 断言错误是剪贴板相关错误，供测试断言使用。 */
export function isClipboardError(error: unknown): boolean {
  return (
    AppError.isAppError(error) &&
    (error.code === 'CLIPBOARD_WRITE_FAILED' || error.code === 'CLIPBOARD_READ_FAILED')
  );
}
