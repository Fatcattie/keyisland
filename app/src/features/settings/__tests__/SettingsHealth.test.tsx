/** 设置面板 · 密码体检交互测试。 */
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPanel } from '../SettingsPanel';
import { renderWithProviders, createTestClient } from '../../__tests__/support/harness';

const MASTER = 'Alpha-Bravo-7788';
const SHARED_PASSWORD = 'Same-Pass-1';
const UNIQUE_PASSWORD = 'Unique-Pass-2';

async function renderPanel(options: { autoLockPolicy?: '30m' | 'boot'; onLocateItem?: (title: string) => void } = {}) {
  const { client } = createTestClient(options.autoLockPolicy ?? 'boot');
  await client.initialize({ masterPassword: MASTER });
  const user = userEvent.setup();
  renderWithProviders(
    client,
    <SettingsPanel
      open
      snapshot={await client.status()}
      onClose={() => {}}
      onSessionChange={() => {}}
      onDataChanged={() => {}}
      onLocateItem={options.onLocateItem}
    />,
  );
  // 等面板打开时的异步加载（数据文件位置）落定，避免 act 警告与竞态断言。
  await screen.findByTestId('storage-location');
  return { client, user };
}

describe('设置面板 · 密码体检', () => {
  it('列出重复密码分组，且界面上不出现密码明文', async () => {
    const { client, user } = await renderPanel();
    await client.createItem({ title: 'GitHub', username: 'dev@example.com', password: SHARED_PASSWORD });
    await client.createItem({ title: 'GitLab', username: 'dev@example.com', password: SHARED_PASSWORD });
    await client.createItem({ title: '邮箱', username: 'me@example.com', password: UNIQUE_PASSWORD });

    await user.click(screen.getByRole('button', { name: '开始体检' }));

    await waitFor(() => {
      expect(screen.getByText('2 张卡片使用同一个密码')).toBeDefined();
    });
    expect(screen.getByText('GitHub')).toBeDefined();
    expect(screen.getByText('GitLab')).toBeDefined();
    expect(screen.getByText(/共检查 3 张卡片/)).toBeDefined();

    // 明文既不在结果区，也不在任何 DOM 属性里。
    expect(screen.queryByText(SHARED_PASSWORD)).toBeNull();
    expect(document.body.innerHTML).not.toContain(SHARED_PASSWORD);
    expect(document.body.innerHTML).not.toContain(UNIQUE_PASSWORD);
  });

  it('弱密码被单独列出并给出原因', async () => {
    const { client, user } = await renderPanel();
    await client.createItem({ title: '弱卡', username: 'weak@example.com', password: '123' });

    await user.click(screen.getByRole('button', { name: '开始体检' }));

    await waitFor(() => {
      expect(screen.getByText('弱密码（1）')).toBeDefined();
    });
    expect(screen.getByText(/弱卡/)).toBeDefined();
    expect(screen.getByText(/强度不足/)).toBeDefined();
    // 弱密码的明文同样不得出现在界面上。
    expect(document.body.innerHTML).not.toContain('"123"');
  });

  it('全部健康时给出空态结论', async () => {
    const { client, user } = await renderPanel();
    await client.createItem({ title: 'GitHub', username: 'dev@example.com', password: UNIQUE_PASSWORD });

    await user.click(screen.getByRole('button', { name: '开始体检' }));

    await waitFor(() => {
      // toast 也会出现"全部健康"，这里断言结果区那句唯一文案。
      expect(screen.getByText('全部健康：没有重复密码、弱密码或过期密码。')).toBeDefined();
    });
    expect(screen.queryByText('弱密码（0）')).toBeNull();
  });

  it('点击「定位」把标题回传给父组件', async () => {
    const onLocateItem = vi.fn();
    const { client, user } = await renderPanel({ onLocateItem });
    await client.createItem({ title: '弱卡', username: 'weak@example.com', password: '123' });

    await user.click(screen.getByRole('button', { name: '开始体检' }));
    await waitFor(() => {
      expect(screen.getByText('弱密码（1）')).toBeDefined();
    });
    await user.click(screen.getByRole('button', { name: '定位' }));
    expect(onLocateItem).toHaveBeenCalledWith('弱卡');
  });

  it('锁定态体检被拒绝，并提示先解锁', async () => {
    const { client, user } = await renderPanel();
    await client.createItem({ title: 'GitHub', username: 'dev@example.com', password: SHARED_PASSWORD });
    await client.lock('manual');

    await user.click(screen.getByRole('button', { name: '开始体检' }));
    await waitFor(() => {
      expect(screen.getByText('保险库已锁定，请先解锁')).toBeDefined();
    });
    // 结果区保持关闭，不会展示任何体检数据。
    expect(screen.queryByText(/共检查/)).toBeNull();
  });

  it('体检结果可手动清除', async () => {
    const { client, user } = await renderPanel();
    await client.createItem({ title: 'GitHub', username: 'dev@example.com', password: SHARED_PASSWORD });
    await client.createItem({ title: 'GitLab', username: 'dev@example.com', password: SHARED_PASSWORD });

    await user.click(screen.getByRole('button', { name: '开始体检' }));
    await waitFor(() => {
      expect(screen.getByText('2 张卡片使用同一个密码')).toBeDefined();
    });

    await user.click(screen.getByRole('button', { name: '清除结果' }));
    expect(screen.queryByText('2 张卡片使用同一个密码')).toBeNull();
  });
});
