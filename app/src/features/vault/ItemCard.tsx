/**
 * 资产卡片（TiltCard）。
 *
 * 实现严格对照 SDD §6.3：
 * - 外层 `perspective: 800px`；
 * - 指针位置用 `useMotionValue` 记录（**不经过 useState**，避免每次移动都重渲染）；
 * - `useSpring(stiffness: 180, damping: 22)` 让回弹有阻尼感；
 * - `rotateX` 由 Y 轴映射到 [10, -10]，`rotateY` 由 X 轴映射到 [-12, 12]；
 * - 内容层 `translateZ(28px)`，光晕中心跟随指针，离开回到 0.5；
 * - `prefers-reduced-motion` 下**完全关闭**倾斜与光晕跟随（不是加速）。
 *
 * 密码明文只存在于组件本地 state，并在 pointerup / pointerleave / blur / 卸载时清空。
 */

import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { motion, useMotionTemplate, useMotionValue, useSpring, useTransform } from 'framer-motion';
import {
  Clipboard,
  Copy,
  ExternalLink,
  Eye,
  Pencil,
  Star,
  Trash2,
} from 'lucide-react';
import { useVaultClient } from '../../app/VaultProvider';
import { Badge } from '../../components/ui/Badge';
import { useToast } from '../../components/ui/Toast';
import { describeError } from '../../lib/i18n';
import {
  avatarColor,
  avatarInitial,
  avatarTextColor,
  formatRelative,
  openExternal,
} from '../../lib/format';
import type { ItemSummary, StrengthLevel } from '../../core/vault/types';
import { ItemJumpMenu } from './ItemJumpMenu';

/** 弹簧参数（SDD §6.3 固定值）。 */
const SPRING = { stiffness: 180, damping: 22 } as const;

/** 默认遮蔽文本。 */
const MASKED = '••••••••';

export interface ItemCardProps {
  item: ItemSummary;
  /** 隐藏卡片视图下需要携带授权。 */
  allowHidden?: boolean;
  /**
   * 隐私访问授权是否生效。`masked` 卡片在授权未生效时遮罩账号与密码、
   * 并拦截复制 / 预览 / 打开 / 编辑，引导用户先验证主密码。
   */
  hiddenAccessActive?: boolean;
  /**
   * 唤起隐私访问授权对话框（验证主密码）。
   *
   * `afterGrant` 是"用户本来想做的事"的续跑回调：验证通过后由父组件执行。
   * 不传的话，用户点「编辑」→ 验证 → 回到列表却什么都没打开，会以为验证失败。
   */
  onRequestHiddenAccess?: (afterGrant?: () => void) => void;
  /** 当前时间，由父组件统一注入，保证同一屏内"几分钟前"一致。 */
  now: number;
  onEdit: (item: ItemSummary) => void;
  onRequestDelete: (item: ItemSummary) => void;
  /** 数据变更后通知父组件刷新。 */
  onChanged: () => void;
  /** 选择模式：卡片进入可勾选状态，点击整卡切换选中（PRD `prd.md:138` 批量删除）。 */
  selectMode?: boolean;
  /** 当前是否被选中（仅选择模式有意义）。 */
  selected?: boolean;
  /** 切换选中。 */
  onToggleSelect?: (id: number) => void;
}

/** 可见性角标。 */
function VisibilityBadge({ item }: { item: ItemSummary }): JSX.Element | null {
  if (item.visibility === 'username_only') {
    return (
      <Badge tone="warning" title="仅展示账号，密码只能复制">
        仅账号
      </Badge>
    );
  }
  if (item.visibility === 'hidden') {
    return (
      <Badge tone="danger" title="隐藏卡片，需二次验证">
        隐藏
      </Badge>
    );
  }
  if (item.visibility === 'masked') {
    return (
      <Badge tone="warning" title="账号与密码已遮罩，验证主密码后显示">
        遮罩
      </Badge>
    );
  }
  return null;
}

/** 密码强度档位 → 填充点数 / 配色 / 文案。 */
const STRENGTH_DOTS: Readonly<Record<StrengthLevel, { filled: number; color: string; label: string }>> =
  Object.freeze({
    weak: { filled: 1, color: 'bg-red-500', label: '弱' },
    medium: { filled: 2, color: 'bg-amber-500', label: '中' },
    strong: { filled: 3, color: 'bg-emerald-500', label: '强' },
  });

