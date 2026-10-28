/**
 * 会话门 · 系统锁屏 / 休眠立即锁定（PRD FR-01，默认开、可关）。
 *
 * Web 端没有系统锁屏事件，`SessionGate` 用 `visibilitychange → hidden` 近似。
 * 这里测的就是这条链路：
 * 1. 默认开：页面转入后台即上锁，解锁页说明原因（不然用户以为切个标签页就锁是 bug）；
 * 2. 关掉后：同样是转入后台，必须留在解锁态；
 * 3. 关掉再打开：事件重新生效（开关不是一次性的）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { SessionGate } from '../SessionGate';
import type { VaultClient } from '../../../services/vault-client';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** 覆写 jsdom 的可见性（默认恒为 visible，不改就永远触发不到监听）。 */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
}

/** 模拟"页面转入后台"。 */
function hidePage(): void {
  setVisibility('hidden');
  fireEvent(document, new Event('visibilitychange'));
}

/**
 * 让门面里的异步链路跑完（不改状态时没有可等的 DOM 变化）。
 *
 * 必须包在 `act` 里：主面板挂载时那次 `client.status()` 还悬着，裸 `setTimeout`
 * 会让它的 setState 落在 act 外面，产生 `not wrapped in act` 警告。
 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/** 直接改门面设置（不经过界面），同样要包 act。 */
async function toggle(client: VaultClient, enabled: boolean): Promise<void> {
  await act(async () => {
    await client.setLockOnSystemLock(enabled);
  });
}

/** 建库、渲染会话门，并等到主面板出现。 */
async function setup(): Promise<VaultClient> {
  const { client } = createTestClient('boot');
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  renderWithProviders(client, <SessionGate />);
  await waitFor(() => {
    expect(document.getElementById('main-search')).not.toBeNull();
  });
  return client;
}

afterEach(() => {
  setVisibility('visible');
});

describe('FR-01 · 页面转入后台即上锁', () => {
  it('默认开启：转入后台后回到解锁页，并说明锁定原因', async () => {
    await setup();

    hidePage();

    const reason = await screen.findByTestId('lock-reason');
    expect(reason).toHaveTextContent('系统锁屏');
    expect(document.getElementById('unlock-password')).not.toBeNull();
    expect(document.getElementById('main-search')).toBeNull();
  });

  it('关闭后：同样转入后台，仍留在解锁态', async () => {
    const client = await setup();
    await toggle(client, false);

    hidePage();
    await flush();

    expect((await client.status()).status).toBe('unlocked');
    expect(document.getElementById('main-search')).not.toBeNull();
    expect(screen.queryByTestId('lock-reason')).toBeNull();
  });

  it('关掉再打开：事件重新生效', async () => {
    const client = await setup();
    await toggle(client, false);
    hidePage();
    await flush();
    expect((await client.status()).status).toBe('unlocked');

    await toggle(client, true);
    hidePage();

    expect(await screen.findByTestId('lock-reason')).toHaveTextContent('系统锁屏');
  });
});
