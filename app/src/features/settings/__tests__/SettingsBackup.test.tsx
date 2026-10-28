/** 设置面板备份/恢复交互测试。 */
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPanel } from '../SettingsPanel';
import { renderWithProviders, createTestClient } from '../../__tests__/support/harness';
import type { VaultClient } from '../../../services/vault-client';
import { AppError } from '../../../core/errors';

const MASTER = 'Master!2026';
const BACKUP_PASSWORD = 'Backup!2026';

async function renderPanel(): Promise<{ client: VaultClient; user: ReturnType<typeof userEvent.setup> }> {
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
  // 等面板打开时的异步加载（数据文件位置）落定，避免 act 警告与竞态断言。
  await screen.findByTestId('storage-location');
  return { client, user };
}

describe('设置面板 · 备份与恢复', () => {
  it('导出备份：锁定态拒绝、解锁后成功并触发下载', async () => {
    const { client, user } = await renderPanel();
    await client.lock('manual');
    // 锁定态下 client.exportBackup 抛 VAULT_LOCKED，UI 只展示中文文案。
    await user.click(screen.getByRole('button', { name: '导出备份' }));
    await user.type(screen.getByLabelText('备份密码'), BACKUP_PASSWORD);
    await user.click(screen.getByRole('button', { name: '导出 .kib 文件' }));
    await waitFor(() => {
      expect(screen.getByText('保险库已锁定，请先解锁')).toBeDefined();
    });

    await client.unlock(MASTER);
    // jsdom 不实现 URL.createObjectURL，先补一个可观察的替身。
    const createUrl = vi.fn(() => 'blob:mock');
    const revokeUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createUrl, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeUrl, configurable: true });
    await user.click(screen.getByRole('button', { name: '导出 .kib 文件' }));
    await waitFor(() => {
      expect(createUrl).toHaveBeenCalledTimes(1);
    });
    expect(revokeUrl).toHaveBeenCalledWith('blob:mock');
    await waitFor(() => {
      expect(screen.getByText('已导出加密备份，请离线保存')).toBeDefined();
    });
  });

  it('合并导入不需要确认词，覆盖导入必须输入「覆盖」', async () => {
    const { user } = await renderPanel();
    await user.click(screen.getByRole('button', { name: '导入备份' }));

    // 默认合并：无确认输入框。
    expect(screen.queryByPlaceholderText('覆盖')).toBeNull();
    expect(screen.getByRole('button', { name: '开始导入' })).toBeDefined();

    await user.selectOptions(screen.getByLabelText('恢复方式'), 'overwrite');
    expect(screen.queryByPlaceholderText('覆盖')).not.toBeNull();
    expect(screen.getByRole('button', { name: '开始导入' })).toBeDefined();
  });

  it('选择 .kib 文件后内容进入粘贴区（jsdom 无 Blob.text 时走 FileReader）', async () => {
    const { user } = await renderPanel();
    await user.click(screen.getByRole('button', { name: '导入备份' }));
    const input = screen.getByLabelText('备份文件');
    Object.defineProperty(input, 'files', {
      value: [new File(['{"magic":"KIB1","version":1}'], 'backup.kib', { type: 'application/json' })],
      configurable: true,
    });
    fireEvent.change(input);
    await waitFor(() => {
      expect((screen.getByLabelText('备份文件内容') as HTMLTextAreaElement).value).toBe('{"magic":"KIB1","version":1}');
    });
  });

  it('覆盖导入必须同时提供确认词与当前库主密码', async () => {
    const { client, user } = await renderPanel();
    await client.createItem({ title: 'Keep', username: 'k@example.com', password: 'Keep-1-Aa1!' });
    await user.click(screen.getByRole('button', { name: '导入备份' }));
    await user.type(screen.getByLabelText('备份密码'), BACKUP_PASSWORD);
    await user.selectOptions(screen.getByLabelText('恢复方式'), 'overwrite');
    fireEvent.change(screen.getByLabelText('备份文件内容'), { target: { value: '{"magic":"KIB1","version":1}' } });

    // 缺确认词与主密码：直接在前端被拦下，不会调用门面。
    await user.click(screen.getByRole('button', { name: '开始导入' }));
    await waitFor(() => {
      expect(screen.getByText('覆盖导入需要输入「覆盖」以确认')).toBeDefined();
    });

    fireEvent.change(screen.getByPlaceholderText('覆盖'), { target: { value: '覆盖' } });
    await user.click(screen.getByRole('button', { name: '开始导入' }));
    await waitFor(() => {
      expect(screen.getByText('覆盖导入需要验证当前库主密码')).toBeDefined();
    });

    await user.type(screen.getByLabelText('当前库主密码'), MASTER);
    await user.click(screen.getByRole('button', { name: '开始导入' }));
    await waitFor(() => {
      // 备份内容本身不合法，因此走到门面后以备份错误收尾；重点是主密码已被一起提交。
      expect(screen.getByText('备份文件无法读取，可能是密码错误或文件已损坏')).toBeDefined();
    });
  });

  it('导入失败时 toast 展示备份相关错误，不显示底层细节', async () => {
    const { client, user } = await renderPanel();
    const exportSpy = vi
      .spyOn(client, 'importBackup')
      .mockRejectedValue(new AppError('VALIDATION_FAILED', 'error.backup_invalid', false));
    await user.click(screen.getByRole('button', { name: '导入备份' }));
    await user.type(screen.getByLabelText('备份密码'), BACKUP_PASSWORD);
    // userEvent 会把 `{` 当作键盘描述符，因此用 fireEvent.change 注入内容。
    fireEvent.change(screen.getByLabelText('备份文件内容'), {
      target: { value: '{"magic":"KIB1","version":1}' },
    });
    await user.click(screen.getByRole('button', { name: '开始导入' }));

    await waitFor(() => {
      expect(exportSpy).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText('备份文件无法读取，可能是密码错误或文件已损坏')).toBeDefined();
    });
    exportSpy.mockRestore();
  });
});
