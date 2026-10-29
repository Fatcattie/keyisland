/** 设置面板 · 选错文件类型的引导（.kib ⇄ .kia）。 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { SettingsPanel } from '../SettingsPanel';
import { createTestClient, renderWithProviders } from '../../__tests__/support/harness';

const MASTER = 'Master!2026';

/**
 * 只造"信封外壳"：两个嗅探函数都只看 magic / version / salt / nonce / payload / kdfParams，
 * 不做解密。这里要验的是**选错文件时的引导文案**，不是加解密本身
 * （那两条链路由 asset-transfer.test.ts 与 backup.test.ts 覆盖）。
 */
function envelope(magic: string): string {
  return JSON.stringify({
    magic,
    version: 1,
    salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
    nonce: 'AAAAAAAAAAAAAAAA',
    payload: 'AAAA',
    kdfParams: { memoryKiB: 1, iterations: 1, parallelism: 1 },
  });
}

function pick(target: HTMLElement, content: string, name: string): void {
  const file = new File([content], name, { type: 'application/json' });
  Object.defineProperty(target, 'files', { value: [file], configurable: true });
  fireEvent.change(target);
}

async function renderPanel(): Promise<void> {
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
}

describe('设置面板 · 选错文件类型', () => {
  it('把资产包塞进「导入完整备份」时，指路到资产批量迁移', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '导入完整备份' }));
    pick(screen.getByLabelText('备份文件'), envelope('KIA1'), 'assets.kia');

    await waitFor(() => {
      expect(screen.getByText('这是资产迁移包（.kia），请用「资产批量迁移」')).toBeDefined();
    });
  });

  it('把完整备份塞进「资产批量迁移」时，指路到导入完整备份', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '资产批量迁移' }));
    pick(screen.getByLabelText('导入资产包'), envelope('KIB1'), 'backup.kib');

    await waitFor(() => {
      expect(screen.getByText('这是完整库备份（.kib），请用「导入完整备份」')).toBeDefined();
    });
  });
});
