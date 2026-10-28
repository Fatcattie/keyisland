/**
 * 全局 UI 状态（Zustand）。
 *
 * 安全约束（SDD §6.1）：本 store 只保存 UI 状态与不敏感摘要，
 * 绝不保存 DEK、KEK、主密码、恢复密钥或资产密码明文。
 */

import { create } from 'zustand';
import type { AutoLockPolicy, SessionStatus, SortMode } from '../core/vault/types';
import { DEFAULT_HOTZONE, type HotzoneConfig } from '../lib/hotzone';
import { DEFAULT_COLLAPSE_DELAY_MS, DEFAULT_DWELL_DELAY_MS } from '../lib/timing';
import { DEFAULT_SHORTCUTS, type ShortcutMap } from '../lib/shortcuts';

/** 灵动岛展示阶段（与 SDD §6.5 状态机一致）。 */
export type IslandPhase = 'collapsed' | 'opening' | 'expanded' | 'closing';

/**
 * 窗口形态（灵动岛常驻化的新增维度）。
 *
 * 与 `island.phase` **语义正交**，绝不能合并：
 * - `phase` 描述"岛这张面展开没展开"，由前端交互驱动；
 * - `appMode` 描述"窗口是大是小"，由 Rust 窗口几何驱动（前端只是镜像）。
 *
 * 两者必须能同时成立：全形态下用户也可以把预览条展开（`phase='expanded'`
 * 且 `appMode='full'`）。另外既有岛测试在 `beforeEach` 里精确重置 `phase`，
 * 把形态塞进 `phase` 会让那些用例在 `appMode` 未重置时互相污染。
 */
export type AppMode = 'full' | 'island' | 'hidden';

/** 灵动岛 UI 状态。 */
export interface IslandUiState {
  phase: IslandPhase;
  query: string;
  activeIndex: number;
  focused: boolean;
}

/** 会话 UI 状态：只保存状态与倒计时，不保存凭据。 */
export interface SessionUiState {
  status: SessionStatus;
  cooldownUntil: number | null;
}

/** 列表筛选状态。 */
export interface FilterUiState {
  category: string;
  sort: SortMode;
}

/**
 * 资产列表展示形态（PRD FR-03「右侧卡片网格（可切列表视图）」）。
 *
 * `grid` = 多列卡片网格；`list` = 单列密集，一屏能看更多行。
 * 只存 UI 偏好，不进元数据：换台设备/重装后回到默认网格没有任何损失。
 */
export type ViewMode = 'grid' | 'list';

/** Store 形状。 */
export interface UiStore {
  /**
   * 窗口形态。**真值源在 Rust**（`src-tauri/src/shell/mod.rs` 的 `AppMode`），
   * 这里是镜像：由 `ShellBridge` 收到 `shell://mode` 后写入，组件只读不写。
   */
  appMode: AppMode;
  island: IslandUiState;
  session: SessionUiState;
  filters: FilterUiState;
  viewMode: ViewMode;
  /**
   * 顶部热区几何（PRD FR-02「默认宽约 300px，可配置宽度与位置」）。
   *
   * 持久化在元数据里，但渲染与命中判定必须**同步**读到它——鼠标事件不会等一个
   * Promise，所以这里留一份镜像：`Island` 挂载时从门面拉一次，设置页改完再写回来。
   * 镜像只是缓存，真值永远在元数据；两边不一致时以元数据为准（下次挂载会覆盖）。
   */
  hotzone: HotzoneConfig;
  /**
   * 展开态收起延时（ms）。与 `hotzone` 同理：真值在元数据，这里是供命中/隐藏
   * 时序同步读取的镜像。
   */
  collapseDelayMs: number;
  /**
   * 展开态「停留时长」（ms）：无操作多久后自动隐藏。
   *
   * 与 `collapseDelayMs` 分开：前者由空闲触发（指针停在岛上也照样收），
   * 后者只由"指针离开"触发。
   */
  dwellDelayMs: number;
  /**
   * 快捷键自定义。与 `hotzone` / `collapseDelayMs` 同理：真值在元数据，
   * 这里是供键盘处理同步读取的镜像——keydown 是同步路径，不能等 Promise。
   */
  shortcuts: ShortcutMap;
  autoLockPolicy: AutoLockPolicy;
  /** 写入窗口形态（唯一写入者是 `ShellBridge`）。 */
  setAppMode(mode: AppMode): void;
  openIsland(): void;
  finishOpening(): void;
  closeIsland(): void;
  finishClosing(): void;
  setQuery(query: string): void;
  setActiveIndex(index: number): void;
  setFocused(focused: boolean): void;
  setSessionStatus(status: SessionStatus, cooldownUntil?: number | null): void;
  setSort(sort: SortMode): void;
  setCategory(category: string): void;
  setViewMode(mode: ViewMode): void;
  setHotzone(config: HotzoneConfig): void;
  setCollapseDelay(delayMs: number): void;
  setDwellDelay(delayMs: number): void;
  setShortcuts(shortcuts: ShortcutMap): void;
  setAutoLockPolicy(policy: AutoLockPolicy): void;
}

