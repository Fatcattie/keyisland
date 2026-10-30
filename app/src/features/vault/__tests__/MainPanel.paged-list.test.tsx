/**
 * 主面板分批渲染：卡片多的时候先画一屏，滚到底部再续。
 *
 * 背景：1000 张卡 ≈ 6.1 万个 DOM 节点，整片画出来要 2 秒（`npm run e2e:perf` 实测）。
 * 分批之后首屏只画 `PAGE_SIZE` 张，剩下的靠「加载更多」/ 滚动触发。
 *
 * 这里钉住四件事：
 * 1. 首屏只渲染一页，不是全部；
 * 2. 续批入口出现、点一次多一页、全部加载完后入口消失；
 * 3. 卡片不超过一页时**不出现**续批入口（小库用户看不到任何多余 UI）；
 * 4. 换搜索词回到第一页（否则在第 240 张的位置搜索，会看到 3 张卡下面挂着「加载更多」）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { MainPanel } from '../MainPanel';
import { createTestClient, renderWithProviders } from '../../__tests__/support/harness';
import { useUiStore } from '../../../stores/ui-store';

const MASTER = 'Master!2026';
/** 必须与 `MainPanel.tsx` 的 `PAGE_SIZE` 一致。 */
const PAGE = 120;

/** 建 `count` 张卡并渲染主面板。 */
async function renderWithCards(count: number): Promise<void> {
  const test = createTestClient();
  await test.client.initialize({ masterPassword: MASTER });
  if (count > 0) {
    await test.client.createItems(
      Array.from({ length: count }, (_, index) => ({
        title: `Card-${String(index + 1).padStart(3, '0')}`,
        username: `user${index + 1}`,
        password: 'Pass-1-Aa1!',
        category: '开发',
      })),
    );
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
  // 等首屏那批异步加载（分类 / 标签 / 列表）落定。
  await waitFor(() => {
    expect(screen.getByTestId('item-list').children.length).toBeGreaterThan(0);
  });
}

/** 列表里当前渲染了多少张卡。 */
function renderedCount(): number {
  return screen.getByTestId('item-list').children.length;
}

afterEach(() => {
  act(() => {
    useUiStore.getState().setCategory('all');
  });
});

describe('主面板 · 分批渲染', () => {
  it('130 张卡首屏只渲染一页，并说明还有多少没显示', async () => {
    await renderWithCards(130);

    expect(renderedCount()).toBe(PAGE);
    expect(screen.getByTestId('item-list-more')).toBeDefined();
    expect(screen.getByText(`已显示 ${PAGE} / 130 张`)).toBeDefined();
  });

  it('点「加载更多」把剩下的铺完，入口消失', async () => {
    await renderWithCards(130);

    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await waitFor(() => {
      expect(renderedCount()).toBe(130);
    });
    // 全部铺完后不该再留一个"已显示 130 / 130"的尾巴。
    expect(screen.queryByTestId('item-list-more')).toBeNull();
  }, 40_000);

  it('卡片不足一页时不出现续批入口（小库不该看到多余 UI）', async () => {
    await renderWithCards(5);

    expect(renderedCount()).toBe(5);
    expect(screen.queryByTestId('item-list-more')).toBeNull();
    expect(screen.queryByText(/已显示 \d+ \//)).toBeNull();
  });

  it('换搜索词后回到第一页', async () => {
    await renderWithCards(130);
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await waitFor(() => {
      expect(renderedCount()).toBe(130);
    });

    // 「Card」能匹配全部 130 张，所以这里考的不是结果变少，而是"窗口被重置"。
    fireEvent.change(screen.getByPlaceholderText(/搜索标题/), { target: { value: 'Card' } });
    // 超时放宽：要去抖 180ms + 重跑筛选 + 在 jsdom 里重画 120 张卡，默认 1s 不够。
    await waitFor(
      () => {
        expect(screen.getByText(`已显示 ${PAGE} / 130 张`)).toBeDefined();
      },
      { timeout: 5000 },
    );
    expect(renderedCount()).toBe(PAGE);
  }, 40_000);
});
