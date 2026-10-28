/**
 * 解锁页回归测试。
 *
 * 覆盖：错误密码提示、连续失败后出现"显示提示"、冷却态禁用提交并倒计时、
 * 以及"忘记密码"进入恢复流程。
 */

import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { UnlockScreen } from '../UnlockScreen';
import {
  MASTER_PASSWORD,
  OTHER_PASSWORD,
  createTestClient,
  renderWithProviders,
} from '../../__tests__/support/harness';
import type { SessionSnapshot } from '../../../core/vault/types';
import type { VaultClient } from '../../../services/vault-client';

/** 用一个受控包装层承接 onSessionChange，模拟真实父组件。 */
function UnlockHarness({ initial }: { initial: SessionSnapshot }): JSX.Element {
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(initial);
  return <UnlockScreen snapshot={snapshot} onSessionChange={setSnapshot} />;
}

/** 建库后立刻锁定，返回锁定态快照。 */
async function createLockedSnapshot(hint: string | null = null): Promise<{
  client: VaultClient;
  snapshot: SessionSnapshot;
}> {
  const { client } = createTestClient();
  await client.initialize({ masterPassword: MASTER_PASSWORD, hint });
  const snapshot = await client.lock('manual');
  return { client, snapshot };
}

/** 输入主密码并提交。 */
function submitPassword(value: string): void {
  fireEvent.change(screen.getByLabelText(/^主密码/), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: '解锁' }));
}

describe('UnlockScreen 解锁', () => {
  it('错误密码显示 AUTH_INVALID 对应文案', async () => {
    const { client, snapshot } = await createLockedSnapshot();
    renderWithProviders(client, <UnlockHarness initial={snapshot} />);

    submitPassword(OTHER_PASSWORD);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('主密码不正确');
  });

  it('连续失败 2 次后才出现"显示提示"按钮，点击后展示提示语', async () => {
    const { client, snapshot } = await createLockedSnapshot('常用的那句歌词');
    renderWithProviders(client, <UnlockHarness initial={snapshot} />);

    expect(screen.queryByRole('button', { name: '显示提示' })).toBeNull();

    submitPassword(OTHER_PASSWORD);
    await screen.findByRole('alert');

    submitPassword(OTHER_PASSWORD);
    const hintButton = await screen.findByRole('button', { name: '显示提示' });

    fireEvent.click(hintButton);
    await waitFor(() => {
      expect(screen.getByText('提示：常用的那句歌词')).toBeInTheDocument();
    });
  });

  it('冷却态禁用提交并显示倒计时', async () => {
    const { client, snapshot } = await createLockedSnapshot();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await client.unlock(OTHER_PASSWORD).catch(() => undefined);
    }
    const cooling = await client.status();
    expect(cooling.status).toBe('cooling_down');

    renderWithProviders(client, <UnlockHarness initial={cooling} />);

    expect(screen.getByRole('button', { name: '解锁' })).toBeDisabled();
    expect(screen.getByLabelText(/^主密码/)).toBeDisabled();
    // Toast 容器也是 role="status"，因此用文案定位冷却提示。
    const notice = screen.getByText(/尝试过于频繁/);
    expect(notice.textContent).toMatch(/\d+ 秒/);
    expect(snapshot.status).toBe('locked');
  });

  it('点击"忘记密码"进入恢复流程', async () => {
    const { client, snapshot } = await createLockedSnapshot();
    renderWithProviders(client, <UnlockHarness initial={snapshot} />);

    fireEvent.click(screen.getByRole('button', { name: '忘记密码？' }));

    expect(await screen.findByText('用恢复凭据验证身份')).toBeInTheDocument();
    expect(screen.getByText(/主密码与恢复密钥同时丢失/)).toBeInTheDocument();
  });
});
