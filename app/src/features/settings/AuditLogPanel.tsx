/**
 * 操作日志区块（NFR 可靠性「操作日志本地化且不含敏感数据」）。
 *
 * 展示的是**最近 20 条**，不是全部 200 条：设置页是给人扫一眼"刚刚发生了什么"的，
 * 不是审计工具；全量列表既撑爆面板也没有更多信息量。
 *
 * 每条只有：时间 · 动作 · 资产 id · 一段裁剪过的说明。没有密码、账号、标题——
 * 这不是"暂时没加"，而是 `core/vault/audit.ts` 里写死的约束：日志会被人读、
 * 被截图，掺进明文就等于制造泄漏源。
 */

import { Button } from '../../components/ui/Button';
import type { AuditAction, AuditEntry } from '../../core/vault/audit';

/** 动作 → 中文标签。 */
const ACTION_LABELS: Record<AuditAction, string> = {
  unlock: '解锁',
  lock: '锁定',
  'item.create': '新建卡片',
  'item.update': '编辑卡片',
  'item.delete': '删除卡片',
  'item.copy_password': '复制密码',
  'item.copy_username': '复制账号',
  'item.reveal': '预览密码',
  'backup.export': '导出备份',
  'backup.import': '导入备份',
  'recovery.rotate': '轮换恢复密钥',
  'recovery.export': '导出恢复密钥',
  jump: '跳转',
};

/** 只显示最近这么多条。 */
const VISIBLE_LIMIT = 20;

export interface AuditLogPanelProps {
  entries: readonly AuditEntry[];
  /** 清空：门面与本地列表都由父组件一起处理，这里不持状态。 */
  onClear: () => void;
}

/** 时间只到秒：日志不需要毫秒精度，日期由"最近"这个语境提供。 */
function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 操作日志区块。 */
export function AuditLogPanel({ entries, onClear }: AuditLogPanelProps): JSX.Element {
  const visible = entries.slice(0, VISIBLE_LIMIT);
  return (
    <section className="flex flex-col gap-2 rounded-card border border-line bg-surface-muted p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-fg">操作日志</h3>
        <Button variant="secondary" size="sm" disabled={entries.length === 0} onClick={onClear}>
          清空
        </Button>
      </div>
      {visible.length === 0 ? (
        <p className="text-[11px] leading-5 text-fg-faint" data-testid="audit-empty">
          还没有操作记录。解锁、复制、编辑、导出等动作都会记在这里。
        </p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="audit-list">
          {visible.map((entry) => (
            <li key={entry.id} className="flex items-baseline gap-2 text-[11px] leading-5">
              <span className="shrink-0 font-mono text-fg-faint">{formatClock(entry.at)}</span>
              <span className="shrink-0 font-medium text-fg-muted">{ACTION_LABELS[entry.action]}</span>
              {entry.itemId !== null ? (
                <span className="shrink-0 text-fg-faint">#{entry.itemId}</span>
              ) : null}
              {entry.detail !== null ? (
                <span className="truncate text-fg-faint">{entry.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] leading-4 text-fg-faint">
        只记录动作与对象编号，不含密码、账号与标题；跳转目标只保留站点与路径（去掉可能带令牌的查询串）。
        当前版本日志仅存内存，刷新即清空。
      </p>
    </section>
  );
}
