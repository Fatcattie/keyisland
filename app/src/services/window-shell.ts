/**
 * 桌面壳端口：把"窗口形态"这件事包成一组命令 + 事件。
 *
 * ## 这个文件为什么存在
 *
 * 岛常驻需要窗口缩小/还原/置顶/托盘，这些都是 Rust 的能力。但如果组件直接
 * `invoke('shell_show_main')`，浏览器版（`npm run dev` / vitest / e2e）就会
 * 到处散落 `isDesktopShell()` 判断，漏一处就是"点了没反应"或"未捕获的
 * Promise rejection"。
 *
 * 所以这里提供**一份端口 + 两个实现**：
 * - 桌面壳：真的 `invoke` / `listen`；
 * - 浏览器：**全部 no-op**（resolve，不抛，不 invoke）。
 *
 * 于是调用方可以无条件下调用 `shellPort().showMain()`，不需要任何守卫。
 *
 * ## 失败策略（刻意不对称）
 *
 * `showMain` / `enterIsland` / `setExpanded` / `setSession` 失败**静默**：
 * 它们是"顺带做一下"的附属动作，抛出来只会在控制台留一堆没人处理的 rejection。
 * `getAutostart` / `setAutostart` 失败返回 `null`（"未知"），由调用方按"不可用"
 * 渲染——既不抛，也不谎报成功。只有 `quit` 允许冒泡：用户点了「退出密岛」，
 * 静默失败等于骗人。
 *
 * ## 安全
 *
 * 参数里只有 `expanded: boolean` 与一个会话状态字符串，**没有任何密钥/明文**
 * （安全不变式 S2）。Rust 侧也不需要它们。
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { SessionStatus } from '../core/vault/types';
import type { AppMode } from '../stores/ui-store';
import { isDesktopShell } from './tauri-storage';

/** Rust 侧 `SessionMirror` 的字符串形式（`cooling_down` 折叠为 `locked`）。 */
export type SessionMirror = 'uninitialized' | 'locked' | 'unlocked';

/** `shell://mode` 的载荷。 */
export interface ShellModeEvent {
  mode: AppMode;
  /** 岛面是否展开（决定窗口是 320×44 还是 400×460）。 */
  expanded: boolean;
  /** 首次"关闭到托盘"提示（CHG-11）。Rust 决定，前端只负责弹。 */
  showCloseHint: boolean;
}

/** 事件名（与 Rust `shell/mod.rs` 的常量逐字一致）。 */
export const SHELL_EVENT_MODE = 'shell://mode';
export const SHELL_EVENT_LOCK_REQUESTED = 'shell://lock-requested';
export const SHELL_EVENT_QUIT_REQUESTED = 'shell://quit-requested';

/** 外壳端口。 */
export interface ShellPort {
  /** 当前是否跑在桌面壳里。浏览器下所有方法都是 no-op。 */
  available(): boolean;
  /** 读一次当前形态；失败返回 null（静默，绝不让它成为启动失败的新来源）。 */
  readMode(): Promise<ShellModeEvent | null>;
  /** 打开主面板（还原全形态 + 聚焦）。全形态下是幂等的 no-op。 */
  showMain(): Promise<void>;
  /** 收进岛形态（工具栏"收进岛"）。 */
  enterIsland(): Promise<void>;
  /** 上报岛面展开状态，由 Rust 落地窗口尺寸。 */
  setExpanded(expanded: boolean): Promise<void>;
  /** 上报会话状态，供托盘置灰 / 文案使用。 */
  setSession(status: SessionStatus): Promise<void>;
  /** 真正退出进程。**唯一**会"真的消失"的动作，失败允许冒泡。 */
  quit(): Promise<void>;
  /**
   * 读开机自启状态。浏览器下返回 `null`（"没有这个能力"，与"关着"区分开）。
   */
  getAutostart(): Promise<boolean | null>;
  /**
   * 开 / 关开机自启，返回**落地后的状态**（`null` = 失败/不可用）。
   * 浏览器下返回 `null`。
   */
  setAutostart(enabled: boolean): Promise<boolean | null>;
  /** 订阅形态变更。返回退订函数。 */
  onMode(callback: (event: ShellModeEvent) => void): Promise<UnlistenFn>;
  /** 订阅"锁定保险库"请求（托盘 / 右键菜单）。 */
  onLockRequested(callback: () => void): Promise<UnlistenFn>;
  /** 订阅"退出密岛"请求。 */
  onQuitRequested(callback: () => void): Promise<UnlistenFn>;
}

/**
 * 会话状态 → 托盘镜像。
 *
 * `cooling_down`（锁定冷却）**折叠成 `locked`**：冷却期同样没有可用资产，
 * 托盘不该出现第四种状态，用户也不该在"冷却中"看到一个能点的「锁定保险库」。
 * 这是这条映射的唯一定义处——散成两处就必然有一处写错。
 */
