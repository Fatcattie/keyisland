/**
 * 跳转目标二选一菜单（PRD FR-07.1）。
 *
 * 卡片与灵动岛**共用这一份**：菜单项、定位方式、Esc 行为必须一致，否则同一个
 * 功能在两个地方手感不同，而用户没有任何理由理解这个差异。
 *
 * PRD 原文：「仅配置一个目标时直接跳转；**两者都配置时弹出二选一菜单**；
 * 未配置时按钮置灰」。
 *
 * 为什么用 portal + fixed 定位而不是简单的 `absolute`：
 * 卡片容器带 `overflow-hidden`（圆角 + 倾斜动效需要），`absolute` 菜单会被卡片
 * 边界裁掉，只能看见一条边。portal 到 body 再按锚点的 `getBoundingClientRect()`
 * 定位，才是"菜单浮在卡片之上"的正确做法。
 *
 * `anchorRef` 收 `HTMLElement` 而不是 `HTMLButtonElement`：灵动岛的锚点是列表行
 * （`<li role="option">`），不是按钮。
 *
 * Web 阶段「启动本地应用」不可执行（没有 ShellExecute），按既有诚实模式**置灰
 * 并说明原因**，而不是点了没反应或假装启动了。Tauri 接入后只需去掉 disabled。
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Monitor } from 'lucide-react';

export interface ItemJumpMenuProps {
  open: boolean;
  /** 触发元素，用于定位菜单与判定"点的是触发器不是外部"。 */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onOpenUrl: () => void;
  onLaunchApp: () => void;
}

/** 菜单项通用样式。 */
const ITEM_CLASS =
  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-700 ' +
  'transition-colors hover:bg-zinc-100 focus-visible:bg-zinc-100 focus-visible:outline-none ' +
  'disabled:cursor-not-allowed disabled:text-zinc-300 disabled:hover:bg-transparent';

interface Position {
  top: number;
  right: number;
}

/** 跳转目标二选一菜单。 */
export function ItemJumpMenu({
  open,
  anchorRef,
  onClose,
  onOpenUrl,
  onLaunchApp,
}: ItemJumpMenuProps): JSX.Element | null {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<Position>({ top: 0, right: 0 });

  // 定位：贴着触发按钮的右下角，右对齐。
  useEffect(() => {
    if (!open || anchorRef.current === null) {
      return;
    }
    const rect = anchorRef.current.getBoundingClientRect();
    setPosition({
      top: rect.bottom + 4,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, [open, anchorRef]);

  // 打开时把焦点交给第一项：键盘用户按下 Enter 就该能直接选，不必再 Tab。
  useEffect(() => {
    if (!open) {
      return;
    }
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
    first?.focus();
  }, [open]);

  // 点外部关闭。必须把触发按钮排除掉：否则 mousedown 先关、随后的 click 又开，
  // 用户看到的是"菜单关不掉"。
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (menuRef.current?.contains(target) === true) {
        return;
      }
      if (anchorRef.current?.contains(target) === true) {
        return;
      }
      onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, onClose, anchorRef]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="选择跳转目标"
      data-testid="item-jump-menu"
      style={{ position: 'fixed', top: position.top, right: position.right }}
      className="z-50 w-44 overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          // 只关菜单，不要把 Esc 冒泡给主面板（否则会顺带退出选择模式 / 关详情页）。
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <button type="button" role="menuitem" className={ITEM_CLASS} onClick={onOpenUrl}>
        <ExternalLink aria-hidden="true" size={13} />
        在浏览器打开
      </button>
      <button
        type="button"
        role="menuitem"
        className={ITEM_CLASS}
        disabled
        title="需要桌面版：Web 阶段不执行本地路径 / URI scheme"
        onClick={onLaunchApp}
      >
        <Monitor aria-hidden="true" size={13} />
        启动本地应用
      </button>
    </div>,
    document.body,
  );
}
