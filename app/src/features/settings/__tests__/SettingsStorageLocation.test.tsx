/**
 * 设置面板 · 数据文件位置行回归（PRD FR-06：展示数据文件路径与"打开所在文件夹"）。
 *
 * 契约：
 * 1. 内存存储阶段如实显示"内存存储（未落盘）"——不显示假路径；
 * 2. "打开所在文件夹"按钮禁用，且标题说明原因（没有文件夹可打开）；
 * 3. 若存储报告了真实路径与可打开状态（SQLCipher 落库后的未来形态），
 *    同一处 UI 无需改动即显示路径并启用按钮——用 mock 证明这个适配性。
 */

import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { SettingsPanel } from '../SettingsPanel';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** 建库并渲染设置面板。 */
async function setup(): Promise<void> {
  const { client } = createTestClient('boot');
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  renderWithProviders(
    client,
    <SettingsPanel
      open
      snapshot={await client.status()}
      onClose={() => {}}
      onSessionChange={() => {}}
      onDataChanged={() => {}}
      onLocateItem={vi.fn()}
    />,
  );
}

describe('设置面板 · 数据文件位置', () => {
  it('内存存储阶段：显示"未落盘"，打开按钮禁用并说明原因', async () => {
    await setup();

    const row = await screen.findByTestId('storage-location');
    expect(row).toHaveTextContent('数据文件');
    expect(row).toHaveTextContent('内存存储（未落盘）');

    const button = screen.getByRole('button', { name: '打开所在文件夹' });
    expect(button).toBeDisabled();
    expect(button.title).toContain('没有文件夹可打开');
  });

  it('存储报告真实路径时：显示路径并启用按钮（SQLCipher 落地后的形态）', async () => {
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER_PASSWORD });
    // 模拟未来的文件存储：describeStorage 返回真实路径与可打开状态。
    vi.spyOn(client, 'describeStorage').mockResolvedValue({
      kind: 'file',
      displayPath: 'C:\\Users\\demo\\AppData\\Roaming\\KeyIsland\\vault.db',
      canReveal: true,
    });
    renderWithProviders(
      client,
      <SettingsPanel
        open
        snapshot={await client.status()}
        onClose={() => {}}
        onSessionChange={() => {}}
        onDataChanged={() => {}}
        onLocateItem={vi.fn()}
      />,
    );

    const row = await screen.findByTestId('storage-location');
    expect(row).toHaveTextContent('vault.db');

    const button = screen.getByRole('button', { name: '打开所在文件夹' });
    expect(button).toBeEnabled();
    expect(button.title).toContain('打开数据文件所在文件夹');
  });

  it('读取位置失败不打断面板：行降级为未落盘，不弹错误', async () => {
    const { client } = createTestClient('boot');
    await client.initialize({ masterPassword: MASTER_PASSWORD });
    vi.spyOn(client, 'describeStorage').mockRejectedValue(new Error('boom'));
    renderWithProviders(
      client,
      <SettingsPanel
        open
        snapshot={await client.status()}
        onClose={() => {}}
        onSessionChange={() => {}}
        onDataChanged={() => {}}
        onLocateItem={vi.fn()}
      />,
    );

    // 失败时静默降级：仍然看得到行与禁用按钮，面板其余功能不受影响。
    const row = await screen.findByTestId('storage-location');
    expect(row).toHaveTextContent('内存存储（未落盘）');
    expect(screen.getByRole('button', { name: '打开所在文件夹' })).toBeDisabled();
    // 无关控件仍在，证明面板没有被错误状态带崩。
    expect(document.getElementById('settings-ttl')).not.toBeNull();
  });
});
