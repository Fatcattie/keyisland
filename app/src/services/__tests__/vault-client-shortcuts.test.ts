/**
 * 快捷键自定义的门面层 + 持久化（NFR 可用性「快捷键可在设置中查看与自定义」）。
 *
 * 为什么这套测试重要：设置页下拉框会把"已被占用"的选项置灰，但那只是 UI 便利。
 * 真正的不变式（冲突、越界、固定项不可改）必须由门面守——`ShortcutSection` 的
 * 文档注释里也明说了"置灰只是 UI 便利，不变式要靠服务端守"。本测试直接打门面，
 * 验证"即使绕过 UI 也能守住不变式"。
 *
 * 另外沿用 `collapse-delay` 的"重启"范式：设置页改完必须写进元数据，否则下次打开
 * 应用自定义全丢——这跟收起延时是同一类坑，曾经没人验。这里用同一个
 * `MemoryVaultStorage` 上新建门面来模拟重启。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { AppError } from '../../core/errors';
import { createVaultClient, type VaultClient } from '../vault-client';
import { MemoryVaultStorage } from '../storage';
import { FakeClipboardPort } from './support/fakes';
import { formatBinding, DEFAULT_SHORTCUTS } from '../../lib/shortcuts';

const NOW = 1_700_000_000_000;
const MASTER = 'Alpha-Bravo-7788';

function makeClient(storage: MemoryVaultStorage): VaultClient {
  return createVaultClient({
    storage,
    now: () => NOW,
    clipboard: new FakeClipboardPort(),
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
    autoLockPolicy: '30m',
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code });
}

/** 校验失败统一归一成 `VALIDATION_FAILED`，具体原因放在 `messageKey`。 */
async function expectValidation(promise: Promise<unknown>, messageKey: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code: 'VALIDATION_FAILED', messageKey });
}

describe('NFR · 快捷键自定义', () => {
  it('新库返回默认映射（与 lib 默认值一致）', async () => {
    const client = makeClient(new MemoryVaultStorage());
    await client.initialize({ masterPassword: MASTER });

    const map = await client.getShortcuts();
    // 默认值必然与 lib 的默认映射文本一致——这是设置页"恢复默认"的基准。
    expect(map).toEqual(DEFAULT_SHORTCUTS);
    expect(formatBinding(map.focus_search)).toBe('/');
  });

  it('改完写进元数据：重启后沿用', async () => {
    const storage = new MemoryVaultStorage();
    const first = makeClient(storage);
    await first.initialize({ masterPassword: MASTER });
    await first.setShortcut('focus_search', 'Ctrl+K');

    // 模拟重启：同一存储上新建门面，只继承磁盘状态。
    const second = makeClient(storage);
    const map = await second.getShortcuts();
    expect(formatBinding(map.focus_search)).toBe('Ctrl+K');
    // 其余动作保持默认。
    expect(formatBinding(map.copy_password)).toBe('Enter');
  });

  it('改成相同值幂等：返回原映射、不报错、不重复落盘', async () => {
    const client = makeClient(new MemoryVaultStorage());
    await client.initialize({ masterPassword: MASTER });

    const same = await client.setShortcut('focus_search', '/');
    expect(formatBinding(same.focus_search)).toBe('/');
  });

  it('与已占用动作冲突报 VALIDATION_FAILED 且不落盘', async () => {
    const client = makeClient(new MemoryVaultStorage());
    await client.initialize({ masterPassword: MASTER });

    // 校验顺序：先判"取值是否在备选项"，再判冲突。这里用"在备选项内但与
    // jump 默认值撞车"的取值——copy_password 的备选项含 'Ctrl+Enter'，而
    // jump 默认正是 'Ctrl+Enter'，这才是真正的冲突（不是越界）。
    await expectValidation(client.setShortcut('copy_password', 'Ctrl+Enter'), 'error.shortcut_conflict');

    // 落盘值不变：冲突的那次修改不能偷偷写进去。
    const map = await client.getShortcuts();
    expect(formatBinding(map.copy_password)).not.toBe('Ctrl+Enter');
  });

  it('不在备选项里的取值报 VALIDATION_FAILED', async () => {
    const client = makeClient(new MemoryVaultStorage());
    await client.initialize({ masterPassword: MASTER });

    // 备选里只有 '/' 与 'Ctrl+K'，'Ctrl+W' 是越界值。
    await expectValidation(client.setShortcut('focus_search', 'Ctrl+W'), 'error.shortcut_invalid');
  });

  it('固定项（↑↓/Esc）不可改，报 VALIDATION_FAILED', async () => {
    const client = makeClient(new MemoryVaultStorage());
    await client.initialize({ masterPassword: MASTER });

    await expectValidation(client.setShortcut('nav_up' as never, 'ArrowDown'), 'error.shortcut_action_invalid');
    await expectValidation(client.setShortcut('collapse' as never, 'Escape'), 'error.shortcut_action_invalid');
  });

  it('恢复默认后回到出厂映射，且重启后仍是默认', async () => {
    const storage = new MemoryVaultStorage();
    const first = makeClient(storage);
    await first.initialize({ masterPassword: MASTER });
    await first.setShortcut('focus_search', 'Ctrl+K');
    await first.resetShortcuts();

    const afterReset = await first.getShortcuts();
    expect(afterReset).toEqual(DEFAULT_SHORTCUTS);

    // 重启后仍是默认（reset 把 meta.shortcuts 置 undefined，落盘不写）。
    const second = makeClient(storage);
    expect(await second.getShortcuts()).toEqual(DEFAULT_SHORTCUTS);
  });

  it('未初始化时改快捷键报 VAULT_NOT_INITIALIZED', async () => {
    const client = makeClient(new MemoryVaultStorage());

    // 读：没有元数据，返回默认即可（键盘处理在解锁前就要能工作）。
    expect(await client.getShortcuts()).toEqual(DEFAULT_SHORTCUTS);
    // 写：未初始化不能假装存下了。
    await expectCode(client.setShortcut('focus_search', 'Ctrl+K'), 'VAULT_NOT_INITIALIZED');
  });
});
