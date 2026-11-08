/**
 * 任务 5 性能对照：资产写入的耗时与写入量（合成数据，不触碰任何真实库）。
 *
 * 运行：npm run perf:items
 *
 * 测的是 `ItemService` + 一个只计数的内存仓库：
 * - 耗时：加密 + 交给存储端口的总时间（中位数）；
 * - 写入量：交给存储端口的 JSON 字节数——桌面端这就是一次 IPC 的载荷，
 *   也是 Rust 侧要重新 AES 加密、写进 SQLite 的数据量；
 * - 加密次数：调用 `encryptItem` 的卡片数。
 *
 * 仓库同时实现旧端口（`saveItems` 整体写）与新端口（`applyItemChanges` 增量写），
 * 所以同一份脚本可以放到改动前的代码上跑，得到"前"的数字。
 */

import { describe, it, vi } from 'vitest';
import { randomBytes } from '../../src/core/crypto/random';
import * as codec from '../../src/core/vault/item-codec';
import { ItemService } from '../../src/core/vault/items';
import type { EncryptedItemRecord } from '../../src/core/vault/types';

class CountingStore {
  records = new Map<number, EncryptedItemRecord>();

  bytes = 0;

  async loadItems(): Promise<EncryptedItemRecord[]> {
    return [...this.records.values()];
  }

  async saveItems(records: EncryptedItemRecord[]): Promise<void> {
    this.bytes += JSON.stringify(records).length;
    this.records = new Map(records.map((record) => [record.id, record]));
  }

  async applyItemChanges(changes: { upserts: EncryptedItemRecord[]; deletes: number[] }): Promise<void> {
    this.bytes += JSON.stringify(changes).length;
    for (const id of changes.deletes) this.records.delete(id);
    for (const record of changes.upserts) this.records.set(record.id, record);
  }
}

function input(index: number) {
  return {
    title: `合成卡 ${index}`,
    platform: `site-${index}.example.test`,
    url: `https://site-${index}.example.test/login`,
    username: `user${index}@example.test`,
    password: `Synthetic-${index}-Aa!`,
    notes: index % 3 === 0 ? `合成备注 ${index}` : null,
    tags: ['合成'],
  };
}

interface Sample {
  ms: number;
  bytes: number;
  encrypts: number;
}

async function measure(store: CountingStore, run: () => Promise<unknown>): Promise<Sample> {
  // 只计数，不改变行为（spyOn 默认透传到原实现）。
  const spy = vi.spyOn(codec, 'encryptItem');
  const bytesBefore = store.bytes;
  const start = performance.now();
  let encrypts = 0;
  try {
    await run();
  } finally {
    // mockRestore 会清空调用记录，先取数。
    encrypts = spy.mock.calls.length;
    spy.mockRestore();
  }
  const ms = performance.now() - start;
  return { ms, bytes: store.bytes - bytesBefore, encrypts };
}

function median(samples: Sample[]): Sample {
  const sorted = [...samples].sort((a, b) => a.ms - b.ms);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const SIZES = [100, 1000, 10000];
const REPEATS = 5;

describe('资产写入性能对照', () => {
  it(
    '100 / 1000 / 10000 条：新增、编辑、删除、批量导入',
    async () => {
      const rows: string[] = [];
      for (const size of SIZES) {
        const store = new CountingStore();
        const service = new ItemService({ dek: randomBytes(32), now: () => 1_700_000_000_000, store });
        const seed = await measure(store, () =>
          service.createItems(Array.from({ length: size }, (_, index) => input(index))),
        );
        rows.push(row(size, `批量导入 ${size} 条（建库）`, seed));

        let next = size;
        const add: Sample[] = [];
        const edit: Sample[] = [];
        const remove: Sample[] = [];
        for (let round = 0; round < REPEATS; round += 1) {
          add.push(await measure(store, () => service.createItem(input(next++))));
          edit.push(await measure(store, () => service.updateItem(1 + round, { title: `改名 ${round}` })));
          remove.push(await measure(store, () => service.deleteItem(size + 1 + round)));
        }
        rows.push(row(size, '新增 1 条', median(add)));
        rows.push(row(size, '编辑 1 条', median(edit)));
        rows.push(row(size, '删除 1 条', median(remove)));
        const bulk = await measure(store, () =>
          service.createItems(Array.from({ length: 100 }, () => input(next++))),
        );
        rows.push(row(size, '再批量导入 100 条', bulk));
      }
      console.log(
        ['', '| 库规模 | 操作 | 耗时 (ms, 中位数) | 写入量 (KB) | 重新加密卡片数 |', '|---|---|---|---|---|', ...rows, ''].join(
          '\n',
        ),
      );
    },
    600_000,
  );
});

function row(size: number, label: string, sample: Sample): string {
  return `| ${size} | ${label} | ${sample.ms.toFixed(1)} | ${(sample.bytes / 1024).toFixed(1)} | ${sample.encrypts} |`;
}
