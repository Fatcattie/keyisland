/**
 * 热区宽度 / 位置与全屏抑制（PRD FR-02「默认宽约 300px，可配置宽度与位置」
 * 与验收要点「全屏应用前台时鼠标划过顶部不弹出」）。
 *
 * jsdom 的 `window.innerWidth` 是 1024，所以"居中 300px"的区间是
 * [362, 662]。用例按这个基准写死数字，比在测试里再算一遍更能抓住回归——
 * 算错了两边一起错，断言就成了自证。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { Island } from '../Island';
import { createTestClient, renderWithProviders, MASTER_PASSWORD } from '../../__tests__/support/harness';
import { useUiStore } from '../../../stores/ui-store';

/** 让挂载后的异步 setState（拉热区配置、拉最近使用）在 act 内落地。 */
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
  });
});

afterEach(() => {
  // 全屏桩必须复位，否则会污染后续用例（它们期望"不全屏"）。
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => null,
  });
});

/** 渲染一座已解锁的灵动岛，可先写入热区配置。 */
async function renderIsland(config?: { widthPx?: number; align?: 'left' | 'center' | 'right' }): Promise<void> {
  const harness = createTestClient();
  await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
  if (config !== undefined) {
    await harness.client.setHotzoneConfig(config);
  }
  renderWithProviders(
    harness.client,
    <Island status="unlocked" onLock={() => {}} onRequestUnlock={() => {}} onOpenSettings={() => {}} />,
  );
  await flushAsyncEffects();
}

describe('Island 热区宽度与位置', () => {
  it('默认 300px 居中：DOM 锚点与命中带一致（1024 视口下 left=362）', async () => {
    await renderIsland();

    const hotzone = screen.getByTestId('island-hotzone');
    expect(hotzone.getAttribute('data-width')).toBe('300');
    expect(hotzone.getAttribute('data-align')).toBe('center');
    expect(hotzone.style.left).toBe('362px');
    expect(hotzone.style.width).toBe('300px');
  });

  it('设置改过之后按新配置渲染（600px 靠左）', async () => {
    await renderIsland({ widthPx: 600, align: 'left' });

    const hotzone = screen.getByTestId('island-hotzone');
    expect(hotzone.getAttribute('data-width')).toBe('600');
    expect(hotzone.getAttribute('data-align')).toBe('left');
    expect(hotzone.style.left).toBe('0px');
    expect(hotzone.style.width).toBe('600px');
  });

  it('横向落在热区外：不唤出；落在带内：唤出', async () => {
    await renderIsland();

    // 默认区间 [362, 662]。100 在屏幕左侧，离热区很远。
    fireEvent.mouseMove(window, { clientY: 0, clientX: 100 });
    expect(screen.queryByRole('button', { name: '展开密岛' })).toBeNull();

    fireEvent.mouseMove(window, { clientY: 0, clientX: 512 });
    expect(screen.getByRole('button', { name: '展开密岛' })).toBeDefined();
  });

  it('全屏时不唤出（浏览器全屏路径）', async () => {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => document.body,
    });

    await renderIsland();

    fireEvent.mouseMove(window, { clientY: 0, clientX: 512 });
    expect(screen.queryByRole('button', { name: '展开密岛' })).toBeNull();
  });
});
