/**
 * 操作日志（PRD 非功能需求 · 可靠性：「操作日志本地化且不含敏感数据
 * （含跳转目标，不含填充动作）」）。
 *
 * 三条硬约束，代码里逐条守住：
 * 1. **绝不记录密码、账号、卡片标题、备注**。日志会进设置页给人看，也可能被
 *    截图分享；一旦掺进明文，日志本身就变成泄漏源。因此条目里只有"动作 +
 *    资产 id + 一段经过裁剪的说明"。
 * 2. **跳转目标只留 origin + pathname**，丢掉 query 与 hash——登录链接的
 *    query 里经常带 token / session，写进日志等于把凭据抄了一份。
 * 3. **不记录填充动作**（PRD 明确要求）：填充是高频无感行为，记了既没用又
 *    扩大了暴露面；Web 阶段本来也没有填充能力。
 *
 * 容量：环形缓冲，最多 `AUDIT_CAPACITY` 条，超出丢最旧的。密码库用一整天也就
 * 几十条，200 条足够回看，又不会让内存随使用时长无限增长。
 *
 * 诚实说明：Web 阶段只在内存里，刷新即清空；落盘要等 SQLCipher（ADR-010）。
 */

/** 可记录的动作类型（新增时同步补 `AUDIT_ACTION_LABELS`）。 */
export type AuditAction =
  | 'unlock'
  | 'lock'
  | 'item.create'
  | 'item.update'
  | 'item.delete'
  | 'item.copy_password'
  | 'item.copy_username'
  | 'item.reveal'
  | 'backup.export'
  | 'backup.import'
  | 'recovery.rotate'
  | 'jump';

/** 一条日志。 */
export interface AuditEntry {
  /** 单调递增，仅用于列表 key 与"第几条"。 */
  id: number;
  at: number;
  action: AuditAction;
  /** 关联资产 id；与资产无关的动作为 null。 */
  itemId: number | null;
  /**
   * 一段**不含敏感内容**的简短说明：跳转目标（已裁剪）、批量条数等。
   * 不要往里塞标题、账号、密码、完整 URL。
   */
  detail: string | null;
}

/** 环形缓冲容量。 */
export const AUDIT_CAPACITY = 200;

/**
 * 把跳转目标裁成"能认出是哪个站"的最小信息。
 *
 * 例：`https://example.com/login?token=abc#x` → `https://example.com/login`
 * 解析失败（比如 `steam://` 这类自定义 scheme）时只保留 scheme 前缀，
 * 避免把整串不明内容原样落进日志。
 */
export function sanitizeJumpTarget(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `${url.origin}${url.pathname}`;
    }
    return url.protocol;
  } catch {
    return '（无法解析的目标）';
  }
}

/** 操作日志（内存环形缓冲）。 */
export class AuditLog {
  private nextId = 1;

  /** 最新的在数组末尾，方便裁剪。 */
  private entries: AuditEntry[] = [];

  private readonly now: () => number;

  constructor(options: { now: () => number }) {
    this.now = options.now;
  }

  /** 记一条。 */
  record(
    action: AuditAction,
    options: { itemId?: number | null; detail?: string | null } = {},
  ): void {
    this.entries.push({
      id: this.nextId,
      at: this.now(),
      action,
      itemId: options.itemId ?? null,
      detail: options.detail ?? null,
    });
    this.nextId += 1;
    if (this.entries.length > AUDIT_CAPACITY) {
      this.entries.splice(0, this.entries.length - AUDIT_CAPACITY);
    }
  }

  /** 读最近 `limit` 条，**新的在前**（设置页从上往下读才顺）。 */
  list(limit = AUDIT_CAPACITY): AuditEntry[] {
    const size = Math.max(0, Math.min(limit, this.entries.length));
    return this.entries.slice(this.entries.length - size).reverse();
  }

  /** 当前条数。 */
  size(): number {
    return this.entries.length;
  }

  /** 清空（用户主动"清空日志"）。 */
  clear(): void {
    this.entries = [];
  }
}
