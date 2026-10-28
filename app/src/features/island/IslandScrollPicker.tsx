/**
 * 灵动岛「滑动线」选择器（滚轮驱动的卡片快速选择）。
 *
 * ## 为什么需要它
 *
 * 岛的常规路径是「唤出 → 搜索 → Enter」。但用户经常记不住标题怎么写，只记得
 * "我存过那个东西"，此时**翻**比**搜**快：鼠标停在岛上滚一下滚轮，全部卡片
 * 沿一条竖线排开，滚到哪张就是哪张，账号与密码各有独立复制入口。
 *
 * ## 三个设计决定
 *
 * 1. **不自己持有选中态**。选中项就是 `island.activeIndex`，与 ↑↓ 搜索列表
 *    共用一份。分成两份就会出现"滑动线指着 A、按 Enter 复制了 B"的分裂。
 * 2. **不复用 `<ul role="listbox">`**。那个列表由搜索框的 `aria-activedescendant`
 *    驱动，是 combobox 语义；这里是独立的一层浮层，混用会让读屏软件听到两套
 *    互相矛盾的"当前项"。这里用 `role="listbox"` + `aria-selected` 自成一体。
 * 3. **滑动线是装饰，名字才是内容**。竖线 + 滑块负责"我在第几个"的直觉，
 *    真正的可读信息是旁边的卡片名——所以名字字号比刻度大，且可点击。
 */

import type { JSX } from 'react';
import { KeyRound, User } from 'lucide-react';
import type { ItemSummary } from '../../core/vault/types';

export interface IslandScrollPickerProps {
  open: boolean;
  items: ItemSummary[];
  /** 当前选中下标（与岛的 `island.activeIndex` 同一份）。 */
  activeIndex: number;
  onActiveChange: (index: number) => void;
  /** 复制某一项的某个字段。账号与密码是两个独立动作。 */
  onCopy: (item: ItemSummary, field: 'username' | 'password') => void;
  onClose: () => void;
}

/** 每行高度（px）。滑块位置按它折算，避免用百分比在项数少时跳动。 */
const ROW_HEIGHT_PX = 30;

/** 视窗内最多显示几行。 */
const VISIBLE_ROWS = 6;

/**
 * 滑动线选择器。`open === false` 时渲染 `null`（不占位、不吃事件）。
 */
export function IslandScrollPicker({
  open,
  items,
  activeIndex,
  onActiveChange,
  onCopy,
  onClose,
}: IslandScrollPickerProps): JSX.Element | null {
  if (!open || items.length === 0) {
    return null;
  }

  const count = items.length;
  const safeIndex = Math.max(0, Math.min(activeIndex, count - 1));
  const active = items[safeIndex];
  const viewportHeight = Math.min(count, VISIBLE_ROWS) * ROW_HEIGHT_PX;
  /** 滑块位置：项数只有 1 时钉在顶部，否则按比例分布。 */
  const thumbTop = count <= 1 ? 0 : (safeIndex / (count - 1)) * (viewportHeight - 12);

  return (
    <div
      data-testid="island-scroll-picker"
      role="dialog"
      aria-label="滚轮选择卡片"
      className="absolute inset-x-0 bottom-0 top-[52px] z-20 flex flex-col gap-2 bg-zinc-950/88 px-4 pb-3 pt-2 backdrop-blur-sm"
    >
      <div className="flex min-h-0 flex-1 gap-3">
        {/**
         * 名字列：固定行高 + 容器滚动，保证"滚到第几个"与"看到第几行"一致。
         * `scrollTop` 由 `activeIndex` 反推，不用 ref 命令式滚动——项数变化时
         * 反推是纯函数，不会出现"列表变了但滚动位置停在旧处"的错位。
         */}
        <div
          className="relative min-w-0 flex-1 overflow-hidden"
          style={{ height: viewportHeight }}
          role="listbox"
          aria-label="已存放的卡片"
        >
          <div
            className="transition-transform duration-150 ease-out"
            style={{
              transform: `translateY(${-Math.max(0, safeIndex - Math.floor(VISIBLE_ROWS / 2)) * ROW_HEIGHT_PX}px)`,
            }}
          >
            {items.map((item, index) => (
              <div
                key={item.id}
                role="option"
                aria-selected={index === safeIndex}
                data-testid={`island-picker-option-${index}`}
                onMouseDown={(event) => {
                  // 与列表一致：保住面板层的键盘焦点，否则 ↑↓/Enter 立刻失效。
                  event.preventDefault();
                }}
                onClick={() => onActiveChange(index)}
                className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 text-xs transition-colors ${
                  index === safeIndex
                    ? 'bg-white/15 font-medium text-white'
                    : 'text-white/55 hover:bg-white/8 hover:text-white/80'
                }`}
                style={{ height: ROW_HEIGHT_PX }}
              >
                <span className="w-4 shrink-0 text-right font-mono text-[10px] text-white/30">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 滑动线：轨道 + 滑块。纯装饰，读屏跳过。 */}
        <div
          aria-hidden="true"
          className="relative w-1 shrink-0 rounded-full bg-white/10"
          style={{ height: viewportHeight }}
        >
          <div
            className="absolute inset-x-0 rounded-full bg-gradient-to-b from-white/90 to-white/40 transition-[top] duration-150 ease-out"
            style={{ top: thumbTop, height: 12 }}
          />
        </div>
      </div>

      {/**
       * 操作区：账号与密码**分开**两个按钮（线上反馈：只有复制密码不够用）。
       * 当前项的账号为空的卡片，账号按钮禁用并说明原因，而不是点了没反应。
       */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="island-picker-copy-username"
          disabled={active === undefined || !active.username}
          title={active?.username ? `复制「${active.title}」的账号` : '这张卡没有账号'}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            if (active !== undefined && active.username) {
              onCopy(active, 'username');
            }
          }}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-white/10 py-1.5 text-[11px] font-medium text-white/85 transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:cursor-not-allowed disabled:text-white/30 disabled:hover:bg-white/10"
        >
          <User aria-hidden="true" size={11} />
          复制账号
        </button>
        <button
          type="button"
          data-testid="island-picker-copy-password"
          disabled={active === undefined}
          title={active === undefined ? undefined : `复制「${active.title}」的密码`}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            if (active !== undefined) {
              onCopy(active, 'password');
            }
          }}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-white py-1.5 text-[11px] font-semibold text-zinc-900 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-40"
        >
          <KeyRound aria-hidden="true" size={11} />
          复制密码
        </button>
      </div>

      <p className="flex items-center justify-between text-[10px] text-white/35">
        <span>滚轮翻卡片 · Enter 复制密码 · ⇧Enter 复制账号</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-1 text-white/45 transition-colors hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          关闭
        </button>
      </p>
    </div>
  );
}
