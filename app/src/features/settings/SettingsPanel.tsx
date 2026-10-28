/**
 * 设置面板（最小集）。
 *
 * 只放"会话/剪贴板/数据"三类可调项，其余（Windows Hello、全局热键、开机自启）
 * 依赖 Tauri 能力，Phase 1.5 再接入。
 */

import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Field, INPUT_CLASS } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { useVaultClient } from '../../app/VaultProvider';
import { describeError } from '../../lib/i18n';
import { downloadTextFile } from '../../lib/format';
import type { AutoLockPolicy, SessionSnapshot } from '../../core/vault/types';
import { CLIPBOARD_TTL_OPTIONS } from '../../core/vault/types';
import type { VaultHealthReport } from '../../core/vault/health';
import { isHealthy } from '../../core/vault/health';
import { previewCsvImport, type CsvImportPreview } from '../../core/vault/csv-import';
import type { StorageLocation } from '../../services/storage';
import { isDesktopShell, revealStorageFolder } from '../../services/tauri-storage';
import type { BackupStatus, HotzoneConfigPatch } from '../../services/vault-client';
import { BACKUP_REMINDER_DAYS } from '../../services/vault-client';
import type { AuditEntry } from '../../core/vault/audit';
import {
  DEFAULT_HOTZONE,
  HOTZONE_MAX_WIDTH_PX,
  HOTZONE_MIN_WIDTH_PX,
  hotzoneBand,
  type HotzoneAlign,
  type HotzoneConfig,
} from '../../lib/hotzone';
import { useUiStore } from '../../stores/ui-store';
import {
  COLLAPSE_DELAY_OPTIONS,
  DEFAULT_COLLAPSE_DELAY_MS,
  DEFAULT_DWELL_DELAY_MS,
  DWELL_DELAY_OPTIONS,
} from '../../lib/timing';
import {
  DEFAULT_SHORTCUTS,
  FIXED_SHORTCUTS,
  SHORTCUT_IDS,
  SHORTCUT_LABELS,
  SHORTCUT_OPTIONS,
  formatBinding,
  isConfigurableAction,
  type ShortcutAction,
  type ShortcutMap,
} from '../../lib/shortcuts';
import { AuditLogPanel } from './AuditLogPanel';
import { RotateRecoveryKeyDialog } from './RotateRecoveryKeyDialog';

/** 自动锁定档位。 */
const POLICY_OPTIONS: ReadonlyArray<{ value: AutoLockPolicy; label: string }> = [
  { value: 'immediate', label: '立即（离开即锁）' },
  { value: '5m', label: '5 分钟' },
  { value: '30m', label: '30 分钟' },
  { value: '4h', label: '4 小时' },
  { value: 'boot', label: '本次开机内保持' },
];

  /** 剪贴板清理时长。 */
  /**
   * 剪贴板自动清理时长（PRD FR-05：默认 30s，10–120s 可调，**可关闭**）。
   *
   * `0` 是"关闭"档：复制后不安排清理，内容一直留在剪贴板里，直到用户复制别的内容
   * 或锁定会话（锁定时仍会按归属清掉）。选它的人应当已经看过下面的历史风险提示。
   */
  const TTL_OPTIONS: readonly number[] = CLIPBOARD_TTL_OPTIONS;

/** 备份恢复模式（与 `ImportBackupInput.mode` 对齐）。 */
type BackupMode = 'overwrite' | 'merge';

/**
 * Windows 剪贴板历史风险提示（PRD FR-05 P0：「设置页检测并提示 Windows『Win+V 剪贴板历史』
 * 风险、引导关闭」）。
 *
 * 关于"检测"的诚实说明：浏览器沙箱里读不到系统的「剪贴板历史」开关状态，
 * 所以这里**不**假装检测后展示，而是常驻提示 + 给出关闭步骤。把风险讲清楚，
 * 比显示一个永远是"未检测"的绿色勾更负责。
 *
 * 为什么不能只靠密岛的自动清理：自动清理只能清掉**当前**剪贴板项，而开启剪贴板历史后
 * Windows 会另行留存每次复制的记录，那是密岛碰不到的地方。
 */
function ClipboardHistoryNotice(): JSX.Element {
  return (
    <div
      data-testid="clipboard-history-notice"
      className="flex flex-col gap-1.5 rounded-card border border-amber-200 bg-amber-50 p-3"
    >
      <h4 className="text-[11px] font-semibold text-amber-900">Windows 剪贴板历史风险</h4>
      <p className="text-[11px] leading-5 text-amber-800">
        自动清理只能清掉「当前」剪贴板项。只要系统开着剪贴板历史，Windows
        会另行留存每次复制的记录，密岛清不到那里——别人按下 <kbd className="rounded border border-amber-300 bg-amber-100 px-1 text-[10px]">Win</kbd>+
        <kbd className="rounded border border-amber-300 bg-amber-100 px-1 text-[10px]">V</kbd> 就能翻到你复制过的密码。
      </p>
      <p className="text-[11px] leading-5 text-amber-800">
        建议关闭：设置 → 系统 → 剪贴板 → 关掉「剪贴板历史」，并在同一页点一次「清除」。
        如果你已经在这里复制过密码，请立刻去清一次历史。
      </p>
    </div>
  );
}

export interface SettingsPanelProps {
  open: boolean;
  snapshot: SessionSnapshot;
  onClose: () => void;
  onSessionChange: (snapshot: SessionSnapshot) => void;
  /** 数据被清空或灌入示例数据后通知父组件刷新。 */
  onDataChanged: () => void;
  /** 体检结果里点击「定位」时通知父组件（关闭面板并在主面板搜索该标题）。 */
  onLocateItem?: (title: string) => void;
}

/** 把体检报告压缩成一句中文摘要（用于 toast）。 */
function describeFindings(report: VaultHealthReport): string {
  const parts: string[] = [];
  if (report.duplicates.length > 0) parts.push(`${report.duplicates.length} 组重复密码`);
  if (report.weak.length > 0) parts.push(`${report.weak.length} 张弱密码`);
  if (report.stale.length > 0) parts.push(`${report.stale.length} 张长期未修改`);
  return parts.join('、');
}

/**
 * 备份时间的人话描述（PRD FR-06）。
 *
 * `null` 表示"还没读到"（打开面板时的异步请求未回来或失败），显示 `—` 而不是
 * "从未备份"——把"不知道"说成"没有"会让用户白紧张一场。
 */
function describeBackupAge(status: BackupStatus | null): { text: string; overdue: boolean } {
  if (status === null) {
    return { text: '—', overdue: false };
  }
  if (status.lastBackupAt === null) {
    return { text: '从未备份', overdue: status.overdue };
  }
  const text = status.daysSinceBackup === 0 ? '今天' : `${status.daysSinceBackup} 天前`;
  return { text, overdue: status.overdue };
}

