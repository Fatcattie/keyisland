/**
 * 设置面板 · Windows 剪贴板历史风险提示回归（PRD FR-05 P0）。
 *
 * PRD 原文：「剪贴板…设置页检测并提示 Windows『Win+V 剪贴板历史』风险、引导关闭」。
 *
 * 契约：
 * 1. 提示必须**常驻可见**——它是安全警示，不能默认收起或藏在折叠区里；
 * 2. 必须说明白"为什么自动清理挡不住"（自动清理只清当前项，历史记录在别处）；
 * 3. 必须给出可操作的关闭步骤。
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
  // 等面板打开时的异步加载（数据文件位置）落定，避免 act 警告与竞态断言。
  await screen.findByTestId('storage-location');
}

describe('设置面板 · 剪贴板历史风险提示', () => {
  it('常驻展示，并说明自动清理挡不住剪贴板历史', async () => {
    await setup();

    const notice = screen.getByTestId('clipboard-history-notice');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent('Windows 剪贴板历史风险');
    // 关键点：必须讲清"自动清理只清当前项"，否则用户会误以为设了 30 秒就安全了。
    expect(notice).toHaveTextContent('自动清理只能清掉「当前」剪贴板项');
    expect(notice).toHaveTextContent('Windows 会另行留存每次复制的记录');
    expect(notice).toHaveTextContent('Win');
    expect(notice).toHaveTextContent('V');
  });

  it('给出可操作的关闭步骤', async () => {
    await setup();

    const notice = screen.getByTestId('clipboard-history-notice');
    expect(notice).toHaveTextContent('设置 → 系统 → 剪贴板');
    expect(notice).toHaveTextContent('关掉「剪贴板历史」');
    // 已经复制过的用户需要知道还能补救。
    expect(notice).toHaveTextContent('立刻去清一次历史');
  });

  it('紧挨着剪贴板清理设置，用户在调这个选项时能看到它', async () => {
    await setup();

    const ttl = document.getElementById('settings-ttl');
    expect(ttl).not.toBeNull();
    const notice = screen.getByTestId('clipboard-history-notice');
    // `DOCUMENT_POSITION_PRECEDING`（值 2）表示 notice 在 ttl 之前，即提示紧跟选择框之后渲染。
    expect(notice.compareDocumentPosition(ttl as Node) & Node.DOCUMENT_POSITION_PRECEDING).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );
  });
});
