/**
 * 隐藏卡片授权「到期后必须退出隐藏视图」回归（QA 第三轮 P2-2）。
 *
 * 只关闭弹窗是不够的：父组件还要把隐藏列表清空并退出隐藏分类，
 * 否则隐藏卡片的标题与账号名会继续留在主面板上。
 *
 * 这里用注入时钟驱动到期，真实调用 `client.requestHiddenAccess`。
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ARGON2_TEST_PARAMS } from '../../../core/crypto/kdf';
import { createVaultClient, HIDDEN_ACCESS_WINDOW_MS, type VaultClient } from '../../../services/vault-client';
import { MemoryVaultStorage } from '../../../services/storage';
import { FakeClipboardPort } from '../../../services/__tests__/support/fakes';
import { ToastProvider } from '../../../components/ui/Toast';
import { VaultProvider } from '../../../app/VaultProvider';
import { HiddenAccessDialog } from '../HiddenAccessDialog';

const START = 1_700_000_000_000;
const MASTER = 'Whiskey-Xray-2211';

interface Harness {
  client: VaultClient;
  advance: (ms: number) => void;
}

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
  await client.createItem({
    title: '内网跳板机',
    username: 'ops-whiskey',
    password: 'Yankee-Zulu-5566',
    visibility: 'hidden',
  });
  return {
    client,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('HiddenAccessDialog · 授权到期', () => {
  it('到期时调用 onExpired（父组件据此清空隐藏列表），而不是只关弹窗', async () => {
    const { client } = await createHarness();
    const onClose = vi.fn();
    const onExpired = vi.fn();
    const onGranted = vi.fn();

    // 弹窗自己的倒计时时钟：只影响"授权剩余"的展示与到期检测。
    let nowValue = START;
    const now = (): number => nowValue;

    render(
      <ToastProvider>
        <VaultProvider client={client}>
          <HiddenAccessDialog
            open
            onClose={onClose}
            onGranted={onGranted}
            onExpired={onExpired}
            now={now}
          />
        </VaultProvider>
      </ToastProvider>,
    );

    fireEvent.change(screen.getByLabelText(/主密码/), { target: { value: MASTER } });
    fireEvent.click(screen.getByRole('button', { name: '验证并查看' }));

    await waitFor(() => {
      expect(onGranted).toHaveBeenCalledTimes(1);
    });
    expect(onExpired).not.toHaveBeenCalled();

    // 推进到窗口结束之后。
    nowValue = START + HIDDEN_ACCESS_WINDOW_MS + 1;

    await waitFor(
      () => {
        expect(onExpired).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 },
    );
    // 有 onExpired 时不再重复调用 onClose，避免父组件被关两次。
    expect(onClose).not.toHaveBeenCalled();
  });
});
