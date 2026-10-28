/**
 * 屏幕顶部热区的几何计算（PRD FR-02「屏幕顶部中央热区（默认宽约 300px，
 * 可配置宽度与位置）」）。
 *
 * 为什么单独抽一个纯函数模块：
 * 1. 命中判定原先只有一句 `clientY <= 4`，加了横向判定后就有「宽度 × 位置 ×
 *    视口宽度 × 坐标缺失」四组边界，写在组件里只能靠渲染 + 事件模拟去测；
 *    抽成纯函数后每一组边界都能直接断言。
 * 2. 设置页要显示"当前热区覆盖屏幕哪一段"，渲染用的 `left/width` 与命中判定用的
 *    区间必须是**同一份计算**——分开写就会出现"设置说 300px、实际命中 260px"
 *    这种用户永远查不出来的错位。
 *
 * 诚实边界：Web 版只能按视口宽度算，管不到操作系统级的多显示器与任务栏；
 * 桌面版会把 `viewportWidth` 换成真实屏幕宽度，其余逻辑无需改动。
 */

/** 热区水平位置。 */
export type HotzoneAlign = 'left' | 'center' | 'right';

/** 热区配置。 */
export interface HotzoneConfig {
  /** 热区宽度（px）。 */
  widthPx: number;
  /** 热区水平位置。 */
  align: HotzoneAlign;
}

/** 默认宽度：PRD 写的是"约 300px"。 */
export const HOTZONE_DEFAULT_WIDTH_PX = 300;

/**
 * 宽度上下限。
 *
 * 下限 120px：再窄就不够从任意位置"扫"过去，鼠标斜着走会漏掉；
 * 上限 1200px：再宽就等于整个顶边都是热区，用户点浏览器标签栏都会误触。
 */
export const HOTZONE_MIN_WIDTH_PX = 120;
export const HOTZONE_MAX_WIDTH_PX = 1200;

/** 默认配置：300px 居中。 */
export const DEFAULT_HOTZONE: HotzoneConfig = {
  widthPx: HOTZONE_DEFAULT_WIDTH_PX,
  align: 'center',
};

/** 水平位置取值校验。 */
export function isHotzoneAlign(value: unknown): value is HotzoneAlign {
  return value === 'left' || value === 'center' || value === 'right';
}

/**
 * 归一化宽度。
 *
 * `Number.isFinite` 而不是 `typeof === 'number'`：`NaN` 与 `Infinity` 都能通过后者，
 * 而它们会让 `left/width` 变成 `NaN px`——CSS 直接忽略整条声明，热区静默消失。
 * 非法值一律回落到默认 300px，与"老元数据没有这个字段"的处理保持一致。
 */
export function clampHotzoneWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return HOTZONE_DEFAULT_WIDTH_PX;
  }
  const rounded = Math.round(value);
  return Math.min(HOTZONE_MAX_WIDTH_PX, Math.max(HOTZONE_MIN_WIDTH_PX, rounded));
}

/**
 * 把可能残缺的存储值解析成完整配置。
 *
 * 缺字段 / 越界 / 类型不对都单独回落，不因为 `align` 坏了就把宽度也一起丢掉。
 */
export function resolveHotzone(raw: unknown): HotzoneConfig {
  if (raw === null || typeof raw !== 'object') {
    return { ...DEFAULT_HOTZONE };
  }
  const record = raw as { widthPx?: unknown; align?: unknown };
  return {
    widthPx: clampHotzoneWidth(record.widthPx),
    align: isHotzoneAlign(record.align) ? record.align : DEFAULT_HOTZONE.align,
  };
}

/** 热区在视口中的横向区间（CSS 像素）。 */
export interface HotzoneBand {
  left: number;
  width: number;
}

/**
 * 计算热区的横向区间。
 *
 * 视口比热区还窄时（窄窗口 / 移动端模拟），宽度收敛到视口宽度——否则
 * `left` 会是负数，命中区间跑到屏幕外，热区反而在可见区域里失效。
 */
export function hotzoneBand(config: HotzoneConfig, viewportWidth: number): HotzoneBand {
  const safeViewport = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 0;
  const width = Math.min(clampHotzoneWidth(config.widthPx), safeViewport);
  const remaining = Math.max(0, safeViewport - width);
  const left =
    config.align === 'left' ? 0 : config.align === 'right' ? remaining : Math.round(remaining / 2);
  return { left, width };
}

/**
 * 横坐标是否落在热区内。
 *
 * `clientX` 缺失时返回 `true`（放行）。这不是宽松，是**兼容**：
 * - jsdom 没有 `PointerEvent`，`fireEvent.pointerMove` 到手的是没有坐标的普通
 *   `Event`；
 * - 部分合成事件（无障碍工具、脚本触发）同样不带坐标。
 *
 * 纵坐标缺失时组件已经直接忽略该事件（交给 `mousemove` 兜底），所以走到这里的
 * 坐标一定是"有 Y 没 X"的残缺情况。此时若判为"不在热区"，键盘/合成唤出路径
 * 会在测试与低版本 WebView 里整体失效；判为"在热区"最多是多重一次唤出，
 * 而唤出本身是幂等的。
 */
export function isWithinHotzoneX(
  clientX: number | undefined,
  config: HotzoneConfig,
  viewportWidth: number,
): boolean {
  if (typeof clientX !== 'number' || !Number.isFinite(clientX)) {
    return true;
  }
  const band = hotzoneBand(config, viewportWidth);
  return clientX >= band.left && clientX <= band.left + band.width;
}

/** 带 `webkit` 前缀的全屏属性（旧版 WebView2 / Safari）。 */
interface FullscreenDocument extends Document {
  webkitFullscreenElement?: Element | null;
}

/**
 * 当前是否处于全屏（PRD FR-02 验收要点「全屏应用前台时鼠标划过顶部不弹出」）。
 *
 * **Web 阶段只能看到浏览器自己的全屏**：按 F11、或页面调用了 Fullscreen API，
 * `document.fullscreenElement` 会有值。操作系统里另开的全屏游戏 / 播放器
 * 在浏览器进程之外，Web 版看不到，因此那条路径下热区仍会响应——这一点必须
 * 在设置页写明，不能靠"实现了全屏检测"让用户以为已经覆盖全部场景。
 *
 * `document` 可能不存在（SSR / 测试环境）：直接返回 false，让热区保持可用。
 */
export function isFullscreenActive(doc: Document | null | undefined): boolean {
  if (doc === null || doc === undefined) {
    return false;
  }
  if (doc.fullscreenElement !== null && doc.fullscreenElement !== undefined) {
    return true;
  }
  const prefixed = (doc as FullscreenDocument).webkitFullscreenElement;
  return prefixed !== null && prefixed !== undefined;
}
