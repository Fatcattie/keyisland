/**
 * 首次设置向导的回归测试。
 *
 * 覆盖：弱密码不可推进、两次输入不一致、未勾选"已离线保存"不可完成、完成后回调。
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { SetupWizard } from '../SetupWizard';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** 取主密码输入框（label 里含必填标记，用前缀匹配）。 */
function passwordInput(): HTMLInputElement {
  return screen.getByLabelText(/^主密码/) as HTMLInputElement;
}

/** 取确认输入框。 */
function confirmInput(): HTMLInputElement {
  return screen.getByLabelText(/^再次输入主密码/) as HTMLInputElement;
}

describe('SetupWizard 首次设置', () => {
  it('弱密码无法进入下一步', async () => {
    const { client } = createTestClient();
    renderWithProviders(client, <SetupWizard onReady={vi.fn()} />);

    fireEvent.change(passwordInput(), { target: { value: 'aaaaaaaa' } });
    fireEvent.change(confirmInput(), { target: { value: 'aaaaaaaa' } });
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/主密码强度不足/);
    // 仍停留在第 1 步。
    expect(screen.getByText('设置主密码')).toBeInTheDocument();
  });

  it('两次输入不一致时报错且不推进', async () => {
    const { client } = createTestClient();
    renderWithProviders(client, <SetupWizard onReady={vi.fn()} />);

    fireEvent.change(passwordInput(), { target: { value: MASTER_PASSWORD } });
    fireEvent.change(confirmInput(), { target: { value: `${MASTER_PASSWORD}-x` } });
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('两次输入的主密码不一致');
    expect(screen.getByText('设置主密码')).toBeInTheDocument();
  });

  it('未勾选"已离线保存"时无法完成', async () => {
    const onReady = vi.fn();
    const { client } = createTestClient();
    renderWithProviders(client, <SetupWizard onReady={onReady} />);

    fireEvent.change(passwordInput(), { target: { value: MASTER_PASSWORD } });
    fireEvent.change(confirmInput(), { target: { value: MASTER_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));

    fireEvent.click(await screen.findByRole('button', { name: '创建保险库' }));

    const code = await screen.findByTestId('recovery-code', {}, { timeout: 8000 });
    expect(code.textContent?.replace(/-/gu, '')).toHaveLength(32);

    const finish = screen.getByRole('button', { name: '进入密岛' });
    expect(finish).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/我已将恢复码离线保存/));
    expect(finish).toBeEnabled();

    fireEvent.click(finish);
    await waitFor(() => {
      expect(onReady).toHaveBeenCalledTimes(1);
    });
  });

  it('密码提示会随初始化一起提交', async () => {
    const { client } = createTestClient();
    renderWithProviders(client, <SetupWizard onReady={vi.fn()} />);

    fireEvent.change(passwordInput(), { target: { value: MASTER_PASSWORD } });
    fireEvent.change(confirmInput(), { target: { value: MASTER_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));

    const hint = await screen.findByLabelText(/密码提示/);
    fireEvent.change(hint, { target: { value: '常用的那句歌词' } });
    fireEvent.click(screen.getByRole('button', { name: '创建保险库' }));

    await screen.findByTestId('recovery-code', {}, { timeout: 8000 });
    expect(await client.getPasswordHint()).toBe('常用的那句歌词');
  });
});
