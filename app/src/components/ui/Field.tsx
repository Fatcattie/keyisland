/**
 * 表单字段容器：label + 控件 + 提示/错误。
 * 错误通过 `role="alert"` 播报，保证屏幕阅读器能读到校验结果。
 */

import type { ReactNode } from 'react';

export interface FieldProps {
  label: string;
  /** 关联控件的 id，用于 label 的 htmlFor。 */
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}

/** 字段容器。 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required = false,
  children,
}: FieldProps): JSX.Element {
  const hintId = htmlFor !== undefined ? `${htmlFor}-hint` : undefined;
  const errorId = htmlFor !== undefined ? `${htmlFor}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-fg-muted">
        {label}
        {required ? (
          <span className="ml-1 text-red-600" aria-hidden="true">
            *
          </span>
        ) : null}
        {required ? <span className="sr-only">（必填）</span> : null}
      </label>
      {children}
      {hint !== undefined && error === undefined ? (
        <p id={hintId} className="text-[11px] leading-4 text-fg-faint">
          {hint}
        </p>
      ) : null}
      {error !== undefined && error !== null ? (
        <p id={errorId} role="alert" className="text-[11px] leading-4 text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** 统一输入框样式，供各表单复用。 */
export const INPUT_CLASS =
  'h-10 w-full rounded-pill border border-line bg-surface px-4 text-sm text-fg ' +
  'placeholder:text-fg-faint focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-accent/10 ' +
  'disabled:bg-surface-muted disabled:text-fg-faint';

/** 多行输入样式。 */
export const TEXTAREA_CLASS =
  'min-h-[80px] w-full rounded-2xl border border-line bg-surface px-4 py-2.5 text-sm text-fg ' +
  'placeholder:text-fg-faint focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-accent/10';