export function mapToMirror(status: SessionStatus): SessionMirror {
  switch (status) {
    case 'unlocked':
      return 'unlocked';
    case 'uninitialized':
      return 'uninitialized';
    case 'locked':
    case 'cooling_down':
      return 'locked';
    default:
      return 'locked';
  }
}

/** 把 Rust 传来的任意值收窄成 `ShellModeEvent`；形状不对返回 null。 */
function normalizeModeEvent(raw: unknown): ShellModeEvent | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const mode = record.mode;
  if (mode !== 'full' && mode !== 'island' && mode !== 'hidden') {
    return null;
  }
  return {
    mode,
    expanded: record.expanded === true,
    showCloseHint: record.showCloseHint === true,
  };
}

/** 浏览器环境的实现：全部 no-op，**零 invoke**。 */
function createNoopPort(): ShellPort {
  return {
    available: () => false,
    readMode: async () => null,
    showMain: async () => undefined,
    enterIsland: async () => undefined,
    setExpanded: async () => undefined,
    setSession: async () => undefined,
    quit: async () => undefined,
    getAutostart: async () => null,
    setAutostart: async () => null,
    onMode: async () => () => undefined,
    onLockRequested: async () => () => undefined,
    onQuitRequested: async () => () => undefined,
  };
}

/** 桌面壳实现。 */
function createDesktopPort(): ShellPort {
  /**
   * 静默执行一条命令。
   *
   * 不用 `try/catch` 包成 `Promise<void>` 的公共壳子，是为了让"哪些失败该静默"
   * 这件事只写一遍——`quit` 单独走 `invoke`。
   */
  const silently = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch {
      // 附属动作：失败不冒泡。下一次形态/会话变化会重新对齐。
    }
  };

  return {
    available: () => true,
    readMode: async () => {
      try {
        return normalizeModeEvent(await invoke('shell_mode'));
      } catch {
        // 老版本壳没有这条命令、IPC 尚未就绪都会走到这里。
        // 探测不该成为新的"启动失败"来源。
        return null;
      }
    },
    showMain: () => silently(() => invoke('shell_show_main')),
    enterIsland: () => silently(() => invoke('shell_enter_island')),
    setExpanded: (expanded: boolean) =>
      silently(() => invoke('shell_set_island_expanded', { expanded })),
    setSession: (status: SessionStatus) =>
      silently(() => invoke('shell_set_session', { status: mapToMirror(status) })),
    quit: async () => {
      // 刻意不吞异常：用户点了「退出密岛」，静默失败等于骗人。
      await invoke('shell_quit');
    },
    getAutostart: async () => {
      try {
        return (await invoke<boolean>('shell_get_autostart')) === true;
      } catch {
        // 读不到就当作"未知"：菜单按不可用渲染，而不是骗用户"已关闭"。
        return null;
      }
    },
    setAutostart: async (enabled: boolean) => {
      try {
        // Rust 返回**落地后的状态**（它读一次注册表再回），不是回显入参：
        // 写注册表可能被组策略/安全软件拦下，那时入参和事实是两回事。
        return (await invoke<boolean>('shell_set_autostart', { enabled })) === true;
      } catch {
        return null;
      }
    },
    onMode: async (callback) =>
      listen(SHELL_EVENT_MODE, (event) => {
        const normalized = normalizeModeEvent(event.payload);
        if (normalized !== null) {
          callback(normalized);
        }
      }),
    onLockRequested: async (callback) => listen(SHELL_EVENT_LOCK_REQUESTED, () => callback()),
    onQuitRequested: async (callback) => listen(SHELL_EVENT_QUIT_REQUESTED, () => callback()),
  };
}

/**
 * 创建端口。
 *
 * 每次调用都按当前环境重新判定（而不是模块加载时判一次）：测试里可以先设置
 * `window.__TAURI_INTERNALS__` 再创建端口，也可以在同一个文件里先后测两种环境。
 */
export function createShellPort(): ShellPort {
  return isDesktopShell() ? createDesktopPort() : createNoopPort();
}

/** 默认端口的惰性单例（组件里用 `shellPort()`，避免每次渲染都新建一份）。 */
let cachedPort: ShellPort | null = null;

/** 取默认端口。 */
export function shellPort(): ShellPort {
  if (cachedPort === null) {
    cachedPort = createShellPort();
  }
  return cachedPort;
}

/** 测试专用：清掉单例缓存（让下一次 `shellPort()` 重新按环境判定）。 */
export function resetShellPortForTests(): void {
  cachedPort = null;
}
