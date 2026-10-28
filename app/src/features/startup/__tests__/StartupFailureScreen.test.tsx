/**
 * 启动失败屏。
 *
 * 这一屏存在的唯一理由：发布版没有控制台，`setup` 里返回 Err 会 panic 成
 * 「双击图标一闪而过」。Rust 侧现在改成"失败也开窗口 + 把原因挂在状态上"，
 * 所以这里的契约很硬：**具体原因必须出现在屏幕上**，不能被泛化成
 * 「本地存储读写失败，请重试」——那句话对"密钥丢了"毫无帮助。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { ToastProvider } from '../../../components/ui/Toast';
import type { StartupFailure } from '../../../services/tauri-storage';
import { StartupFailureScreen } from '../StartupFailureScreen';

function renderScreen(failure: StartupFailure): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <StartupFailureScreen failure={failure} />
    </ToastProvider>,
  );
}

describe('StartupFailureScreen', () => {
  beforeEach(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    invokeMock.mockReset();
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('密钥丢失：先说数据还在，再说为什么没启动，最后给三步出路', () => {
    const { container } = renderScreen({
      code: 'missing_key',
      detail: '数据库里已有数据，但系统凭据管理器里找不到对应的密钥。',
      dbPath: 'C:\\Users\\tester\\AppData\\Roaming\\com.keyisland.desktop\\vault.db',
    });

    expect(screen.getByRole('alert')).toHaveTextContent('数据还在，但解开它的密钥不在了');
    // "为什么没启动"必须讲清是**保护**而不是故障，否则用户只会以为程序坏了、去删库。
    expect(container).toHaveTextContent('为了避免用新密钥覆盖旧数据，密岛这次选择不启动');
    // 具体原因与数据路径都要在，这是用户去求助时唯一能提供的信息。
    expect(container).toHaveTextContent('系统凭据管理器里找不到对应的密钥');
    expect(container).toHaveTextContent('com.keyisland.desktop');
    expect(screen.getByRole('button', { name: '打开数据文件夹' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('未知分类仍然展示具体原因，不退回通用文案', () => {
    const { container } = renderScreen({
      code: 'unknown',
      detail: '定位数据目录失败：拒绝访问 (os error 5)',
      dbPath: null,
    });

    expect(screen.getByRole('alert')).toHaveTextContent('密岛无法启动');
    expect(container).toHaveTextContent('定位数据目录失败：拒绝访问 (os error 5)');
  });

  it('没有具体原因时不渲染空的原因块，也不渲染数据路径', () => {
    const { container } = renderScreen({ code: 'database', detail: '', dbPath: null });

    expect(container).not.toHaveTextContent('具体原因');
    expect(container).not.toHaveTextContent('数据文件：');
  });

  it('打开文件夹失败时，把 Rust 给的具体原因提示出来', async () => {
    invokeMock.mockRejectedValue('打开文件夹失败：explorer 启动失败');
    renderScreen({
      code: 'data_dir',
      detail: '创建数据目录失败：拒绝访问',
      dbPath: null,
    });

    fireEvent.click(screen.getByRole('button', { name: '打开数据文件夹' }));

    await waitFor(() => {
      expect(screen.getByText('打开文件夹失败：explorer 启动失败')).toBeInTheDocument();
    });
    expect(invokeMock).toHaveBeenCalledWith('storage_reveal');
  });

  it('抛出的不是字符串时退回通用文案，不把 undefined 显示给用户', async () => {
    invokeMock.mockRejectedValue(new Error('boom'));
    renderScreen({ code: 'data_dir', detail: '创建数据目录失败：拒绝访问', dbPath: null });

    fireEvent.click(screen.getByRole('button', { name: '打开数据文件夹' }));

    await waitFor(() => {
      expect(screen.getByText('打开文件夹失败，请手动前往数据目录')).toBeInTheDocument();
    });
  });
});
