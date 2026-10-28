import { describe, expect, it } from 'vitest';
import { ClipboardService, type ClipboardPort } from '../clipboard';

/** 内存剪贴板端口，模拟用户与系统剪贴板。 */
class FakePort implements ClipboardPort {
  content: string | null = null;

  writeCount = 0;

  clearCount = 0;

  failWrite = false;

  /** 置为 true 时 `read()` 抛错，模拟**读取权限被拒**（≠ 剪贴板为空）。 */
  failRead = false;

  /** 置为 true 时 `clear()` 抛错，模拟清理本身失败。 */
  failClear = false;

  async write(text: string): Promise<void> {
    if (this.failWrite) {
      throw new Error('write failed');
    }
    this.content = text;
    this.writeCount += 1;
  }

  async read(): Promise<string | null> {
    if (this.failRead) {
      throw new Error('read denied');
    }
    return this.content;
  }

  async clear(): Promise<void> {
    if (this.failClear) {
      throw new Error('clear failed');
    }
    this.content = null;
    this.clearCount += 1;
  }
}

/** 可手动触发的调度器，替代真实计时器。 */
function createScheduler() {
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  return {
    timers,
    schedule: (callback: () => void, delay: number): unknown => {
      timers.push({ callback, delay, cancelled: false });
      return timers.length - 1;
    },
    cancel: (handle: unknown): void => {
      const timer = timers[handle as number];
      if (timer) {
        timer.cancelled = true;
      }
    },
    fire: (index: number): void => {
      timers[index].callback();
    },
  };
}

interface Fixture {
  port: FakePort;
  service: ClipboardService;
  scheduler: ReturnType<typeof createScheduler>;
  outcomes: Array<{ token: string; outcome: string }>;
}

/** 构造带注入调度器的服务。 */
function setup(): Fixture {
  const port = new FakePort();
  const scheduler = createScheduler();
  const outcomes: Array<{ token: string; outcome: string }> = [];
  const service = new ClipboardService({
    port,
    now: () => 0,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    defaultTtlMs: 30_000,
    onCleared: (receipt) => outcomes.push({ token: receipt.token, outcome: 'cleared' }),
    onOverwritten: (receipt) => outcomes.push({ token: receipt.token, outcome: 'overwritten' }),
  });
  return { port, service, scheduler, outcomes };
}

