/**
 * 任务 2：剪贴板清理失败必须可观测，重试有界，不误清用户内容。
 *
 * 这里全部用注入的调度器与内存端口，不碰真实剪贴板，也不依赖真实时间。
 * Windows 桌面 WebView 失焦 / 缩成岛 / 锁定时的真实行为需要在桌面端人工验证，
 * 见 docs/agent-improvement-plan.md 的交付记录。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserClipboardPort,
  CLIPBOARD_CLEAR_RETRY_DELAYS_MS,
  ClipboardService,
  type ClipboardPort,
} from '../clipboard';

class FakePort implements ClipboardPort {
  content: string | null = null;

  failRead = false;

  /** 剩余多少次 `clear()` 会失败；Infinity 表示一直失败。 */
  clearFailuresLeft = 0;

  clearCalls = 0;

  async write(text: string): Promise<void> {
    this.content = text;
  }

  async read(): Promise<string | null> {
    if (this.failRead) {
      throw new Error('read denied');
    }
    return this.content;
  }

  async clear(): Promise<void> {
    this.clearCalls += 1;
    if (this.clearFailuresLeft > 0) {
      this.clearFailuresLeft -= 1;
      throw new Error('clear denied');
    }
    this.content = null;
  }
}

/** 可手动推进的调度器：记录每个定时器的延时与是否被取消。 */
function createScheduler() {
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean; fired: boolean }> = [];
  return {
    timers,
    schedule: (callback: () => void, delay: number): unknown => {
      timers.push({ callback, delay, cancelled: false, fired: false });
      return timers.length - 1;
    },
    cancel: (handle: unknown): void => {
      const timer = timers[handle as number];
      if (timer) timer.cancelled = true;
    },
    /** 触发最新一个尚未触发、未取消的定时器。 */
    fireNext: (): boolean => {
      const timer = [...timers].reverse().find((candidate) => !candidate.cancelled && !candidate.fired);
      if (!timer) return false;
      timer.fired = true;
      timer.callback();
      return true;
    },
    live: (): number => timers.filter((timer) => !timer.cancelled && !timer.fired).length,
  };
}

function setup() {
  const port = new FakePort();
  const scheduler = createScheduler();
  const events: string[] = [];
  const service = new ClipboardService({
    port,
    now: () => 0,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    defaultTtlMs: 5_000,
    onCleared: () => events.push('cleared'),
    onOverwritten: () => events.push('overwritten'),
    onClearFailed: () => events.push('clear-failed'),
  });
  return { port, scheduler, service, events };
}

async function expire(scheduler: ReturnType<typeof createScheduler>, service: ClipboardService): Promise<void> {
  scheduler.fireNext();
  await service.awaitPending();
}

