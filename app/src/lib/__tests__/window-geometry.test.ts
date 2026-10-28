/**
 * 窗口几何常量的前端镜像。
 *
 * 尺寸的**真值在 Rust**（`src-tauri/src/shell/geometry.rs`），TS 这份只用于
 * `phase → expanded` 判断与测试。两边必须同值——不同值时症状是"前端以为展开了、
 * 窗口没变"，而且没有任何报错。
 *
 * 这里把设计文档 §7.1 的四个数字**写死在断言里**（而不是 import 常量再比常量，
 * 那等于自己和自己比）：将来谁把常量改错，这条测试会红，提示"改尺寸要两侧同改"。
 */

import { describe, expect, it } from 'vitest';
import {
  FULL_DEFAULT,
  FULL_MIN,
  ISLAND_COLLAPSED,
  ISLAND_EXPANDED,
  islandSize,
  isIslandMode,
  phaseWantsExpandedWindow,
} from '../window-geometry';

describe('window-geometry · 与 Rust 同值', () => {
  it('四个尺寸常量与设计 §7.1 一致', () => {
    expect(ISLAND_COLLAPSED).toEqual({ w: 320, h: 44 });
    expect(ISLAND_EXPANDED).toEqual({ w: 400, h: 460 });
    expect(FULL_DEFAULT).toEqual({ w: 1180, h: 820 });
    expect(FULL_MIN).toEqual({ w: 960, h: 640 });
  });

  it('展开态宽度不得小于 360（否则搜索框与列表挤成一列）', () => {
    expect(ISLAND_EXPANDED.w).toBeGreaterThanOrEqual(360);
  });

  it('islandSize 按展开与否取两个常量', () => {
    expect(islandSize(false)).toBe(ISLAND_COLLAPSED);
    expect(islandSize(true)).toBe(ISLAND_EXPANDED);
  });
});

describe('window-geometry · 相位映射', () => {
  it('closing 仍算展开（否则收起动画会被窗口裁掉一半）', () => {
    expect(phaseWantsExpandedWindow('collapsed')).toBe(false);
    expect(phaseWantsExpandedWindow('opening')).toBe(true);
    expect(phaseWantsExpandedWindow('expanded')).toBe(true);
    expect(phaseWantsExpandedWindow('closing')).toBe(true);
  });

  it('只有 island 是岛形态', () => {
    expect(isIslandMode('island')).toBe(true);
    expect(isIslandMode('full')).toBe(false);
    expect(isIslandMode('hidden')).toBe(false);
  });
});