describe('剪贴板服务', () => {
  it('写入内容并返回回执，默认 TTL 30 秒', async () => {
    const { port, service, scheduler } = setup();
    const receipt = await service.copyWithTtl('secret-value');

    expect(port.content).toBe('secret-value');
    expect(receipt.field).toBe('password');
    expect(receipt.ttlMs).toBe(30_000);
    expect(receipt.expiresAt).toBe(30_000);
    expect(service.pendingCount()).toBe(1);
    expect(scheduler.timers[0].delay).toBe(30_000);
  });

  it('到期且内容未被覆盖时清空剪贴板', async () => {
    const { port, service, scheduler, outcomes } = setup();
    await service.copyWithTtl('secret-value', 5_000);

    scheduler.fire(0);
    await service.awaitPending();

    expect(port.content).toBeNull();
    expect(port.clearCount).toBe(1);
    expect(outcomes).toEqual([{ token: expect.any(String), outcome: 'cleared' }]);
    expect(service.pendingCount()).toBe(0);
  });

  it('用户覆盖剪贴板后不清理新内容', async () => {
    const { port, service, scheduler, outcomes } = setup();
    await service.copyWithTtl('secret-value', 5_000);

    port.content = 'user-copied-text';
    scheduler.fire(0);
    await service.awaitPending();

    expect(port.content).toBe('user-copied-text');
    expect(port.clearCount).toBe(0);
    expect(outcomes).toEqual([{ token: expect.any(String), outcome: 'overwritten' }]);
    expect(service.getOutcomes()[0].outcome).toBe('overwritten');
  });

  it('读取被拒时强制清空（无法验证归属则安全优先）', async () => {
    const { port, service, scheduler } = setup();
    await service.copyWithTtl('secret-value', 5_000);
    port.failRead = true;

    scheduler.fire(0);
    await service.awaitPending();

    // 原实现把"读不到"当成"内容已不在"，于是静默跳过清理——密码留在剪贴板里，
    // 而界面刚刚承诺过"5 秒后自动清空"。留下明文不可恢复，误清内容可以重复制。
    expect(port.content).toBeNull();
    expect(port.clearCount).toBe(1);
    expect(service.getOutcomes()[0].outcome).toBe('cleared-unverified');
  });

  it('剪贴板被外部清空时不重复清理，且诊断与"读不到"区分开', async () => {
    const { port, service, scheduler } = setup();
    await service.copyWithTtl('secret-value', 5_000);
    // 读得到，但里面已经空了——这才是真正的"内容不在了"。
    port.content = null;

    scheduler.fire(0);
    await service.awaitPending();

    expect(port.clearCount).toBe(0);
    expect(service.getOutcomes()[0].outcome).toBe('missing');
  });

  it('清空本身失败不会让到期任务抛出未处理的 rejection', async () => {
    const { port, service, scheduler } = setup();
    await service.copyWithTtl('secret-value', 5_000);
    port.failClear = true;

    scheduler.fire(0);
    // 清理发生在定时器回调里，抛出去没人接。这里断言它被吞掉而不是炸穿。
    await expect(service.awaitPending()).resolves.toBeUndefined();
  });

  it('cancelAll 取消任务且不覆盖剪贴板', async () => {
    const { port, service, scheduler } = setup();
    await service.copyWithTtl('secret-value', 5_000);

    await service.cancelAll();
    expect(service.pendingCount()).toBe(0);
    expect(scheduler.timers[0].cancelled).toBe(true);

    // 即使计时器已触发，也不会重复清理
    scheduler.fire(0);
    await service.awaitPending();
    expect(port.content).toBe('secret-value');
    expect(service.getOutcomes()[0].outcome).toBe('cancelled');
  });

  it('cancelAll({ clearIfOwned: true }) 在锁定时立即清空自己的内容', async () => {
    const { port, service } = setup();
    await service.copyWithTtl('secret-value', 5_000);

    await service.cancelAll({ clearIfOwned: true });
    expect(port.content).toBeNull();
    expect(port.clearCount).toBe(1);
  });

  it('锁定时若用户已覆盖则不清理', async () => {
    const { port, service } = setup();
    await service.copyWithTtl('secret-value', 5_000);
    port.content = 'user-new-content';

    await service.cancelAll({ clearIfOwned: true });
    expect(port.content).toBe('user-new-content');
  });

  it('锁定时读被拒也强制清空', async () => {
    const { port, service } = setup();
    await service.copyWithTtl('secret-value', 5_000);
    port.failRead = true;

    // 用户刚按下"上锁"，预期就是"外面不要再留着我的密码"。读不到不是留着的理由。
    await service.cancelAll({ clearIfOwned: true });
    expect(port.content).toBeNull();
    expect(port.clearCount).toBe(1);
  });

  it('多次复制各自独立结算', async () => {
    const { port, service, scheduler } = setup();
    const first = await service.copyWithTtl('first-value', 1_000);
    const second = await service.copyWithTtl('second-value', 2_000);

    expect(service.pendingCount()).toBe(2);
    expect(first.token).not.toBe(second.token);

    scheduler.fire(0);
    await service.awaitPending();
    // 第一个任务发现剪贴板已被第二次复制覆盖，跳过清理
    expect(port.content).toBe('second-value');

    scheduler.fire(1);
    await service.awaitPending();
    expect(port.content).toBeNull();
  });

  it('拒绝空值与非法 TTL', async () => {
    const { service } = setup();
    await expect(service.copyWithTtl('')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // `0` 已是合法的「关闭自动清理」档，其行为由 clipboard-ttl-off.test.ts 覆盖；
    // 这里只留真正非法的值：负数、Infinity、NaN。
    await expect(service.copyWithTtl('value', -1)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.copyWithTtl('value', Number.POSITIVE_INFINITY)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.copyWithTtl('value', Number.NaN)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('写入失败返回 CLIPBOARD_WRITE_FAILED', async () => {
    const { port, service } = setup();
    port.failWrite = true;

    await expect(service.copyWithTtl('secret-value')).rejects.toMatchObject({
      code: 'CLIPBOARD_WRITE_FAILED',
    });
    expect(service.pendingCount()).toBe(0);
  });

  it('不保存明文：服务内部只保留摘要', async () => {
    const { service } = setup();
    await service.copyWithTtl('super-secret-value', 5_000);

    const serialized = JSON.stringify({
      outcomes: service.getOutcomes(),
      pending: service.pendingCount(),
    });
    expect(serialized).not.toContain('super-secret-value');
  });
});
