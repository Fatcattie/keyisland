/**
 * 岛形态端到端验收（真实 Chrome + 假 Tauri 桥，跑 `dist` 产物）。
 *
 * ## 为什么需要它
 *
 * `vitest` 全在 jsdom 上跑：那里 `isDesktopShell()` 恒为 false，端口全是 no-op，
 * 所以"前端 → 命令边界"这一段**永远执行不到**。这个脚本注入一个假的
 * `window.__TAURI_INTERNALS__`（含事件系统与 `shell_*` 命令），在真实 bundle 上
 * 把形态切换走一遍：
 *
 * 1. 建库 → 主面板 → 上报 `shell_set_session('unlocked')`（托盘据此置灰）；
 * 2. 点真实工具栏「收进岛」按钮（关闭窗口的等价入口）→ 主面板隐藏、岛窗口出现、
 *    首次关闭提示上屏、showCloseHint=true；
 * 3. 右键岛窗口 → 三项菜单（打开主面板 / 锁定保险库 / 退出密岛）；
 * 4. 点「打开主面板」→ `shell_show_main` 被调用且回到全形态；
 * 5. 二次点「收进岛」→ 仍在岛形态，但 showCloseHint=false（关闭提示只弹一次，项⑥）；
 * 6. 托盘锁定 → 岛切成锁定态且不残留资产；解锁 → 展开岛、复制 → 点「退出密岛」
 *    → 断言**先清空剪贴板，再 shell_quit**。
 *
 * ## 边界（写清楚，别把它当"Rust 已验证"）
 *
 * 这里验的是**前端到命令边界**这一段。窗口真的会不会变成 320×44、任务栏有没有
 * 条目、托盘图标长什么样，只有真机才能验：`npm run desktop:probe`（Win32 探针）
 * 与 `npm run desktop:build` 之后的手工验收。
 *
 * 用法：
 *   npm run build && npm run e2e:shell
 *   npm run e2e:shell -- --shots    # 额外存截图到 artifacts/e2e/
 *
 * 前置：本机有 Chrome / Edge（可用 CHROME_PATH 指定）。
 */

import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { findChrome, launchChrome, openPage, sleep } from './cdp.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const DIST = join(ROOT, 'dist');
const SHOTS = process.argv.includes('--shots');
const MASTER = 'TestMaster#2026';

/**
 * 假 Tauri 桥（在页面加载前注入）。
 *
 * 与 `smoke.mjs --desktop` 的那份是同一思路，额外补了三样东西：
 * - `shell_*` 六条命令（记录调用 + 维护形态/会话状态）；
 * - 事件系统（`plugin:event|listen` + `transformCallback`），否则 `listen()` 直接抛；
 * - 假剪贴板（记录每次写入），用来验证"退出前先清空剪贴板"。
 */
