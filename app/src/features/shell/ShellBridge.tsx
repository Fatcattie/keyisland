/**
 * 桌面壳 ↔ 前端的唯一桥。
 *
 * ## 职责（都是"副作用"，不渲染任何东西）
 *
 * 1. 挂载时读一次形态（`shell_mode`），之后订阅 `shell://mode`；
 * 2. 把形态写进 `ui-store.appMode`，并同步到 `<html data-app-mode>` —— 这是
 *    **唯一**的形态 CSS 锚点（组件内不得用 `appMode === 'island'` 写内联样式）；
 * 3. 会话状态单向推给 Rust（供托盘置灰/文案），按值去重；
 * 4. 岛面相位单向推给 Rust（供窗口缩放），**`closing` 仍算展开**；
 * 5. 收到 `shell://quit-requested` → 先 `dispose()` 再 `shell_quit`；
 * 6. 首次"关闭到托盘"的轻提示（CHG-11）。
 *
 * ## 为什么会话状态从 store 读、而不是自己再调一次 `client.status()`
 *
 * `ui-store.session.status` 的唯一写入者是 `SessionGate`（每次拿到新 snapshot 就写）。
 * 桥这里再读一次会话，会额外触发一次**惰性落锁判定**——多一个写状态的地方，
 * 就多一处会和真值不一致的地方。所以这里只订阅、不重复读。
 *
 * ## 托盘「锁定保险库」为什么不在这里处理
 *
 * 锁定要把结果写回 `SessionGate` 的 `snapshot`（决定显示解锁屏还是主面板），
 * 而那份状态在 `SessionGate` 里。锁定请求由 `SessionGate` 自己订阅处理，
 * 桥只管窗口形态与退出——两边各管一件事，谁都不会去猜对方的内部状态。
 */

import { useCallback, useEffect, useRef } from 'react';
import { useVaultClient } from '../../app/VaultProvider';
import { useToast } from '../../components/ui/Toast';
import { phaseWantsExpandedWindow } from '../../lib/window-geometry';
import { useUiStore } from '../../stores/ui-store';
import { mapToMirror, shellPort, type ShellModeEvent, type ShellPort } from '../../services/window-shell';

/** 首次"关闭到托盘"的提示文案（CHG-11）。 */
export const CLOSE_HINT_MESSAGE = '密岛已收进托盘，灵动岛仍可使用。彻底退出：托盘或岛右键 → 退出';

export interface ShellBridgeProps {
  /**
   * 端口注入点（默认用全局 `shellPort()`）。
   *
   * 存在的理由：单测里需要断言"到底 invoke 了什么、调用顺序如何"，
   * 而真实端口只在 Tauri 壳里可用。生产代码永远不传这个 prop。
   */
  port?: ShellPort;
}

/**
 * 把形态落到 store 与 DOM。
 *
 * 进入岛形态时**强制把岛面收回 collapsed**：用户在展开预览条的状态下关掉主面板，
 * Rust 会立刻把窗口缩成 320×44，若前端还停在 `expanded`，岛面板会被塞进一个
 * 44px 高的窗口里——只剩一条被裁掉的边。
 */
function applyMode(event: ShellModeEvent): void {
  const store = useUiStore.getState();
  store.setAppMode(event.mode);
  if (event.mode === 'island' && !event.expanded && store.island.phase !== 'collapsed') {
    store.finishClosing();
  }
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.appMode = event.mode;
  }
}

