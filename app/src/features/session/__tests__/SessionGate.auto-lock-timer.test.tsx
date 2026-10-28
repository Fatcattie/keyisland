/**
 * 会话门 · 闲置超时自动锁定（时效性）。
 *
 * `session` 的超时判定是"惰性"的——只在 `status()` 被调用时才落锁。
 * 若没有到期定时器，用户把页面开着不动，到期后主面板会一直留在屏幕上
 * （卡片标题/平台照旧可见），直到下一次 focus 或操作才切换成解锁页。
 *
 * 本测试证明：到期点 `SessionGate` 会主动 `refresh()`，主面板收起、解锁页出现，
 * **不需要任何用户操作**。
 *
 * 只 fake `setTimeout` / `Date`，不 fake `setInterval`：
 * 主面板的倒计时用 `setInterval` 每秒 tick，若一并 fake，推进 5 分钟会触发
 * 数百次 setState；保持真实 setInterval 可让测试只推进我们关心的那个到期定时器。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { SessionGate } from '../SessionGate';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** 让挂起的微任务（status()/refresh()）落定。 */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('闲置超时自动锁定', () => {
  it('到期后主动收起主面板（无需用户操作）', async () => {
    // 先建库（Argon2 走真实定时器），再开假定时器，避免 WASM 异步被冻结。
    const test = createTestClient('5m');
    await test.client.initialize({ masterPassword: MASTER_PASSWORD });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    renderWithProviders(test.client, <SessionGate />);
    await flushMicrotasks();
    expect(document.getElementById('main-search')).not.toBeNull();

    // 到期：会话时钟与页面定时器一起推进。
    await act(async () => {
      test.advance(5 * 60 * 1000 + 1000);
      vi.advanceTimersByTime(5 * 60 * 1000 + 2000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.getElementById('unlock-password')).not.toBeNull();
    expect(document.getElementById('main-search')).toBeNull();
  });
});
