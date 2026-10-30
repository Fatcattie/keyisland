/** 设置面板 · 资产迁移包的导出范围。 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { SettingsPanel } from '../SettingsPanel';
import { createTestClient, renderWithProviders } from '../../__tests__/support/harness';

const MASTER = 'Master!2026';

/**
 * 建库并渲染设置面板。
 *
 * `seed` 在**渲染前**写入：分类下拉是在面板打开时读一次列表汇总的，
 * 渲染后再建卡就赶不上这次汇总。
 */
async function renderPanel(seed?: { title: string; category: string }) {
  const test = createTestClient();
  await test.client.initialize({ masterPassword: MASTER });
  if (seed !== undefined) {
    await test.client.createItem({
      title: seed.title,
      username: 'u',
      password: 'Pass-1-Aa1!',
      category: seed.category,
    });
  }
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
  // 等面板初始化那批异步加载（存储位置 / 备份状态 / 日志 / 热区 / 分类）落定，
  // 否则它们的 setState 会落在测试边界外，刷一堆 act 警告。
  await screen.findByTestId('storage-location');
  return test.client;
}

/** 展开资产迁移区，等分类下拉被填上（预设分类里一定有「工作」）。 */
async function openBundleSection(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '资产批量迁移' }));
  await waitFor(() => {
    expect(screen.getByRole('option', { name: '工作' })).toBeDefined();
  });
}

/** 点「导出加密资产包」。 */
function clickExport(): void {
  fireEvent.click(screen.getByRole('button', { name: '导出加密资产包' }));
}

describe('设置面板 · 资产包导出范围', () => {
  it('展开后默认「全部卡片」，导出时不传分类', async () => {
    const client = await renderPanel();
    const spy = vi.spyOn(client, 'exportAssetBundle').mockResolvedValue('{"magic":"KIA1"}');

    await openBundleSection();
    const scope = screen.getByLabelText('导出范围') as HTMLSelectElement;
    expect(scope.value).toBe('');
    expect(scope.selectedOptions[0].textContent).toBe('全部卡片');

    fireEvent.change(screen.getByLabelText('导出主密码'), { target: { value: MASTER } });
    clickExport();

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(MASTER, undefined);
    });
  });

  it('选了分类就只导出该分类', async () => {
    const client = await renderPanel();
    const spy = vi.spyOn(client, 'exportAssetBundle').mockResolvedValue('{"magic":"KIA1"}');

    await openBundleSection();
    // 预设分类在面板打开时就已列出，不需要库里先有卡片。
    fireEvent.change(screen.getByLabelText('导出范围'), { target: { value: '工作' } });
    fireEvent.change(screen.getByLabelText('导出主密码'), { target: { value: MASTER } });
    clickExport();

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(MASTER, { category: '工作' });
    });
  });

  it('库里的自定义分类也会出现在下拉里', async () => {
    await renderPanel({ title: 'Home', category: '家庭' });

    await openBundleSection();
    await waitFor(() => {
      expect(screen.getByRole('option', { name: '家庭' })).toBeDefined();
    });
  });
});