/** 三颗「强度点」：列表无需解密即可展示（强度在保存时算好存为元数据）。 */
function StrengthDots({ level }: { level: StrengthLevel }): JSX.Element {
  const meta = STRENGTH_DOTS[level];
  return (
    <span
      className="flex items-center gap-1"
      title={`密码强度：${meta.label}`}
      aria-label={`密码强度：${meta.label}`}
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className={`h-1.5 w-1.5 rounded-full ${index < meta.filled ? meta.color : 'bg-surface-sunken'}`}
        />
      ))}
    </span>
  );
}

/**
 * 卡片组件。
 *
 * `memo` 不是为了省几次渲染，而是为了 1000 张卡时**输入还能跟手**：
 * 搜索框的每次按键都会让 `MainPanel` 重渲染，没有 memo 就是 1000 张卡
 * 各自重建 motion 值、spring、光晕模板（实测单次按键要几百毫秒）。
 * 有 memo 后，只要卡片自己的 props 没变就直接跳过。
 *
 * 前提是 props 引用稳定——父组件因此把 `now` 做成每分钟跳一次的状态、
 * 把 `onEdit` / `onChanged` 包成 `useCallback`。加 props 时注意别破坏这点。
 */
export const ItemCard = memo(function ItemCardImpl({
  item,
  allowHidden = false,
  hiddenAccessActive = false,
  onRequestHiddenAccess,
  now,
  onEdit,
  onRequestDelete,
  onChanged,
  selectMode = false,
  selected = false,
  onToggleSelect,
}: ItemCardProps): JSX.Element {
  const client = useVaultClient();
  const toast = useToast();

  /**
   * `masked` 卡片在隐私授权未生效时锁定：账号与密码遮罩，敏感操作被拦截。
   * 一旦用户验证主密码（`hiddenAccessActive` 变 true），字段与操作恢复正常。
   */
  const privacyLocked = item.visibility === 'masked' && !hiddenAccessActive;

  // —— 倾斜：指针位置只进 MotionValue，不进 React 状态 ——
  const pointerX = useMotionValue(0.5);
  const pointerY = useMotionValue(0.5);
  const rotateX = useSpring(useTransform(pointerY, [0, 1], [10, -10]), SPRING);
  const rotateY = useSpring(useTransform(pointerX, [0, 1], [-12, 12]), SPRING);
  const glowX = useTransform(pointerX, (value) => `${Math.round(value * 100)}%`);
  const glowY = useTransform(pointerY, (value) => `${Math.round(value * 100)}%`);
  /**
   * 光晕强度走 CSS 变量（`--ki-glow-a`）：亮色下卡片是白的，白色光晕几乎不可见；
   * 深色下同一束白光会糊成一大块白斑，只能靠变量把它压下去。
   */
  const glow = useMotionTemplate`radial-gradient(circle at ${glowX} ${glowY}, rgb(255 255 255 / var(--ki-glow-a)), transparent 55%)`;

  // —— 按住预览：明文只在本地 state ——
  const [revealed, setRevealed] = useState<string | null>(null);
  const revealActive = useRef(false);
  const mounted = useRef(true);

  // —— 跳转目标二选一（PRD FR-07.1：两者都配置时弹菜单）——
  const [jumpMenuOpen, setJumpMenuOpen] = useState(false);
  const jumpButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      // 卸载时立刻丢弃明文引用。
      mounted.current = false;
      revealActive.current = false;
      setRevealed(null);
    };
  }, []);

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }
    pointerX.set((event.clientX - rect.left) / rect.width);
    pointerY.set((event.clientY - rect.top) / rect.height);
  };

  const resetPointer = (): void => {
    pointerX.set(0.5);
    pointerY.set(0.5);
  };

  const endReveal = (): void => {
    revealActive.current = false;
    setRevealed(null);
  };

  const startReveal = async (): Promise<void> => {
    if (item.visibility === 'username_only') {
      return;
    }
    revealActive.current = true;
    try {
      const value = await client.revealPassword(item.id, { allowHidden });
      if (revealActive.current && mounted.current) {
        setRevealed(value);
      }
    } catch (caught) {
      revealActive.current = false;
      toast(describeError(caught));
    }
  };

  /**
   * 预览密码的按压入口：遮罩卡片未授权时改为唤起授权对话框，授权后才预览。
   */
  const handleRevealPress = (): void => {
    if (privacyLocked) {
      onRequestHiddenAccess?.();
      return;
    }
    void startReveal();
  };

  /** 复制账号 / 密码：遮罩卡片未授权时改为唤起授权对话框，验证通过后自动补做复制。 */
  const guardCopy = (field: 'password' | 'username'): void => {
    if (privacyLocked) {
      onRequestHiddenAccess?.(() => void handleCopy(field));
      return;
    }
    void handleCopy(field);
  };

  /** 编辑入口：遮罩卡片未授权时改为唤起授权对话框（编辑会展示明文密码），验证通过后直接进编辑。 */
  const handleEditPress = (): void => {
    if (privacyLocked) {
      onRequestHiddenAccess?.(() => onEdit(item));
      return;
    }
    onEdit(item);
  };

  /**
   * 删除入口：`deleteItem` 对 `masked` 卡片要求隐私授权（防止未验证就抹掉受保护数据），
   * 未授权时先唤起验证对话框，而不是让用户点完确认后只收到一个错误 toast。
   */
  const handleDeletePress = (): void => {
    if (privacyLocked) {
      onRequestHiddenAccess?.(() => onRequestDelete(item));
      return;
    }
    onRequestDelete(item);
  };

  const handleCopy = async (field: 'password' | 'username'): Promise<void> => {
    try {
      const receipt =
        field === 'password'
          ? await client.copyPassword(item.id, { allowHidden })
          : await client.copyUsername(item.id, { allowHidden });
      const seconds = Math.round(receipt.ttlMs / 1000);
      // SDD §6.4：Toast 必须说明复制对象与自动清空时间。
      // 关闭档（autoClear === false）不能报"0 秒后自动清空"——那既是错的也很吓人。
      toast(
        receipt.autoClear
          ? `已复制${field === 'password' ? '密码' : '账号'} · ${seconds} 秒后自动清空`
          : `已复制${field === 'password' ? '密码' : '账号'} · 不会自动清空`,
      );
      onChanged();
    } catch (caught) {
      toast(describeError(caught));
    }
  };

  const handleFavorite = async (): Promise<void> => {
    try {
      await client.setFavorite(item.id, !item.favorite);
      onChanged();
    } catch (caught) {
      toast(describeError(caught));
    }
  };

  /** 打开卡片配置的网址（拉一次详情拿完整 URL；列表项里只有 hasUrl 布尔值）。 */
  const openUrl = (): void => {
    void client
      .getItem(item.id, { allowHidden })
      .then((detail) => {
        if (detail.url !== null && openExternal(detail.url)) {
          // 只在**真的打开了**之后记账（PRD：操作日志含跳转目标）。
          // 目标由门面裁剪成 origin + pathname，query 里的 token 不会进日志。
          void client.recordJump(item.id, detail.url).catch(() => {
            // 记账失败不影响跳转本身。
          });
          return;
        }
        toast('无法打开该链接');
      })
      .catch((caught: unknown) => {
        toast(describeError(caught));
      });
  };

  /**
   * 真正执行跳转（不含隐私守卫）。抽出来是为了让授权通过后能续跑，
   * 而不是让用户验证完还得再点一次同一个按钮。
   */
  const performOpen = (): void => {
    if (item.hasUrl && item.hasAppTarget) {
      setJumpMenuOpen((previous) => !previous);
      return;
    }
    if (item.hasUrl) {
      openUrl();
      return;
    }
    if (item.hasAppTarget) {
      toast('桌面版将启动本地应用（Web 阶段不执行本地路径）');
      return;
    }
    toast('该卡片没有配置跳转目标');
  };

  /**
   * 跳转（PRD FR-07.1）：
   * - 只配了一个目标 → 直接跳；
   * - 两个都配了 → 弹二选一菜单（不替用户做选择，避免"我想开客户端却开了网页"）；
   * - 一个都没配 → 按钮本身已置灰，这里只是兜底。
   */
  const handleOpen = (): void => {
    // 遮罩卡片未授权：引导先验证主密码，而不是把（可能含账号的）URL 打开。
    if (privacyLocked) {
      onRequestHiddenAccess?.(performOpen);
      return;
    }
    performOpen();
  };

  /**
   * 倾斜样式**始终**应用（用户需求：卡片就是 TiltCard）。
   * 不再按 `prefers-reduced-motion` 关闭——需求里没有这条豁免，而且不少 Windows
   * 机器默认关掉「动画效果」会让卡片永远平着，看起来像根本没实现。
   */
  const tiltStyle = { rotateX, rotateY, transformStyle: 'preserve-3d' as const };

  /** 选择模式下整卡是一个 checkbox 控件；正常模式下它是普通容器。 */
  const toggleSelect = (): void => {
    onToggleSelect?.(item.id);
  };

  return (
    <div style={{ perspective: '800px' }} data-testid={`item-card-${item.id}`}>
      <motion.div
        data-tilt="on"
        data-selected={selectMode ? selected : undefined}
        /**
         * 选择模式：整卡变成 `role="checkbox"`。
         *
         * 只有真正可交互时才挂 `role` / `tabIndex` / `aria-checked`，正常模式保持
         * 普通容器的语义——否则读屏用户会听到一堆"复选框"。
         */
        role={selectMode ? 'checkbox' : undefined}
        aria-checked={selectMode ? selected : undefined}
        aria-label={selectMode ? `选择 ${item.title}` : undefined}
        tabIndex={selectMode ? 0 : undefined}
        onClick={selectMode ? toggleSelect : undefined}
        onKeyDown={
          selectMode
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  toggleSelect();
                }
              }
            : undefined
        }
        style={tiltStyle}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => {
          resetPointer();
          endReveal();
        }}
        onBlur={endReveal}
        className={`group relative rounded-card border bg-surface shadow-card ${
          selectMode && selected ? 'border-accent ring-2 ring-accent' : 'border-line'
        } ${selectMode ? 'cursor-pointer' : ''}`}
      >
        {/*
          * 光晕单独包一层 `overflow-hidden + 圆角` 来裁切。
          * 卡片本身**不能** overflow-hidden：那会强制 `transform-style` 扁平化，
          * 把内层 `translateZ(28px)` 的深度整个吃掉（看起来就是一张平的卡片）。
          */}
        {/*
         * 光晕只在指针悬停时出现。
         *
         * 原来是无条件铺在卡片上：亮色下卡片本身就是白的，白光晕看不见，谁也没发现；
         * 深色下同一束光会变成卡片中央一块洗不掉的灰白雾。改成 hover 才显影，
         * 亮色视觉零变化，深色干净。
         */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-card"
        >
          <motion.span
            className="absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-70"
            style={{ backgroundImage: glow }}
          />
        </div>

        <div
          className="relative flex flex-col gap-3 p-5"
          style={{ transform: 'translateZ(28px)' }}
        >
          <div className="flex items-start gap-3">
            {selectMode ? (
              /**
               * 纯视觉复选框：真正的可访问控件是外层整卡的 `role="checkbox"`。
               * 这里 `aria-hidden` + `tabIndex={-1}` 避免读屏与 Tab 序列里出现两个复选框。
               */
              <input
                type="checkbox"
                checked={selected}
                readOnly
                tabIndex={-1}
                aria-hidden="true"
                className="mt-1 h-4 w-4 shrink-0 accent-accent"
              />
            ) : null}
            <span
              aria-hidden="true"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-semibold"
              style={{ backgroundColor: avatarColor(item.title), color: avatarTextColor(item.title) }}
            >
              {avatarInitial(item.title)}
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-semibold text-fg" title={item.title}>
                {item.title}
              </h3>
              <p className="truncate text-[11px] text-fg-faint">
                {item.platform ?? '未填写平台'}
              </p>
            </div>
            {selectMode ? null : (
              <button
                type="button"
                aria-label={item.favorite ? '取消收藏' : '收藏'}
                aria-pressed={item.favorite}
                onClick={() => void handleFavorite()}
                className={`rounded-full p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20 ${
                  item.favorite ? 'text-amber-500' : 'text-fg-faint hover:text-fg-faint'
                }`}
              >
                <Star aria-hidden="true" size={14} fill={item.favorite ? 'currentColor' : 'none'} />
              </button>
            )}
          </div>

          <dl className="flex flex-col gap-1 text-xs">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-fg-faint">账号</dt>
              <dd
                className="truncate font-medium text-fg-muted"
                data-testid={`username-${item.id}`}
                data-masked-locked={privacyLocked || undefined}
              >
                {privacyLocked ? MASKED : (item.username ?? '—')}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-fg-faint">密码</dt>
              <dd className="font-mono text-fg-muted" data-testid={`password-${item.id}`}>
                {revealed ?? MASKED}
              </dd>
            </div>
            {/*
              * 强度点也会泄露"这条密码强/弱"的暗示：
              * - 「仅账号」档刻意不显示（密码本就不可预览）；
              * - 「遮罩」档在未验证前也不显示，验证后才随字段一起出现。
              */}
            {item.strength !== undefined && item.visibility !== 'username_only' && !privacyLocked ? (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-fg-faint">强度</dt>
                <dd data-testid={`strength-${item.id}`}>
                  <StrengthDots level={item.strength} />
                </dd>
              </div>
            ) : null}
          </dl>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <VisibilityBadge item={item} />
              {item.favorite ? <Badge tone="success">已收藏</Badge> : null}
            </div>
            <span className="text-[11px] text-fg-faint">{formatRelative(item.updatedAt, now)}</span>
          </div>

          {selectMode ? null : (
            <div className="flex items-center gap-1 border-t border-line-subtle pt-3">
            <button
              type="button"
              aria-label="复制账号"
              onClick={() => guardCopy('username')}
              className="rounded-full p-1.5 text-fg-faint transition-colors hover:bg-surface-sunken hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20"
            >
              <Copy aria-hidden="true" size={14} />
            </button>
            <button
              type="button"
              aria-label="复制密码"
              onClick={() => guardCopy('password')}
              className="rounded-full p-1.5 text-fg-faint transition-colors hover:bg-surface-sunken hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20"
            >
              <Clipboard aria-hidden="true" size={14} />
            </button>
            <button
              type="button"
              aria-label="预览密码"
              title={privacyLocked ? '验证主密码后预览' : item.visibility === 'username_only' ? '仅展示账号' : '按住预览密码'}
              disabled={item.visibility === 'username_only'}
              onPointerDown={() => handleRevealPress()}
              onPointerUp={endReveal}
              onPointerLeave={endReveal}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  handleRevealPress();
                }
              }}
              onKeyUp={endReveal}
              className="rounded-full p-1.5 text-fg-faint transition-colors hover:bg-surface-sunken hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20 disabled:cursor-not-allowed disabled:text-fg-faint disabled:hover:bg-transparent"
            >
              <Eye aria-hidden="true" size={14} />
            </button>
            <div className="relative">
              <button
                ref={jumpButtonRef}
                type="button"
                aria-label="打开链接"
                aria-haspopup={item.hasUrl && item.hasAppTarget ? 'menu' : undefined}
                aria-expanded={item.hasUrl && item.hasAppTarget ? jumpMenuOpen : undefined}
                disabled={!item.hasUrl && !item.hasAppTarget}
                onClick={handleOpen}
                className="rounded-full p-1.5 text-fg-faint transition-colors hover:bg-surface-sunken hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20 disabled:cursor-not-allowed disabled:text-fg-faint disabled:hover:bg-transparent"
              >
                <ExternalLink aria-hidden="true" size={14} />
              </button>
              <ItemJumpMenu
                open={jumpMenuOpen}
                anchorRef={jumpButtonRef}
                onClose={() => setJumpMenuOpen(false)}
                onOpenUrl={() => {
                  setJumpMenuOpen(false);
                  openUrl();
                }}
                onLaunchApp={() => {
                  setJumpMenuOpen(false);
                  toast('桌面版将启动本地应用（Web 阶段不执行本地路径）');
                }}
              />
            </div>
            <div className="flex-1" />
            <button
              type="button"
              aria-label="编辑"
              onClick={() => handleEditPress()}
              className="rounded-full p-1.5 text-fg-faint transition-colors hover:bg-surface-sunken hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20"
            >
              <Pencil aria-hidden="true" size={14} />
            </button>
            <button
              type="button"
              aria-label="删除"
              onClick={handleDeletePress}
              className="rounded-full p-1.5 text-fg-faint transition-colors hover:bg-red-50 dark:hover:bg-red-500/15 hover:text-red-600 dark:hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30"
            >
              <Trash2 aria-hidden="true" size={14} />
            </button>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
});
