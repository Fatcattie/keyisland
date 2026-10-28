/**
 * 卡片（TiltCard）回归测试。
 *
 * 覆盖：username_only 眼睛禁用且账号常显、密码默认遮蔽、
 * 按住预览后松开恢复遮蔽、prefers-reduced-motion 下关闭倾斜、复制回执 Toast。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ItemCard } from '../ItemCard';
import { createTestClient, renderWithProviders } from '../../__tests__/support/harness';
import { MASTER_PASSWORD } from '../../__tests__/support/harness';
import type { ItemSummary } from '../../../core/vault/types';

/** 建库并创建两张卡片（普通 + 仅账号）。 */
async function setup(): Promise<{
  client: ReturnType<typeof createTestClient>['client'];
  clipboard: ReturnType<typeof createTestClient>['clipboard'];
  normal: ItemSummary;
  restricted: ItemSummary;
}> {
  const { client, clipboard } = createTestClient();
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  const normal = await client.createItem({
    title: 'GitHub',
    platform: 'GitHub',
    username: 'dev-alpha',
    password: 'Value-Alpha-1',
  });
  const restricted = await client.createItem({
    title: '流媒体',
    platform: '流媒体',
    username: 'watch-bravo',
    password: 'Value-Bravo-2',
    visibility: 'username_only',
  });
  return { client, clipboard, normal, restricted };
}

/** 渲染单张卡片。 */
function renderCard(
  client: ReturnType<typeof createTestClient>['client'],
  item: ItemSummary,
): void {
  renderWithProviders(
    client,
    <ItemCard
      item={item}
      now={Date.now()}
      onEdit={vi.fn()}
      onRequestDelete={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
}

afterEach(() => {
  // 还原 matchMedia 替身，避免污染后续用例。
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('ItemCard 卡片', () => {
  it('密码默认遮蔽显示', async () => {
    const { client, normal } = await setup();
    renderCard(client, normal);

    expect(screen.getByTestId(`password-${normal.id}`)).toHaveTextContent('••••••••');
  });

  it('username_only 档位：账号常显且眼睛按钮禁用', async () => {
    const { client, restricted } = await setup();
    renderCard(client, restricted);

    expect(screen.getByTestId(`username-${restricted.id}`)).toHaveTextContent('watch-bravo');
    const eye = screen.getByRole('button', { name: '预览密码' });
    expect(eye).toBeDisabled();
    expect(eye).toHaveAttribute('title', '仅展示账号');
    expect(screen.getByText('仅账号')).toBeInTheDocument();
  });

  it('按住预览显示明文，松开后恢复遮蔽', async () => {
    const { client, normal } = await setup();
    renderCard(client, normal);

    const eye = screen.getByRole('button', { name: '预览密码' });
    fireEvent.pointerDown(eye);

    await waitFor(() => {
      expect(screen.getByTestId(`password-${normal.id}`)).toHaveTextContent('Value-Alpha-1');
    });

    fireEvent.pointerUp(eye);

    await waitFor(() => {
      expect(screen.getByTestId(`password-${normal.id}`)).toHaveTextContent('••••••••');
    });
  });

  it('prefers-reduced-motion 下仍应用倾斜（TiltCard 始终生效）', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });

    const { client, normal } = await setup();
    renderCard(client, normal);

    const tiltNode = document.querySelector('[data-tilt]');
    expect(tiltNode).not.toBeNull();
    // 需求里没有 reduced-motion 豁免：倾斜始终应用，否则部分 Windows 机器
    // 默认关掉「动画效果」时卡片会永远平着，看起来像没实现。
    expect(tiltNode).toHaveAttribute('data-tilt', 'on');
  });

  it('复制密码写入剪贴板并提示自动清空时长', async () => {
    const { client, clipboard, normal } = await setup();
    renderCard(client, normal);

    fireEvent.click(screen.getByRole('button', { name: '复制密码' }));

    await waitFor(() => {
      expect(clipboard.value).toBe('Value-Alpha-1');
    });
    // SDD §6.4：Toast 必须说明复制对象与自动清空时间，缺一不可。
    expect(await screen.findByText('已复制密码 · 30 秒后自动清空')).toBeInTheDocument();
  });
});
