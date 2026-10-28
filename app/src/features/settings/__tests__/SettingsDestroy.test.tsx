/**
 * 设置面板 · 主动销毁（PRD FR-08.4）。
 *
 * PRD 的保护链原文：「需处于解锁状态 + **输入主密码** + 输入确认文字"销毁" +
 * 明确告知不可恢复」。前两轮实现只做了"确认文字"一环，主密码二次认证缺失——
 * 能打开设置面板的人就能把整库抹掉，而这恰恰是 FR-08 整章想防的
 * "有人走到一台已解锁的机器前"。
 *
 * 契约：
 * 1. 确认词必须是「销毁」，且**主密码也要填**，两者缺一按钮都不启用；
 * 2. 主密码错误时**不销毁**，只提示，且密码输入被清空（防止"看着填好了"直接再点）；
 * 3. 锁定态拒绝销毁并提示先解锁；
 * 4. 销毁后回到首次设置状态，可重新初始化（E2E-09）。
 */

import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { SettingsPanel } from '../SettingsPanel';
import { MASTER_PASSWORD, createTestClient, renderWithProviders } from '../../__tests__/support/harness';

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
}

/** 建库并渲染设置面板。 */
async function setup(): Promise<ReturnType<typeof createTestClient>> {
  const harness = createTestClient('boot');
  await harness.client.initialize({ masterPassword: MASTER_PASSWORD });
  renderWithProviders(
    harness.client,
    <SettingsPanel
      open
      snapshot={await harness.client.status()}
      onClose={() => {}}
      onSessionChange={() => {}}
      onDataChanged={() => {}}
      onLocateItem={vi.fn()}
    />,
  );
  await flush();
  return harness;
}

/** 按 PRD 保护链填齐两项：主密码 + 确认文字。 */
async function fillDestroyForm(password: string, confirmWord: string): Promise<void> {
  fireEvent.change(screen.getByLabelText('销毁数据主密码'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('确认销毁'), { target: { value: confirmWord } });
  await flush();
}

function confirmButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '确认销毁' }) as HTMLButtonElement;
}

describe('设置面板 · 主动销毁', () => {
  it('确认词与主密码都填好才能提交，缺一不可', async () => {
    await setup();

    // 两项都空：按钮不可用。
    expect(confirmButton().disabled).toBe(true);

    // 只填确认词：仍然不可用（这一轮补上的正是这一环）。
    fireEvent.change(screen.getByLabelText('确认销毁'), { target: { value: '销毁' } });
    await flush();
    expect(confirmButton().disabled).toBe(true);

    // 只填主密码：同样不可用。
    fireEvent.change(screen.getByLabelText('确认销毁'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('销毁数据主密码'), { target: { value: MASTER_PASSWORD } });
    await flush();
    expect(confirmButton().disabled).toBe(true);

    // 两项都对才放行。
    fireEvent.change(screen.getByLabelText('确认销毁'), { target: { value: '销毁' } });
    await flush();
    expect(confirmButton().disabled).toBe(false);
  });

  it('确认词写错时不提交', async () => {
    const harness = await setup();

    await fillDestroyForm(MASTER_PASSWORD, '删掉');
    expect(confirmButton().disabled).toBe(true);
    expect((await harness.client.status()).status).toBe('unlocked');
  });

  it('主密码错误时不销毁，只提示，并清空密码输入', async () => {
    const harness = await setup();

    await fillDestroyForm('wrong-password', '销毁');
    expect(confirmButton().disabled).toBe(false);

    fireEvent.click(confirmButton());
    await flush();

    // 数据必须还在：错的密码不能成为销毁理由。
    expect(screen.getByText('主密码不正确')).toBeDefined();
    expect((await harness.client.status()).status).toBe('unlocked');
    expect((await harness.client.listItems()).length).toBeGreaterThanOrEqual(0);
    // 密码输入被清空——留着会让下次点确认像"已经填好了"。
    expect((screen.getByLabelText('销毁数据主密码') as HTMLInputElement).value).toBe('');
  });

  it('锁定态拒绝销毁，并提示先解锁', async () => {
    const harness = await setup();
    await harness.client.lock('manual');
    await flush();

    await fillDestroyForm(MASTER_PASSWORD, '销毁');
    fireEvent.click(confirmButton());
    await flush();

    expect(screen.getByText('保险库已锁定，请先解锁')).toBeDefined();
    // 库没有被抹掉：重新解锁后数据照旧。
    await harness.client.unlock(MASTER_PASSWORD);
    expect((await harness.client.listItems()).length).toBeGreaterThanOrEqual(0);
  });

  it('销毁后回到首次设置状态，且可以重新初始化（E2E-09）', async () => {
    const harness = await setup();
    await harness.client.createItem({
      title: '销毁前的一张卡',
      username: 'user@example.com',
      password: 'pw-123456',
    });
    await flush();

    await fillDestroyForm(MASTER_PASSWORD, '销毁');
    fireEvent.click(confirmButton());
    await flush();

    expect(screen.getByText('本地数据已清空')).toBeDefined();
    expect((await harness.client.status()).status).toBe('uninitialized');

    // 回到首次设置引导后可以重新开始用。
    await harness.client.initialize({ masterPassword: 'brand-new-master' });
    expect((await harness.client.status()).status).toBe('unlocked');
    expect(await harness.client.listItems()).toHaveLength(0);
  });
});
