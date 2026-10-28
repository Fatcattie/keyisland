/** 恢复流程：.kirk 文件选择与凭据识别（UI 层行为）。 */
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { RecoveryFlow } from '../RecoveryFlow';
import { renderWithProviders, createTestClient } from '../../__tests__/support/harness';
import { AppError } from '../../../core/errors';

const MASTER = 'Master!2026';

/** 构造一个 File（jsdom 的 `File.text()` 可用）。 */
function kirkFile(content: string, name = 'keyisland-recovery.kirk'): File {
  return new File([content], name, { type: 'application/json' });
}

/**
 * jsdom 的 `input.files` 只有 getter，`fireEvent.change` 的 `target` 赋值不生效，
 * 因此显式重定义 `files` 再派发 change 事件。
 */
function pickFile(labelText: string | RegExp, file: File): void {
  const input = screen.getByLabelText(labelText);
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

async function renderFlow(): Promise<{ client: ReturnType<typeof createTestClient>['client']; kirkJson: string }> {
  const test = createTestClient();
  const init = await test.client.initialize({ masterPassword: MASTER });
  await test.client.lock('manual');
  renderWithProviders(test.client, <RecoveryFlow onCancel={() => {}} onDone={() => {}} />);
  return { client: test.client, kirkJson: init.kirkJson };
}

describe('RecoveryFlow · .kirk 文件选择', () => {
  it('选择 .kirk 文件后把内容带入输入区并识别为 .kirk', async () => {
    await renderFlow();
    // 这里只验证「文件 → 输入区」这条 UI 通路，文件内容合法性由服务层测试覆盖。
    pickFile('选择 .kirk 恢复文件', kirkFile('{"magic":"KIRK1","version":1}'));

    await waitFor(() => {
      expect(screen.getByText(/已载入文件：keyisland-recovery\.kirk/)).toBeDefined();
    });
    expect(screen.getByLabelText(/恢复码 \/ \.kirk 内容/)).toHaveValue('{"magic":"KIRK1","version":1}');
    expect(screen.getByText('已识别为 .kirk 文件内容')).toBeDefined();
  });

  it('选择非 .kirk 文件时不带入内容，并给出明确提示', async () => {
    await renderFlow();
    pickFile('选择 .kirk 恢复文件', kirkFile('just a text file', 'notes.txt'));

    await waitFor(() => {
      expect(screen.getByText('这个文件不是 .kirk 恢复文件，请重新选择')).toBeDefined();
    });
    expect(screen.getByLabelText(/恢复码 \/ \.kirk 内容/)).toHaveValue('');
  });

  it('粘贴内容会清掉"已载入文件"标记，避免误以为还在用文件', async () => {
    await renderFlow();
    pickFile('选择 .kirk 恢复文件', kirkFile('{"magic":"KIRK1","version":1}'));
    await waitFor(() => {
      expect(screen.getByText(/已载入文件：/)).toBeDefined();
    });
    fireEvent.change(screen.getByLabelText(/恢复码 \/ \.kirk 内容/), {
      target: { value: 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-2345-6789' },
    });
    expect(screen.queryByText(/已载入文件：/)).toBeNull();
  });

  it('验证失败只展示统一文案，不泄漏是恢复码错还是文件格式错', async () => {
    const { client } = await renderFlow();
    const spy = vi
      .spyOn(client, 'recoverWithKirk')
      .mockRejectedValue(new AppError('RECOVERY_CODE_INVALID', 'error.recovery_code_invalid', true));
    fireEvent.change(screen.getByLabelText(/恢复码 \/ \.kirk 内容/), {
      target: { value: '{"magic":"KIRK1","version":1}' },
    });
    fireEvent.click(screen.getByRole('button', { name: '验证' }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText('恢复码格式不正确')).toBeDefined();
    spy.mockRestore();
  });
});
