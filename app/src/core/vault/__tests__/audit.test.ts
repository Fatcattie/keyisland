/**
 * 操作日志核心（NFR 可靠性「操作日志本地化且不含敏感数据」）。
 *
 * 契约：
 * 1. 新的在前（设置页从上往下读才顺）；
 * 2. 环形缓冲：超过 200 条丢最旧的，内存不随使用时长增长；
 * 3. 跳转目标必须裁掉 query / hash——登录链接的 query 里常带 token，
 *    原样写进日志等于把凭据抄了一份；
 * 4. 清空后确实为空。
 */

import { describe, expect, it } from 'vitest';
import { AUDIT_CAPACITY, AuditLog, sanitizeJumpTarget } from '../audit';

const NOW = 1_700_000_000_000;

/** 建一个固定时钟的日志。 */
function makeLog(): AuditLog {
  return new AuditLog({ now: () => NOW });
}

describe('操作日志 · 记录与读取', () => {
  it('新的在前，默认字段补 null', () => {
    const log = makeLog();
    log.record('unlock');
    log.record('item.copy_password', { itemId: 7 });

    const entries = log.list();
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe('item.copy_password');
    expect(entries[0].itemId).toBe(7);
    expect(entries[0].at).toBe(NOW);
    expect(entries[1].action).toBe('unlock');
    expect(entries[1].itemId).toBeNull();
    expect(entries[1].detail).toBeNull();
  });

  it('limit 截断取最近的若干条', () => {
    const log = makeLog();
    for (const action of ['unlock', 'lock', 'jump'] as const) {
      log.record(action);
    }

    const entries = log.list(2);
    expect(entries.map((entry) => entry.action)).toEqual(['jump', 'lock']);
  });

  it('容量上限：超出后丢最旧的', () => {
    const log = makeLog();
    for (let index = 0; index < AUDIT_CAPACITY + 5; index += 1) {
      log.record('unlock');
    }

    expect(log.size()).toBe(AUDIT_CAPACITY);
    const entries = log.list(AUDIT_CAPACITY);
    // id 从 1 开始，丢掉最旧 5 条后最新的 id 是 205，最旧的可见 id 是 6。
    expect(entries[0].id).toBe(AUDIT_CAPACITY + 5);
    expect(entries[entries.length - 1].id).toBe(6);
  });

  it('清空后为空', () => {
    const log = makeLog();
    log.record('unlock');
    log.clear();

    expect(log.size()).toBe(0);
    expect(log.list()).toEqual([]);
  });
});

describe('跳转目标裁剪', () => {
  it('保留 origin + pathname，丢掉 query 与 hash', () => {
    expect(sanitizeJumpTarget('https://example.com/login?token=secret#frag')).toBe(
      'https://example.com/login',
    );
  });

  it('非 http(s) 的自定义 scheme 只留协议名', () => {
    // `steam://open/12345?x=1` 这类目标原样落盘没有必要，只记"跳了哪个应用"。
    expect(sanitizeJumpTarget('steam://open/12345?x=1')).toBe('steam:');
  });

  it('无法解析时给占位符，不把原始串写进去', () => {
    expect(sanitizeJumpTarget('not a url')).toBe('（无法解析的目标）');
  });
});
