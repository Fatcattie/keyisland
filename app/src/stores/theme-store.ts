/**
 * 主题（白天 / 黑夜）状态。
 *
 * ## 为什么不塞进 `ui-store`
 *
 * `ui-store` 是**纯内存**的 UI 状态，几十个测试按字段重置它（`useUiStore.setState`）。
 * 主题需要**落盘**（下次打开还是同一个主题），一旦混进去，"重置 UI 状态"就会顺手
 * 把用户的主题偏好也清掉——这类 bug 只在切过主题之后才出现，最难查。
 *
 * ## 为什么默认跟随系统
 *
 * 主流做法：首次打开跟随系统，用户手动切过之后以用户为准（落盘）。
 * 只有"用户从没选过"时才读 `prefers-color-scheme`，避免每次启动都覆盖用户的选择。
 */

import { create } from 'zustand';

/** 目前只有两种：白天 / 黑夜。不暴露 `system`，因为开关本身是二元的。 */
export type ThemeMode = 'light' | 'dark';

/** 落盘键。带前缀，避免和别的 localStorage 数据混。 */
export const THEME_STORAGE_KEY = 'keyisland.theme';

/** 读用户上次选的。读不到 / 存储被禁时返回 `null`（交给系统偏好兜底）。 */
export function readStoredTheme(): ThemeMode | null {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    // 隐私模式 / 存储被策略禁用：主题读不到不该让应用起不来。
    return null;
  }
}

/** 系统是否偏好深色。 */
function prefersDark(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

/** 首次进入时的主题：用户选过的优先，否则跟随系统。 */
export function resolveInitialTheme(): ThemeMode {
  return readStoredTheme() ?? (prefersDark() ? 'dark' : 'light');
}

/**
 * 把主题写到 `<html>` 上。
 *
 * - `class="dark"` 给 Tailwind 的 `dark:` 变体用（虽然本项目的主题靠 CSS 变量，
 *   但留一条标准入口，将来写个别 `dark:` 特例不用改基础设施）；
 * - `data-theme` 给测试与调试一个可断言的钩子；
 * - `color-scheme` 让滚动条、原生输入控件、`<select>` 下拉一起变深，
 *   少了这一步会出现"页面黑了但下拉框还是白的"。
 */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  root.classList.toggle('dark', mode === 'dark');
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
}

function persist(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 落盘失败只影响"下次启动的主题"，不该打断本次切换。
  }
}

export interface ThemeStore {
  mode: ThemeMode;
  setMode(mode: ThemeMode): void;
  /** 白天 ⇄ 黑夜。开关组件只需要这一个动作。 */
  toggle(): void;
}

/** 主题 store。 */
export const useThemeStore = create<ThemeStore>((set, get) => ({
  mode: resolveInitialTheme(),

  setMode: (mode: ThemeMode) => {
    applyTheme(mode);
    persist(mode);
    set({ mode });
  },

  toggle: () => {
    get().setMode(get().mode === 'dark' ? 'light' : 'dark');
  },
}));

/**
 * 系统主题变了（`prefers-color-scheme` 的 change 事件）。
 *
 * 只在**用户从没手动选过**时跟随：一旦他按过开关，系统怎么变都与他无关——
 * 不然"我明明选了黑夜，傍晚系统一变又被改回白天"会显得应用不听人话。
 *
 * 刻意**不落盘**：跟随系统不等于替用户做决定，下次启动仍然先问系统。
 * 抽成这个纯函数是为了可测——jsdom 没有 `matchMedia` 事件，伪造 MediaQueryList
 * 比直接调用这个函数麻烦得多。
 */
export function syncWithSystemPreference(dark: boolean): void {
  if (readStoredTheme() !== null) {
    return;
  }
  const mode: ThemeMode = dark ? 'dark' : 'light';
  if (useThemeStore.getState().mode === mode) {
    return;
  }
  applyTheme(mode);
  useThemeStore.setState({ mode });
}

/** 订阅系统主题变化，返回取消订阅函数（浏览器不支持时返回空操作）。 */
export function watchSystemTheme(): () => void {
  if (typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = (event: MediaQueryListEvent): void => {
    syncWithSystemPreference(event.matches);
  };
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}
