import { describe, expect, it } from 'vitest';
import { MAX_RECENT_ITEMS, RecencyTracker, parseRecentEntries } from '../recency';

/** 构造带可变时钟的跟踪器。 */
function setup(initial: Array<{ itemId: number; lastUsedAt: number }> = []) {
  let current = 1000;
  const tracker = new RecencyTracker({ now: () => current, initial });
  const advance = (ms: number) => {
    current += ms;
  };
  return { tracker, advance };
}

describe('最近使用', () => {
  it('按最近复制时间倒序', () => {
    const { tracker, advance } = setup();

    tracker.recordUse(1, 'normal');
    advance(10);
    tracker.recordUse(2, 'normal');
    advance(10);
    tracker.recordUse(3, 'username_only');

    expect(tracker.list().map((entry) => entry.itemId)).toEqual([3, 2, 1]);
  });

  it('最多保留 6 条', () => {
    const { tracker, advance } = setup();

    for (let id = 1; id <= 9; id += 1) {
      tracker.recordUse(id, 'normal');
      advance(1);
    }

    const list = tracker.list();
    expect(list).toHaveLength(MAX_RECENT_ITEMS);
    expect(list.map((entry) => entry.itemId)).toEqual([9, 8, 7, 6, 5, 4]);
  });

  it('重复使用同一资产会提升到最前且不产生重复项', () => {
    const { tracker, advance } = setup();

    tracker.recordUse(1, 'normal');
    advance(10);
    tracker.recordUse(2, 'normal');
    advance(10);
    tracker.recordUse(1, 'normal');

    const list = tracker.list();
    expect(list.map((entry) => entry.itemId)).toEqual([1, 2]);
    expect(list[0].lastUsedAt).toBe(1020);
  });

  it('hidden 资产不会进入最近使用', () => {
    const { tracker } = setup();

    tracker.recordUse(1, 'hidden');
    tracker.recordUse(2, 'username_only');

    expect(tracker.list().map((entry) => entry.itemId)).toEqual([2]);
  });

  it('删除资产时清理记录', () => {
    const { tracker, advance } = setup();

    tracker.recordUse(1, 'normal');
    advance(5);
    tracker.recordUse(2, 'normal');
    tracker.remove(1);

    expect(tracker.list().map((entry) => entry.itemId)).toEqual([2]);
  });

  it('prune 移除已不可见的条目', () => {
    const { tracker, advance } = setup();

    tracker.recordUse(1, 'normal');
    advance(1);
    tracker.recordUse(2, 'normal');
    advance(1);
    tracker.recordUse(3, 'normal');

    tracker.prune(new Set([1, 3]));
    expect(tracker.list().map((entry) => entry.itemId)).toEqual([3, 1]);
  });

  it('index 返回 itemId → 最近使用时间', () => {
    const { tracker, advance } = setup();

    tracker.recordUse(1, 'normal');
    advance(50);
    tracker.recordUse(2, 'normal');

    const index = tracker.index();
    expect(index.get(1)).toBe(1000);
    expect(index.get(2)).toBe(1050);
  });

  it('从持久化数据恢复：去重、排序、截断', () => {
    const tracker = RecencyTracker.fromJSON(
      [
        { itemId: 1, lastUsedAt: 100 },
        { itemId: 2, lastUsedAt: 300 },
        { itemId: 1, lastUsedAt: 200 },
        { itemId: 'bad', lastUsedAt: 100 },
        { itemId: 3, lastUsedAt: 200 },
        { itemId: 4, lastUsedAt: 900 },
        { itemId: 5, lastUsedAt: 800 },
        { itemId: 6, lastUsedAt: 700 },
        { itemId: 7, lastUsedAt: 600 },
        { itemId: 8, lastUsedAt: 500 },
      ],
      () => 0,
    );

    const list = tracker.list();
    expect(list).toHaveLength(MAX_RECENT_ITEMS);
    expect(list.map((entry) => entry.itemId)).toEqual([4, 5, 6, 7, 8, 2]);
  });

  it('parseRecentEntries 容忍脏数据', () => {
    expect(parseRecentEntries(null)).toEqual([]);
    expect(parseRecentEntries([{ itemId: 0, lastUsedAt: 1 }, { itemId: 1 }])).toEqual([]);
    expect(parseRecentEntries([{ itemId: 1, lastUsedAt: 2 }])).toEqual([{ itemId: 1, lastUsedAt: 2 }]);
  });
});
