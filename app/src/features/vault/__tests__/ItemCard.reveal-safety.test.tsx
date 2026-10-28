/**
 * ItemCard 明文生命周期回归（安全）。
 *
 * 断言的不是"能预览"，而是**明文一定会被丢掉**：
 * pointerleave / blur / 卸载 / 锁定（父组件卸载）四条路径都必须回到遮蔽态。
 *
 * 使用真实 VaultClient（ARGON2_TEST_PARAMS）+ 内存存储，不 mock 加密层。
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ItemCard } from '../ItemCard';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';
import type { ItemSummary } from '../../../core/vault/types';

const MASKED = '••••••••';

async function setup(): Promise<{ client: ReturnType<typeof createTestClient>['client']; item: ItemSummary }> {
  const { client } = createTestClient();
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  const item = await client.createItem({
    title: '普通站点',
    username: 'alice@example.test',
    password: 'Value-Alpha-1',
    visibility: 'normal',
  });
  return { client, item };
}

function card(item: ItemSummary): JSX.Element {
  return (
    <ItemCard
      item={item}
      now={Date.now()}
      onEdit={vi.fn()}
      onRequestDelete={vi.fn()}
      onChanged={vi.fn()}
    />
  );
}

describe('ItemCard 明文生命周期', () => {
  it('pointerleave 后立即恢复遮蔽', async () => {
    const { client, item } = await setup();
    renderWithProviders(client, card(item));

    const eye = screen.getByRole('button', { name: '预览密码' });
    fireEvent.pointerDown(eye);
    await waitFor(() => {
      expect(screen.getByTestId(`password-${item.id}`)).toHaveTextContent('Value-Alpha-1');
    });

    fireEvent.pointerOut(eye, { relatedTarget: null });
    await waitFor(() => {
      expect(screen.getByTestId(`password-${item.id}`)).toHaveTextContent(MASKED);
    });
    await client.dispose();
  });

  it('失焦（blur/focusout）后恢复遮蔽', async () => {
    const { client, item } = await setup();
    const { container } = renderWithProviders(client, card(item));

    const eye = screen.getByRole('button', { name: '预览密码' });
    fireEvent.pointerDown(eye);
    await waitFor(() => {
      expect(screen.getByTestId(`password-${item.id}`)).toHaveTextContent('Value-Alpha-1');
    });

    const tilt = container.querySelector('[data-tilt]');
    expect(tilt).not.toBeNull();
    fireEvent.focusOut(tilt as Element);

    await waitFor(() => {
      expect(screen.getByTestId(`password-${item.id}`)).toHaveTextContent(MASKED);
    });
    await client.dispose();
  });

  it('卸载后重新挂载，不会从任何全局状态"复活"明文', async () => {
    const { client, item } = await setup();
    const first = renderWithProviders(client, card(item));

    const eye = screen.getByRole('button', { name: '预览密码' });
    fireEvent.pointerDown(eye);
    await waitFor(() => {
      expect(screen.getByTestId(`password-${item.id}`)).toHaveTextContent('Value-Alpha-1');
    });

    first.unmount();

    renderWithProviders(client, card(item));
    expect(screen.getByTestId(`password-${item.id}`)).toHaveTextContent(MASKED);
    await client.dispose();
  });

  it('锁定后卡片被卸载，文档里不再残留明文', async () => {
    const { client, item } = await setup();
    const view = renderWithProviders(client, card(item));

    const eye = screen.getByRole('button', { name: '预览密码' });
    fireEvent.pointerDown(eye);
    await waitFor(() => {
      expect(screen.getByTestId(`password-${item.id}`)).toHaveTextContent('Value-Alpha-1');
    });

    // SessionGate 在 status !== 'unlocked' 时会整体卸载主面板。
    await client.lock('manual');
    view.unmount();

    expect(document.body.textContent ?? '').not.toContain('Value-Alpha-1');
    await client.dispose();
  });

  it('预览不会写入剪贴板，也不会污染最近使用', async () => {
    const { client, item } = await setup();
    renderWithProviders(client, card(item));

    const eye = screen.getByRole('button', { name: '预览密码' });
    fireEvent.pointerDown(eye);
    await waitFor(() => {
      expect(screen.getByTestId(`password-${item.id}`)).toHaveTextContent('Value-Alpha-1');
    });
    fireEvent.pointerUp(eye);

    expect(await client.getRecentItems()).toEqual([]);
    await client.dispose();
  });
});
