/**
 * 窗口级右键菜单（岛形态下的"三个高频动作"）。
 *
 * ## 为什么是新组件，而不是复用 `IslandContextMenu`
 *
 * 岛形态下屏幕上其实有两处右键：
 * 1. **岛面板内部**（`Island` 自己渲染的六项菜单：打开主面板 / 新建卡片 / 设置 /
 *    立即锁定 / 开机自启开关 / 退出）——那份菜单的文案、顺序、禁用语义被 9 个
 *    既有测试逐字锁住，一个字符都不能动；
 * 2. **窗口本身**（岛条、面板外的空白）——原先这里什么都没有，右键只弹浏览器
 *    默认菜单。
 *
 * 本次要补的是第 2 处。按产品决策它只有三项：打开主面板 / 锁定保险库 / 退出密岛。
 * 把它做成独立组件而不是改造第 1 处，好处是**既有契约零风险**：岛内菜单照旧，
 * 窗口菜单是新增的一扇门。两扇门同时打开的问题由 `IslandWindowChrome` 处理
 * （面板已经 `preventDefault` 过的事件不再开窗口菜单）。
 *
 * ## 可用性
 *
 * 三项都是 `<button role="menuitem">`：键盘可达、Esc 关闭、方向键切换，
 * 禁用项必须带 `title` 说明原因（产品原则："不摆假按钮"）。
 */

import { useEffect, useRef, type JSX } from 'react';
import { Lock, PanelTop, Power } from 'lucide-react';

export interface WindowMenuProps {
  open: boolean;
  /** 会话是否已解锁：未解锁时「锁定保险库」置灰（CHG-09）。 */
  unlocked: boolean;
  onClose: () => void;
  /** 还原全形态并聚焦主面板。 */
  onOpenMainPanel: () => void;
  /** 立即锁定（与岛内「立即锁定」、托盘「锁定保险库」同一个前端动作）。 */
  onLock: () => void;
  /** 真正退出进程（前端 `dispose()` 之后）。 */
  onQuit: () => void;
}

const ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[11px] text-white/85 transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none disabled:cursor-not-allowed disabled:text-white/30 disabled:hover:bg-transparent';

/** 窗口级右键菜单。 */
export function WindowMenu({
  open,
  unlocked,
  onClose,
  onOpenMainPanel,
  onLock,
  onQuit,
}: WindowMenuProps): JSX.Element | null {
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 打开时聚焦第一项，让键盘用户直接开始导航。
  useEffect(() => {
    if (!open) {
      return;
    }
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    first?.focus();
  }, [open]);

  // 按下即关（与系统菜单一致）。
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

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="密岛窗口菜单"
      data-testid="window-context-menu"
      onKeyDown={(event) => {
        // Esc / 方向键在菜单内消化：面板上层的 Esc 是"收起岛"，菜单开着时
        // 该键只该关菜单。
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          event.stopPropagation();
          const items = Array.from(
            menuRef.current?.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]:not([disabled])',
            ) ?? [],
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
      className="absolute right-3 top-11 z-30 flex w-40 flex-col gap-0.5 rounded-xl border border-white/10 bg-zinc-900/95 p-1 shadow-island backdrop-blur"
    >
      <button
        type="button"
        role="menuitem"
        className={ITEM_CLASS}
        onClick={() => run(onOpenMainPanel)}
      >
        <PanelTop aria-hidden="true" size={11} />
        打开主面板
      </button>
      <button
        type="button"
        role="menuitem"
        className={ITEM_CLASS}
        disabled={!unlocked}
        title={unlocked ? '立即锁定会话' : '会话已锁定'}
        onClick={() => run(onLock)}
      >
        <Lock aria-hidden="true" size={11} />
        锁定保险库
      </button>
      <div role="separator" className="my-0.5 h-px bg-white/10" />
      <button
        type="button"
        role="menuitem"
        className={ITEM_CLASS}
        onClick={() => run(onQuit)}
      >
        <Power aria-hidden="true" size={11} />
        退出密岛
      </button>
    </div>
  );
}
