/**
 * 卡片「跳转」二选一菜单（PRD FR-07.1）。
 *
 * 契约：
 * 1. 只配一个目标 → 直接跳，不弹菜单（多一步选择就是多一次打断）；
 * 2. 两个都配了 → 弹菜单，且**不替用户决定**（不能直接开网页）；
 * 3. 菜单「在浏览器打开」可用，「启动本地应用」置灰并说明需要桌面版；
 * 4. Esc 只关菜单，不冒泡给外层（否则会顺带退出选择模式 / 关详情页）；
 * 5. 一个都没配 → 按钮置灰。
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { ItemCard } from '../ItemCard';
import type { ItemDetail, ItemSummary } from '../../../core/vault/types';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

const NOW = 1_700_000_000_000;
const URL_VALUE = 'https://store.steampowered.com/login';

function makeSummary(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: 1,
    title: 'Steam',
    platform: 'Steam',
    username: 'demo-user',
    category: '游戏',
    tags: [],
    favorite: false,
    visibility: 'normal',
    updatedAt: NOW,
    hasUrl: false,
    hasAppTarget: false,
    ...overrides,
  };
}

function makeDetail(summary: ItemSummary): ItemDetail {
  return {
    ...summary,
    url: URL_VALUE,
    appPath: 'steam://open/',
    passwordUpdatedAt: NOW,
  };
}

/** 渲染卡片，返回 window.open 的 spy。 */
async function setup(
  summary: ItemSummary,
  wrapper?: { onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void },
) {
  const { client } = createTestClient('boot');
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  const getItem = vi.spyOn(client, 'getItem').mockResolvedValue(makeDetail(summary));
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);

  const card = (
    <ItemCard
      item={summary}
      now={NOW}
      onEdit={() => {}}
      onRequestDelete={() => {}}
      onChanged={() => {}}
    />
  );
  renderWithProviders(
    client,
    wrapper === undefined ? (
      card
    ) : (
      <div onKeyDown={wrapper.onKeyDown}>{card}</div>
    ),
  );
  return { open, getItem };
}

describe('FR-07.1 · 卡片跳转目标二选一', () => {
  it('只配网址：直接打开，不弹菜单', async () => {
    const { open } = await setup(makeSummary({ hasUrl: true }));

    fireEvent.click(screen.getByRole('button', { name: '打开链接' }));

    await waitFor(() => {
      expect(open).toHaveBeenCalledWith(URL_VALUE, '_blank', 'noopener,noreferrer');
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('两个都配了：弹菜单，且不替用户决定', async () => {
    const { open } = await setup(makeSummary({ hasUrl: true, hasAppTarget: true }));

    fireEvent.click(screen.getByRole('button', { name: '打开链接' }));

    const menu = await screen.findByRole('menu', { name: '选择跳转目标' });
    expect(menu).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    // 触发按钮要如实宣告它开了个菜单。
    expect(screen.getByRole('button', { name: '打开链接' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('选「在浏览器打开」：跳转并收起菜单', async () => {
    const { open } = await setup(makeSummary({ hasUrl: true, hasAppTarget: true }));
    fireEvent.click(screen.getByRole('button', { name: '打开链接' }));
    await screen.findByRole('menu', { name: '选择跳转目标' });

    fireEvent.click(screen.getByRole('menuitem', { name: '在浏览器打开' }));

    await waitFor(() => {
      expect(open).toHaveBeenCalledWith(URL_VALUE, '_blank', 'noopener,noreferrer');
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('「启动本地应用」在 Web 阶段置灰，并说明需要桌面版', async () => {
    await setup(makeSummary({ hasUrl: true, hasAppTarget: true }));
    fireEvent.click(screen.getByRole('button', { name: '打开链接' }));

    const item = await screen.findByRole('menuitem', { name: '启动本地应用' });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute('title', expect.stringContaining('桌面版'));
  });

  it('Esc 只关菜单，不冒泡到外层', async () => {
    const outer = vi.fn();
    await setup(makeSummary({ hasUrl: true, hasAppTarget: true }), { onKeyDown: outer });
    fireEvent.click(screen.getByRole('button', { name: '打开链接' }));
    const menu = await screen.findByRole('menu', { name: '选择跳转目标' });

    fireEvent.keyDown(menu, { key: 'Escape' });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  it('没有配置任何目标：按钮置灰', async () => {
    await setup(makeSummary());

    expect(screen.getByRole('button', { name: '打开链接' })).toBeDisabled();
  });
});
