/**
 * 按钮：统一的圆角、阴影与状态。
 * 支持 ref 转发，Modal 的焦点陷阱需要它。
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

/** 视觉变体。 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** 尺寸。 */
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 加载态：禁用交互并显示旋转指示。 */
  loading?: boolean;
  children?: ReactNode;
}

/** 各变体的静态类名。 */
const VARIANT_CLASS: Readonly<Record<ButtonVariant, string>> = Object.freeze({
  // 主按钮底/字是"反相色对"（accent / accent-fg）：亮色下黑底白字，
  // 深色下自动变成白底黑字。hover 用透明度压暗/压亮，两种主题都成立。
  // 禁用态单独给深色一套底：`line-strong`（zinc-600）配 `fg-faint` 在深色下几乎同亮度，
  // 字会糊在底里；亮色保持原样不动（那套灰底灰字是既有的、可接受的观感）。
  primary:
    'bg-accent text-accent-fg hover:bg-accent/90 active:bg-accent/80 disabled:bg-line-strong disabled:text-fg-faint dark:disabled:bg-surface-sunken',
  secondary:
    'border border-line bg-surface text-fg hover:border-line-strong hover:bg-surface-muted disabled:text-fg-faint',
  ghost: 'text-fg-subtle hover:bg-surface-sunken hover:text-fg disabled:text-fg-faint',
  // 危险色是固定的红，字必须始终是白：不能用 accent-fg（深色下会变成黑字）。
  danger: 'bg-red-600 text-white hover:bg-red-500 disabled:bg-red-200',
});

/** 尺寸类名。 */
const SIZE_CLASS: Readonly<Record<ButtonSize, string>> = Object.freeze({
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
});

/** 按钮组件。 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, className = '', children, disabled, ...rest },
  ref,
) {
  const classes = [
    'inline-flex select-none items-center justify-center gap-2 rounded-pill font-medium',
    'transition-colors duration-150',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20 focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
    'disabled:cursor-not-allowed',
    VARIANT_CLASS[variant],
    SIZE_CLASS[size],
    className,
  ]
    .filter((part) => part.length > 0)
    .join(' ');

  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden="true"
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
});
