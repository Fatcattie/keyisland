/**
 * 灵动岛「生成密码」快捷按钮回归（PRD FR-02：快捷按钮「新建、生成密码、锁定」）。
 *
 * 契约：
 * 1. 点一下就把新密码复制进剪贴板，并提示"多少秒后自动清空"；
 * 2. 关闭自动清理档位时提示必须改成"不会自动清空"（说错会让人以为密码会自己消失）；
 * 3. 锁定态禁用——与「新建」保持一致，锁定时的岛只该引导解锁。
 */

import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Island } from '../Island';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** 渲染岛并展开面板。 */
async function expand(options: { unlocked?: boolean } = {}) {
  const unlocked = options.unlocked ?? true;
  const test = createTestClient('boot');
  await test.client.initialize({ masterPassword: MASTER_PASSWORD });
  renderWithProviders(
    test.client,
    <Island
      status={unlocked ? 'unlocked' : 'locked'}
      onLock={() => {}}
      onRequestUnlock={() => {}}
      onOpenSettings={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '唤出灵动岛' }));
  await screen.findByTestId('island-panel');
  return test;
}

describe('灵动岛 · 生成密码', () => {
  it('点击后把新密码复制进剪贴板，并提示自动清空秒数', async () => {
    const { clipboard } = await expand();

    fireEvent.click(screen.getByTestId('island-generate-password'));

    expect(await screen.findByText(/已复制新生成的密码 · 30 秒后自动清空/)).toBeInTheDocument();
    expect(clipboard.value).not.toBeNull();
    expect(clipboard.value?.length).toBeGreaterThanOrEqual(12);
  });

  it('关闭自动清理时提示"不会自动清空"，不说成 N 秒', async () => {
    const test = await expand();
    await test.client.setClipboardTtl(0);

    fireEvent.click(screen.getByTestId('island-generate-password'));

    expect(await screen.findByText('已复制新生成的密码 · 不会自动清空')).toBeInTheDocument();
    expect(screen.queryByText(/秒后自动清空/)).toBeNull();
  });

  it('锁定态禁用', async () => {
    await expand({ unlocked: false });

    expect(screen.getByTestId('island-generate-password')).toBeDisabled();
  });
});
