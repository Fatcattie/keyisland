/**
 * 设置面板 · 灵动岛热区（PRD FR-02「默认宽约 300px，可配置宽度与位置」）。
 *
 * 契约：
 * 1. 打开时读出门面里的配置并渲染（默认 300px / 居中）；
 * 2. 改宽度后写进门面，并**同步**写进 UI store——灵动岛的命中判定读的是 store，
 *    只改面板本地状态会出现"预览条动了、实际热区没动"；
 * 3. 越界输入被拒绝且不落盘：输入框回退到当前值，门面里仍是旧值。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { SettingsPanel } from '../SettingsPanel';
import { useUiStore } from '../../../stores/ui-store';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

// store 是模块级单例：上一个用例改过的热区会漏到下一个，必须每个用例前复位。
beforeEach(() => {
  useUiStore.setState({ hotzone: { widthPx: 300, align: 'center' } });
});

/** 让面板打开时的几个异步读取（存储位置 / 备份状态 / 日志 / 热区）落地。 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
}

/** 建库并渲染设置面板。 */
async function setup(widthPx?: number, align?: 'left' | 'center' | 'right'): Promise<ReturnType<typeof createTestClient>> {
  const harness = createTestClient('boot');
  await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
  if (widthPx !== undefined || align !== undefined) {
    await harness.client.setHotzoneConfig({
      ...(widthPx !== undefined ? { widthPx } : {}),
      ...(align !== undefined ? { align } : {}),
    });
  }
  renderWithProviders(
    harness.client,
    <SettingsPanel
      open
      snapshot={await harness.client.status()}
      onClose={() => {}}
      onSessionChange={() => {}}
      onDataChanged={() => {}}
      onLocateItem={vi.fn()}
    />,
  );
  await flush();
  return harness;
}

describe('FR-02 · 设置页热区配置', () => {
  it('默认渲染 300px / 居中', async () => {
    await setup();

    const input = screen.getByLabelText('热区宽度') as HTMLInputElement;
    expect(input.value).toBe('300');
    expect(screen.getByRole('button', { name: '居中' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('改宽度：写入门面并同步到 UI store', async () => {
    const harness = await setup();

    const input = screen.getByLabelText('热区宽度') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '480' } });
    fireEvent.blur(input);
    await flush();

    expect(await harness.client.getHotzoneConfig()).toEqual({ widthPx: 480, align: 'center' });
    expect(useUiStore.getState().hotzone).toEqual({ widthPx: 480, align: 'center' });
  });

  it('改位置：写入门面并同步到 UI store', async () => {
    const harness = await setup();

    fireEvent.click(screen.getByRole('button', { name: '靠左' }));
    await flush();

    expect(await harness.client.getHotzoneConfig()).toEqual({ widthPx: 300, align: 'left' });
    expect(useUiStore.getState().hotzone.align).toBe('left');
  });

  it('越界宽度被拒绝：输入框回退，门面里仍是旧值', async () => {
    const harness = await setup();

    const input = screen.getByLabelText('热区宽度') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '9999' } });
    fireEvent.blur(input);
    await flush();

    expect(input.value).toBe('300');
    expect(await harness.client.getHotzoneConfig()).toEqual({ widthPx: 300, align: 'center' });
  });
});
