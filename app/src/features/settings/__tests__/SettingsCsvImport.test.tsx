/** 设置面板 · CSV 导入。 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { SettingsPanel } from '../SettingsPanel';
import { createTestClient, renderWithProviders } from '../../__tests__/support/harness';

const MASTER = 'Master!2026';

const CSV = [
  'name,username,password,url',
  'GitHub,dev@example.com,Pass-1-Aa1!,https://github.com',
  'NoPass,u@example.com,,',
].join('\n');

function csvFile(content: string, name = 'passwords.csv'): File {
  return new File([content], name, { type: 'text/csv' });
}

function pick(target: HTMLElement, file: File): void {
  Object.defineProperty(target, 'files', { value: [file], configurable: true });
  fireEvent.change(target);
}

async function renderPanel(): Promise<ReturnType<typeof createTestClient>['client']> {
  const test = createTestClient();
  await test.client.initialize({ masterPassword: MASTER });
  renderWithProviders(
    test.client,
    <SettingsPanel
      open
      snapshot={await test.client.status()}
      onClose={() => {}}
      onSessionChange={() => {}}
      onDataChanged={() => {}}
    />,
  );
  return test.client;
}

describe('设置面板 · CSV 导入', () => {
  it('选择 CSV 后预览条目数与跳过行，且不显示密码明文', async () => {
    const client = await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '导入 CSV' }));
    pick(screen.getByLabelText('CSV 文件'), csvFile(CSV));

    await waitFor(() => {
      expect(screen.getByText(/可导入/)).toBeDefined();
    });
    // 文本被拆成多个节点，用函数匹配。
    // 文本被拆成多个节点，用函数匹配（命中 <li> 本身）。
    expect(screen.getByRole('listitem').textContent).toBe('第 3 行：缺少密码');
    expect(screen.getByText(/跳过 1 行/)).toBeDefined();
    // 界面只有计数与原因，密码明文不出现在 DOM 里。
    expect(document.body.textContent).not.toContain('Pass-1-Aa1!');
    void client;
  });

  it('无法识别的 CSV 给出明确错误，不进入导入', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '导入 CSV' }));
    pick(screen.getByLabelText('CSV 文件'), csvFile('只有一列\n值\n'));

    await waitFor(() => {
      expect(screen.getByText('没能自动识别列名，请在下方手动指定名称、账号和密码')).toBeDefined();
    });
    const importButton = screen.getByRole('button', { name: /导入 \d+ 张卡片/ });
    expect(importButton).toBeDisabled();
  });

  it('自动识别失败时仍可手动映射三列，映射后即可导入', async () => {
    const client = await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '导入 CSV' }));
    // 表头是自定义英文，别名表认不出来 —— 这正是最需要手动映射的场景。
    pick(screen.getByLabelText('CSV 文件'), csvFile('service,login,secret\nGitHub,octocat,Pass-1-Aa1!\n'));

    await waitFor(() => {
      expect(screen.getByText('没能自动识别列名，请在下方手动指定名称、账号和密码')).toBeDefined();
    });
    // 映射界面必须存在（旧实现里此时整块都不渲染，用户无从修正）。
    const titleSelect = screen.getByLabelText(/^名称/) as HTMLSelectElement;

    fireEvent.change(titleSelect, { target: { value: 'service' } });
    fireEvent.change(screen.getByLabelText(/^账号/), { target: { value: 'login' } });
    fireEvent.change(screen.getByLabelText(/^密码/), { target: { value: 'secret' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '导入 1 张卡片' })).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: '导入 1 张卡片' }));
    await waitFor(() => {
      expect(screen.getByText(/已导入 1 张卡片/)).toBeDefined();
    });

    const list = await client.listItems();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('GitHub');
  });

  it('确认导入后条目真的入库（走真实加密链路）', async () => {
    const client = await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '导入 CSV' }));
    pick(screen.getByLabelText('CSV 文件'), csvFile(CSV));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '导入 1 张卡片' })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: '导入 1 张卡片' }));
    await waitFor(() => {
      expect(screen.getByText(/已导入 1 张卡片，跳过 1 行/)).toBeDefined();
    });

    const list = await client.listItems();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('GitHub');
    // URL 只在详情里，顺便确认它真的被加密入库。
    const detail = await client.getItem(list[0].id);
    expect(detail.url).toBe('https://github.com');
    expect(detail.username).toBe('dev@example.com');
  });
});
