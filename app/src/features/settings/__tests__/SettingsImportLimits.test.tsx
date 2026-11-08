/** 设置面板 · 导入文件大小上限（任务 4）：读之前拒绝，提示上限，粘贴区不变。 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPanel } from '../SettingsPanel';
import { renderWithProviders, createTestClient } from '../../__tests__/support/harness';
import { IMPORT_LIMITS } from '../../../core/vault/import-limits';

const MASTER = 'Master!2026';

async function renderPanel() {
  const { client } = createTestClient();
  await client.initialize({ masterPassword: MASTER });
  const user = userEvent.setup();
  renderWithProviders(
    client,
    <SettingsPanel
      open
      snapshot={await client.status()}
      onClose={() => {}}
      onSessionChange={() => {}}
      onDataChanged={() => {}}
    />,
  );
  await screen.findByTestId('storage-location');
  return { client, user };
}

/** 内容很小、但 `size` 声称超限的文件：证明判定看的是 size，且根本没去读。 */
function oversizedFile(name: string, limit: number): { file: File; text: ReturnType<typeof vi.fn> } {
  const file = new File(['{}'], name, { type: 'application/json' });
  const text = vi.fn(async () => '{}');
  Object.defineProperty(file, 'size', { value: limit + 1 });
  Object.defineProperty(file, 'text', { value: text });
  return { file, text };
}

describe('设置面板 · 导入上限', () => {
  it('超过上限的 .kib 文件不读取，提示上限，粘贴区保持为空', async () => {
    const { user } = await renderPanel();
    await user.click(screen.getByRole('button', { name: '导入完整备份' }));
    const input = screen.getByLabelText('备份文件');
    const { file, text } = oversizedFile('huge.kib', IMPORT_LIMITS.backupMaxBytes);
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);

    expect(await screen.findByText(/文件太大.*备份上限 32 MB/)).toBeDefined();
    expect(text).not.toHaveBeenCalled();
    expect((screen.getByLabelText('备份文件内容') as HTMLTextAreaElement).value).toBe('');
  });
});
