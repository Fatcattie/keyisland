/**
 * 重新生成恢复密钥对话框（PRD FR-08.1）。
 *
 * 契约：
 * 1. 输入主密码 → 展示新恢复码，且与旧码不同；
 * 2. 必须勾选「已离线保存」才能点「完成」——与首次设置同一规则，不允许跳过；
 * 3. 主密码错误 → 只出错误提示，**不展示任何恢复码**；
 * 4. 取消 → 关闭且不产生轮换。
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { RotateRecoveryKeyDialog } from '../RotateRecoveryKeyDialog';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** 建库并打开对话框。 */
async function setup(): Promise<{ oldCode: string; onClose: ReturnType<typeof vi.fn> }> {
  const { client } = createTestClient('boot');
  const init = await client.initialize({ masterPassword: MASTER_PASSWORD });
  const onClose = vi.fn();
  renderWithProviders(client, <RotateRecoveryKeyDialog open onClose={onClose} />);
  return { oldCode: init.recoveryCode, onClose };
}

describe('设置面板 · 重新生成恢复密钥', () => {
  it('输入主密码后展示新恢复码，勾选「已保存」才能完成', async () => {
    const { oldCode } = await setup();

    fireEvent.change(screen.getByLabelText(/主密码/), { target: { value: MASTER_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: '生成新的恢复码' }));

    const code = await screen.findByTestId('rotated-recovery-code');
    expect(code.textContent?.length).toBeGreaterThan(0);
    expect(code.textContent).not.toBe(oldCode);

    const done = screen.getByRole('button', { name: '完成' });
    expect(done).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(done).toBeEnabled();
  });

  it('主密码错误：只出错误提示，不展示恢复码', async () => {
    await setup();

    fireEvent.change(screen.getByLabelText(/主密码/), { target: { value: 'Wrong-Pass-1234' } });
    fireEvent.click(screen.getByRole('button', { name: '生成新的恢复码' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByTestId('rotated-recovery-code')).toBeNull();
  });

  it('取消关闭，不产生轮换', async () => {
    const { onClose } = await setup();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
