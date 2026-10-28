/**
 * 岛形态的窗口层：小窗里那一块「无边框、置顶、半透明」的容器。
 *
 * ## 它负责什么
 *
 * 1. **收起态的一条窄条**：320×44 的窗口里只放得下"密岛 · 已解锁/已锁定"，
 *    点击即展开；左侧留一小段拖拽区（`data-tauri-drag-region`），把窗口拖到
 *    哪儿由用户决定（CHG-10）。
 * 2. **展开态**：直接渲染**完整的** `Island`（搜索 / 最近使用 / 快捷建卡 /
 *    复制 / 生成密码 / 跳转全都在），不另做一套精简版——两份实现必然漂移。
 * 3. **窗口级右键菜单**：三项（打开主面板 / 锁定保险库 / 退出密岛）。
 * 4. **失焦收起**：小窗不像页面有"点外部"可言，窗口失去焦点就该收回去，
 *    否则一个 400×460 的面板会一直悬在桌面最上层。
 *
 * ## 为什么收起态是这里画的、而不是 `Island` 的胶囊
 *
 * `Island` 的表面由它内部的 `revealed` 状态驱动，而 `revealed` 只由"顶部热区
 * 命中"或"键盘唤出入口"打开。岛形态下窗口本身就只有 320×44，屏幕顶部热区
 * 那套语义（鼠标扫过屏幕顶边）已经不存在了，硬套只会得到"鼠标划过窗口顶边
 * 才出现"的怪行为。所以收起态由窗口层自己画一条，展开后把舞台交给 `Island`。
 *
 * 代价：`Island` 在收起态是**卸载**的，它的内部状态（`items`、快捷新建草稿）
 * 每次展开都会重来。这不影响既有能力——搜索词与高亮下标都存在 `ui-store` 里，
 * 最近使用每次展开本来就会重新拉一次。
 */

import { useCallback, useEffect, useState, type JSX, type MouseEvent } from 'react';
import { GripVertical, Lock, Sparkles } from 'lucide-react';
import { useUiStore } from '../../stores/ui-store';
import { shellPort, type ShellPort } from '../../services/window-shell';
import type { SessionStatus } from '../../core/vault/types';
import { Island } from '../island/Island';
import { useQuitViaShell } from './ShellBridge';
import { WindowMenu } from './WindowMenu';

export interface IslandWindowChromeProps {
  status: SessionStatus;
  onLock: () => void;
  /** 锁定态下"去解锁"：把主面板叫回来（岛内不提供验密入口）。 */
  onRequestUnlock: () => void;
  onOpenSettings: () => void;
  /** 端口注入点（默认全局 `shellPort()`；生产代码不传）。 */
  port?: ShellPort;
}

