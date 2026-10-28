/**
 * 通用 React hooks。
 */

import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './format';

/** 稳定的默认时钟，避免每次渲染都创建新函数导致 effect 反复执行。 */
const systemNow = (): number => Date.now();

/**
 * 距离 `until` 的剩余毫秒数，每 500ms 刷新一次。
 *
 * @param until 目标时间戳；`null` 表示没有截止时间（返回 0）。
 * @param now 注入时钟，测试可完全控制。
 */
export function useCountdown(until: number | null, now: () => number = systemNow): number {
  const nowRef = useRef(now);
  nowRef.current = now;
  const [remaining, setRemaining] = useState(() =>
    until === null ? 0 : Math.max(0, until - nowRef.current()),
  );

  useEffect(() => {
    if (until === null) {
      setRemaining(0);
      return;
    }
    const tick = (): void => {
      setRemaining(Math.max(0, until - nowRef.current()));
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => {
      clearInterval(timer);
    };
  }, [until]);

  return remaining;
}

/**
 * 是否处于"减少动效"模式。
 * 通过 `matchMedia` 订阅变化，避免用户在系统设置里切换后需要刷新。
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => prefersReducedMotion());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    let query: MediaQueryList;
    try {
      query = window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return;
    }
    const handleChange = (): void => {
      setReduced(query.matches);
    };
    handleChange();
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', handleChange);
      return () => {
        query.removeEventListener('change', handleChange);
      };
    }
    return;
  }, []);

  return reduced;
}

/** 防抖值：输入框搜索用，避免每次按键都触发一次全表过滤。 */
export function useDebouncedValue<T>(value: T, delayMs = 120): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debounced;
}
