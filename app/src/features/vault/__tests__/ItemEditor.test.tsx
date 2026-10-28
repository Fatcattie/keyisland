/**
 * 资产编辑器回归测试。
 *
 * 覆盖：必填校验就地提示、编辑受限档位时可见性保持原值、生成密码写入密码框、
 * 新建成功后落库。
 *
 * 注意：定位控件一律用 `id` 而不是 label 文本 —— 编辑器里有一个
 * `aria-label="密码生成器"` 的分组，用 `/^密码/` 会同时命中它。
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ItemEditor } from '../ItemEditor';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';
import type { ItemDetail } from '../../../core/vault/types';

/** 按 id 取控件。 */
function control<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  expect(node).not.toBeNull();
  return node as T;
}

/** 提交编辑器表单（footer 的保存按钮通过 form 属性关联，直接触发 submit 更稳定）。 */
function submitForm(): void {
  const form = document.getElementById('item-editor-form');
  expect(form).not.toBeNull();
  fireEvent.submit(form as HTMLFormElement);
}

/** 建库 + 一张 username_only 卡片。 */
async function setup(): Promise<{
  client: ReturnType<typeof createTestClient>['client'];
  detail: ItemDetail;
}> {
  const { client } = createTestClient();
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  const created = await client.createItem({
    title: '流媒体',
    platform: '流媒体',
    username: 'watch-bravo',
    password: 'Value-Bravo-2',
    visibility: 'username_only',
  });
  const detail = await client.getItem(created.id);
  return { client, detail };
}

describe('ItemEditor 编辑器', () => {
  it('必填项为空时就地提示，不发起保存', async () => {
    const { client } = await setup();
    renderWithProviders(
      client,
      <ItemEditor open item={null} onClose={vi.fn()} onSaved={vi.fn()} />,
    );

    submitForm();

    expect(await screen.findByText('请填写标题')).toBeInTheDocument();
    expect(screen.getByText('请填写账号')).toBeInTheDocument();
    expect(screen.getByText('请填写密码')).toBeInTheDocument();
    // 原有那一张卡片仍然只有一张，说明没有新增。
    expect(await client.listItems()).toHaveLength(1);
  });

  it('编辑受限档位时可见性保持原值，不会自动放开', async () => {
    const { client, detail } = await setup();
    const onSaved = vi.fn();
    renderWithProviders(
      client,
      <ItemEditor open item={detail} onClose={vi.fn()} onSaved={onSaved} />,
    );

    expect(control<HTMLSelectElement>('editor-visibility')).toHaveValue('username_only');
    expect(screen.getByText(/当前为受限档位，保存不会自动放开/)).toBeInTheDocument();

    fireEvent.change(control('editor-title'), { target: { value: '流媒体（已改）' } });
    submitForm();

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    const updated = await client.getItem(detail.id);
    expect(updated.title).toBe('流媒体（已改）');
    expect(updated.visibility).toBe('username_only');
  });

  it('生成强密码写入密码框', async () => {
    const { client } = await setup();
    renderWithProviders(
      client,
      <ItemEditor open item={null} onClose={vi.fn()} onSaved={vi.fn()} />,
    );

    const password = control<HTMLInputElement>('editor-password');
    expect(password.value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: '生成' }));

    await waitFor(() => {
      expect(password.value.length).toBe(20);
    });
    expect(password.value).toMatch(/[a-z]/u);
    expect(password.value).toMatch(/[A-Z]/u);
    expect(password.value).toMatch(/[0-9]/u);
  });

  it('新建成功后写入加密存储并回调 onSaved', async () => {
    const { client } = await setup();
    const onSaved = vi.fn();
    renderWithProviders(
      client,
      <ItemEditor open item={null} onClose={vi.fn()} onSaved={onSaved} />,
    );

    fireEvent.change(control('editor-title'), { target: { value: '新卡片' } });
    fireEvent.change(control('editor-username'), { target: { value: 'new-user' } });
    fireEvent.change(control('editor-password'), { target: { value: 'Value-New-3' } });
    submitForm();

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    const items = await client.listItems();
    expect(items.map((item) => item.title)).toContain('新卡片');
  });
});
