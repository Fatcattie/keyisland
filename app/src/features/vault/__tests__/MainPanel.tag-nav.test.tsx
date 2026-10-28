/**
 * 左侧导航的「标签」分组（PRD FR-03「左侧导航（全部 / 收藏 / 分类 / **标签** /
 * 隐藏卡片 / 最近删除【V2】）」）。
 *
 * 契约：
 * 1. 数据里出现过的标签进入导航，按字典序排列（不随列表顺序抖动）；
 * 2. 点标签 = 按 `filter.tag` 过滤，与分类是两个维度；
 * 3. 标签与分类**可以重名**，点标签不能变成过滤分类（key 前缀区分）；
 * 4. 隐藏卡片的标签不进导航（"有个叫 私密 的标签"本身就是信息）；
 * 5. 选中标签的最后一张卡被删掉后，导航回到「全部」，不留在空列表上。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { MainPanel } from '../MainPanel';
import { useUiStore } from '../../../stores/ui-store';
import type { CreateItemInput } from '../../../core/vault/types';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

beforeEach(() => {
  useUiStore.setState({
    filters: { category: 'all', sort: 'recent_updated' },
    viewMode: 'grid',
  });
});

/** 造一条资产。 */
function item(title: string, category: string, tags: string[] = []): CreateItemInput {
  return {
    title,
    username: `${title.toLowerCase()}@example.com`,
    password: 'Strong-Pass-9988',
    category,
    tags,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
}

/** 建库 + 渲染主面板，返回 client 便于后续操作。 */
async function setup(inputs: CreateItemInput[] = []): Promise<ReturnType<typeof createTestClient>['client']> {
  const { client } = createTestClient('boot');
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  for (const input of inputs) {
    await client.createItem(input);
  }
  renderWithProviders(
    client,
    <MainPanel
      snapshot={await client.status()}
      onSessionChange={() => {}}
      settingsOpen={false}
      onSettingsOpenChange={() => {}}
    />,
  );
  await screen.findByTestId('item-list');
  await flush();
  return client;
}

describe('FR-03 · 左侧导航「标签」', () => {
  it('数据里出现过的标签进入导航，并归在「标签」分组下', async () => {
    await setup([item('GitHub', '开发', ['代码托管']), item('Figma', '工作', ['设计'])]);

    expect(screen.getByText('标签')).toBeDefined();
    expect(screen.getByRole('button', { name: '代码托管' })).toBeDefined();
    expect(screen.getByRole('button', { name: '设计' })).toBeDefined();
  });

  it('点标签按标签过滤，且不影响分类筛选', async () => {
    await setup([
      item('GitHub', '开发', ['代码托管']),
      item('GitLab', '开发', ['代码托管']),
      item('Figma', '工作', ['设计']),
    ]);

    fireEvent.click(screen.getByRole('button', { name: '代码托管' }));
    await flush();

    expect(screen.getByText('GitHub')).toBeDefined();
    expect(screen.getByText('GitLab')).toBeDefined();
    expect(screen.queryByText('Figma')).toBeNull();
    // 导航 key 带前缀，store 里记的是标签维度而不是分类名。
    expect(useUiStore.getState().filters.category).toBe('tag:代码托管');
  });

  it('标签与分类重名时互不串台：点标签只按标签过滤', async () => {
    await setup([
      // 「工作」既是分类又是标签，但只有 GitHub 两者都占。
      item('GitHub', '工作', ['工作']),
      item('Figma', '工作', ['设计']),
      item('Notion', '其他', ['工作']),
    ]);

    // 两个「工作」：一个是分类项，一个是标签项。取第二个（标签分组在分类之后）。
    const works = screen.getAllByRole('button', { name: '工作' });
    expect(works.length).toBe(2);
    fireEvent.click(works[1]);
    await flush();

    // 按标签「工作」过滤 → GitHub + Notion；Figma 是分类「工作」但没有这个标签。
    expect(screen.getByText('GitHub')).toBeDefined();
    expect(screen.getByText('Notion')).toBeDefined();
    expect(screen.queryByText('Figma')).toBeNull();
  });

  it('隐藏卡片的标签不进导航', async () => {
    await setup([
      item('GitHub', '开发', ['公开标签']),
      { ...item('私密卡', '开发', ['私密标签']), visibility: 'hidden' },
    ]);

    expect(screen.getByRole('button', { name: '公开标签' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '私密标签' })).toBeNull();
  });

  it('标签消失后回到「全部」，不留在空列表上', async () => {
    await setup([item('GitHub', '开发', ['临时标签'])]);

    fireEvent.click(screen.getByRole('button', { name: '临时标签' }));
    await flush();
    expect(useUiStore.getState().filters.category).toBe('tag:临时标签');

    // 删掉唯一带这个标签的卡（走真实 UI：卡片上的「删除」→ 弹窗确认）。
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
    await flush();

    expect(useUiStore.getState().filters.category).toBe('all');
  });
});
