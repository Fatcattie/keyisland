/**
 * 轻提示（Toast）。
 *
 * 用途：复制回执、授权过期等"不需要用户决策"的反馈。
 * 文案由调用方拼好（已经过 `i18n` 翻译），这里不做错误码解析。
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/** 单条提示。 */
interface ToastRecord {
  id: number;
  message: string;
}

/** 默认存活时长。 */
const TOAST_TTL_MS = 3200;

const ToastContext = createContext<((message: string) => void) | null>(null);

export interface ToastProviderProps {
  children: ReactNode;
}

/** 提示容器。 */
export function ToastProvider({ children }: ToastProviderProps): JSX.Element {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);
  const timers = useRef<number[]>([]);

  const show = useCallback((message: string): void => {
    const id = nextId.current;
    nextId.current += 1;
    setToasts((previous) => [...previous, { id, message }]);
    const timer = window.setTimeout(() => {
      setToasts((previous) => previous.filter((toast) => toast.id !== id));
    }, TOAST_TTL_MS);
    timers.current.push(timer);
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="rounded-pill bg-zinc-900/95 px-4 py-2 text-xs font-medium text-white shadow-card"
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** 取提示函数。 */
export function useToast(): (message: string) => void {
  const show = useContext(ToastContext);
  if (show === null) {
    throw new Error('useToast 必须在 ToastProvider 内使用');
  }
  return show;
}
