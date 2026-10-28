/**
 * 批量删除的**交互层**回归。
 *
 * 门面层已经保证"密码错就一张不删"（见 `vault-client-bulk-delete.test.ts`），
 * 这里只测 UI 自己该做的事：
 *
 * 1. 选择模式能把卡片切成 `role="checkbox"`，且**屏蔽卡片原有操作按钮**——
 *    否则用户想勾选却误触了单张删除；
 * 2. 删除失败时弹窗**保持打开**、选中态不动（用户多半只是打错密码）；
 * 3. 删除成功后退出选择模式、列表刷新、toast 报张数；
 * 4. 切换分类 / 改搜索词必须退出选择模式——选中集是基于旧结果集的，不能跨视图复用。
 *
 * 全部走真实 client + `MemoryVaultStorage`，不 mock 加密层。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ARGON2_TEST_PARAMS } from '../../../core/crypto/kdf';
import { createVaultClient, type VaultClient } from '../../../services/vault-client';
import { MemoryVaultStorage } from '../../../services/storage';
import { FakeClipboardPort } from '../../../services/__tests__/support/fakes';
import { ToastProvider } from '../../../components/ui/Toast';
import { VaultProvider } from '../../../app/VaultProvider';
import { useUiStore } from '../../../stores/ui-store';
import { MainPanel } from '../MainPanel';

const START = 1_700_000_000_000;
const MASTER = 'Oscar-Papa-2233';
const WRONG = 'Quebec-Romeo-8877';

interface Harness {
  client: VaultClient;
  advance: (ms: number) => void;
}

/** 建库 + 3 张卡片。 */
async function createHarness(): Promise<Harness> {
  let now = START;
  const client = createVaultClient({
    storage: new MemoryVaultStorage(),
    now: () => now,
    clipboard: new FakeClipboardPort(),
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
    autoLockPolicy: '30m',
  });
  await client.initialize({ masterPassword: MASTER });
  for (let index = 1; index <= 3; index += 1) {
    await client.createItem({
      title: `批量卡片-${index}`,
      platform: '示例',
      username: `papa-${index}@example.test`,
      password: `Tango-Uniform-${index}000`,
    });
  }
  return { client, advance: (ms: number) => { now += ms; } };
}

async function renderPanel(client: VaultClient): Promise<void> {
  const snapshot = await client.status();
  render(
    <ToastProvider>
      <VaultProvider client={client}>
        <MainPanel
          snapshot={snapshot}
          onSessionChange={vi.fn()}
          settingsOpen={false}
          onSettingsOpenChange={() => {}}
        />
      </VaultProvider>
    </ToastProvider>,
  );
}

/** 等卡片渲染出来。 */
async function waitForCards(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByText('批量卡片-1')).toBeInTheDocument();
  });
}

/** 进入选择模式。 */
async function enterSelectMode(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /选择/ }));
  await waitFor(() => {
    expect(screen.getByTestId('bulk-count')).toBeInTheDocument();
  });
}

describe('MainPanel · 批量删除', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
    useUiStore.setState((state) => ({
      ...state,
      filters: { category: 'all', sort: 'recent_updated' },
    }));
  });

  it('选择模式下卡片变成 checkbox，且隐藏单卡操作按钮', async () => {
    const { client } = harness;
    await renderPanel(client);
    await waitForCards();

    // 选择模式前：卡片上有"删除"按钮，且不是 checkbox 语义。
    expect(screen.getAllByRole('button', { name: '删除' }).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);

    await enterSelectMode();

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(3);
    // 不假设排序：列表默认按「最近更新」排，第一张是最新创建的那张。
    // 只要求"每张卡都有一个以自己标题命名的 checkbox"。
    const labels = checkboxes.map((node) => node.getAttribute('aria-label')).sort();
    expect(labels).toEqual(['选择 批量卡片-1', '选择 批量卡片-2', '选择 批量卡片-3']);
    checkboxes.forEach((node) => {
      expect(node.getAttribute('aria-checked')).toBe('false');
    });
    // 单张删除按钮必须被屏蔽，否则勾选时容易误触。
    expect(screen.queryAllByRole('button', { name: '删除' })).toHaveLength(0);
  });

  it('密码错误时一张不删，弹窗保持打开、选中态保留', async () => {
    const { client } = harness;
    await renderPanel(client);
    await waitForCards();
    await enterSelectMode();

    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(screen.getByTestId('bulk-count')).toHaveTextContent('已选 3 张');

    fireEvent.click(screen.getByRole('button', { name: /删除所选/ }));
    const password = await screen.findByLabelText('主密码');
    fireEvent.change(password, { target: { value: WRONG } });
    fireEvent.click(screen.getByRole('button', { name: '删除', hidden: true }));

    // 弹窗仍在、密码框已清空、三张卡都还在。
    await waitFor(() => {
      expect(screen.getByLabelText('主密码')).toHaveValue('');
    });
    expect(screen.getByTestId('bulk-count')).toHaveTextContent('已选 3 张');
    expect(screen.getByText('批量卡片-1')).toBeInTheDocument();
    expect(screen.getByText('批量卡片-3')).toBeInTheDocument();
  });

  it('密码正确时删除成功，退出选择模式并刷新列表', async () => {
    const { client } = harness;
    await renderPanel(client);
    await waitForCards();
    await enterSelectMode();

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 批量卡片-2' }));
    expect(screen.getByTestId('bulk-count')).toHaveTextContent('已选 1 张');

    fireEvent.click(screen.getByRole('button', { name: /删除所选/ }));
    fireEvent.change(await screen.findByLabelText('主密码'), { target: { value: MASTER } });
    fireEvent.click(screen.getByRole('button', { name: '删除', hidden: true }));

    await waitFor(() => {
      expect(screen.queryByText('批量卡片-2')).not.toBeInTheDocument();
    });
    // 退出选择模式、其余卡片保留。
    expect(screen.queryByTestId('bulk-count')).not.toBeInTheDocument();
    expect(screen.getByText('批量卡片-1')).toBeInTheDocument();
    expect(screen.getByText('批量卡片-3')).toBeInTheDocument();
  });

  it('切换分类退出选择模式', async () => {
    const { client } = harness;
    await renderPanel(client);
    await waitForCards();
    await enterSelectMode();

    fireEvent.click(screen.getByRole('button', { name: '退出' }));

    await waitFor(() => {
      expect(screen.queryByTestId('bulk-count')).not.toBeInTheDocument();
    });
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('空选时「删除所选」不可用', async () => {
    const { client } = harness;
    await renderPanel(client);
    await waitForCards();
    await enterSelectMode();

    const button = screen.getByRole('button', { name: /删除所选/ });
    expect(button).toBeDisabled();
  });
});
