/**
 * 灵动岛收起时序（PRD FR-02「收起：鼠标离开 2 秒后自动收起」，
 * SDD §6.5「生产默认 2s，并允许用户在设置中配置」）。
 *
 * 为什么有两个延时：
 *
 * PRD 的"2 秒收起"说的是**工具栏**——也就是展开后的面板。实现里多了一个
 * PRD 没有描述的中间态：鼠标刚碰到顶部热区时先滑出一枚折叠胶囊，点它才展开。
 * 胶囊只有 88×32px 且可点击，若也挂 2 秒，用户只是路过顶边就会被一枚悬浮按钮
 * 挡住 2 秒；所以胶囊用短延时（探一下就消失），面板用可配置的长延时。
 *
 * 这个区分必须写进设置页文案——用户看到的"收起延时"只对面板生效，
 * 不解释清楚就会出现"我设了 3 秒，怎么胶囊还是马上就没了"。
 */

/** 展开态离开后的收起延时档位（ms）。 */
export const COLLAPSE_DELAY_OPTIONS: readonly number[] = [500, 1000, 2000, 3000];

/** 默认 2 秒：PRD 与 SDD §6.5 一致。 */
export const DEFAULT_COLLAPSE_DELAY_MS = 2000;

/** 折叠胶囊态的隐藏延时：短到"探一下就消失"，不遮挡页面顶部的点击。 */
export const PEEK_HIDE_DELAY_MS = 250;

/**
 * 收起延时是否合法。
 *
 * 只接受档位里的值，而不是"任意 0–10000 的整数"：设置页是下拉框，
 * 能选出来的只有这几个；放开任意值只会让"越界该报错还是该夹取"重新变成争议。
 */
export function isValidCollapseDelay(value: unknown): value is number {
  return typeof value === 'number' && COLLAPSE_DELAY_OPTIONS.includes(value);
}

/** 把可能残缺的存储值解析成合法延时（缺字段 / 非法值回落默认 2 秒）。 */
export function resolveCollapseDelay(value: unknown): number {
  return isValidCollapseDelay(value) ? value : DEFAULT_COLLAPSE_DELAY_MS;
}

/**
 * 展开态「停留时长」档位（ms）：**无操作**多久之后自动隐藏。
 *
 * 与上面的「收起延时」是两件事，必须分开存：
 * - 收起延时管"鼠标离开之后多久收"，只由指针位置触发；
 * - 停留时长管"展开之后最多待多久"，由**空闲**触发——指针一直停在岛上也照样收。
 *
 * 合成一个值会互相打架：把 0.5 秒当停留时长会把面板"闪"没，把 30 秒当收起
 * 延时又会让"鼠标移开就收起"变得毫无意义。
 *
 * 档位从 5 秒起：读一屏 6 条卡片需要时间，2 秒属于"还没看清就没了"。
 */
export const DWELL_DELAY_OPTIONS: readonly number[] = [5000, 10000, 20000, 30000, 60000];

/** 默认 10 秒：够读完一屏、又不至于长期占着屏幕。 */
export const DEFAULT_DWELL_DELAY_MS = 10000;

/** 停留时长是否合法（同样只认档位）。 */
export function isValidDwellDelay(value: unknown): value is number {
  return typeof value === 'number' && DWELL_DELAY_OPTIONS.includes(value);
}

/** 解析停留时长（缺字段 / 非法值回落默认 10 秒）。 */
export function resolveDwellDelay(value: unknown): number {
  return isValidDwellDelay(value) ? value : DEFAULT_DWELL_DELAY_MS;
}
