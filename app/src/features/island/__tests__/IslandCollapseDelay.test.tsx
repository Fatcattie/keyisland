/**
 * 展开态收起延时（PRD FR-02「鼠标离开 2 秒后自动收起」/ SDD §6.5「默认 2s，可配置」）。
 *
 * 四条契约：
 * 1. 默认 2 秒：1900ms 时面板还在，2100ms 后消失；
 * 2. 配置生效：设为 500ms 后 600ms 就收起；
 * 3. 胶囊态不受配置影响：即使把延时设成 3 秒，胶囊离开 250ms 就消失；
 * 4. 鼠标在页面上持续移动**不会无限续期**——2 秒的倒计时从"离开那一刻"起算，
 *    不能因为用户还在动鼠标就一直重排。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { Island } from '../Island';
import { createTestClient, renderWithProviders, MASTER_PASSWORD } from '../../__tests__/support/harness';
import { useUiStore } from '../../../stores/ui-store';

async function flushAsyncEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
}

beforeEach(() => {
  useUiStore.setState({
    island: { phase: 'collapsed', query: '', activeIndex: 0, focused: false },
    session: { status: 'unlocked', cooldownUntil: null },
    hotzone: { widthPx: 300, align: 'center' },
    collapseDelayMs: 2000,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** 渲染一座已解锁的灵动岛，可先写入收起延时。 */
async function renderIsland(collapseDelayMs?: number): Promise<void> {
  const harness = createTestClient();
  await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
  if (collapseDelayMs !== undefined) {
    await harness.client.setCollapseDelay(collapseDelayMs);
  }
  renderWithProviders(
    harness.client,
    <Island status="unlocked" onLock={() => {}} onRequestUnlock={() => {}} onOpenSettings={() => {}} />,
  );
  await flushAsyncEffects();
}

/** 唤出胶囊并展开面板。 */
async function expand(): Promise<void> {
  fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
  fireEvent.click(screen.getByRole('button', { name: '展开密岛' }));
  expect(screen.getByTestId('island-panel')).toBeDefined();
}

/** 推进假定时钟（包在 act 里，避免异步 setState 落在 act 之外）。 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('FR-02 · 展开态收起延时', () => {
  it('默认 2 秒：1900ms 时还在，2100ms 后消失', async () => {
    await renderIsland();
    await expand();

    vi.useFakeTimers();
    fireEvent.mouseMove(window, { clientX: 512, clientY: 400 });

    await advance(1900);
    expect(screen.getByTestId('island-panel')).toBeDefined();

    await advance(200);
    expect(screen.queryByTestId('island-panel')).toBeNull();
  });

  it('设成 500ms：600ms 后就收起', async () => {
    await renderIsland(500);
    await expand();

    vi.useFakeTimers();
    fireEvent.mouseMove(window, { clientX: 512, clientY: 400 });

    await advance(600);
    expect(screen.queryByTestId('island-panel')).toBeNull();
  });

  it('胶囊态不受配置影响：设成 3 秒，胶囊离开 250ms 仍会消失', async () => {
    await renderIsland(3000);

    fireEvent.mouseMove(window, { clientX: 512, clientY: 0 });
    expect(screen.getByRole('button', { name: '展开密岛' })).toBeDefined();

    vi.useFakeTimers();
    fireEvent.mouseMove(window, { clientX: 512, clientY: 400 });
    await advance(300);

    expect(screen.queryByRole('button', { name: '展开密岛' })).toBeNull();
  });

  it('鼠标在页面上持续移动不会给倒计时续期', async () => {
    await renderIsland();
    await expand();

    vi.useFakeTimers();
    fireEvent.mouseMove(window, { clientX: 512, clientY: 400 });
    await advance(1500);

    // 用户还在页面上晃鼠标：不能因此把 2 秒重新开始算。
    fireEvent.mouseMove(window, { clientX: 300, clientY: 500 });
    await advance(600);

    expect(screen.queryByTestId('island-panel')).toBeNull();
  });
});
