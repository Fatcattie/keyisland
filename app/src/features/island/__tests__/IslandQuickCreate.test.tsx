/** 灵动岛快捷新建：岛内建卡 + 生成密码 + 复制闭环。 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Island } from '../Island';
import { createTestClient, renderWithProviders, MASTER_PASSWORD } from '../../__tests__/support/harness';
import type { TestClient } from '../../__tests__/support/harness';
import { useUiStore } from '../../../stores/ui-store';

/** 用调用方准备好的 client 渲染一座已解锁的灵动岛。 */
function renderIslandWith(test: TestClient): void {
  renderWithProviders(test.client, <Island status="unlocked" onLock={() => {}} onRequestUnlock={() => {}} onOpenSettings={() => {}} />);
}

/**
 * 让展开副作用里的异步 `setState` 在 `act` 内落地。
 *
 * `Island` 展开后会 `await client.getRecentItems()` 再 `setItems`；若测试不等待这段
 * 微/宏任务链，React 会抛 "An update to Island inside a test was not wrapped in act"。
 * 那类警告会掩盖真实的时序断言，所以这里主动 flush 一次宏任务。
 */
async function flushAsyncEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
}

/** 用 act 包住 store 操作后展开面板，并等搜索框与异步列表都就绪。 */
async function openPanel(): Promise<void> {
  act(() => {
    useUiStore.getState().openIsland();
  });
  await screen.findByPlaceholderText('搜索资产…');
  await flushAsyncEffects();
}

beforeEach(() => {
  // 没有整体 reset，用 finishClosing 复位到收起态并清空搜索词。
  useUiStore.getState().closeIsland();
  useUiStore.getState().finishClosing();
});

