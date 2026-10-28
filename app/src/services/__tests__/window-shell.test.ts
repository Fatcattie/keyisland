/**
 * 桌面壳端口（`window-shell.ts`）的契约。
 *
 * 这一层是"前端 → 命令边界"的唯一出入口，所以必须钉住四件事：
 * 1. **浏览器环境零 invoke**：组件可以无条件下调用，不需要 `isDesktopShell()` 守卫；
 * 2. **命令名与参数形状精确**：拼错一个名字，jsdom 与假桥都发现不了，
 *    只有装好的程序才会炸（`npm run desktop:doctor` 静态比对的就是这件事，
 *    这里补的是"参数形状"这一半）；
 * 3. **失败策略不对称**：附属动作静默，`quit` 允许冒泡；
 * 4. **事件载荷要收窄**：Rust 那边改字段名时，前端不能把 `undefined` 当成 `false`
 *    悄悄吃掉。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createShellPort, mapToMirror, resetShellPortForTests } from '../window-shell';

/** 一次 invoke 记录。 */
interface InvokeCall {
  command: string;
  args: Record<string, unknown>;
}

/**
 * 假的 Tauri 运行时。
 *
 * 只需要三样东西就够 `@tauri-apps/api` 跑起来：
 * - `invoke`：命令入口（我们记录并应答）；
 * - `transformCallback`：`listen` 用它把 JS 回调注册成全局 `_<id>`；
 * - `__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener`：退订时会被调用。
 */
function installFakeTauri(options: { failCommands?: string[] } = {}) {
  const calls: InvokeCall[] = [];
  const listeners = new Map<string, number[]>();
  const callbacks = new Map<number, (payload: unknown) => void>();
  let nextId = 1;

  const internals = {
    invoke: async (command: string, args: Record<string, unknown> = {}) => {
      calls.push({ command, args });
      if (options.failCommands?.includes(command)) {
        throw new Error(`命令失败：${command}`);
      }
      if (command === 'plugin:event|listen') {
        const event = String(args.event);
        const handler = Number(args.handler);
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        return handler;
      }
      if (command === 'plugin:event|unlisten') {
        return null;
      }
      if (command === 'shell_mode') {
        return { mode: 'full', islandExpanded: false, session: 'locked' };
      }
      return null;
    },
    transformCallback: (callback: (payload: unknown) => void) => {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      (window as unknown as Record<string, unknown>)[`_${id}`] = callback;
      return id;
    },
  };

  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: internals,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
    value: { unregisterListener: () => undefined },
    configurable: true,
    writable: true,
  });

  return {
    calls,
    /** 模拟 Rust 侧 `emit`。 */
    emit(event: string, payload: unknown) {
      for (const id of listeners.get(event) ?? []) {
        const callback = callbacks.get(id);
        callback?.({ event, id, payload });
      }
    },
  };
}

