/**
 * 顶部热区几何（PRD FR-02「默认宽约 300px，可配置宽度与位置」）。
 *
 * 这些断言覆盖的是"设置说多少、实际就命中多少"这条链路的算术部分：
 * 越界回落、位置换算、窄视口收敛、坐标缺失放行、全屏检测。
 * 组件层的接线在 `IslandHotzoneWidth.test.tsx` 里验证。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOTZONE,
  HOTZONE_DEFAULT_WIDTH_PX,
  HOTZONE_MAX_WIDTH_PX,
  HOTZONE_MIN_WIDTH_PX,
  clampHotzoneWidth,
  hotzoneBand,
  isFullscreenActive,
  isHotzoneAlign,
  isWithinHotzoneX,
  resolveHotzone,
} from '../hotzone';

describe('clampHotzoneWidth', () => {
  it('合法值原样保留（四舍五入到整数）', () => {
    expect(clampHotzoneWidth(300)).toBe(300);
    expect(clampHotzoneWidth(300.4)).toBe(300);
    expect(clampHotzoneWidth(300.6)).toBe(301);
  });

  it('越界夹到上下限', () => {
    expect(clampHotzoneWidth(10)).toBe(HOTZONE_MIN_WIDTH_PX);
    expect(clampHotzoneWidth(5000)).toBe(HOTZONE_MAX_WIDTH_PX);
  });

  it('非数值回落默认值（NaN / Infinity 必须挡住）', () => {
    // NaN 能通过 `typeof === 'number'`，但会让 CSS 变成 `NaNpx` —— 整条声明被丢弃，
    // 热区静默消失。这类值必须在进入渲染前就被替换掉。
    expect(clampHotzoneWidth(Number.NaN)).toBe(HOTZONE_DEFAULT_WIDTH_PX);
    expect(clampHotzoneWidth(Number.POSITIVE_INFINITY)).toBe(HOTZONE_DEFAULT_WIDTH_PX);
    expect(clampHotzoneWidth('300')).toBe(HOTZONE_DEFAULT_WIDTH_PX);
    expect(clampHotzoneWidth(undefined)).toBe(HOTZONE_DEFAULT_WIDTH_PX);
  });
});

describe('resolveHotzone', () => {
  it('空 / 非对象 → 默认 300px 居中', () => {
    expect(resolveHotzone(null)).toEqual(DEFAULT_HOTZONE);
    expect(resolveHotzone(undefined)).toEqual(DEFAULT_HOTZONE);
    expect(resolveHotzone({})).toEqual(DEFAULT_HOTZONE);
    expect(resolveHotzone('300')).toEqual(DEFAULT_HOTZONE);
  });

  it('缺字段时逐项回落，不因为一个字段坏了就丢掉另一个', () => {
    expect(resolveHotzone({ widthPx: 480 })).toEqual({ widthPx: 480, align: 'center' });
    expect(resolveHotzone({ align: 'right' })).toEqual({
      widthPx: HOTZONE_DEFAULT_WIDTH_PX,
      align: 'right',
    });
    expect(resolveHotzone({ widthPx: 480, align: 'diagonal' })).toEqual({
      widthPx: 480,
      align: 'center',
    });
  });
});

describe('isHotzoneAlign', () => {
  it('只认三种位置', () => {
    expect(isHotzoneAlign('left')).toBe(true);
    expect(isHotzoneAlign('center')).toBe(true);
    expect(isHotzoneAlign('right')).toBe(true);
    expect(isHotzoneAlign('middle')).toBe(false);
    expect(isHotzoneAlign(null)).toBe(false);
  });
});

describe('hotzoneBand', () => {
  it('居中：1440px 视口里 300px 热区从 570px 开始', () => {
    expect(hotzoneBand({ widthPx: 300, align: 'center' }, 1440)).toEqual({ left: 570, width: 300 });
  });

  it('靠左从 0 开始，靠右贴住右边界', () => {
    expect(hotzoneBand({ widthPx: 300, align: 'left' }, 1440)).toEqual({ left: 0, width: 300 });
    expect(hotzoneBand({ widthPx: 300, align: 'right' }, 1440)).toEqual({ left: 1140, width: 300 });
  });

  it('视口比热区还窄时收敛到视口宽度，left 不会变成负数', () => {
    // 否则 left = (200 - 300) / 2 = -50，命中区间一半跑到屏幕外，
    // 可见区域里反而只剩一半热区可用。
    expect(hotzoneBand({ widthPx: 300, align: 'center' }, 200)).toEqual({ left: 0, width: 200 });
    expect(hotzoneBand({ widthPx: 300, align: 'right' }, 200)).toEqual({ left: 0, width: 200 });
  });

  it('视口宽度非法时退化为零宽区间（而不是 NaN）', () => {
    expect(hotzoneBand({ widthPx: 300, align: 'center' }, 0)).toEqual({ left: 0, width: 0 });
    expect(hotzoneBand({ widthPx: 300, align: 'center' }, Number.NaN)).toEqual({ left: 0, width: 0 });
  });
});

describe('isWithinHotzoneX', () => {
  const center = { widthPx: 300, align: 'center' } as const;

  it('命中区间是闭区间：边界点算命中', () => {
    expect(isWithinHotzoneX(569, center, 1440)).toBe(false);
    expect(isWithinHotzoneX(570, center, 1440)).toBe(true);
    expect(isWithinHotzoneX(870, center, 1440)).toBe(true);
    expect(isWithinHotzoneX(871, center, 1440)).toBe(false);
  });

  it('坐标缺失时放行（jsdom / 合成事件的兼容分支）', () => {
    // 判为"不在热区"会让键盘与合成唤出路径在测试环境整体失效；
    // 判为"在热区"最多多重一次唤出，而唤出本身是幂等的。
    expect(isWithinHotzoneX(undefined, center, 1440)).toBe(true);
    expect(isWithinHotzoneX(Number.NaN, center, 1440)).toBe(true);
  });

  it('位置配置生效：靠左时右侧不再命中', () => {
    const left = { widthPx: 300, align: 'left' } as const;
    expect(isWithinHotzoneX(100, left, 1440)).toBe(true);
    expect(isWithinHotzoneX(1400, left, 1440)).toBe(false);
  });
});

describe('isFullscreenActive', () => {
  it('没有 document / 未全屏 → false', () => {
    expect(isFullscreenActive(null)).toBe(false);
    expect(isFullscreenActive(undefined)).toBe(false);
    expect(isFullscreenActive({ fullscreenElement: null } as unknown as Document)).toBe(false);
  });

  it('标准属性有值时 → true', () => {
    const doc = { fullscreenElement: {} } as unknown as Document;
    expect(isFullscreenActive(doc)).toBe(true);
  });

  it('只有 webkit 前缀属性时同样识别（旧版 WebView2 / Safari）', () => {
    const doc = { fullscreenElement: null, webkitFullscreenElement: {} } as unknown as Document;
    expect(isFullscreenActive(doc)).toBe(true);
  });
});
