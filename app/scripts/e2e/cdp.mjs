/**
 * 极简 CDP 客户端 —— 用 Node 22 内置 WebSocket 直连 Chrome，零依赖。
 *
 * 为什么不用 Playwright：本项目是纯前端工具，装一套浏览器驱动只为跑冒烟测试
 * 性价比太低（下载 100MB+、还要跟着 Chrome 版本升级）。CDP 只要一个 WebSocket
 * 和几条 Runtime.evaluate 就能驱动真实浏览器。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 按平台常见安装位置找 Chrome，可用 CHROME_PATH 覆盖。 */
export function findChrome() {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  return candidates.find((path) => existsSync(path));
}

/** 启动一个无头浏览器实例（独立 user-data-dir，互不干扰）。 */
export async function launchChrome({ chromePath, port = 9333 }) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'ki-e2e-profile-'));
  const child = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        break;
      }
    } catch {
      // 还没起来
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('Chrome 未能在 20s 内开启调试端口');
    }
    await sleep(200);
  }

  const close = async () => {
    // 只杀自己这棵进程树（按 PID），绝不按进程名批量杀——那会连用户正在用的
    // 浏览器一起关掉。
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.on('exit', resolve);
        killer.on('error', resolve);
      });
    } else {
      child.kill('SIGKILL');
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  };

  return { port, close };
}

/**
 * 打开一个新页面并连上它。
 *
 * **必须关缓存**：Chrome 会缓存 index.html，重新 build 后仍加载旧 JS，
 * 表现为"改了半天没生效"——这个坑踩过一次就够。
 */
export async function openPage({ port, url }) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const events = [];

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve: done, reject: fail } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        fail(new Error(`CDP ${JSON.stringify(message.error)}`));
      } else {
        done(message.result);
      }
    } else if (message.method) {
      events.push(message);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 20000);
    });

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`页面内执行失败：${detail}`);
    }
    return result.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  for (let i = 0; i < 150; i += 1) {
    if (events.some((event) => event.method === 'Page.loadEventFired')) {
      break;
    }
    await sleep(100);
  }
  await sleep(1200);

  const consoleErrors = () =>
    events
      .filter((event) => event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error')
      .map((event) => event.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));

  const close = async () => {
    await send('Page.close').catch(() => undefined);
    ws.close();
  };

  return { send, evaluate, close, consoleErrors };
}
