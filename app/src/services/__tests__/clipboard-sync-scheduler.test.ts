/**
 * 剪贴板登记顺序回归测试（QA 验收 P2-6）。
 *
 * 缺陷：`copyWithTtl` 先调用 `schedule()` 再 `pending.set()`。
 * 若 `schedule` 是同步实现（立即回调），`handleExpiry` 在 `pending` 里查不到条目，
 * 于是直接返回，本次写入永远不会被清理 —— 密码就留在剪贴板里。
 *
 * 正确顺序：先登记，再定时。
 */

import { describe, expect, it } from 'vitest';
import { ClipboardService, type ClipboardPort } from '../clipboard';

/** 内存剪贴板替身，记录清理次数。 */
class FakePort implements ClipboardPort {
  value: string | null = null;

  clearCount = 0;

  async write(text: string): Promise<void> {
    this.value = text;
  }

  async read(): Promise<string | null> {
    return this.value;
  }

  async clear(): Promise<void> {
    this.clearCount += 1;
    this.value = '';
  }
}

describe('剪贴板登记顺序（P2-6）', () => {
  it('同步 scheduler 立即回调时，到期仍然清理一次', async () => {
    const port = new FakePort();
    const service = new ClipboardService({
      port,
      now: () => 0,
      // 同步实现：注册的同时立刻执行回调。
      schedule: (callback) => {
        callback();
        return 'handle';
      },
      cancel: () => undefined,
      defaultTtlMs: 1000,
    });

    await service.copyWithTtl('Value-Alpha-1', 1000, 'password');
    await service.awaitPending();

    expect(port.clearCount).toBe(1);
    expect(service.pendingCount()).toBe(0);
    const outcomes = service.getOutcomes();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].outcome).toBe('cleared');
  });

  it('调用 schedule 时条目已登记在 pending 中', async () => {
    const port = new FakePort();
    let pendingAtSchedule = -1;
    let service: ClipboardService;
    service = new ClipboardService({
      port,
      now: () => 0,
      schedule: () => {
        pendingAtSchedule = service.pendingCount();
        return 'handle';
      },
      cancel: () => undefined,
      defaultTtlMs: 1000,
    });

    await service.copyWithTtl('Value-Bravo-2', 1000, 'username');

    // 定时器注册的那一刻，条目必须已经可见，否则到期回调会空转。
    expect(pendingAtSchedule).toBe(1);
    expect(service.pendingCount()).toBe(1);
  });
});