describe('Island 快捷新建', () => {
  it('打开新建面板会预生成 12 位以上密码', async () => {
    const test = createTestClient();
    await test.client.initialize({ masterPassword: MASTER_PASSWORD });
    renderIslandWith(test);
    await openPanel();

    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    const password = screen.getByLabelText('密码') as HTMLInputElement;
    expect(password.value.length).toBeGreaterThanOrEqual(12);
    // 密码可自定义（用户需求）：不再是只读输入框。
    expect(password.readOnly).toBe(false);

    // 重新生成会换一个新密码。
    const before = password.value;
    fireEvent.click(screen.getByRole('button', { name: '重新生成密码' }));
    await waitFor(() => {
      expect((screen.getByLabelText('密码') as HTMLInputElement).value).not.toBe(before);
    });
  });

  it('可以自定义密码：创建时用用户填的密码（不再强制生成）', async () => {
    const test = createTestClient();
    await test.client.initialize({ masterPassword: MASTER_PASSWORD });
    renderIslandWith(test);
    await openPanel();

    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '自定义 · 密码' } });
    fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'me@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'MyOwnPass!2026' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并复制密码' }));

    await waitFor(() => {
      expect(screen.getByText('已创建卡片，密码已复制到剪贴板')).toBeDefined();
    });
    // 剪贴板里是用户填的那个密码（copyPassword 复制的是落库值，能反证存的是自定义密码）。
    expect(test.clipboard.value).toBe('MyOwnPass!2026');
    expect(await test.client.listItems()).toHaveLength(1);
  });

  it('创建后卡片入库、密码写入剪贴板、岛自动收起', async () => {
    const test = createTestClient();
    await test.client.initialize({ masterPassword: MASTER_PASSWORD });
    renderIslandWith(test);
    await openPanel();

    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '快捷 · Notion' } });
    fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'quick@example.com' } });
    const password = (screen.getByLabelText('密码') as HTMLInputElement).value;
    fireEvent.click(screen.getByRole('button', { name: '创建并复制密码' }));

    await waitFor(() => {
      expect(screen.getByText('已创建卡片，密码已复制到剪贴板')).toBeDefined();
    });
    // 卡片真的进了库（走真实加密链路），密码真的写进了剪贴板。
    const list = await test.client.listItems();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('快捷 · Notion');
    expect(test.clipboard.value).toBe(password);
    // 5 秒闭环：创建完成后岛开始收起（closing → collapsed，由动画定时器收尾）。
    expect(useUiStore.getState().island.phase).not.toBe('expanded');
  });

  it('标题为空时不创建，只提示', async () => {
    const test = createTestClient();
    await test.client.initialize({ masterPassword: MASTER_PASSWORD });
    renderIslandWith(test);
    await openPanel();

    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    fireEvent.click(screen.getByRole('button', { name: '创建并复制密码' }));
    await waitFor(() => {
      expect(screen.getByText('请填写标题')).toBeDefined();
    });
    expect(await test.client.listItems()).toHaveLength(0);
    expect(screen.getByLabelText('标题')).toBeDefined();
  });

  it('Esc 在新建面板里只退出新建，不收起岛', async () => {
    const test = createTestClient();
    await test.client.initialize({ masterPassword: MASTER_PASSWORD });
    renderIslandWith(test);
    await openPanel();

    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    expect(screen.getByLabelText('标题')).toBeDefined();

    const panel = screen.getByTestId('island-panel');
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(screen.queryByLabelText('标题')).toBeNull();
    expect(useUiStore.getState().island.phase).toBe('expanded');
  });

  it('表单里按 Enter 建卡，不会把旧卡的密码复制进剪贴板（QA P1）', async () => {
    const test = createTestClient();
    await test.client.initialize({ masterPassword: MASTER_PASSWORD });
    const existing = await test.client.createItem({
      title: '旧卡',
      username: 'old@example.com',
      password: 'Old-Secret-1',
    });
    // 先让剪贴板里有值：这样"被误复制"是可观测的（旧实现会把它换成旧卡的密码）。
    await test.client.copyPassword(existing.id);
    expect(test.clipboard.value).toBe('Old-Secret-1');

    renderIslandWith(test);
    await openPanel();

    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    const titleInput = screen.getByLabelText('标题');
    fireEvent.change(titleInput, { target: { value: '新卡 Enter' } });
    // 账号按 PRD 必填（prd.md:139 账号*、prd.md:296 username_enc NOT NULL），
    // 表单标签已对齐为「账号」。
    fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'new@example.com' } });

    // 在标题框里按 Enter：面板这一层**不能** preventDefault，否则浏览器的隐式提交
    // 会被掐掉、表单永远不 submit。`fireEvent` 返回 false 就代表事件被取消了。
    const notCancelled = fireEvent.keyDown(titleInput, { key: 'Enter' });
    expect(notCancelled).toBe(true);

    // 剪贴板与 toast 都不能被旧卡污染。
    expect(test.clipboard.value).toBe('Old-Secret-1');
    expect(screen.queryByText('已复制密码 · 30 秒后自动清空')).toBeNull();

    // jsdom 不实现"输入框里按 Enter 触发表单隐式提交"，这里手动补上浏览器会做的事：
    // 触发 form 的 submit。真正要验的是"面板没有拦掉这条路"。
    const form = titleInput.closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    await waitFor(() => {
      expect(screen.getByText('已创建卡片，密码已复制到剪贴板')).toBeDefined();
    });
    const list = await test.client.listItems();
    expect(list).toHaveLength(2);
    expect(list.some((item) => item.title === '新卡 Enter')).toBe(true);
    // 新卡的密码进了剪贴板，且绝不是旧卡的。
    expect(test.clipboard.value).not.toBe('Old-Secret-1');
  });

  it('表单开着时列表语义闭嘴：aria-expanded=false、无 aria-controls、无 aria-activedescendant', async () => {
    const test = createTestClient();
    await test.client.initialize({ masterPassword: MASTER_PASSWORD });
    const first = await test.client.createItem({ title: 'GitHub', username: 'dev', password: 'Secret-A' });
    const second = await test.client.createItem({ title: '邮箱', username: 'me', password: 'Secret-B' });
    await test.client.copyPassword(first.id);
    await test.client.copyPassword(second.id);

    renderIslandWith(test);
    await openPanel();

    const input = screen.getByTestId('island-input');
    // 打开表单前：列表真的在，三个属性都该有值。
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', 'island-listbox');
    const beforeId = input.getAttribute('aria-activedescendant');
    expect(beforeId).not.toBeNull();
    expect(document.getElementById(beforeId as string)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '新建' }));

    // 打开表单后：列表已被表单替换，三个属性必须一起闭嘴，否则屏幕阅读器被两头骗。
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input.getAttribute('aria-controls')).toBeNull();
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });
});
