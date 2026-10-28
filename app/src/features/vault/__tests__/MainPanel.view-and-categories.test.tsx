/**
 * 主面板 · 展示方式切换与自定义分类导航（PRD FR-03）。
 *
 * 契约：
 * 1. 默认网格；切到列表后容器变成单列，且两个按钮的 `aria-pressed` 互斥；
 * 2. 自定义分类（编辑器里自由输入的那种）必须出现在左侧导航里并能筛选——
 *    否则用户建了「工具」却只能靠搜索找到它，"可自定义"就是半截的；
 * 3. 隐藏卡片的分类**不得**出现在导航里：连"存在"都不该暴露。
 */

import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { MainPanel } from '../MainPanel';
import type { CreateItemInput } from '../../../core/vault/types';
import type { VaultClient } from '../../../services/vault-client';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** 一条最小可用的资产入参。 */
function item(title: string, category: string, visibility: 'normal' | 'hidden' = 'normal'): CreateItemInput {
  return {
    title,
    username: `${title.toLowerCase()}-user`,
    password: 'Passw0rd!234',
    category,
    visibility,
  };
}

/** 建库、灌数据、渲染主面板。 */
async function setup(inputs: CreateItemInput[] = []): Promise<VaultClient> {
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
  // 分类统计是异步的一趟（listItems），等它落定再返回：
  // 否则它会在测试的同步断言之后 setState，产生 act 警告。
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
  return client;
}

describe('FR-03 · 展示方式切换', () => {
  it('默认网格，切到列表后容器与按钮状态同步变化', async () => {
    await setup([item('GitHub', '开发')]);

    expect(screen.getByTestId('item-list')).toHaveAttribute('data-view', 'grid');
    expect(screen.getByRole('button', { name: '网格视图' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '列表视图' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: '列表视图' }));

    expect(screen.getByTestId('item-list')).toHaveAttribute('data-view', 'list');
    expect(screen.getByRole('button', { name: '列表视图' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '网格视图' })).toHaveAttribute('aria-pressed', 'false');

    // 切回来也要能切回去（不是单向开关）。
    fireEvent.click(screen.getByRole('button', { name: '网格视图' }));
    expect(screen.getByTestId('item-list')).toHaveAttribute('data-view', 'grid');
  });
});

describe('FR-03 · 自定义分类进导航', () => {
  it('数据里出现的自定义分类会出现在导航，点它按分类筛选', async () => {
    await setup([item('GitHub', '开发'), item('Docker', '工具')]);

    const navItem = await screen.findByRole('button', { name: '工具' });
    fireEvent.click(navItem);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '工具' })).toHaveAttribute('aria-current', 'page');
    });
    expect(await screen.findByText('Docker')).toBeInTheDocument();
    expect(screen.queryByText('GitHub')).toBeNull();
  });

  it('隐藏卡片的分类不进入导航', async () => {
    await setup([item('Docker', '工具'), item('Steam', '私密', 'hidden')]);

    // 先等可见的自定义分类出现——证明"统计分类"这一趟已经跑完了。
    await screen.findByRole('button', { name: '工具' });

    // 然后断言隐藏卡片的分类确实不在导航里。
    expect(screen.queryByRole('button', { name: '私密' })).toBeNull();
  });
});
