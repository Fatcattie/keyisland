/**
 * 窗口尺寸常量与形态判定（前端侧镜像）。
 *
 * **真值在 Rust**（`src-tauri/src/shell/geometry.rs`），这里只用于两件事：
 * 1. 单测里断言"前端以为的尺寸"与设计一致；
 * 2. `phase → expanded` 的映射（`closing` 仍算展开，见下）。
 *
 * 前端**不做任何窗口操作**：`set_size` / `set_position` 全部由 Rust 落地，
 * 因为窗口是 Rust 的资产，前端只上报"岛面展开了没有"。这样就不存在
 * "前端改了尺寸、窗口没变"的假状态。
 *
 * 改尺寸必须两侧同改（设计 §7.1），否则会出现"前端以为展开了、窗口没变"。
 */

import type { AppMode, IslandPhase } from '../stores/ui-store';

/** 逻辑像素尺寸。 */
export interface WindowSize {
  readonly w: number;
  readonly h: number;
}

/** 岛形态 · 收起：只有一条窄条。 */
export const ISLAND_COLLAPSED: WindowSize = { w: 320, h: 44 };
/** 岛形态 · 展开：完整岛面（搜索 + 最近使用 + 快捷新建）。 */
export const ISLAND_EXPANDED: WindowSize = { w: 400, h: 460 };
/** 全形态默认尺寸。 */
export const FULL_DEFAULT: WindowSize = { w: 1180, h: 820 };
/** 全形态最小尺寸。进入岛形态前 Rust 会先清掉它，否则缩不下去。 */
export const FULL_MIN: WindowSize = { w: 960, h: 640 };

/** 岛形态尺寸（与 Rust `geometry::island_size` 同值）。 */
export function islandSize(expanded: boolean): WindowSize {
  return expanded ? ISLAND_EXPANDED : ISLAND_COLLAPSED;
}

/** 当前是否处于岛形态（窗口只有一小块、主面板不可见）。 */
export function isIslandMode(mode: AppMode): boolean {
  return mode === 'island';
}

/**
 * 岛面相位 → 窗口是否该按展开尺寸。
 *
 * `closing`（收起动画进行中）**仍算展开**：如果一进 closing 就把窗口缩回
 * 320×44，退出动画会被窗口裁掉一半——这是最容易漏的一处（设计 §1.4.3）。
 */
export function phaseWantsExpandedWindow(phase: IslandPhase): boolean {
  return phase !== 'collapsed';
}
