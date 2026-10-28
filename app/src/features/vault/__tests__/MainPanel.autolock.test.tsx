/**
 * 主面板「自动锁定兜底」回归（QA 第三轮 P2-1）。
 *
 * 场景：用户离开 30 分钟再回来，DEK 已被清掉，但卡片标题与账号名还挂在屏幕上。
 * 期望：`MainPanel` 的倒计时归零后主动向 client 确认状态，并通过 `onSessionChange`
 * 把画面交回 `SessionGate`（由它切到解锁屏）。
 *
 * 这里用"`unlockedUntil` 已经过期"的 snapshot 渲染，配合已被推进的注入时钟，
 * 让 `client.status()` 真实返回 `locked`——不 mock 会话层。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { ARGON2_TEST_PARAMS } from '../../../core/crypto/kdf';
import { createVaultClient, type VaultClient } from '../../../services/vault-client';
import { MemoryVaultStorage } from '../../../services/storage';
import { FakeClipboardPort } from '../../../services/__tests__/support/fakes';
import { ToastProvider } from '../../../components/ui/Toast';
import { VaultProvider } from '../../../app/VaultProvider';
import { useUiStore } from '../../../stores/ui-store';
import { MainPanel, type MainPanelProps } from '../MainPanel';

const START = 1_700_000_000_000;
const MASTER = 'Sierra-Tango-6677';
const AUTO_LOCK_MS = 30 * 60 * 1000;

interface Harness {
  client: VaultClient;
  advance: (ms: number) => void;
}

/** 解锁态 + 一张卡片，用于验证"锁定后画面必须切走"。 */
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
    title: '团队邮箱',
    username: 'team-sierra',
    password: 'Uniform-Victor-8899',
  });
  return {
    client,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function renderPanel(client: VaultClient, props: MainPanelProps): void {
  render(
    <ToastProvider>
      <VaultProvider client={client}>
        <MainPanel {...props} />
      </VaultProvider>
    </ToastProvider>,
  );
}

describe('MainPanel · 自动锁定兜底', () => {
  beforeEach(() => {
    useUiStore.setState((state) => ({
      ...state,
      filters: { category: 'all', sort: 'recent_updated' },
    }));
  });

  it('会话剩余归零后主动刷新状态并上报 locked', async () => {
    const { client, advance } = await createHarness();
    const snapshot = await client.status();
    expect(snapshot.status).toBe('unlocked');

    // 时间越过自动锁定阈值：此时 client 内部已经锁了，但 UI 手上的 snapshot 还是旧的。
    advance(AUTO_LOCK_MS + 1);

    const onSessionChange = vi.fn();
    renderPanel(client, { snapshot, onSessionChange, settingsOpen: false, onSettingsOpenChange: () => {} });

    await waitFor(() => {
      expect(onSessionChange).toHaveBeenCalled();
    });
    const latest = onSessionChange.mock.calls.at(-1)?.[0] as { status: string };
    expect(latest.status).toBe('locked');
  });

  it('未设置自动锁定（unlockedUntil 为 null）时不会误触发刷新', async () => {
    const { client } = await createHarness();
    const base = await client.status();
    const snapshot = { ...base, unlockedUntil: null };

    const onSessionChange = vi.fn();
    renderPanel(client, { snapshot, onSessionChange, settingsOpen: false, onSettingsOpenChange: () => {} });

    // 给 effect 与 500ms tick 留出时间。
    // 用 act 包住这段等待：MainPanel 挂载后还有异步 setState 落地，
    // 裸 await 会让它落在 act 之外，React 抛 "not wrapped in act" 警告。
    await act(async () => {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 60);
      });
    });
    expect(onSessionChange).not.toHaveBeenCalled();
  });
});
