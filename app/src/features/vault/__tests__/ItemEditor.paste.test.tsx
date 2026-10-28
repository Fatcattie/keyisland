/**
 * 资产编辑器的**剪贴板粘贴**回归（PRD `prd.md:157` FR-04.1 P0）。
 *
 * 覆盖四条契约：
 * 1. 粘贴账号 → 填入账号框；
 * 2. 粘贴密码 → 填入密码框，且**仍然是 `type="password"`**（不自动显形）；
 * 3. 读不到剪贴板（权限被拒）→ 给出提示且**不改动**已有输入；
 * 4. 剪贴板空白 → 给出提示且**不改动**已有输入。
 *
 * 隐私契约顺带钉住：粘贴内容绝不作为可见文本渲染——通知里也不许出现。
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ItemEditor } from '../ItemEditor';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** 建库，并把剪贴板替身一起交出来（走真实 `ClipboardPort.read()`）。 */
async function setup(): Promise<{
  client: ReturnType<typeof createTestClient>['client'];
  clipboard: ReturnType<typeof createTestClient>['clipboard'];
}> {
  const { client, clipboard } = createTestClient();
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  return { client, clipboard };
}

/** 按 id 取控件。 */
function control<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  expect(node).not.toBeNull();
  return node as T;
}

describe('ItemEditor · 从剪贴板粘贴', () => {
  it('粘贴账号填入账号框', async () => {
    const { client, clipboard } = await setup();
    clipboard.value = 'pasted-user@example.test';
    renderWithProviders(client, <ItemEditor open item={null} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '粘贴账号' }));

    await waitFor(() => {
      expect(control<HTMLInputElement>('editor-username').value).toBe('pasted-user@example.test');
    });
    // 粘贴内容不得作为可见文本出现在页面上（不进 toast 等任何通知）。
    expect(screen.queryByText('pasted-user@example.test')).toBeNull();
  });

  it('粘贴密码填入密码框，但仍保持遮蔽', async () => {
    const { client, clipboard } = await setup();
    clipboard.value = 'Zulu-Yankee-1234';
    renderWithProviders(client, <ItemEditor open item={null} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '粘贴密码' }));

    await waitFor(() => {
      expect(control<HTMLInputElement>('editor-password').value).toBe('Zulu-Yankee-1234');
    });
    expect(control<HTMLInputElement>('editor-password').type).toBe('password');
    expect(screen.queryByText('Zulu-Yankee-1234')).toBeNull();
  });

  it('读不到剪贴板时提示，且不改动已填内容', async () => {
    const { client, clipboard } = await setup();
    clipboard.denyRead = true;
    renderWithProviders(client, <ItemEditor open item={null} onClose={vi.fn()} onSaved={vi.fn()} />);

    const username = control<HTMLInputElement>('editor-username');
    fireEvent.change(username, { target: { value: 'already-here@example.test' } });

    fireEvent.click(screen.getByRole('button', { name: '粘贴账号' }));

    expect(await screen.findByText('无法读取剪贴板，请允许浏览器的剪贴板读取权限')).toBeInTheDocument();
    expect(username.value).toBe('already-here@example.test');
  });

  it('剪贴板空白时提示，且不改动已填内容', async () => {
    const { client, clipboard } = await setup();
    clipboard.value = '   ';
    renderWithProviders(client, <ItemEditor open item={null} onClose={vi.fn()} onSaved={vi.fn()} />);

    const username = control<HTMLInputElement>('editor-username');
    fireEvent.change(username, { target: { value: 'keep-me@example.test' } });

    fireEvent.click(screen.getByRole('button', { name: '粘贴账号' }));

    expect(await screen.findByText('剪贴板是空的')).toBeInTheDocument();
    expect(username.value).toBe('keep-me@example.test');
  });
});
