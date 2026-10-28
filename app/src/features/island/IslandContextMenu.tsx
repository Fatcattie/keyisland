/**
 * 灵动岛右键菜单（PRD FR-02：「右键菜单（类输入法）：打开主面板 / 新建卡片 /
 * 设置 / 立即锁定 / 开机自启开关 / 退出」）。
 *
 * 两个设计约束：
 * 1. **不能只有右键**：纯鼠标入口把键盘与读屏用户挡在门外。岛头部同时提供
 *    「菜单」按钮打开同一份菜单，条目均为真实 `<button role="menuitem">`，
 *    Esc 关闭并把焦点还给触发者。
 * 2. **Tauri 依赖项由桌面壳真正接线**：开机自启写 HKCU 的 Run 键，退出走
 *    `dispose() → shell_quit`。Web 预览没有注册表/进程可操作，由 `nativeAvailable`
 *    与 `onQuit` 如实禁用并说明——不再出现"能点但没反应"的按钮。
 *    「打开主面板」在桌面壳里是 `shell.showMain()`（还原全形态），Web 下退回
 *    聚焦搜索框。
 */

import { useEffect, useRef, type JSX } from 'react';
import { MoreHorizontal, Power, Rocket } from 'lucide-react';

/** 菜单属性。 */
export interface IslandContextMenuProps {
  open: boolean;
  /** 会话是否已解锁：新建/设置/立即锁定都需要解锁态。 */
  unlocked: boolean;
  onClose: () => void;
  onOpenMainPanel: () => void;
  onCreate: () => void;
  onOpenSettings: () => void;
  onLock: () => void;
  /** 桌面壳是否提供原生能力（开机自启 / 退出）。Web 预览为 false。 */
  nativeAvailable: boolean;
  /** 开机自启当前状态；`null` = 未知（读失败），按"未开"渲染但不谎报。 */
  autostartEnabled: boolean | null;
  onToggleAutostart: () => void;
  /** 未提供时「退出」保持禁用——Web 预览没有进程可退。 */
  onQuit?: () => void;
}

/** 触发按钮（键盘可达的菜单入口）。 */
export function IslandMenuTrigger({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      aria-label="菜单"
      aria-haspopup="menu"
      data-testid="island-menu-trigger"
      onClick={onClick}
      className="flex items-center rounded-full bg-white/10 px-2 py-1 text-white/80 transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
    >
      <MoreHorizontal aria-hidden="true" size={12} />
    </button>
  );
}

/** 菜单本体。 */
export function IslandContextMenu({
  open,
  unlocked,
  onClose,
  onOpenMainPanel,
  onCreate,
  onOpenSettings,
  onLock,
  nativeAvailable,
  autostartEnabled,
  onToggleAutostart,
  onQuit,
}: IslandContextMenuProps): JSX.Element | null {
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 打开时聚焦第一项，让键盘用户直接开始导航。
  useEffect(() => {
    if (!open) {
      return;
    }
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    first?.focus();
  }, [open]);

  // 点击菜单之外关闭。用 mousedown 而非 click：按下即关，与系统菜单一致。
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent): void => {
      const node = menuRef.current;
      if (node !== null && event.target instanceof Node && !node.contains(event.target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  /** 统一收口：执行动作后一律关菜单。 */
  const run = (action: () => void): void => {
    action();
    onClose();
  };

  const itemClass =
    'flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[11px] text-white/85 transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none disabled:cursor-not-allowed disabled:text-white/30 disabled:hover:bg-transparent';

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="密岛菜单"
      data-testid="island-context-menu"
      onKeyDown={(event) => {
        // Esc 与方向键在菜单内消化，不能冒泡到岛面板——岛的 Esc 是收起整个岛，
        // 菜单开着时该键只该关菜单。
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          event.stopPropagation();
          const items = Array.from(
            menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [],
          );
          if (items.length === 0) {
            return;
          }
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          const next = items[(current + delta + items.length) % items.length];
          next?.focus();
        }
      }}
      className="absolute right-4 top-12 z-10 flex w-44 flex-col gap-0.5 rounded-xl border border-white/10 bg-zinc-900/95 p-1 shadow-island backdrop-blur"
    >
      <button type="button" role="menuitem" className={itemClass} onClick={() => run(onOpenMainPanel)}>
        打开主面板
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        disabled={!unlocked}
        title={unlocked ? undefined : '解锁后可用'}
        onClick={() => run(onCreate)}
      >
        新建卡片
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        disabled={!unlocked}
        title={unlocked ? undefined : '解锁后可用'}
        onClick={() => run(onOpenSettings)}
      >
        设置
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        disabled={!unlocked}
        title={unlocked ? '立即锁定会话' : '会话已锁定'}
        onClick={() => run(onLock)}
      >
        立即锁定
      </button>
      <div role="separator" className="my-0.5 h-px bg-white/10" />
      {/**
       * 开机自启：桌面壳里是真实开关（写 HKCU Run）；Web 预览没有注册表可写，
       * 如实禁用并说明，而不是摆一个点了没反应的按钮。
       */}
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        disabled={!nativeAvailable}
        title={
          nativeAvailable
            ? autostartEnabled === true
              ? '已开启，点击关闭'
              : '已关闭，点击开启'
            : '仅桌面版可用'
        }
        onClick={() => run(onToggleAutostart)}
      >
        <Rocket aria-hidden="true" size={11} />
        {autostartEnabled === true ? '开机自启：已开' : '开机自启：已关'}
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        disabled={onQuit === undefined}
        title={onQuit === undefined ? '仅桌面版可用' : '退出密岛（先清空剪贴板）'}
        onClick={() => {
          if (onQuit !== undefined) {
            run(onQuit);
          }
        }}
      >
        <Power aria-hidden="true" size={11} />
        退出
      </button>
    </div>
  );
}