/** 让所有已排队的 promise 落地（端口内部有 await 链）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  resetShellPortForTests();
});

afterEach(() => {
  resetShellPortForTests();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  delete (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__;
});

describe('window-shell · 浏览器环境', () => {
  it('全部方法 resolve，且一次 invoke 都不发', async () => {
    // 先在"没有 Tauri"的环境里创建端口（浏览器路径）。
    const port = createShellPort();
    expect(port.available()).toBe(false);

    // 再把假运行时装上：如果 no-op 实现其实偷偷 invoke 了，这里会记录到调用。
    const fake = installFakeTauri();

    await expect(port.readMode()).resolves.toBeNull();
    await expect(port.showMain()).resolves.toBeUndefined();
    await expect(port.enterIsland()).resolves.toBeUndefined();
    await expect(port.setExpanded(true)).resolves.toBeUndefined();
    await expect(port.setSession('unlocked')).resolves.toBeUndefined();
    await expect(port.quit()).resolves.toBeUndefined();

    const off = await port.onMode(() => undefined);
    const offLock = await port.onLockRequested(() => undefined);
    const offQuit = await port.onQuitRequested(() => undefined);
    expect(typeof off).toBe('function');
    expect(() => {
      off();
      offLock();
      offQuit();
    }).not.toThrow();

    expect(fake.calls).toEqual([]);
  });
});

describe('window-shell · 桌面壳', () => {
  it('命令名与参数形状精确匹配', async () => {
    const fake = installFakeTauri();
    const port = createShellPort();
    expect(port.available()).toBe(true);

    await port.showMain();
    await port.enterIsland();
    await port.setExpanded(true);
    await port.setExpanded(false);
    await port.setSession('unlocked');
    await port.quit();
    await flush();

    expect(fake.calls.map((call) => call.command)).toEqual([
      'shell_show_main',
      'shell_enter_island',
      'shell_set_island_expanded',
      'shell_set_island_expanded',
      'shell_set_session',
      'shell_quit',
    ]);
    // 展开状态必须是布尔（Rust 侧参数是 `expanded: bool`，传字符串会反序列化失败）。
    expect(fake.calls[2].args).toEqual({ expanded: true });
    expect(fake.calls[3].args).toEqual({ expanded: false });
    // 会话状态传的是**镜像枚举字符串**，不是前端的 SessionStatus。
    expect(fake.calls[4].args).toEqual({ status: 'unlocked' });
  });

  it('冷却期折叠成 locked（托盘不该出现第四种状态）', async () => {
    const fake = installFakeTauri();
    const port = createShellPort();

    await port.setSession('cooling_down');
    await flush();

    expect(fake.calls).toEqual([{ command: 'shell_set_session', args: { status: 'locked' } }]);
  });

  it('readMode 把载荷收窄；形状不对时返回 null', async () => {
    installFakeTauri();
    const port = createShellPort();

    await expect(port.readMode()).resolves.toEqual({
      mode: 'full',
      expanded: false,
      showCloseHint: false,
    });

    // 换一份"字段名不对"的应答：不能把 undefined 当成合法形态透传。
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {
        invoke: async () => ({ status: 'island' }),
        transformCallback: () => 1,
      },
      configurable: true,
      writable: true,
    });
    const broken = createShellPort();
    await expect(broken.readMode()).resolves.toBeNull();
  });

  it('附属动作失败静默，只有 quit 允许冒泡', async () => {
    installFakeTauri({
      failCommands: [
        'shell_show_main',
        'shell_enter_island',
        'shell_set_island_expanded',
        'shell_set_session',
        'shell_quit',
      ],
    });
    const port = createShellPort();

    // 静默：不产生未捕获的 rejection，也不改变返回值形状。
    await expect(port.showMain()).resolves.toBeUndefined();
    await expect(port.enterIsland()).resolves.toBeUndefined();
    await expect(port.setExpanded(true)).resolves.toBeUndefined();
    await expect(port.setSession('locked')).resolves.toBeUndefined();
    // 用户点了「退出密岛」，静默失败等于骗人。
    await expect(port.quit()).rejects.toThrow(/命令失败/);
  });

  it('事件载荷校验：合法形态才回调', async () => {
    const fake = installFakeTauri();
    const port = createShellPort();
    const seen: string[] = [];
    await port.onMode((event) => {
      seen.push(`${event.mode}:${event.expanded}:${event.showCloseHint}`);
    });

    fake.emit('shell://mode', { mode: 'island', expanded: false, showCloseHint: true });
    fake.emit('shell://mode', { mode: 'weird' });
    fake.emit('shell://mode', null);
    await flush();

    expect(seen).toEqual(['island:false:true']);
  });

  it('锁定 / 退出请求无载荷也能回调', async () => {
    const fake = installFakeTauri();
    const port = createShellPort();
    let locked = 0;
    let quit = 0;
    await port.onLockRequested(() => {
      locked += 1;
    });
    await port.onQuitRequested(() => {
      quit += 1;
    });

    fake.emit('shell://lock-requested', null);
    fake.emit('shell://quit-requested', null);
    await flush();

    expect(locked).toBe(1);
    expect(quit).toBe(1);
  });
});

describe('window-shell · mapToMirror', () => {
  it('四种会话状态映射成三档镜像', () => {
    expect(mapToMirror('uninitialized')).toBe('uninitialized');
    expect(mapToMirror('unlocked')).toBe('unlocked');
    expect(mapToMirror('locked')).toBe('locked');
    // 冷却期没有可用资产，托盘不该出现第四种状态。
    expect(mapToMirror('cooling_down')).toBe('locked');
  });
});
