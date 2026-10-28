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
  neutral: 'bg-zinc-100 text-zinc-600 ring-zinc-200',
  info: 'bg-sky-50 text-sky-700 ring-sky-200',
  warning: 'bg-amber-50 text-amber-700 ring-amber-200',
  danger: 'bg-red-50 text-red-700 ring-red-200',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
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