/** 默认初始状态。 */
const initialIsland: IslandUiState = {
  phase: 'collapsed',
  query: '',
  activeIndex: 0,
  focused: false,
};

/** 全局 UI store。 */
export const useUiStore = create<UiStore>((set) => ({
  // 默认全形态：与 `tauri.conf.json` 里 main 窗口的初始状态一致。
  appMode: 'full',
  island: initialIsland,
  session: { status: 'uninitialized', cooldownUntil: null },
  filters: { category: 'all', sort: 'recent_updated' },
  viewMode: 'grid',
  hotzone: { ...DEFAULT_HOTZONE },
  collapseDelayMs: DEFAULT_COLLAPSE_DELAY_MS,
  dwellDelayMs: DEFAULT_DWELL_DELAY_MS,
  shortcuts: DEFAULT_SHORTCUTS,
  autoLockPolicy: '30m',

  // 形态写入不做任何"顺手重置 phase"的动作：两者正交，混在一起就会出现
  // "切回全形态时预览条莫名收起"这种无法解释的行为。
  setAppMode: (mode: AppMode) => set(() => ({ appMode: mode })),

  openIsland: () =>
    set((state) => ({
      island: { ...state.island, phase: state.island.phase === 'expanded' ? 'expanded' : 'opening' },
    })),

  finishOpening: () =>
    set((state) => ({
      island: { ...state.island, phase: 'expanded', focused: true },
    })),

  closeIsland: () =>
    set((state) => ({
      island: { ...state.island, phase: 'closing', focused: false, activeIndex: 0 },
    })),

  finishClosing: () =>
    set((state) => ({
      island: { ...state.island, phase: 'collapsed', query: '', activeIndex: 0, focused: false },
    })),

  setQuery: (query: string) =>
    set((state) => ({
      island: { ...state.island, query, activeIndex: 0 },
    })),

  setActiveIndex: (index: number) =>
    set((state) => ({
      island: { ...state.island, activeIndex: Math.max(0, index) },
    })),

  setFocused: (focused: boolean) =>
    set((state) => ({
      island: { ...state.island, focused },
    })),

  setSessionStatus: (status: SessionStatus, cooldownUntil: number | null = null) =>
    set(() => ({
      session: { status, cooldownUntil },
    })),

  setSort: (sort: SortMode) =>
    set((state) => ({
      filters: { ...state.filters, sort },
    })),

  setCategory: (category: string) =>
    set((state) => ({
      filters: { ...state.filters, category },
    })),

  setViewMode: (mode: ViewMode) => set(() => ({ viewMode: mode })),

  setHotzone: (config: HotzoneConfig) =>
    set((state) => {
      // 相同配置直接复用旧对象：这个值挂在 `Island` 的 effect 依赖上，
      // 每次都换新对象会让"拉一次配置"变成无限重渲染。
      if (state.hotzone.widthPx === config.widthPx && state.hotzone.align === config.align) {
        return state;
      }
      return { hotzone: { widthPx: config.widthPx, align: config.align } };
    }),

  setCollapseDelay: (delayMs: number) => set(() => ({ collapseDelayMs: delayMs })),

  setDwellDelay: (delayMs: number) => set(() => ({ dwellDelayMs: delayMs })),

  setShortcuts: (shortcuts: ShortcutMap) => set(() => ({ shortcuts })),

  setAutoLockPolicy: (policy: AutoLockPolicy) => set(() => ({ autoLockPolicy: policy })),
}));
