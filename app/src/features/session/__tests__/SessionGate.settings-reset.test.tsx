/**
 * 会话门 · 设置面板不该跨过"锁定"这道门。
 *
 * 背景：`settingsOpen` 只能挂在门上（主面板与岛右键菜单共用同一个开关），
 * 而锁定会把 `MainPanel` 整棵卸载——门自己的 state 却不会跟着清。
 * 于是"开着设置 → 锁定 → 解锁"之后，设置弹窗会自己弹回来：用户刚解锁，
 * 眼前却是上次那个设置面板。对密码库来说这是"锁了个寂寞"的观感。
 *
 * 两条断言互为边界：
 * 1. 锁定要收起设置（否则就是上面那个 bug）；
 * 2. 全形态 ↔ 岛形态互切**不能**收起设置——那是 PRD CHG-02「恢复原状态」，
 *    形态切换不是安全事件，两种形态都是 unlocked。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { SessionGate } from '../SessionGate';
import { useUiStore } from '../../../stores/ui-store';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

/** 覆写 jsdom 的可见性（默认恒为 visible，不改就永远触发不到监听）。 */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
}

/** 模拟"页面转入后台"——系统锁屏 / 休眠的近似信号，默认开即会锁定。 */
function hidePage(): void {
  setVisibility('hidden');
  fireEvent(document, new Event('visibilitychange'));
}

/** 建库 + 一张卡 + 渲染会话门，等到主面板出现。 */
async function setup() {
  const { client } = createTestClient('boot');
  await client.initialize({ masterPassword: MASTER_PASSWORD });
  await client.createItem({ title: 'GitHub', username: 'dev@example.test', password: 'Value-1' });

  useUiStore.setState({
    appMode: 'full',
    island: { phase: 'collapsed', query: '', activeIndex: 0, focused: false },
    session: { status: 'uninitialized', cooldownUntil: null },
  });

  renderWithProviders(client, <SessionGate />);
  await waitFor(() => {
    expect(document.getElementById('main-search')).not.toBeNull();
  });
  return client;
}

/** 从侧栏打开设置面板。 */
async function openSettings(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  await waitFor(() => {
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
}

beforeEach(() => {
  useUiStore.setState({
    appMode: 'full',
    island: { phase: 'collapsed', query: '', activeIndex: 0, focused: false },
    session: { status: 'uninitialized', cooldownUntil: null },
  });
});

afterEach(() => {
  setVisibility('visible');
});

describe('锁定会收起设置面板', () => {
  it('开着设置锁定，解锁后设置不再自己弹回来', async () => {
    await setup();
    await openSettings();

    hidePage();
    await waitFor(() => {
      expect(document.getElementById('unlock-password')).not.toBeNull();
    });
    // 锁定瞬间就该收起：锁定态下屏幕里只该有解锁页。
    expect(screen.queryByRole('dialog')).toBeNull();

    const password = document.getElementById('unlock-password') as HTMLInputElement;
    fireEvent.change(password, { target: { value: MASTER_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: '解锁' }));

    await waitFor(() => {
      expect(document.getElementById('main-search')).not.toBeNull();
    });
    // 关键断言：解锁后是干净的主面板，不是上次那个设置弹窗。
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('全形态 ↔ 岛形态互切时设置面板保持（CHG-02 恢复原状态）', async () => {
    await setup();
    await openSettings();

    await act(async () => {
      useUiStore.setState({ appMode: 'island' });
    });
    await act(async () => {
      useUiStore.setState({ appMode: 'full' });
    });

    // 形态切换不是安全事件，面板该原样还在。
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
