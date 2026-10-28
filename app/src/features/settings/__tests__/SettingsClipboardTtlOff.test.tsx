/**
 * 设置面板 · 剪贴板清理「可关闭」档位回归（PRD FR-05）。
 *
 * PRD 原文要求剪贴板 TTL「10–120 秒可调，**可关闭**」。
 *
 * 契约：
 * 1. 下拉必须有「关闭」档，且值为 `0`——`setClipboardTtl(0)` 是唯一能表达
 *    "不自动清理"的值，UI 不提供它就等于功能不存在；
 * 2. 选「关闭」时 `setClipboardTtl(0)` 被调用，且提示必须是"已关闭"，
 *    不能说成"0 秒后自动清空"（那等于立刻清空，与语义正好相反）；
 * 3. 选具体秒数时提示带回准确秒数。
 */

import { describe, expect, it, vi, type MockInstance } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { SettingsPanel } from '../SettingsPanel';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** 建库并渲染设置面板。 */
async function setup(): Promise<{ setClipboardTtl: MockInstance<(ttlMs: number) => Promise<void>> }> {
  const { client } = createTestClient('boot');
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  const setClipboardTtl = vi.spyOn(client, 'setClipboardTtl');
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
  // 等面板打开时的异步加载（数据文件位置）落定，避免 act 警告与竞态断言。
  await screen.findByTestId('storage-location');
  return { setClipboardTtl };
}

describe('设置面板 · 剪贴板清理可关闭', () => {
  it('下拉提供「关闭」档，值为 0', async () => {
    await setup();

    const select = screen.getByLabelText('剪贴板自动清理') as HTMLSelectElement;
    const options = Array.from(select.options);
    const off = options.find((option) => option.value === '0');

    expect(off).toBeDefined();
    expect(off?.textContent).toContain('关闭');
    // 其余档位必须落在 PRD 的 10–120 秒区间内。
    for (const option of options) {
      if (option.value === '0') continue;
      const seconds = Number(option.value) / 1000;
      expect(seconds).toBeGreaterThanOrEqual(10);
      expect(seconds).toBeLessThanOrEqual(120);
    }
  });

  it('选「关闭」时写入 0，并提示"已关闭"而不是"0 秒后清空"', async () => {
    const { setClipboardTtl } = await setup();

    const select = screen.getByLabelText('剪贴板自动清理') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '0' } });

    expect(setClipboardTtl).toHaveBeenCalledWith(0);
    expect(select.value).toBe('0');
    // toast 由异步的 `handleTtl` 触发，必须等它落库后再断言。
    expect(await screen.findByText('已关闭剪贴板自动清空')).toBeInTheDocument();
    // 反义文案绝不能出现。
    expect(screen.queryByText(/0 秒后自动清空/)).toBeNull();
  });

  it('选具体秒数时提示带回准确秒数', async () => {
    await setup();

    const select = screen.getByLabelText('剪贴板自动清理') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '60000' } });

    expect(select.value).toBe('60000');
    expect(await screen.findByText('剪贴板将在 60 秒后自动清空')).toBeInTheDocument();
  });
});