/**
 * 桌面端专属、Web 阶段只能置灰的开关（PRD FR-05 防截屏 / 检查更新）。
 *
 * 为什么不用 `checked` 表示"桌面版默认开"：勾着的禁用复选框传达的是"现在是开的"，
 * 而事实是 Web 阶段根本没有这个能力。宁可显示未勾选 + 一句原因，也不给假状态。
 */
function DesktopOnlyToggle({
  id,
  label,
  reason,
}: {
  id: string;
  label: string;
  reason: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1" data-testid={id}>
      <div className="flex items-center gap-2">
        <input id={id} type="checkbox" disabled className="h-4 w-4 rounded border-zinc-300" />
        <label htmlFor={id} className="text-xs text-zinc-500">
          {label}
        </label>
      </div>
      <p className="pl-6 text-[11px] leading-4 text-zinc-500">{reason}</p>
    </div>
  );
}

/**
 * 快捷键设置区（NFR 可用性：「所有快捷键可在设置中查看与自定义」）。
 *
 * ## 为什么只让改四个
 *
 * 另三个（↑↓ 移动、Esc 收起）是 WAI-ARIA APG 与浏览器原生行为，不是密岛的选择：
 * 把它们做成可配置，等于允许用户把应用改成不合规，而设置页不会提醒后果。
 * 所以这三行**照常列出**、标明组合键，但显示为固定并给出原因。
 * 诚实的部分交付好过假装全都能改——见 `lib/shortcuts.ts` 顶部的完整说明。
 *
 * ## 冲突的处理：置灰而不是报错
 *
 * 一个组合键同时只能属于一个动作（两个动作同一个键时，先判的那个永远赢，
 * 另一个静默失效，而这种失效在设置页上看不出来）。这里把已被占用的选项
 * 置灰，用户根本选不到冲突值；门面仍然会校验并抛 `VALIDATION_FAILED`，
 * 因为置灰只是 UI 便利，不变式要靠服务端守。
 */