/** 岛形态窗口层。 */
export function IslandWindowChrome({
  status,
  onLock,
  onRequestUnlock,
  onOpenSettings,
  port,
}: IslandWindowChromeProps): JSX.Element {
  const shell = port ?? shellPort();
  const phase = useUiStore((state) => state.island.phase);
  const openIsland = useUiStore((state) => state.openIsland);
  const closeIsland = useUiStore((state) => state.closeIsland);
  const quit = useQuitViaShell(shell);

  const [menuOpen, setMenuOpen] = useState(false);

  const unlocked = status === 'unlocked';
  /** `closing` 仍算展开：收起动画播完之前不换形态，否则动画会被裁掉。 */
  const expanded = phase !== 'collapsed';

  /**
   * 窗口级右键。
   *
   * 两处必须让路：
   * 1. 事件已被面板消化（`Island` 的 `onContextMenu` 会 `preventDefault` 并开
   *    它自己的六项菜单）——此时再开窗口菜单就是两扇门同时打开；
   * 2. DOM 里已经有一份岛内菜单（`island-context-menu`）——同上，只是兜底。
   */
  const handleContextMenu = useCallback((event: MouseEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented) {
      return;
    }
    if (document.querySelector('[data-testid="island-context-menu"]') !== null) {
      return;
    }
    event.preventDefault();
    setMenuOpen(true);
  }, []);

  /** 收起（失焦 / Esc / 展开后想缩回去）。 */
  const collapse = useCallback((): void => {
    setMenuOpen(false);
    if (useUiStore.getState().island.phase !== 'collapsed') {
      closeIsland();
    }
  }, [closeIsland]);

  // 小窗失去焦点就收起：岛形态没有"页面其他位置"可点，失焦是最接近"用户走开了"的信号。
  useEffect(() => {
    const onBlur = (): void => {
      collapse();
    };
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
    };
  }, [collapse]);

  // 收起态：菜单一定不能留着（展开时它属于面板，收起后属于窗口，别串台）。
  useEffect(() => {
    if (!expanded) {
      setMenuOpen(false);
    }
  }, [expanded]);

  const handleOpenMainPanel = useCallback((): void => {
    // 先把岛收起来再还原窗口：否则主面板会带着一个"展开态岛"一起出现。
    collapse();
    void shell.showMain();
  }, [collapse, shell]);

  const handleQuit = useCallback((): void => {
    void quit();
  }, [quit]);

  return (
    <div
      data-testid="island-window"
      data-expanded={expanded ? 'true' : 'false'}
      className="fixed inset-0 z-40 flex flex-col"
      onContextMenu={handleContextMenu}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && menuOpen) {
          event.stopPropagation();
          setMenuOpen(false);
        }
      }}
    >
      {expanded ? (
        /**
         * 展开态：把舞台交给 `Island` 本体。
         *
         * 它是 `fixed` 定位的页面级浮层，会盖住这个小窗口的整个可视区；
         * 视觉上的"铺满小窗"由 `styles/island-window.css` 的
         * `[data-app-mode='island'] [data-testid='island-panel']` 规则完成
         * （前端不改窗口尺寸，尺寸真值在 Rust）。
         */
        <Island
          status={status}
          onLock={onLock}
          onRequestUnlock={onRequestUnlock}
          onOpenSettings={onOpenSettings}
        />
      ) : (
        <div className="flex h-full w-full items-center gap-1.5 rounded-full bg-[linear-gradient(135deg,#1e3a8a_0%,#0b1220_55%,#0b0b0d_100%)] pl-1.5 pr-2 shadow-island">
          {/**
           * 拖拽区。刻意做成一条独立的小把手而不是整条窄条可拖：
           * `data-tauri-drag-region` 会吃掉 mousedown，整条可拖的话"点一下展开"
           * 就永远不会触发。
           */}
          <span
            aria-hidden="true"
            data-tauri-drag-region
            title="拖动可移动岛的位置"
            className="flex h-8 w-4 shrink-0 cursor-grab items-center justify-center rounded-full text-white/25 hover:text-white/50"
          >
            <GripVertical size={11} />
          </span>

          <button
            type="button"
            aria-label="展开密岛"
            data-testid="island-window-bar"
            onClick={() => {
              if (!unlocked) {
                // 锁定态不在岛上验密（PRD Q1 的默认结论）：只把人引到主面板。
                onRequestUnlock();
                return;
              }
              openIsland();
            }}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-full px-1 py-1.5 text-[11px] font-medium text-white transition-transform hover:scale-[1.01] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/15">
              {unlocked ? (
                <Sparkles aria-hidden="true" size={9} />
              ) : (
                <Lock aria-hidden="true" size={9} />
              )}
            </span>
            <span className="shrink-0">密岛</span>
            <span aria-hidden="true" className="text-white/40">
              ·
            </span>
            <span
              data-testid="island-window-status"
              className={`truncate ${unlocked ? 'text-emerald-300' : 'text-amber-300'}`}
            >
              {unlocked ? '已解锁' : status === 'cooling_down' ? '冷却中' : '已锁定'}
            </span>
          </button>
        </div>
      )}

      <WindowMenu
        open={menuOpen}
        unlocked={unlocked}
        onClose={() => setMenuOpen(false)}
        onOpenMainPanel={handleOpenMainPanel}
        onLock={onLock}
        onQuit={handleQuit}
      />
    </div>
  );
}
