/**
 * 用恢复码生成 `.kirk` 对话框。
 *
 * 契约：
 * 1. 恢复码正确 → 出成功态、回显规范化后的恢复码，并真的发起一次下载；
 * 2. 恢复码错误 → 只有错误提示，**不出现成功态**（不能让人以为文件已经生成了）；
 * 3. 空输入时按钮禁用；
 * 4. 成功后再改输入 → 成功态立刻撤掉，避免"改过码却还显示上一次的结论"。
 *
 * 注意：这里**不该**出现"旧恢复码已失效"这类措辞——它不是轮换。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ExportRecoveryKeyDialog } from '../ExportRecoveryKeyDialog';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** jsdom 没有 createObjectURL：补上桩，才能验证"确实发起了下载"。 */
function stubDownload(): ReturnType<typeof vi.fn> {
  const create = vi.fn(() => 'blob:keyisland-test');
  Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  // jsdom 会真的去导航 blob: 并抛 "Not implemented"：把点击拦掉，只留下"发起过下载"这个事实。
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  return create;
}

/** 建库并打开对话框，返回真恢复码。 */
async function setup(): Promise<{ recoveryCode: string }> {
  const { client } = createTestClient('boot');
  const init = await client.initialize({ masterPassword: MASTER_PASSWORD });
  renderWithProviders(client, <ExportRecoveryKeyDialog open onClose={vi.fn()} />);
  return { recoveryCode: init.recoveryCode };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('设置面板 · 用恢复码生成 .kirk', () => {
  it('恢复码正确：出成功态、回显规范化恢复码，并真的发起下载', async () => {
    const create = stubDownload();
    const { recoveryCode } = await setup();

    fireEvent.change(screen.getByRole('textbox', { name: /恢复码/ }), { target: { value: recoveryCode } });
    fireEvent.click(screen.getByRole('button', { name: '验证并生成 .kirk' }));

    const done = await screen.findByTestId('export-kirk-done', {}, { timeout: 5000 });
    expect(done.textContent).toContain(recoveryCode);
    // 下载真的发生了：不是只弹了个提示。
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    // 并且可以再下一次，不必重新验码。
    expect(screen.getByRole('button', { name: '再下载一次' })).toBeInTheDocument();
  });

  it('恢复码错误：只出错误提示，不出现成功态', async () => {
    await setup();

    fireEvent.change(screen.getByRole('textbox', { name: /恢复码/ }), {
      target: { value: '0000-0000-0000-0000-0000-0000-0000-0000' },
    });
    fireEvent.click(screen.getByRole('button', { name: '验证并生成 .kirk' }));

    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByTestId('export-kirk-done')).toBeNull();
  });

  it('空输入时按钮禁用', async () => {
    await setup();

    expect(screen.getByRole('button', { name: '验证并生成 .kirk' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: /恢复码/ }), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: '验证并生成 .kirk' })).toBeDisabled();
  });

  it('成功后再改输入：上一次的成功态立刻撤掉', async () => {
    stubDownload();
    const { recoveryCode } = await setup();

    fireEvent.change(screen.getByRole('textbox', { name: /恢复码/ }), { target: { value: recoveryCode } });
    fireEvent.click(screen.getByRole('button', { name: '验证并生成 .kirk' }));
    await screen.findByTestId('export-kirk-done', {}, { timeout: 5000 });

    fireEvent.change(screen.getByRole('textbox', { name: /恢复码/ }), { target: { value: recoveryCode.slice(0, 8) } });

    expect(screen.queryByTestId('export-kirk-done')).toBeNull();
  });

  it('文案不冒充轮换：不出现"旧恢复码已失效"', async () => {
    await setup();

    expect(screen.queryByText(/旧恢复码.*失效/u)).toBeNull();
    expect(screen.getByText(/不会更换密钥/u)).toBeInTheDocument();
  });
});
