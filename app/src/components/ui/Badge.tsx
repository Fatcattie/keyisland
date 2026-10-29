/**
 * 角标：可见性档位、收藏等轻量标记。
 */

import type { ReactNode } from 'react';

/** 语义色。 */
export type BadgeTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success';

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  /** 屏幕阅读器补充说明。 */
  title?: string;
}

/** 各语义色的类名。 */
const TONE_CLASS: Readonly<Record<BadgeTone, string>> = Object.freeze({
  neutral: 'bg-surface-sunken text-fg-subtle ring-line',
  // 彩色角标在深色主题下要压暗底、提亮字，否则一整块浅粉/浅绿会糊在深色卡片上。
  info: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/30',
  warning:
    'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30',
  danger: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30',
  success:
    'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30',
});

/** 角标组件。 */
export function Badge({ tone = 'neutral', children, title }: BadgeProps): JSX.Element {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}
