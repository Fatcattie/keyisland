/**
 * 模态框：焦点陷阱 + Esc 关闭 + 焦点归还。
 *
 * 无障碍要求（SDD §6.4）：
 * - `role="dialog"` + `aria-modal="true"` + `aria-labelledby`；
 * - 打开时把焦点移到第一个可聚焦元素，Tab 在内部循环；
 * - 关闭后把焦点还给触发者，避免键盘用户"丢失位置"。
 */

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

/** 可聚焦元素选择器。 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** 面板宽度类名，默认 `max-w-lg`。 */
  widthClass?: string;
}

/** 模态框组件。 */
export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  widthClass = 'max-w-lg',
}: ModalProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const active = document.activeElement;
    previousFocus.current = active instanceof HTMLElement ? active : null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    first?.focus();
    return () => {
      previousFocus.current?.focus();
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (nodes.length === 0) {
      event.preventDefault();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-zinc-950/40 px-4 py-10 backdrop-blur-[2px]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby={description !== undefined ? 'modal-description' : undefined}
        onKeyDown={handleKeyDown}
        className={`w-full ${widthClass} rounded-card border border-line bg-surface shadow-card`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line-subtle px-6 py-4">
          <div>
            <h2 id="modal-title" className="text-sm font-semibold text-fg">
              {title}
            </h2>
            {description !== undefined ? (
              <p id="modal-description" className="mt-1 text-xs leading-5 text-fg-faint">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="rounded-full px-2 py-1 text-fg-faint transition-colors hover:bg-surface-sunken hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20"
          >
            ✕
          </button>
        </header>
        <div className="px-6 py-5">{children}</div>
        {footer !== undefined ? (
          <footer className="flex items-center justify-end gap-2 border-t border-line-subtle px-6 py-4">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
