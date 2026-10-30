/**
 * 主面板空状态：区分「库里真的没有」与「这个筛选下没有」。
 *
 * 「收藏」和「标签」是筛选视图，不是分类。它们为空时库里往往还有别的卡片，
 * 若沿用「还没有资产」+「点击新建卡片开始」，用户（尤其是刚导入完的人）
 * 会以为数据丢了。这里把这条区分钉住。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { MainPanel } from '../MainPanel';
import { createTestClient, renderWithProviders } from '../../__tests__/support/harness';
import { useUiStore } from '../../../stores/ui-store';

const MASTER = 'Master!2026';

/** 渲染主面板；`seed` 为 true 时先放一张普通卡。 */
async function renderMain(seed = true): Promise<void> {
  const test = createTestClient();
  await test.client.initialize({ masterPassword: MASTER });
  if (seed) {
    await test.client.createItem({
      title: 'PlainCard',
      username: 'u',
      password: 'Pass-1-Aa1!',
      category: '开发',
    });
  }
  renderWithProviders(
    test.client,
    <MainPanel
      snapshot={await test.client.status()}
      onSessionChange={() => {}}
      settingsOpen={false}
      onSettingsOpenChange={() => {}}
    />,
  );
  await waitFor(() => {
    expect(screen.getByText(/PlainCard|还没有资产/)).toBeDefined();
  });
}

afterEach(() => {
  // ui-store 是纯内存的，测试之间必须手动复位分类。
  act(() => {
    useUiStore.getState().setCategory('all');
  });
});

describe('主面板 · 空状态', () => {
  it('收藏视图为空时说「这个筛选下还没有资产」，而不是「还没有资产」', async () => {
    await renderMain();
    act(() => {
      useUiStore.getState().setCategory('favorite');
    });

    await waitFor(() => {
      expect(screen.getByText('这个筛选下还没有资产')).toBeDefined();
    });
    // 关键：不能出现「库里空空如也」的说法——库里明明有一张卡。
    expect(screen.queryByText('还没有资产')).toBeNull();
    expect(screen.queryByText('点击右上角「新建卡片」开始')).toBeNull();
    expect(screen.getByText('切到「全部」看看，或换一个分类 / 标签')).toBeDefined();
  });

  it('标签已不存在时自动回退到「全部」，不会停在空白列表上', async () => {
    await renderMain();
    // 标签是从卡片统计出来的：不存在的标签会被导航层清掉。
    // 关键是不能让用户停在一个"没有任何导航项高亮"的空列表上。
    act(() => {
      useUiStore.getState().setCategory('tag:不存在的标签');
    });

    await waitFor(() => {
      expect(screen.getByText('PlainCard')).toBeDefined();
    });
    expect(useUiStore.getState().filters.category).toBe('all');
  });

  it('真的空库仍然说「还没有资产」并引导新建', async () => {
    await renderMain(false);

    await waitFor(() => {
      expect(screen.getByText('还没有资产')).toBeDefined();
    });
    expect(screen.getByText('点击右上角「新建卡片」开始')).toBeDefined();
    expect(screen.queryByText('这个筛选下还没有资产')).toBeNull();
  });
});