/** 外壳桥。渲染 `null`。 */
export function ShellBridge({ port }: ShellBridgeProps = {}): null {
  const client = useVaultClient();
  const toast = useToast();
  const sessionStatus = useUiStore((state) => state.session.status);
  const phase = useUiStore((state) => state.island.phase);
  const appMode = useUiStore((state) => state.appMode);

  /** 端口只解析一次：每次渲染都 `createShellPort()` 会重复订阅。 */
  const shellRef = useRef<ShellPort | null>(null);
  if (shellRef.current === null) {
    shellRef.current = port ?? shellPort();
  }
  const shell = shellRef.current;

  /** 上一次推给 Rust 的会话镜像（按值去重）。 */
  const pushedSessionRef = useRef<string | null>(null);
  /** 上一次推给 Rust 的展开状态（按值去重）。 */
  const pushedExpandedRef = useRef<boolean | null>(null);

  // 1) 读一次初始形态。
  //
  // 为什么还需要这一步：`shell://mode` 只在**变化时**发。若窗口在岛形态下被
  // 二次启动还原，前端可能错过那条事件；启动时读一次才能保证镜像与窗口一致。
  useEffect(() => {
    let cancelled = false;
    void shell
      .readMode()
      .then((event) => {
        if (cancelled || event === null) {
          return;
        }
        applyMode(event);
      })
      .catch(() => {
        // 端口内部已静默，这里只是兜底。
      });
    return () => {
      cancelled = true;
    };
  }, [shell]);

  // 2) 订阅形态变更 + 退出请求。
  //
  // 退订必须处理"卸载时 promise 还没 resolve"的情况：StrictMode 的双挂载会让
  // 第一个订阅在 resolve 之后才拿到退订函数，那时若直接丢弃就会留下一个
  // 永远不会被清理的监听器（每挂载一次多一个，事件被处理多遍）。
  useEffect(() => {
    let disposed = false;
    const offs: Array<() => void> = [];

    const register = (pending: Promise<() => void>): void => {
      void pending
        .then((off) => {
          if (disposed) {
            off();
            return;
          }
          offs.push(off);
        })
        .catch(() => {
          // 订阅失败（老版本壳没有这些事件）：形态变化拿不到，但应用仍可用。
        });
    };

    register(
      shell.onMode((event) => {
        applyMode(event);
        // 形态切换后 Rust 那边的展开状态可能已被重置，让下一次相位变化重新上报。
        pushedExpandedRef.current = null;
        if (event.showCloseHint) {
          toast(CLOSE_HINT_MESSAGE);
        }
      }),
    );

    register(
      shell.onQuitRequested(() => {
        // 退出前必须先 `dispose()`：它清剪贴板与计时器。Rust 侧直接 `exit`
        // 会绕过这一切，用户的密码就会留在剪贴板里。
        void (async () => {
          try {
            await client.dispose();
          } catch {
            // 清理失败也要继续退出：卡在"点了退出没反应"比剪贴板残留更糟，
            // 而且 Rust 的 1500ms 看门狗也会兜底。
          }
          await shell.quit();
        })();
      }),
    );

    return () => {
      disposed = true;
      for (const off of offs) {
        off();
      }
    };
  }, [client, shell, toast]);

  // 3) 会话状态单向推给 Rust（托盘置灰 / 文案 / tooltip）。
  useEffect(() => {
    const mirror = mapToMirror(sessionStatus);
    if (pushedSessionRef.current === mirror) {
      return;
    }
    pushedSessionRef.current = mirror;
    void shell.setSession(sessionStatus);
  }, [sessionStatus, shell]);

  // 4) 岛面相位 → 窗口尺寸。全形态下一次都不调（主面板不缩窗）。
  useEffect(() => {
    if (appMode !== 'island') {
      // 离开岛形态时复位，保证下次进入会重新上报一次。
      pushedExpandedRef.current = null;
      return;
    }
    const expanded = phaseWantsExpandedWindow(phase);
    if (pushedExpandedRef.current === expanded) {
      return;
    }
    pushedExpandedRef.current = expanded;
    void shell.setExpanded(expanded);
  }, [appMode, phase, shell]);

  // 5) 兜底：`appMode` 被外部改写时也保证 DOM 锚点跟着走。
  //
  // 正常路径是 `applyMode` 同时写 store 与 DOM；这条 effect 覆盖"store 被测试
  // 或将来某个功能直接 setState"的情况，让 `<html data-app-mode>` 永远是镜像。
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.appMode = appMode;
    }
  }, [appMode]);

  return null;
}

/**
 * 「退出密岛」的统一前端实现：右键岛菜单与（将来的）其它入口共用。
 *
 * 单独导出而不是内联，是为了让"退出前必须 dispose"这条规则只有一处实现。
 */
export function useQuitViaShell(port?: ShellPort): () => Promise<void> {
  const client = useVaultClient();
  const shell = port ?? shellPort();
  return useCallback(async (): Promise<void> => {
    try {
      await client.dispose();
    } catch {
      // 同上：清理失败不阻断退出。
    }
    await shell.quit();
  }, [client, shell]);
}