const SHELL_BRIDGE = `
(() => {
  const DB_KEY = 'ki-fake-tauri-db';
  const readDb = () => { try { return JSON.parse(localStorage.getItem(DB_KEY) || '{}'); } catch { return {}; } };
  const writeDb = (db) => localStorage.setItem(DB_KEY, JSON.stringify(db));

  const listeners = new Map();
  const calls = [];
  const clipWrites = [];
  const state = { mode: 'full', expanded: false, session: 'uninitialized' };
  // 镜像 Rust 的 take_close_hint：首次进入岛形态才提示，之后不再提示。
  let closeHintSeen = false;
  let nextCallbackId = 1;
  let clipboardText = '';

  const emit = (event, payload) => {
    for (const id of listeners.get(event) ?? []) {
      const callback = window['_' + id];
      if (typeof callback === 'function') {
        callback({ event, id, payload });
      }
    }
  };

  const internals = {
    invoke: async (command, args = {}) => {
      calls.push({ command, args });
      switch (command) {
        case 'storage_load':
          return readDb()[args.key] ?? null;
        case 'storage_save': {
          const db = readDb();
          db[args.key] = args.value;
          writeDb(db);
          return null;
        }
        case 'storage_clear':
          writeDb({});
          return null;
        case 'storage_describe':
          return { kind: 'file', displayPath: 'C:////Fake//vault.db', canReveal: true };
        case 'storage_reveal':
          return null;
        case 'startup_failure':
          return null;
        case 'open_external':
          window.__openedExternal = args.url;
          return null;
        case 'shell_mode':
          return { mode: state.mode, islandExpanded: state.expanded, session: state.session };
        case 'shell_set_session':
          state.session = args.status;
          return null;
        case 'shell_set_island_expanded':
          state.expanded = args.expanded;
          return null;
        case 'shell_show_main':
          state.mode = 'full';
          state.expanded = false;
          emit('shell://mode', { mode: 'full', expanded: false, showCloseHint: false });
          return null;
        case 'shell_enter_island':
          state.mode = 'island';
          state.expanded = false;
          // 镜像 Rust：take_close_hint 只在未看过时提示一次。
          const showCloseHint = !closeHintSeen;
          if (!closeHintSeen) {
            closeHintSeen = true;
          }
          window.__shell.lastShowCloseHint = showCloseHint;
          emit('shell://mode', { mode: 'island', expanded: false, showCloseHint });
          return null;
        case 'shell_quit':
          // 记下"退出发生时剪贴板已经被写了几次"：dispose() 的清空必须排在它前面。
          window.__shell.quitAt = clipWrites.length;
          return null;
        case 'plugin:event|listen': {
          const list = listeners.get(args.event) ?? [];
          list.push(args.handler);
          listeners.set(args.event, list);
          return args.handler;
        }
        case 'plugin:event|unlisten':
          return null;
        default:
          throw new Error('unknown command: ' + command);
      }
    },
    transformCallback: (callback) => {
      const id = nextCallbackId;
      nextCallbackId += 1;
      window['_' + id] = callback;
      return id;
    },
  };

  window.__TAURI_INTERNALS__ = internals;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };

  // 假剪贴板：headless 里 navigator.clipboard 存在但读回不稳，直接替换成可控实现。
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text) => {
        clipboardText = text;
        clipWrites.push(text);
      },
      readText: async () => clipboardText,
    },
  });

  window.__shell = {
    calls,
    clipWrites,
    state,
    quitAt: null,
    lastShowCloseHint: null,
    emit,
    count: (command) => calls.filter((call) => call.command === command).length,
    /** 模拟 Rust 侧发形态事件（窗口已按新形态调整好了）。 */
    emitMode: (payload) => {
      state.mode = payload.mode;
      state.expanded = payload.expanded;
      window.__shell.lastShowCloseHint = payload.showCloseHint;
      emit('shell://mode', payload);
    },
  };
})();
true;
`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

/** 起一个只读静态服务器（SPA 回退到 index.html）。 */
async function serveDist() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let filePath = normalize(join(DIST, decodeURIComponent(url.pathname)));
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) {
        filePath = join(filePath, 'index.html');
      }
      const body = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, port: server.address().port };
}

const results = [];
function check(name, pass, extra = '') {
  results.push({ name, pass });
  const mark = pass ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  console.log(`${mark}  ${name}${pass || !extra ? '' : `\n      → ${extra}`}`);
}

/** 页面内的小工具（受控组件必须用原生 setter + input 事件）。 */
const HELPERS = `
window.__ki = {
  setVal(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
  fields() {
    return Array.from(document.querySelectorAll('input,textarea'))
      .filter((el) => el.type !== 'hidden' && !el.disabled && el.type !== 'checkbox');
  },
  fill(vals) { const f = window.__ki.fields(); vals.forEach((v, i) => { if (f[i]) window.__ki.setVal(f[i], v); }); },
  click(text) {
    const el = Array.from(document.querySelectorAll('button,[role=button],a,label'))
      .find((node) => (node.innerText || '').trim().includes(text));
    if (!el) return false;
    el.click();
    return true;
  },
  clickTestId(id) {
    const el = document.querySelector('[data-testid="' + id + '"]');
    if (!el) return false;
    el.click();
    return true;
  },
  contextMenuTestId(id) {
    const el = document.querySelector('[data-testid="' + id + '"]');
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    return true;
  },
  menuItems(testId) {
    const menu = document.querySelector('[data-testid="' + testId + '"]');
    if (!menu) return null;
    return Array.from(menu.querySelectorAll('[role="menuitem"]')).map((node) => (node.textContent || '').trim());
  },
  clickMenuItem(text) {
    const el = Array.from(document.querySelectorAll('[role="menuitem"]'))
      .find((node) => (node.textContent || '').trim().includes(text));
    if (!el) return false;
    el.click();
    return true;
  },
  clickFirstOption() {
    const el = document.querySelector('[role="option"]');
    if (!el) return false;
    el.click();
    return true;
  },
  appMode() { return document.documentElement.dataset.appMode || null; },
  mainPanelHidden() {
    const search = document.getElementById('main-search');
    if (!search) return null;
    return search.closest('[aria-hidden="true"]') !== null;
  },
  text() { return document.body.innerText || ''; },
  has(t) { return (document.body.innerText || '').includes(t); },
};
true;
`;

/** 有界轮询等待某段文案上屏（首次设置要跑 Argon2，不能赌固定 sleep）。 */
async function waitForText(page, text, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    if (await page.evaluate(`window.__ki.has(${JSON.stringify(text)})`)) {
      return Date.now() - started;
    }
    if (Date.now() - started >= timeoutMs) {
      return -1;
    }
    await sleep(200);
  }
}

