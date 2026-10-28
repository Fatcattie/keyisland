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
  primary:
    'bg-zinc-900 text-white hover:bg-zinc-800 active:bg-black disabled:bg-zinc-300 disabled:text-zinc-500',
  secondary:
    'border border-zinc-200 bg-white text-zinc-800 hover:border-zinc-300 hover:bg-zinc-50 disabled:text-zinc-400',
  ghost: 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 disabled:text-zinc-300',
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
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20 focus-visible:ring-offset-2',
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