describe('剪贴板 · 清理失败可观测', () => {
  it('端口清理一直失败：不产生"已清理"，重试有上限，最终记 clear-failed 并通知', async () => {
    const { port, scheduler, service, events } = setup();
    await service.copyWithTtl('Synthetic-Secret-1');
    port.clearFailuresLeft = Infinity;

    await expire(scheduler, service); // 到期
    for (let index = 0; index < CLIPBOARD_CLEAR_RETRY_DELAYS_MS.length; index += 1) {
      expect(service.pendingCount()).toBe(1);
      expect(scheduler.timers.at(-1)?.delay).toBe(CLIPBOARD_CLEAR_RETRY_DELAYS_MS[index]);
      await expire(scheduler, service); // 重试
    }

    expect(port.clearCalls).toBe(1 + CLIPBOARD_CLEAR_RETRY_DELAYS_MS.length);
    expect(events).toEqual(['clear-failed']);
    expect(service.getOutcomes().map((outcome) => outcome.outcome)).toEqual(['clear-failed']);
    // 重试用尽后不再有活着的定时器，也没有挂起任务。
    expect(scheduler.live()).toBe(0);
    expect(service.pendingCount()).toBe(0);
    expect(port.content).toBe('Synthetic-Secret-1');
  });

  it('重试中途成功：记 cleared 并只通知一次', async () => {
    const { port, scheduler, service, events } = setup();
    await service.copyWithTtl('Synthetic-Secret-2');
    port.clearFailuresLeft = 1;

    await expire(scheduler, service);
    expect(events).toEqual([]);
    await expire(scheduler, service);

    expect(port.content).toBeNull();
    expect(events).toEqual(['cleared']);
    expect(service.getOutcomes()[0]?.outcome).toBe('cleared');
    expect(scheduler.live()).toBe(0);
  });

  it('读权限失败 + 写（清空）权限失败：不报成 cleared-unverified', async () => {
    const { port, scheduler, service, events } = setup();
    await service.copyWithTtl('Synthetic-Secret-3');
    port.failRead = true;
    port.clearFailuresLeft = Infinity;

    await expire(scheduler, service);
    while (scheduler.fireNext()) {
      await service.awaitPending();
    }
    expect(events).toEqual(['clear-failed']);
    expect(service.getOutcomes().map((outcome) => outcome.outcome)).not.toContain('cleared-unverified');
  });

  it('读权限失败但清空成功：记 cleared-unverified', async () => {
    const { port, scheduler, service, events } = setup();
    await service.copyWithTtl('Synthetic-Secret-4');
    port.failRead = true;
    await expire(scheduler, service);
    expect(service.getOutcomes()[0]?.outcome).toBe('cleared-unverified');
    expect(events).toEqual(['cleared']);
  });

  it('重试期间用户覆盖了剪贴板：重试核对归属后不清新内容', async () => {
    const { port, scheduler, service, events } = setup();
    await service.copyWithTtl('Synthetic-Secret-5');
    port.clearFailuresLeft = 1;
    await expire(scheduler, service);

    port.content = 'user-new-text';
    await expire(scheduler, service);

    expect(port.content).toBe('user-new-text');
    expect(events).toEqual(['overwritten']);
    expect(port.clearCalls).toBe(1);
  });

  it('重试期间又复制了一次：旧任务被取代，重试定时器取消，不会清掉新内容', async () => {
    const { port, scheduler, service } = setup();
    port.failRead = true; // 读不到时会强制清空——最容易误清新内容的情形
    await service.copyWithTtl('Synthetic-Secret-6');
    port.clearFailuresLeft = 1;
    await expire(scheduler, service); // 第一次失败，排了重试
    const retryTimer = scheduler.timers.at(-1)!;

    await service.copyWithTtl('Synthetic-Secret-7');
    expect(retryTimer.cancelled).toBe(true);
    expect(service.pendingCount()).toBe(1);
    expect(port.content).toBe('Synthetic-Secret-7');
    expect(service.getOutcomes()[0]?.outcome).toBe('superseded');
  });

  it('快速连续复制 3 次：只有最后一个任务存活', async () => {
    const { scheduler, service } = setup();
    await service.copyWithTtl('a-synthetic');
    await service.copyWithTtl('b-synthetic');
    await service.copyWithTtl('c-synthetic');
    expect(service.pendingCount()).toBe(1);
    expect(scheduler.live()).toBe(1);
  });

  it('锁定时清理失败：返回 clearFailed、记 clear-failed 并通知，不重试', async () => {
    const { port, scheduler, service, events } = setup();
    await service.copyWithTtl('Synthetic-Secret-8');
    port.clearFailuresLeft = Infinity;

    const result = await service.cancelAll({ clearIfOwned: true });

    expect(result).toEqual({ clearFailed: 1 });
    expect(events).toEqual(['clear-failed']);
    expect(service.getOutcomes()[0]?.outcome).toBe('clear-failed');
    expect(scheduler.live()).toBe(0);
  });

  it('锁定发生在重试排队期间：重试定时器被取消，按归属立即清理', async () => {
    const { port, scheduler, service, events } = setup();
    await service.copyWithTtl('Synthetic-Secret-9');
    port.clearFailuresLeft = 1;
    await expire(scheduler, service);
    expect(scheduler.live()).toBe(1);

    const result = await service.cancelAll({ clearIfOwned: true });
    expect(result).toEqual({ clearFailed: 0 });
    expect(port.content).toBeNull();
    expect(scheduler.live()).toBe(0);
    expect(events).toEqual([]);
  });

  it('回调抛错不会变成未处理的 rejection', async () => {
    const port = new FakePort();
    const scheduler = createScheduler();
    const service = new ClipboardService({
      port,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      onCleared: () => {
        throw new Error('ui exploded');
      },
    });
    await service.copyWithTtl('Synthetic-Secret-10', 1_000);
    scheduler.fireNext();
    await expect(service.awaitPending()).resolves.toBeUndefined();
    expect(service.getOutcomes()[0]?.outcome).toBe('cleared');
  });
});

describe('BrowserClipboardPort', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  afterEach(() => {
    if (original) {
      Object.defineProperty(navigator, 'clipboard', original);
    } else {
      delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  });

  it('clear() 失败时抛 CLIPBOARD_WRITE_FAILED，而不是静默吞掉', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')), readText: vi.fn() },
    });
    await expect(new BrowserClipboardPort().clear()).rejects.toMatchObject({ code: 'CLIPBOARD_WRITE_FAILED' });
  });
});

describe('VaultClient · 剪贴板清理失败通知', () => {
  it('复制后锁定、清空失败：订阅方收到 clear-failed（不含明文）；退订后不再收到', async () => {
    const { createVaultClient } = await import('../vault-client');
    const { MemoryVaultStorage } = await import('../storage');
    const { ARGON2_TEST_PARAMS } = await import('../../core/crypto');
    const port = new FakePort();
    const client = createVaultClient({
      storage: new MemoryVaultStorage(),
      clipboard: port,
      clipboardTtlMs: 30_000,
      passwordParams: ARGON2_TEST_PARAMS,
      recoveryParams: ARGON2_TEST_PARAMS,
    });
    await client.initialize({ masterPassword: 'Notice-Master-1' });
    const item = await client.createItem({ title: 'n', username: 'n@example.test', password: 'Notice-Pass-1!' });

    const notices: unknown[] = [];
    const unsubscribe = client.onClipboardNotice((notice) => notices.push(notice));
    await client.copyPassword(item.id);
    port.clearFailuresLeft = Infinity;
    await client.lock('manual');

    expect(notices).toEqual([{ kind: 'clear-failed', field: 'password' }]);
    expect(JSON.stringify(notices)).not.toContain('Notice-Pass-1!');

    unsubscribe();
    await client.unlock('Notice-Master-1');
    await client.copyPassword(item.id);
    await client.lock('manual');
    expect(notices).toHaveLength(1);
    await client.dispose();
  });
});