async function main() {
  try {
    await stat(join(DIST, 'index.html'));
  } catch {
    console.error('找不到 dist/index.html —— 先跑 `npm run build`。');
    process.exit(1);
  }

  const chromePath = findChrome();
  if (!chromePath) {
    console.error('找不到 Chrome/Edge。可用 CHROME_PATH 环境变量指定可执行文件路径。');
    process.exit(1);
  }

  const { server, port: httpPort } = await serveDist();
  const origin = `http://127.0.0.1:${httpPort}`;
  const browser = await launchChrome({ chromePath, port: 9334 });
  let page;

  const shots = async (name) => {
    if (!SHOTS) {
      return;
    }
    const dir = join(ROOT, 'artifacts/e2e');
    await mkdir(dir, { recursive: true });
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(dir, `${name}.png`), Buffer.from(shot.data, 'base64'));
  };

  try {
    page = await openPage({ port: browser.port, url: origin });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SHELL_BRIDGE });
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 860,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await page.send('Page.navigate', { url: origin });
    await sleep(1500);
    await page.evaluate(HELPERS);

    // ── 建库（走完整三步向导，和真实用户一样）──────────────────────
    check('首屏是「设置主密码」', await page.evaluate(`window.__ki.has('设置主密码')`));
    await page.evaluate(`window.__ki.fill(['${MASTER}', '${MASTER}'])`);
    await sleep(250);
    await page.evaluate(`window.__ki.click('下一步')`);
    await sleep(900);
    await page.evaluate(`window.__ki.click('创建保险库')`);
    check('生成恢复码', (await waitForText(page, '恢复码')) >= 0);
    await page.evaluate(
      `(() => { const cb = document.querySelector('input[type=checkbox]'); if (cb) cb.click(); })()`,
    );
    await sleep(300);
    await page.evaluate(`window.__ki.click('进入密岛')`);
    check('进入主面板', (await waitForText(page, '新建卡片')) >= 0);

    // ── 会话镜像上报 ────────────────────────────────────────────
    check(
      '解锁后向 Rust 上报 shell_set_session(unlocked)',
      await page.evaluate(
        `window.__shell.calls.some((c) => c.command === 'shell_set_session' && c.args.status === 'unlocked')`,
      ),
    );

    // 建一张卡，让岛里有内容可复制。
    await page.evaluate(`window.__ki.click('新建卡片')`);
    await sleep(900);
    await page.evaluate(`window.__ki.setVal(window.__ki.fields()[1], '岛内卡片')`);
    await page.evaluate(`window.__ki.setVal(window.__ki.fields()[2], 'example.com')`);
    await page.evaluate(`window.__ki.setVal(window.__ki.fields()[3], 'island@example.test')`);
    await page.evaluate(`window.__ki.setVal(window.__ki.fields()[4], 'Pa55w0rd-Island!')`);
    await sleep(250);
    await page.evaluate(`window.__ki.click('保存')`);
    await sleep(1200);

    // ── 真实入口：点工具栏「收进岛」按钮（关闭 / 最小化窗口的等价入口）──
    // 走真实 UI 触发 → shellPort().enterIsland() → 假命令 → ShellBridge → DOM，
    // 而不是像下面那样直接 emitMode 模拟 Rust。这是验证"关闭 → 岛形态"的用户真实路径。
    check('工具栏「收进岛」按钮存在', await page.evaluate(`window.__ki.clickTestId('collapse-to-island')`));
    await sleep(700);

    check('点「收进岛」→ 形态锚点 <html data-app-mode="island">', (await page.evaluate(`window.__ki.appMode()`)) === 'island');
    check('主面板仍在 DOM 但不可见（aria-hidden）', (await page.evaluate(`window.__ki.mainPanelHidden()`)) === true);
    check('岛窗口层已渲染', await page.evaluate(`document.querySelector('[data-testid="island-window"]') !== null`));
    check('首次关闭提示上屏（密岛已收进托盘）', await page.evaluate(`window.__ki.has('密岛已收进托盘')`));
    check('首次进入 showCloseHint=true（Rust 侧判定）', (await page.evaluate(`window.__shell.lastShowCloseHint`)) === true);
    await shots('10-island-collapsed');

    // ── 窗口级右键菜单 ──────────────────────────────────────────
    check('右键岛窗口弹出窗口级菜单', await page.evaluate(`window.__ki.contextMenuTestId('island-window')`));
    await sleep(300);
    const menu = await page.evaluate(`window.__ki.menuItems('window-context-menu')`);
    check(
      '菜单三项且顺序为 打开主面板 / 锁定保险库 / 退出密岛',
      Array.isArray(menu) && menu.join('|') === '打开主面板|锁定保险库|退出密岛',
      JSON.stringify(menu),
    );
    await shots('11-island-menu');

    // ── 点「打开主面板」→ 全形态 ────────────────────────────────
    await page.evaluate(`window.__ki.clickMenuItem('打开主面板')`);
    await sleep(800);
    check('调用了 shell_show_main', (await page.evaluate(`window.__shell.count('shell_show_main')`)) === 1);
    check('回到全形态', (await page.evaluate(`window.__ki.appMode()`)) === 'full');
    check('主面板重新可见', (await page.evaluate(`window.__ki.mainPanelHidden()`)) === false);

    // ── 二次进入岛形态：验证"关闭提示只弹一次"（项⑥）──────────────
    // 回到全形态后再次点「收进岛」：岛形态仍在，但 Rust 的 `take_close_hint`
    // 已经翻过标记，这次 showCloseHint 必须为 false（假桥镜像了同一逻辑）。
    await page.evaluate(`window.__ki.clickTestId('collapse-to-island')`);
    await sleep(600);
    check('二次进入仍在岛形态', (await page.evaluate(`window.__ki.appMode()`)) === 'island');
    check('二次进入 showCloseHint=false（不再提示，项⑥）', (await page.evaluate(`window.__shell.lastShowCloseHint`)) === false);
    await shots('13-island-second-entry');

    // ── 托盘「锁定保险库」→ 岛切成锁定态，且不残留资产 ─────────────
    await page.evaluate(
      `window.__shell.emitMode({ mode: 'island', expanded: false, showCloseHint: false })`,
    );
    await sleep(500);
    await page.evaluate(`window.__shell.emit('shell://lock-requested', null)`);
    await sleep(900);
    check(
      '托盘锁定请求把岛切成锁定态',
      await page.evaluate(
        `(document.querySelector('[data-testid="island-window-status"]')?.textContent || '').includes('已锁定')`,
      ),
    );
    check('锁定后岛面不含资产标题', !(await page.evaluate(`window.__ki.has('岛内卡片')`)));
    await shots('12-island-locked');

    // ── 解锁回来，验「退出前先清剪贴板」──────────────────────────
    await page.evaluate(`window.__ki.contextMenuTestId('island-window')`);
    await sleep(300);
    await page.evaluate(`window.__ki.clickMenuItem('打开主面板')`);
    await sleep(700);
    await page.evaluate(
      `(() => { const f = window.__ki.fields(); if (f[0]) window.__ki.setVal(f[0], '${MASTER}'); })()`,
    );
    await sleep(250);
    await page.evaluate(`window.__ki.click('解锁')`);
    check('锁定后可以重新解锁', (await waitForText(page, '新建卡片')) >= 0);

    await page.evaluate(
      `window.__shell.emitMode({ mode: 'island', expanded: false, showCloseHint: false })`,
    );
    await sleep(500);
    await page.evaluate(`window.__ki.clickTestId('island-window-bar')`);
    await sleep(600);
    check(
      '点击岛条后展开出完整岛面（搜索框可用）',
      await page.evaluate(`document.querySelector('[data-testid="island-input"]') !== null`),
    );
    // 「生成密码」不需要选中任何卡片就能验证"复制"这条链路（岛内复制会写剪贴板）。
    await page.evaluate(`window.__ki.clickTestId('island-generate-password')`);
    await sleep(700);
    check(
      '岛内复制写入了剪贴板',
      await page.evaluate(`window.__shell.clipWrites.some((t) => t.length > 0)`),
    );

    await page.evaluate(`window.__ki.contextMenuTestId('island-window')`);
    await sleep(300);
    await page.evaluate(`window.__ki.clickMenuItem('退出密岛')`);
    await sleep(600);

    const clip = await page.evaluate(`window.__shell.clipWrites`);
    const quitAt = await page.evaluate(`window.__shell.quitAt`);
    check('退出前清空了剪贴板', Array.isArray(clip) && clip[clip.length - 1] === '');
    check(
      '清剪贴板发生在 shell_quit 之前',
      typeof quitAt === 'number' && quitAt === (Array.isArray(clip) ? clip.length : -1),
      `quitAt=${quitAt} · writes=${JSON.stringify(clip)}`,
    );
    check('调用了 shell_quit', (await page.evaluate(`window.__shell.count('shell_quit')`)) === 1);
  } finally {
    try {
      await page?.close();
    } catch {
      // 忽略：关页面失败不该掩盖断言结果。
    }
    await browser.close();
    await new Promise((done) => server.close(done));
  }

  const failed = results.filter((item) => !item.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.error(`\n失败项：\n${failed.map((item) => `  - ${item.name}`).join('\n')}`);
    process.exit(1);
  }
}

await main();
