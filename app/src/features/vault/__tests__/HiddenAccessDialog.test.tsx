/**
 * 隐藏卡片授权弹窗回归测试。
 *
 * 覆盖：无授权不显示列表、密码错误不授权且显示剩余次数、正确密码授权回调、
 * 授权到期后自动退出。
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HiddenAccessDialog } from '../HiddenAccessDialog';
import { HIDDEN_ACCESS_WINDOW_MS } from '../../../services/vault-client';
import {
  MASTER_PASSWORD,
  OTHER_PASSWORD,
  createTestClient,
  renderWithProviders,
} from '../../__tests__/support/harness';

/** 建库并创建一张隐藏卡片。 */
async function setup(): Promise<ReturnType<typeof createTestClient>> {
  const harness = createTestClient();
  await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
  await harness.client.createItem({
    title: '隐藏卡',
    platform: '内部系统',
    username: 'secret-user',
    password: 'Value-Hidden-1',
    visibility: 'hidden',
  });
  return harness;
}

/** 输入主密码并提交。 */
function submitPassword(value: string): void {
  fireEvent.change(screen.getByLabelText(/^主密码/), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: '验证并查看' }));
}

describe('HiddenAccessDialog 隐藏卡片授权', () => {
  it('未授权时不展示隐藏列表', async () => {
    const harness = await setup();
    const onGranted = vi.fn();

    renderWithProviders(
      harness.client,
      <HiddenAccessDialog open onClose={vi.fn()} onGranted={onGranted} now={harness.now} />,
    );

    expect(screen.getByText('访问隐藏卡片')).toBeInTheDocument();
    expect(screen.queryByText('隐藏卡')).toBeNull();
    expect(onGranted).not.toHaveBeenCalled();
  });

  it('密码错误不发放授权，并显示剩余可试次数', async () => {
    const harness = await setup();
    const onGranted = vi.fn();

    renderWithProviders(
      harness.client,
      <HiddenAccessDialog open onClose={vi.fn()} onGranted={onGranted} now={harness.now} />,
    );

    submitPassword(OTHER_PASSWORD);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('主密码不正确');
    expect(alert).toHaveTextContent('还可尝试 4 次');
    expect(onGranted).not.toHaveBeenCalled();

    // 直接问核心层：确实没有授权。
    await expect(harness.client.listItems({ includeHidden: true })).rejects.toMatchObject({
      code: 'ITEM_HIDDEN',
    });
  });

  it('密码正确后回调隐藏列表与授权窗口', async () => {
    const harness = await setup();
    const onGranted = vi.fn();

    renderWithProviders(
      harness.client,
      <HiddenAccessDialog open onClose={vi.fn()} onGranted={onGranted} now={harness.now} />,
    );

    submitPassword(MASTER_PASSWORD);

    await waitFor(() => {
      expect(onGranted).toHaveBeenCalledTimes(1);
    });
    const [items, grant] = onGranted.mock.calls[0] as [
      Array<{ title: string }>,
      { grantedUntil: number },
    ];
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('隐藏卡');
    expect(grant.grantedUntil).toBe(harness.now() + HIDDEN_ACCESS_WINDOW_MS);

    expect(await screen.findByText(/授权剩余/)).toBeInTheDocument();
  });

  it('授权到期后自动退出隐藏视图', async () => {
    const harness = await setup();
    const onClose = vi.fn();

    renderWithProviders(
      harness.client,
      <HiddenAccessDialog open onClose={onClose} onGranted={vi.fn()} now={harness.now} />,
    );

    submitPassword(MASTER_PASSWORD);
    await screen.findByText(/授权剩余/);

    harness.advance(HIDDEN_ACCESS_WINDOW_MS);

    await waitFor(
      () => {
        expect(onClose).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );
    expect(await screen.findByText('隐藏卡片授权已过期')).toBeInTheDocument();
  });
});
