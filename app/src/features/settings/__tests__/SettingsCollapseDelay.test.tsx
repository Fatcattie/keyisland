/**
 * 设置面板 · 收起延时（PRD FR-02「鼠标离开 2 秒后自动收起」/ SDD §6.5「可配置」）。
 *
 * 契约：
 * 1. 默认档位是 2 秒，并标出"（默认）"——否则用户不知道回到哪一档才算标准；
 * 2. 改档位后写进门面，并**同步**写进 UI store（灵动岛的隐藏时序读的是 store）；
 * 3. 文案必须说明"折叠胶囊态不受此项影响"，否则会出现"我设了 3 秒，胶囊还是
 *    马上就没了"的困惑。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { SettingsPanel } from '../SettingsPanel';
import { useUiStore } from '../../../stores/ui-store';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

beforeEach(() => {
  useUiStore.setState({ collapseDelayMs: 2000, hotzone: { widthPx: 300, align: 'center' } });
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
}

/** 建库并渲染设置面板，可先写入收起延时。 */
async function setup(collapseDelayMs?: number): Promise<ReturnType<typeof createTestClient>> {
  const harness = createTestClient('boot');
  await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
  if (collapseDelayMs !== undefined) {
    await harness.client.setCollapseDelay(collapseDelayMs);
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

describe('FR-02 · 设置页收起延时', () => {
  it('默认选中 2 秒并标注"（默认）"', async () => {
    await setup();

    const select = screen.getByLabelText('收起延时') as HTMLSelectElement;
    expect(select.value).toBe('2000');
    const selected = select.selectedOptions[0];
    expect(selected.textContent).toContain('2 秒');
    expect(selected.textContent).toContain('默认');
  });

  it('改档位：写入门面并同步到 UI store', async () => {
    const harness = await setup();

    fireEvent.change(screen.getByLabelText('收起延时'), { target: { value: '1000' } });
    await flush();

    expect(await harness.client.getCollapseDelay()).toBe(1000);
    expect(useUiStore.getState().collapseDelayMs).toBe(1000);
  });

  it('说明折叠胶囊态不受此项影响', async () => {
    await setup();

    expect(screen.getByText(/折叠胶囊态不受此项影响/)).toBeDefined();
  });
});
