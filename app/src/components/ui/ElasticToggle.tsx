/**
 * 弹性开关（白天 / 黑夜切换）。
 *
 * ## 动效为什么这么写
 *
 * 1. **轨道换色用 CSS transition（250ms），滑块的位移用 spring**：换色是"底色渐变"，
 *    用 CSS 最省事且不受 JS 帧率影响；位移要手感，交给 spring。
 * 2. **滑块在移动中会被"拉长"**：可见的白色圆球不是滑动的那个元素本身，而是它的
 *    **子元素**——外层负责 `x` 位移，内层用 `useAnimationControls` 跑
 *    `scaleX [1, 1.4, 1]` / `scaleY [1, 0.78, 1]` 的关键帧，中途变成横向椭圆再弹回。
 *    分两层是必须的：同一个元素上既写 spring 的 `x` 又写关键帧 `scaleX`，
 *    两套 transition 会互相覆盖。
 * 3. **只在"值变化"时抖一次**：首次挂载不该弹，否则一进页面就抖一下。
 *    用 `useRef` 记住首帧。
 * 4. 尊重 `prefers-reduced-motion`：关掉拉长与旋转，只保留位移（位移是信息，不是装饰）。
 */

import { useEffect, useRef, type JSX } from 'react';
import { motion, useAnimationControls, type Transition } from 'framer-motion';
import { Moon, Sun } from 'lucide-react';
import { usePrefersReducedMotion } from '../../lib/hooks';

export interface ElasticToggleProps {
  /** 当前是否"开"（= 黑夜）。 */
  checked: boolean;
  /** 切换回调。参数是**切换后**的目标值，不是"取反"指令。 */
  onCheckedChange: (checked: boolean) => void;
  /** 读屏用的名字。 */
  label?: string;
  disabled?: boolean;
  /** 额外的 class，用于外部控制外边距等布局。 */
  className?: string;
}

/** 轨道尺寸（px）。与 Tailwind 的 `h-8 w-14` 一致，写在这里是为了算滑块行程。 */
const TRACK_W = 56;
const TRACK_H = 32;
const KNOB = 24;
const PAD = (TRACK_H - KNOB) / 2;
/** 滑块行程：轨道宽 − 两侧内边距 − 滑块宽 = 24。 */
const TRAVEL = TRACK_W - PAD * 2 - KNOB;

/** 拉长动画：450ms，中点最扁。 */
const STRETCH_TRANSITION: Transition = {
  duration: 0.45,
  times: [0, 0.45, 1],
  ease: 'easeOut',
};

/** 位移手感：硬一点的 spring，避免"慢慢飘过去"。 */
const SLIDE_TRANSITION: Transition = { type: 'spring', stiffness: 500, damping: 28 };

/** 图标交叉淡入淡出。 */
const ICON_TRANSITION: Transition = { duration: 0.2 };

export function ElasticToggle({
  checked,
  onCheckedChange,
  label = '深色模式',
  disabled = false,
  className = '',
}: ElasticToggleProps): JSX.Element {
  const stretch = useAnimationControls();
  const reducedMotion = usePrefersReducedMotion();
  const mounted = useRef(false);

  useEffect(() => {
    // 首次挂载不抖：用户没做任何操作，动效只会显得"页面在抽"。
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (reducedMotion) {
      return;
    }
    void stretch.start({
      scaleX: [1, 1.4, 1],
      scaleY: [1, 0.78, 1],
      transition: STRETCH_TRANSITION,
    });
  }, [checked, reducedMotion, stretch]);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      data-testid="elastic-toggle"
      /*
       * 轨道色严格按规格写死 zinc-200 ⇄ zinc-950（不跟随主题令牌）：
       * 这个开关本身就是"主题的显示器"，跟着主题变色会让它自我指涉。
       * 代价是深色主题下 zinc-950 轨道与近黑的侧栏底几乎同色，
       * 所以补一圈极淡的内描边把形状"勾"出来——只是描边，不改底色。
       */
      className={`relative shrink-0 rounded-full ring-1 ring-inset ring-black/5 transition-colors duration-[250ms] ease-out dark:ring-white/15 ${
        checked ? 'bg-zinc-950' : 'bg-zinc-200'
      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${className}`}
      style={{ width: TRACK_W, height: TRACK_H }}
    >
      {/* 外层：只负责位移。 */}
      <motion.span
        className="absolute block"
        style={{ width: KNOB, height: KNOB, top: PAD, left: PAD }}
        animate={{ x: checked ? TRAVEL : 0 }}
        transition={SLIDE_TRANSITION}
      >
        {/*
         * 内层：只负责拉长。两层分开，两套 transition 才不会互相覆盖。
         * 圆钮恒为白色（规格要求），**不能**用 `bg-surface`：深色主题下那会变成深灰，
         * 白钮是这套控件的识别点，必须与主题解耦。
         */}
        <motion.span
          animate={stretch}
          className="relative flex h-full w-full items-center justify-center rounded-full bg-white shadow-sm"
        >
          <motion.span
            className="absolute flex items-center justify-center text-amber-500"
            animate={{
              opacity: checked ? 0 : 1,
              scale: checked ? 0.4 : 1,
              rotate: checked ? -90 : 0,
            }}
            transition={ICON_TRANSITION}
            aria-hidden="true"
          >
            <Sun size={12} />
          </motion.span>
          <motion.span
            className="absolute flex items-center justify-center text-zinc-700"
            animate={{
              opacity: checked ? 1 : 0,
              scale: checked ? 1 : 0.4,
              rotate: checked ? 0 : 90,
            }}
            transition={ICON_TRANSITION}
            aria-hidden="true"
          >
            <Moon size={12} />
          </motion.span>
        </motion.span>
      </motion.span>
    </button>
  );
}