function ShortcutSection({
  shortcuts,
  onChange,
  onReset,
  busy,
}: {
  shortcuts: ShortcutMap;
  onChange: (action: ShortcutAction, spec: string) => void;
  onReset: () => void;
  busy: boolean;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-2 rounded-card border border-zinc-200 bg-zinc-50 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-zinc-900">快捷键</h3>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onReset}>
          恢复默认
        </Button>
      </div>
      <div className="flex flex-col gap-1.5" data-testid="shortcut-list">
        {SHORTCUT_IDS.map((id) => {
          const label = SHORTCUT_LABELS[id];
          if (isConfigurableAction(id)) {
            const options = SHORTCUT_OPTIONS[id];
            const takenByOthers = new Set(
              SHORTCUT_IDS.filter((other) => other !== id).map((other) =>
                formatBinding(shortcuts[other]),
              ),
            );
            return (
              <div key={id} className="flex items-center justify-between gap-3">
                <span className="shrink-0 text-[11px] leading-5 text-zinc-600">{label}</span>
                <select
                  aria-label={`${label}快捷键`}
                  className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 font-mono text-[10px] text-zinc-700"
                  value={formatBinding(shortcuts[id])}
                  onChange={(event) => onChange(id, event.target.value)}
                >
                  {options.map((spec) => (
                    <option key={spec} value={spec} disabled={takenByOthers.has(spec)}>
                      {spec}
                    </option>
                  ))}
                </select>
              </div>
            );
          }
          return (
            <div key={id} className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-[11px] leading-5 text-zinc-600">{label}</span>
              <span className="flex items-center gap-2">
                <kbd className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 font-mono text-[10px] text-zinc-700">
                  {formatBinding(shortcuts[id])}
                </kbd>
                <span className="text-[10px] text-zinc-400" title={FIXED_SHORTCUTS[id].reason}>
                  固定
                </span>
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] leading-4 text-zinc-500">
        标为「固定」的三项是列表导航与关闭浮层的通用约定（WAI-ARIA
        APG），更换会让读屏用户失去预期，因此不开放自定义。全局热键（唤出灵动岛 / 立即锁定）
        与系统级自定义绑定需要桌面版：Web 阶段没有注册系统级热键的能力，给了开关也按不动。
      </p>
    </section>
  );
}

/** 数据说明里的「上次备份」一行（PRD FR-06）。 */
function BackupStatusRow({ status }: { status: BackupStatus | null }): JSX.Element {
  const age = describeBackupAge(status);
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="backup-status">
      <span className="text-[11px] font-medium text-zinc-700">上次备份</span>
      <span className={age.overdue ? 'text-[11px] font-medium text-amber-700' : 'text-[11px] text-zinc-600'}>
        {age.text}
      </span>
      {age.overdue ? (
        <span className="text-[11px] text-amber-700">
          · 已超过 {BACKUP_REMINDER_DAYS} 天，建议现在导出一份
        </span>
      ) : null}
    </div>
  );
}

/** 设置面板。 */
/** 热区预览的参照视口宽度：1440px 桌面窗口，用来把 px 换算成百分比。 */
const HOTZONE_PREVIEW_VIEWPORT_PX = 1440;

/** 热区水平位置的可选值。 */
const HOTZONE_ALIGN_OPTIONS: ReadonlyArray<{ value: HotzoneAlign; label: string }> = [
  { value: 'left', label: '靠左' },
  { value: 'center', label: '居中' },
  { value: 'right', label: '靠右' },
];

interface HotzoneSectionProps {
  config: HotzoneConfig;
  onChange: (patch: HotzoneConfigPatch) => void;
  collapseDelayMs: number;
  onCollapseDelayChange: (delayMs: number) => void;
  dwellDelayMs: number;
  onDwellDelayChange: (delayMs: number) => void;
}

/**
 * 顶部热区与收起时序（PRD FR-02「默认宽约 300px，可配置宽度与位置」+
 * 「鼠标离开 2 秒后自动收起」/ SDD §6.5「可配置」）。
 *
 * 宽度用数字输入而不是滑块：滑块每拖一格就发一次请求，既刷屏 toast 又让
 * "最后一次请求赢"的竞态有机可乘。数字框在失焦 / 回车时提交一次，语义清楚。
 * 非法值（越界、非整数、清空）直接回退到当前值，不弹错——输入框自带 min/max，
 * 浏览器已经把范围标出来了，再弹一次 toast 只是噪音。
 *
 * 预览条按 1440px 折算：热区宽度是绝对像素，不同屏幕上占的比例不同，
 * 写死一个参照宽度并注明，比画一条"看起来居中"的假比例条诚实。
 */
function HotzoneSection({
  config,
  onChange,
  collapseDelayMs,
  onCollapseDelayChange,
  dwellDelayMs,
  onDwellDelayChange,
}: HotzoneSectionProps): JSX.Element {
  const [draft, setDraft] = useState(String(config.widthPx));

  // 外部配置变了（设置页重新打开、别处改过）就同步草稿，否则输入框会一直显示旧值。
  useEffect(() => {
    setDraft(String(config.widthPx));
  }, [config.widthPx]);

  const commitWidth = (): void => {
    const parsed = Number(draft);
    if (
      draft.trim() === '' ||
      !Number.isInteger(parsed) ||
      parsed < HOTZONE_MIN_WIDTH_PX ||
      parsed > HOTZONE_MAX_WIDTH_PX
    ) {
      setDraft(String(config.widthPx));
      return;
    }
    if (parsed !== config.widthPx) {
      onChange({ widthPx: parsed });
    }
  };

  const band = hotzoneBand(config, HOTZONE_PREVIEW_VIEWPORT_PX);
  const leftPercent = (band.left / HOTZONE_PREVIEW_VIEWPORT_PX) * 100;
  const widthPercent = (band.width / HOTZONE_PREVIEW_VIEWPORT_PX) * 100;

  return (
    <section className="flex flex-col gap-3 rounded-card border border-zinc-200 bg-zinc-50 p-4">
      <h3 className="text-xs font-semibold text-zinc-900">灵动岛</h3>
      <Field
        label="收起延时"
        htmlFor="settings-collapse-delay"
        hint="鼠标离开展开面板后多久自动收起（PRD 默认 2 秒）。折叠胶囊态不受此项影响：它只是「探个头」，离开 250ms 就消失，免得挡住页面顶部的点击。"
      >
        <select
          id="settings-collapse-delay"
          className={INPUT_CLASS}
          value={collapseDelayMs}
          onChange={(event) => onCollapseDelayChange(Number(event.target.value))}
        >
          {COLLAPSE_DELAY_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {value === DEFAULT_COLLAPSE_DELAY_MS ? `${value / 1000} 秒（默认）` : `${value / 1000} 秒`}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="停留时长"
        htmlFor="settings-dwell-delay"
        hint="展开后无操作多久自动隐藏。与上面的「收起延时」是两件事：收起延时只在鼠标离开后计时，停留时长管的是「鼠标一直停在岛上、但人已经走了」——到点同样收起。移动鼠标、按键、滚轮都会重新计时。"
      >
        <select
          id="settings-dwell-delay"
          className={INPUT_CLASS}
          value={dwellDelayMs}
          onChange={(event) => onDwellDelayChange(Number(event.target.value))}
        >
          {DWELL_DELAY_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {value === DEFAULT_DWELL_DELAY_MS ? `${value / 1000} 秒（默认）` : `${value / 1000} 秒`}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="热区宽度"
        htmlFor="settings-hotzone-width"
        hint={`屏幕顶部可唤出灵动岛的范围，默认 300px。可填 ${HOTZONE_MIN_WIDTH_PX}–${HOTZONE_MAX_WIDTH_PX}px，失焦或回车后生效。`}
      >
        <div className="flex items-center gap-2">
          <input
            id="settings-hotzone-width"
            type="number"
            min={HOTZONE_MIN_WIDTH_PX}
            max={HOTZONE_MAX_WIDTH_PX}
            step={20}
            className={INPUT_CLASS}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitWidth}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitWidth();
              }
            }}
          />
          <span className="text-xs text-zinc-500">px</span>
        </div>
      </Field>
      <Field
        label="热区位置"
        hint="沿屏幕顶边水平移动。垂直位置固定在顶端：Web 版拿不到系统级窗口位置，桌面版才可自由摆放。"
      >
        <div className="flex flex-wrap gap-2" role="group" aria-label="热区位置" data-testid="hotzone-align-group">
          {HOTZONE_ALIGN_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={config.align === option.value}
              onClick={() => onChange({ align: option.value })}
              className={
                config.align === option.value
                  ? 'rounded-pill bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white'
                  : 'rounded-pill border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:border-zinc-300'
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      </Field>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-zinc-700">覆盖范围（按 1440px 宽屏折算）</span>
        <div className="relative h-2 w-full rounded-full bg-zinc-200" data-testid="hotzone-preview">
          <div
            className="absolute top-0 h-2 rounded-full bg-zinc-900"
            style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
          />
        </div>
      </div>
      {/* PRD FR-02 验收要点「全屏应用前台时鼠标划过顶部不弹出」。
          Web 阶段只能看到浏览器自己的全屏，这一点必须写清楚，不能靠
          "实现了全屏检测"让用户以为已经覆盖所有场景。 */}
      <p className="text-[11px] leading-5 text-zinc-500">
        全屏时自动抑制唤起：浏览器全屏（F11 或页面全屏）下，鼠标划过顶部不会弹出灵动岛。
        系统里另开的全屏游戏 / 播放器、以及多显示器的主屏归属，都在浏览器进程之外，Web 版看不到，那几条路径要等桌面版接入。
      </p>
    </section>
  );
}

export function SettingsPanel({
  open,
  snapshot,
  onClose,
  onSessionChange,
  onDataChanged,
  onLocateItem,
}: SettingsPanelProps): JSX.Element {
  const client = useVaultClient();
  const toast = useToast();
  const [ttl, setTtl] = useState<number>(30_000);
  const [confirmText, setConfirmText] = useState('');
  /** 销毁数据前的二次认证输入（PRD FR-08.4 保护链第二环）。 */
  const [destroyPassword, setDestroyPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [backupPassword, setBackupPassword] = useState('');
  const [backupOpen, setBackupOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importMode, setImportMode] = useState<BackupMode>('merge');
  const [importConfirm, setImportConfirm] = useState('');
  const [importMaster, setImportMaster] = useState('');
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [csvPreview, setCsvPreview] = useState<CsvImportPreview | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const [health, setHealth] = useState<VaultHealthReport | null>(null);
  const [storageLocation, setStorageLocation] = useState<StorageLocation | null>(null);
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [auditEntries, setAuditEntries] = useState<readonly AuditEntry[]>([]);
  const [rotateOpen, setRotateOpen] = useState(false);
  /** 热区配置（FR-02）：真值在元数据，这里是一份供预览条渲染的副本。 */
  const [hotzoneConfig, setHotzoneConfig] = useState<HotzoneConfig>(DEFAULT_HOTZONE);
  /** 写回 UI store：灵动岛的命中判定读的是它，改完要立刻生效。 */
  const applyHotzone = useUiStore((state) => state.setHotzone);
  /** 收起延时（FR-02）：同样真值在元数据，store 是供隐藏时序同步读取的镜像。 */
  const [collapseDelayMs, setCollapseDelayMs] = useState<number>(DEFAULT_COLLAPSE_DELAY_MS);
  const applyCollapseDelay = useUiStore((state) => state.setCollapseDelay);
  /** 停留时长（无操作多久自动隐藏）：与收起延时分开的两件事，见 `lib/timing.ts`。 */
  const [dwellDelayMs, setDwellDelayMs] = useState<number>(DEFAULT_DWELL_DELAY_MS);
  const applyDwellDelay = useUiStore((state) => state.setDwellDelay);
  /** 快捷键自定义：本地副本供下拉框显示，另写一份进 store 供键盘处理同步读。 */
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(DEFAULT_SHORTCUTS);
  const [shortcutBusy, setShortcutBusy] = useState(false);
  const applyShortcuts = useUiStore((state) => state.setShortcuts);

  useEffect(() => {
    if (!open) {
      setConfirmText('');
      setBackupPassword('');
      setBackupOpen(false);
      setImportOpen(false);
      setImportText('');
      setImportMode('merge');
      setImportConfirm('');
      setImportMaster('');
      setCsvOpen(false);
      setCsvText('');
      setCsvPreview(null);
      setCsvError(null);
      setHealth(null);
      setHealthBusy(false);
      setRotateOpen(false);
      setAuditEntries([]);
      return;
    }
    // 打开时读取数据文件位置（PRD FR-06）。读失败只留空，不弹 toast——
    // 位置信息是附属展示，不该打断用户正在进行的设置操作。
    let active = true;
    void client
      .describeStorage()
      .then((location) => {
        if (active) {
          setStorageLocation(location);
        }
      })
      .catch(() => {
        if (active) {
          setStorageLocation(null);
        }
      });
    // 备份状态（PRD FR-06）：读失败同样静默降级，不打断设置操作。
    void client
      .getBackupStatus()
      .then((status) => {
        if (active) {
          setBackupStatus(status);
        }
      })
      .catch(() => {
        if (active) {
          setBackupStatus(null);
        }
      });
    // 操作日志（NFR 可靠性）：读失败同样静默，日志是附属信息。
    void client
      .getAuditLog(20)
      .then((entries) => {
        if (active) {
          setAuditEntries(entries);
        }
      })
      .catch(() => {
        if (active) {
          setAuditEntries([]);
        }
      });
    // 热区配置（PRD FR-02）：读失败回落到默认 300px 居中，不挡设置面板。
    void client
      .getHotzoneConfig()
      .then((config) => {
        if (active) {
          setHotzoneConfig(config);
          applyHotzone(config);
        }
      })
      .catch(() => {
        if (active) {
          setHotzoneConfig(DEFAULT_HOTZONE);
        }
      });
    // 收起延时（PRD FR-02 / SDD §6.5）：读失败回落到默认 2 秒。
    void client
      .getCollapseDelay()
      .then((delay) => {
        if (active) {
          setCollapseDelayMs(delay);
          applyCollapseDelay(delay);
        }
      })
      .catch(() => {
        if (active) {
          setCollapseDelayMs(DEFAULT_COLLAPSE_DELAY_MS);
        }
      });
    // 停留时长：读失败回落到默认 10 秒。
    void client
      .getDwellDelay()
      .then((delay) => {
        if (active) {
          setDwellDelayMs(delay);
          applyDwellDelay(delay);
        }
      })
      .catch(() => {
        if (active) {
          setDwellDelayMs(DEFAULT_DWELL_DELAY_MS);
        }
      });
    // 快捷键自定义（NFR 可用性）：读失败回落默认映射。
    void client
      .getShortcuts()
      .then((next) => {
        if (active) {
          setShortcuts(next);
          applyShortcuts(next);
        }
      })
      .catch(() => {
        if (active) {
          setShortcuts(DEFAULT_SHORTCUTS);
        }
      });
    return () => {
      active = false;
    };
  }, [open, client, applyHotzone, applyCollapseDelay, applyDwellDelay, applyShortcuts]);

  /**
   * 清空操作日志。
   *
   * 门面与本地列表一起清：只清一边会出现"界面空了、下次打开又冒出来"，
   * 用户会以为清空没生效。
   */
  const handleClearAudit = async (): Promise<void> => {
    try {
      await client.clearAuditLog();
      setAuditEntries([]);
      toast('操作日志已清空');
    } catch (caught) {
      toast(describeError(caught));
    }
  };

  /**
   * 切换「系统锁屏 / 休眠立即锁定」（PRD FR-01，默认开）。
   *
   * 直接写门面并回填快照：开关状态在快照里，不额外维护本地 state——
   * 两处各存一份，迟早会出现"界面显示开、实际是关"。
   */
  const handleLockOnSystemLock = async (enabled: boolean): Promise<void> => {
    try {
      onSessionChange(await client.setLockOnSystemLock(enabled));
      toast(enabled ? '已开启：系统锁屏 / 休眠时立即锁定' : '已关闭：系统锁屏时不再自动锁定');
    } catch (caught) {
      toast(describeError(caught));
    }
  };

  /**
   * 修改热区宽度 / 位置（PRD FR-02）。
   *
   * 成功后同时更新本地副本与 UI store：本地副本供预览条渲染，store 供灵动岛
   * 的命中判定——只更新一处就会出现"预览条动了、实际热区没动"。
   * 不弹成功 toast：预览条本身就是反馈，改一次宽度弹一次提示只会挡住面板。
   */
  const handleHotzoneChange = async (patch: HotzoneConfigPatch): Promise<void> => {
    try {
      const next = await client.setHotzoneConfig(patch);
      setHotzoneConfig(next);
      applyHotzone(next);
    } catch (caught) {
      toast(describeError(caught));
    }
  };

  /**
   * 修改展开态收起延时（PRD FR-02「鼠标离开 2 秒后自动收起」，SDD §6.5「可配置」）。
   *
   * 同样双写：本地副本供下拉框显示，store 供灵动岛的隐藏时序——只写一处就会出现
   * "设置显示 3 秒、实际还是 2 秒收起"。
   */
  const handleCollapseDelayChange = async (delayMs: number): Promise<void> => {
    try {
      const next = await client.setCollapseDelay(delayMs);
      setCollapseDelayMs(next);
      applyCollapseDelay(next);
    } catch (caught) {
      toast(describeError(caught));
    }
  };

  /**
   * 修改展开态停留时长（无操作多久自动隐藏）。
   *
   * 与收起延时同样双写：本地副本供下拉框显示，store 供岛的停留计时器同步读取。
   */
  const handleDwellDelayChange = async (delayMs: number): Promise<void> => {
    try {
      const next = await client.setDwellDelay(delayMs);
      setDwellDelayMs(next);
      applyDwellDelay(next);
    } catch (caught) {
      toast(describeError(caught));
    }
  };

  /**
   * 改一个快捷键（NFR 可用性）。
   *
   * 同样双写：本地副本供下拉框回显，store 供键盘处理——只写一处就会出现
   * "设置显示 Alt+Enter、实际还是 Enter 复制密码"。
   *
   * 失败时**不回滚**本地副本：门面校验不过（被占用、不在备选里）时返回的还是
   * 原映射，`setShortcuts(next)` 拿到的是旧值，下拉框自然停在原处。
   */
  const handleShortcutChange = async (action: ShortcutAction, spec: string): Promise<void> => {
    setShortcutBusy(true);
    try {
      const next = await client.setShortcut(action, spec);
      setShortcuts(next);
      applyShortcuts(next);
    } catch (caught) {
      toast(describeError(caught));
    } finally {
      setShortcutBusy(false);
    }
  };

  const handleShortcutReset = async (): Promise<void> => {
    setShortcutBusy(true);
    try {
      const next = await client.resetShortcuts();
      setShortcuts(next);
      applyShortcuts(next);
      toast('快捷键已恢复默认');
    } catch (caught) {
      toast(describeError(caught));
    } finally {
      setShortcutBusy(false);
    }
  };

  const handlePolicy = async (policy: AutoLockPolicy): Promise<void> => {
    try {
      onSessionChange(await client.setAutoLockPolicy(policy));
      toast('自动锁定档位已更新');
    } catch (caught) {
      toast(describeError(caught));
    }
  };

  const handleTtl = async (value: number): Promise<void> => {
    setTtl(value);
    try {
      await client.setClipboardTtl(value);
      // 关闭档不能说"0 秒后自动清空"——那等于立刻清空，与"不清理"正好相反。
      toast(value === 0 ? '已关闭剪贴板自动清空' : `剪贴板将在 ${value / 1000} 秒后自动清空`);
    } catch (caught) {
      toast(describeError(caught));
    }
  };

  const handleLock = async (): Promise<void> => {
    try {
      onSessionChange(await client.lock('manual'));
      onClose();
    } catch (caught) {
      toast(describeError(caught));
    }
  };

  const handleSeed = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.createItem({
        title: '示例 · GitHub',
        platform: 'GitHub',
        url: 'https://github.com',
        username: 'dev@example.com',
        password: 'Demo-Only-Pass-1',
        category: '开发',
        tags: ['示例'],
      });
      await client.createItem({
        title: '示例 · 公司邮箱',
        platform: '企业邮箱',
        username: 'me@example.com',
        password: 'Demo-Only-Pass-2',
        category: '工作',
        tags: ['示例'],
      });
      await client.createItem({
        title: '示例 · 流媒体',
        platform: '流媒体',
        username: 'watch@example.com',
        password: 'Demo-Only-Pass-3',
        category: '娱乐',
        tags: ['示例'],
        visibility: 'username_only',
      });
      toast('已载入 3 条示例数据（仅开发演示）');
      onDataChanged();
    } catch (caught) {
      toast(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 销毁全部数据（PRD FR-08.4）。
   *
   * 保护链按 PRD 顺序走：解锁态（能打开设置面板就已满足）→ 主密码二次认证 →
   * 确认文字 → 执行。**先验密码再重置**，顺序反了的话"密码错"会发生在
   * 数据已经没了之后——那时用户看到的是一个既没删掉数据、也解释不清的报错。
   *
   * 无论成败都清空密码输入：失败时留着输入框里的明文密码，用户下次打开
   * 设置面板会以为已经填好了，直接点确认就绕过了二次认证。
   */
  const handleReset = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.verifyMasterPassword(destroyPassword);
      await client.resetVault();
      setDestroyPassword('');
      setConfirmText('');
      toast('本地数据已清空');
      onDataChanged();
      onClose();
      onSessionChange(await client.status());
    } catch (caught) {
      setDestroyPassword('');
      toast(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleExportBackup = async (): Promise<void> => {
    if (backupPassword.length === 0) {
      toast('请输入备份密码');
      return;
    }
    setBusy(true);
    try {
      const text = await client.exportBackup(backupPassword);
      const filename = `keyisland-${new Date().toISOString().slice(0, 10)}.kib`;
      // 必须检查返回值。原先这里自己拼 blob + <a download>，且**无条件**提示
      // "已导出加密备份"——下载没发生时用户也会以为自己有备份。
      // 备份是密码库的最后一道保险，谎报比报错危险得多。
      if (!downloadTextFile(filename, text)) {
        toast('保存文件失败，备份未导出；请重试，或改用其他方式保存');
        return;
      }
      // 记账放在**落盘之后**：`exportBackup()` 只产出密文，不碰 lastBackupAt。
      // 先记账再落盘，一旦保存失败，「超过 7 天未备份」的提醒会被静默重置，
      // 而用户手上其实什么都没有。
      await client.confirmBackupSaved();
      toast('已导出加密备份，请离线保存');
      setBackupPassword('');
      setBackupOpen(false);
    } catch (caught) {
      toast(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleImportBackup = async (): Promise<void> => {
    if (importText.trim().length === 0) {
      toast('请选择或粘贴备份文件内容');
      return;
    }
    if (backupPassword.length === 0) {
      toast('请输入备份密码');
      return;
    }
    if (importMode === 'overwrite' && importConfirm !== '覆盖') {
      toast('覆盖导入需要输入「覆盖」以确认');
      return;
    }
    if (importMode === 'overwrite' && importMaster.length === 0) {
      toast('覆盖导入需要验证当前库主密码');
      return;
    }
    setBusy(true);
    try {
      const result = await client.importBackup({
        kirkJson: importText.trim(),
        password: backupPassword,
        mode: importMode,
        masterPassword: importMode === 'overwrite' ? importMaster : undefined,
      });
      const conflictText = result.conflicts.length > 0 ? `，${result.conflicts.length} 处冲突已保留当前版本` : '';
      toast(`导入完成：共 ${result.totalItems} 张卡片${conflictText}`);
      onDataChanged();
      if (importMode === 'overwrite') {
        // 覆盖导入后回到锁定态：让用户用源库主密码重新解锁。
        onClose();
        onSessionChange(await client.status());
      }
      setImportText('');
      setImportConfirm('');
      setImportMaster('');
      setBackupPassword('');
      setImportOpen(false);
    } catch (caught) {
      toast(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const handlePickFile = async (file: File): Promise<void> => {
    try {
      const text =
        typeof file.text === 'function'
          ? await file.text()
          : await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = (): void => {
                resolve(typeof reader.result === 'string' ? reader.result : '');
              };
              reader.onerror = (): void => {
                reject(new Error('无法读取该文件'));
              };
              reader.readAsText(file);
            });
      setImportText(text);
    } catch {
      toast('无法读取该文件，请确认它是 .kib 备份');
    }
  };

  /** 选择 CSV 文件后预解析，给出条目数与被跳过的行（不展示任何密码）。 */
  const handleCsvFile = async (file: File): Promise<void> => {
    try {
      const text =
        typeof file.text === 'function'
          ? await file.text()
          : await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = (): void => {
                resolve(typeof reader.result === 'string' ? reader.result : '');
              };
              reader.onerror = (): void => {
                reject(new Error('无法读取该文件'));
              };
              reader.readAsText(file);
            });
      setCsvText(text);
      setCsvError(null);
      try {
        setCsvPreview(previewCsvImport(text));
      } catch {
        setCsvPreview(null);
        setCsvError('无法识别这个 CSV：需要包含「名称/账号/密码」三列');
      }
    } catch {
      setCsvError('无法读取该文件，请确认它是 CSV 格式');
    }
  };

  /** 逐条创建；任一条失败就停止并报告已导入数量，避免半途而废又无提示。 */
  const handleCsvImport = async (): Promise<void> => {
    if (csvPreview === null || csvPreview.items.length === 0) {
      toast('没有可导入的条目');
      return;
    }
    setBusy(true);
    let created = 0;
    try {
      for (const item of csvPreview.items) {
        await client.createItem(item);
        created += 1;
      }
      const skippedText = csvPreview.skipped.length > 0 ? `，跳过 ${csvPreview.skipped.length} 行` : '';
      toast(`已导入 ${created} 张卡片${skippedText}`);
      setCsvOpen(false);
      setCsvText('');
      setCsvPreview(null);
      onDataChanged();
    } catch (caught) {
      toast(`${describeError(caught)}（已导入 ${created} 张）`);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 密码体检：需要解锁态（内部会逐条解密取摘要）。
   * 报告里只有标题与摘要，绝不含密码明文，因此可以直接渲染。
   */
  const handleAudit = async (): Promise<void> => {
    setHealthBusy(true);
    try {
      const report = await client.auditPasswordHealth();
      setHealth(report);
      if (report.totalItems === 0) {
        toast('当前没有卡片，无需体检');
      } else if (isHealthy(report)) {
        toast(`已检查 ${report.totalItems} 张卡片，全部健康`);
      } else {
        toast(`体检完成：${describeFindings(report)}`);
      }
    } catch (caught) {
      toast(describeError(caught));
    } finally {
      setHealthBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="设置"
      description="所有设置都保存在本地，不会上传"
      onClose={onClose}
      widthClass="max-w-xl"
      footer={
        <Button variant="secondary" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold text-zinc-900">安全</h3>
          <Field label="自动锁定" htmlFor="settings-policy" hint="切换后立即生效，并对已解锁会话重新计时">
            <select
              id="settings-policy"
              className={INPUT_CLASS}
              value={snapshot.autoLockPolicy}
              onChange={(event) => void handlePolicy(event.target.value as AutoLockPolicy)}
            >
              {POLICY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="剪贴板自动清理"
            htmlFor="settings-ttl"
            hint="关闭后复制的内容会一直留在剪贴板里，锁定会话时仍会清掉"
          >
            <select
              id="settings-ttl"
              className={INPUT_CLASS}
              value={ttl}
              onChange={(event) => void handleTtl(Number(event.target.value))}
            >
              {TTL_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value === 0 ? '关闭（不自动清空）' : `${value / 1000} 秒`}
                </option>
              ))}
            </select>
          </Field>
          <ClipboardHistoryNotice />
          {/* PRD FR-01「系统锁屏、休眠立即锁定（默认开，可关）」。
              Web 预览读不到系统锁屏事件，提示里必须写清楚是近似，否则用户会以为
              "切个标签页就锁"是 bug。桌面端接入后文案随之更新。 */}
          <Field
            label="系统锁屏 / 休眠时立即锁定"
            htmlFor="settings-lock-on-system-lock"
            hint="默认开启。当前 Web 版读不到操作系统的锁屏事件，暂以「页面切到后台」近似，所以切标签页也会上锁；桌面端接入后改用真实系统事件。"
          >
            <div className="flex items-center gap-2">
              <input
                id="settings-lock-on-system-lock"
                type="checkbox"
                role="switch"
                className="h-4 w-4 rounded border-zinc-300 accent-zinc-900"
                checked={snapshot.lockOnSystemLock}
                onChange={(event) => void handleLockOnSystemLock(event.target.checked)}
              />
              <span className="text-xs text-zinc-600" data-testid="lock-on-system-lock-state">
                {snapshot.lockOnSystemLock ? '已开启' : '已关闭'}
              </span>
            </div>
          </Field>
          <Button variant="secondary" onClick={() => void handleLock()}>
            立即锁定
          </Button>
          {/* PRD FR-05「防截屏…可开关」与「网络行为：仅检查更新为显式开关（默认关）」。
              两者都依赖桌面端能力（WDA_EXCLUDEFROMCAPTURE / 更新通道），
              Web 阶段如实置灰并说明，而不是做一个点了没反应的开关。

              注意文案要分环境：在桌面壳里还说「需要桌面版」是错的——
              用户明明就在桌面版里。那里应该说的是"桌面版还没接这一项"。 */}
          <DesktopOnlyToggle
            id="setting-anti-screenshot"
            label="防截屏（截图 / 录屏 / 屏幕共享中隐藏窗口）"
            reason={
              isDesktopShell()
                ? '桌面版尚未接入这一项：需要在 Rust 侧调用 Windows WDA_EXCLUDEFROMCAPTURE（见 docs/DESKTOP-BUILD.md §6.3），接入后默认开启。'
                : '需要桌面版：Web 阶段无法调用 Windows WDA_EXCLUDEFROMCAPTURE，当前浏览器窗口仍会出现在截图里。桌面版默认开启。'
            }
          />
          <DesktopOnlyToggle
            id="setting-check-update"
            label="启动时检查更新（默认关闭）"
            reason={
              isDesktopShell()
                ? '桌面版尚未接入这一项：当前版本不含任何网络请求，也没有更新通道（见 docs/DESKTOP-BUILD.md §6.6）。'
                : '需要桌面版：当前版本不含任何网络请求，没有更新通道。桌面版会提供这个显式开关，默认关。'
            }
          />
          {/* PRD FR-08.1：解锁态下可轮换恢复密钥（怀疑泄露时用）。
              放在「安全」区而不是「数据管理」区：它换的是一把钥匙，不是一份数据。 */}
          <div className="flex flex-col gap-1.5 border-t border-zinc-100 pt-3">
            <Button variant="secondary" onClick={() => setRotateOpen(true)}>
              重新生成恢复密钥
            </Button>
            <p className="text-[11px] leading-4 text-zinc-500">
              怀疑恢复码泄露时换一把新的。需要输入主密码，生成后旧恢复码立即失效，主密码不受影响。
            </p>
          </div>
        </section>

        <RotateRecoveryKeyDialog open={rotateOpen} onClose={() => setRotateOpen(false)} />

        <HotzoneSection
          config={hotzoneConfig}
          onChange={(patch) => void handleHotzoneChange(patch)}
          collapseDelayMs={collapseDelayMs}
          onCollapseDelayChange={(delayMs) => void handleCollapseDelayChange(delayMs)}
          dwellDelayMs={dwellDelayMs}
          onDwellDelayChange={(delayMs) => void handleDwellDelayChange(delayMs)}
        />

        <ShortcutSection
          shortcuts={shortcuts}
          onChange={handleShortcutChange}
          onReset={handleShortcutReset}
          busy={shortcutBusy}
        />

        <AuditLogPanel entries={auditEntries} onClear={() => void handleClearAudit()} />

        <section className="flex flex-col gap-2 rounded-card border border-zinc-200 bg-zinc-50 p-4">
          <h3 className="text-xs font-semibold text-zinc-900">数据说明</h3>
          <p className="text-[11px] leading-5 text-zinc-600">
            当前版本使用内存存储：刷新或关闭页面即清空全部数据，不会写入磁盘。
            Tauri + SQLCipher 接入后才会持久化（见 ADR-010）。
          </p>
          {/* PRD FR-06：设置页展示数据文件路径与"打开所在文件夹"。
              内存存储没有文件路径，也不假装有——路径显示为"未落盘"，
              按钮禁用并说明原因；SQLCipher 落库后同一处自动显示真实路径。 */}
          <div className="flex flex-wrap items-center gap-2" data-testid="storage-location">
            <span className="text-[11px] font-medium text-zinc-700">数据文件</span>
            <code className="rounded bg-white px-2 py-1 text-[11px] text-zinc-600 ring-1 ring-zinc-200">
              {storageLocation?.displayPath ?? '内存存储（未落盘）'}
            </code>
            <Button
              variant="secondary"
              size="sm"
              disabled={storageLocation?.canReveal !== true}
              title={
                storageLocation?.canReveal === true
                  ? '在文件资源管理器中打开数据文件所在文件夹'
                  : '当前为内存存储，没有文件夹可打开；桌面版落盘后可打开'
              }
              onClick={() => {
                if (storageLocation?.canReveal === true) {
                  // Rust 侧抛的是给人看的中文原因（"创建数据目录失败：..."），
                  // 优先透传；只有在拿不到原因时才退回通用文案。
                  void revealStorageFolder().catch((error: unknown) => {
                    toast(
                      typeof error === 'string' && error.length > 0
                        ? error
                        : '打开文件夹失败，请手动前往数据目录',
                    );
                  });
                }
              }}
            >
              打开所在文件夹
            </Button>
          </div>
          {/* PRD FR-06「超过 7 天未备份时轻提示」：这里给出可查的基准，
              提醒文案（锁定前的 toast）才有上下文可对。 */}
          <BackupStatusRow status={backupStatus} />
          {import.meta.env.DEV ? (
            <div>
              <Button variant="secondary" size="sm" loading={busy} onClick={() => void handleSeed()}>
                载入示例数据（仅开发演示）
              </Button>
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-3 rounded-card border border-zinc-200 bg-zinc-50 p-4">
          <h3 className="text-xs font-semibold text-zinc-900">密码体检</h3>
          <p className="text-[11px] leading-5 text-zinc-600">
            检查重复密码、弱密码与长期未修改的卡片。体检只读取密码摘要，不会显示任何密码明文。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" loading={healthBusy} onClick={() => void handleAudit()}>
              开始体检
            </Button>
            {health !== null && !isHealthy(health) ? (
              <Button variant="ghost" size="sm" onClick={() => setHealth(null)}>
                清除结果
              </Button>
            ) : null}
          </div>

          {health !== null ? (
            <div className="flex flex-col gap-3 rounded-card border border-zinc-200 bg-white p-3 text-[11px] text-zinc-600">
              <p>共检查 {health.totalItems} 张卡片。</p>

              {isHealthy(health) ? (
                <p className="text-emerald-700">全部健康：没有重复密码、弱密码或过期密码。</p>
              ) : null}

              {health.duplicates.map((group) => (
                <div key={group.digest} className="flex flex-col gap-1">
                  <p className="font-semibold text-zinc-900">{group.itemIds.length} 张卡片使用同一个密码</p>
                  <ul className="list-disc pl-4">
                    {group.titles.map((title, index) => (
                      <li key={group.itemIds[index]}>{title}</li>
                    ))}
                  </ul>
                </div>
              ))}

              {health.weak.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="font-semibold text-zinc-900">弱密码（{health.weak.length}）</p>
                  <ul className="list-disc pl-4">
                    {health.weak.map((finding) => (
                      <li key={finding.itemId}>
                        {finding.title}
                        <span className="text-zinc-500"> · {finding.detail}</span>
                        {onLocateItem !== undefined ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="ml-1 h-6 px-2 text-[11px]"
                            onClick={() => onLocateItem(finding.title)}
                          >
                            定位
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {health.stale.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="font-semibold text-zinc-900">长期未修改（{health.stale.length}）</p>
                  <ul className="list-disc pl-4">
                    {health.stale.map((finding) => (
                      <li key={finding.itemId}>
                        {finding.title}
                        <span className="text-zinc-500"> · {finding.detail}</span>
                        {onLocateItem !== undefined ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="ml-1 h-6 px-2 text-[11px]"
                            onClick={() => onLocateItem(finding.title)}
                          >
                            定位
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <p className="text-zinc-500">修改密码请在主面板打开对应卡片后编辑。</p>
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-3 rounded-card border border-zinc-200 bg-zinc-50 p-4">
          <h3 className="text-xs font-semibold text-zinc-900">从 CSV 迁移</h3>
          <p className="text-[11px] leading-5 text-zinc-600">
            从浏览器或其它密码管理器导出的 CSV 通常是明文的，导入后请尽快删除源文件。
            预览只显示标题与账号，不会显示密码。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setCsvOpen((v) => !v)}>
              {csvOpen ? '收起 CSV 导入' : '导入 CSV'}
            </Button>
          </div>

          {csvOpen ? (
            <div className="flex flex-col gap-2 rounded-card border border-zinc-200 bg-white p-3">
              <Field label="CSV 文件" htmlFor="settings-csv-file" hint="需要包含「名称 / 账号 / 密码」三列，兼容常见英文与中文表头">
                <input
                  id="settings-csv-file"
                  type="file"
                  accept=".csv,text/csv"
                  className={INPUT_CLASS}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file !== undefined) {
                      void handleCsvFile(file);
                    }
                  }}
                />
              </Field>

              {csvError !== null ? (
                <p role="alert" className="text-[11px] text-red-600">
                  {csvError}
                </p>
              ) : null}

              {csvPreview !== null ? (
                <div className="rounded-card border border-zinc-200 bg-zinc-50 p-3 text-[11px] text-zinc-600">
                  <p>
                    可导入 <span className="font-semibold text-zinc-900">{csvPreview.items.length}</span> 张卡片
                    {csvPreview.skipped.length > 0 ? ` · 跳过 ${csvPreview.skipped.length} 行` : ''}
                  </p>
                  {csvPreview.skipped.length > 0 ? (
                    <ul className="mt-1 list-disc pl-4">
                      {csvPreview.skipped.slice(0, 5).map((item) => (
                        <li key={item.line}>
                          第 {item.line} 行：{item.reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {csvPreview.skipped.length > 5 ? (
                    <p className="mt-1">其余 {csvPreview.skipped.length - 5} 行同样被跳过。</p>
                  ) : null}
                  <p className="mt-1 text-zinc-500">已读取文件内容：{csvText.length} 个字符</p>
                </div>
              ) : null}

              <div className="flex items-center justify-end">
                <Button
                  variant="primary"
                  size="sm"
                  loading={busy}
                  disabled={csvPreview === null || csvPreview.items.length === 0}
                  onClick={() => void handleCsvImport()}
                >
                  导入 {csvPreview?.items.length ?? 0} 张卡片
                </Button>
              </div>
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-3 rounded-card border border-zinc-200 bg-zinc-50 p-4">
          <h3 className="text-xs font-semibold text-zinc-900">备份与恢复</h3>
          <p className="text-[11px] leading-5 text-zinc-600">
            备份文件用备份密码单独加密，需要解锁状态才能导出；导入必须提供同一个备份密码。
          </p>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => { setBackupOpen((v) => !v); setImportOpen(false); }}>
              {backupOpen ? '收起导出' : '导出备份'}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { setImportOpen((v) => !v); setBackupOpen(false); }}>
              {importOpen ? '收起导入' : '导入备份'}
            </Button>
          </div>

          {backupOpen ? (
            <div className="flex flex-col gap-2 rounded-card border border-zinc-200 bg-white p-3">
              <Field
                label="备份密码"
                htmlFor="settings-backup-password"
                hint="与主密码可以不同；忘记它将无法解开这个备份文件"
              >
                <input
                  id="settings-backup-password"
                  type="password"
                  className={INPUT_CLASS}
                  autoComplete="new-password"
                  value={backupPassword}
                  onChange={(event) => setBackupPassword(event.target.value)}
                />
              </Field>
              <div>
                <Button variant="primary" size="sm" loading={busy} onClick={() => void handleExportBackup()}>
                  导出 .kib 文件
                </Button>
              </div>
            </div>
          ) : null}

          {importOpen ? (
            <div className="flex flex-col gap-2 rounded-card border border-zinc-200 bg-white p-3">
              <Field label="备份文件" htmlFor="settings-backup-file" hint="选择 .kib 文件，或直接在下方粘贴内容">
                <input
                  id="settings-backup-file"
                  type="file"
                  accept=".kib,application/json"
                  className={INPUT_CLASS}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file !== undefined) {
                      void handlePickFile(file);
                    }
                  }}
                />
              </Field>
              <Field label="备份文件内容" htmlFor="settings-backup-text">
                <textarea
                  id="settings-backup-text"
                  rows={3}
                  className={`${INPUT_CLASS} font-mono text-[11px]`}
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                  placeholder='{"magic":"KIB1", ...}'
                />
              </Field>
              <Field label="备份密码" htmlFor="settings-import-password">
                <input
                  id="settings-import-password"
                  type="password"
                  className={INPUT_CLASS}
                  autoComplete="new-password"
                  value={backupPassword}
                  onChange={(event) => setBackupPassword(event.target.value)}
                />
              </Field>
              <Field label="恢复方式" htmlFor="settings-import-mode">
                <select
                  id="settings-import-mode"
                  className={INPUT_CLASS}
                  value={importMode}
                  onChange={(event) => setImportMode(event.target.value as BackupMode)}
                >
                  <option value="merge">合并导入（同站点的冲突保留当前版本）</option>
                  <option value="overwrite">覆盖导入（整体替换当前库）</option>
                </select>
              </Field>
              {importMode === 'overwrite' ? (
                <Field
                  label="确认覆盖"
                  htmlFor="settings-import-confirm"
                  hint="当前库的全部卡片会被备份替换，且导入后需要重新解锁"
                >
                  <input
                    id="settings-import-confirm"
                    className={INPUT_CLASS}
                    value={importConfirm}
                    onChange={(event) => setImportConfirm(event.target.value)}
                    placeholder="覆盖"
                  />
                </Field>
              ) : null}
              {importMode === 'overwrite' ? (
                <Field
                  label="当前库主密码"
                  htmlFor="settings-import-master"
                  hint="二次确认：覆盖会替换密钥槽，必须证明你是库的主人"
                >
                  <input
                    id="settings-import-master"
                    type="password"
                    autoComplete="current-password"
                    className={INPUT_CLASS}
                    value={importMaster}
                    onChange={(event) => setImportMaster(event.target.value)}
                  />
                </Field>
              ) : null}
              <div className="flex items-center justify-end">
                <Button variant="primary" size="sm" loading={busy} onClick={() => void handleImportBackup()}>
                  开始导入
                </Button>
              </div>
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-2 rounded-card border border-red-200 bg-red-50 p-4">
          <h3 className="text-xs font-semibold text-red-800">销毁全部数据</h3>
          <p className="text-[11px] leading-5 text-red-700">
            这是唯一的数据销毁途径，删除后无法恢复。请输入主密码并输入「销毁」以确认。
          </p>
          <input
            aria-label="销毁数据主密码"
            type="password"
            autoComplete="current-password"
            className={`${INPUT_CLASS} border-red-200`}
            value={destroyPassword}
            onChange={(event) => setDestroyPassword(event.target.value)}
          />
          <input
            aria-label="确认销毁"
            className={`${INPUT_CLASS} border-red-200`}
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
            placeholder="销毁"
          />
          <div>
            <Button
              variant="danger"
              size="sm"
              loading={busy}
              disabled={confirmText !== '销毁' || destroyPassword.length === 0}
              onClick={() => void handleReset()}
            >
              确认销毁
            </Button>
          </div>
        </section>
      </div>
    </Modal>
  );
}
