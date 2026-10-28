/**
 * 生产包冒烟验收（真实 Chrome，跑 dist 而不是源码）。
 *
 * 为什么需要它：`vitest` 全部跑在 jsdom 上，覆盖不到 bundle 层——
 * 分包路径、Portal 渲染、hash-wasm、CSS 变量，任何一处坏掉单测都发现不了。
 * 这个脚本用 `npm run build` 的产物走一遍最关键的账密安全路径。
 *
 * 用法：
 *   npm run build && npm run e2e:smoke
 *   npm run e2e:smoke -- --shots     # 额外把截图存到 artifacts/e2e/
 *   npm run e2e:smoke -- --desktop   # 走桌面存储路径（假 Tauri 桥 + localStorage）
 *   npm run e2e:smoke -- --csp       # 带真实 CSP 再跑一遍
 *   npm run e2e:smoke -- --startup-failure
 *                                    # 额外验证「启动失败屏」：假桥返回 startup_failure，
 *                                    # 断言原因上屏（Rust 侧启动失败的可见性修复）
 *
 * 前置：本机有 Chrome / Edge（可用 CHROME_PATH 指定）。
 */

import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { findChrome, launchChrome, openPage, sleep } from './cdp.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const DIST = join(ROOT, 'dist');
const SHOTS = process.argv.includes('--shots');
/**
 * `--csp`：用 `src-tauri/tauri.conf.json` 里那条 CSP 作为响应头再跑一遍。
 *
 * 为什么需要：桌面版白屏最常见的原因就是 CSP 拦了资源，而这条配置在浏览器里
 * 根本不会生效——不模拟一次，就得等装完 Rust、打完包、双击打开才发现是白屏。
 */
const WITH_CSP = process.argv.includes('--csp');
/**
 * `--desktop`：在页面加载前注入一个假的 Tauri 桥（`window.__TAURI_INTERNALS__`），
 * 让生产包走**桌面路径**——`TauriVaultStorage` 而不是内存存储。
 *
 * 为什么值得：单测里的 mock 只能证明适配器自己的逻辑，证明不了
 * 「命令名对不对、参数形状对不对、刷新后数据还在不在」。这里用 localStorage
 * 假装是 SQLite，于是可以在真实 bundle 上验证「关掉再开，数据还在」。
 *
 * 注意：这不是替代 `cargo test`。它验的是**前端到命令边界**这一段，
 * 边界之后的 Rust 实现仍然只有装完工具链才能验。
 */
const DESKTOP = process.argv.includes('--desktop') || process.argv.includes('--startup-failure');
/** 只跑「启动失败屏」这一段，跳过建库流程（见 `FAILING_TAURI_BRIDGE`）。 */
const STARTUP_FAILURE = process.argv.includes('--startup-failure');

const FAKE_TAURI_BRIDGE = `
(() => {
  const DB_KEY = 'ki-fake-tauri-db';
  const read = () => { try { return JSON.parse(localStorage.getItem(DB_KEY) || '{}'); } catch { return {}; } };
  const write = (db) => localStorage.setItem(DB_KEY, JSON.stringify(db));

  window.__openedExternal = null;

  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args = {}) => {
      switch (command) {
        case 'storage_load':
          return read()[args.key] ?? null;
        case 'storage_save': {
          const db = read();
          db[args.key] = args.value;
          write(db);
          return null;
        }
        case 'storage_clear':
          write({});
          return null;
        case 'storage_describe':
          return { kind: 'file', displayPath: 'C:////////Fake////vault.db', canReveal: true };
        case 'storage_reveal':
          return null;
        case 'startup_failure':
          return null;
        case 'open_external':
          window.__openedExternal = args.url;
          return null;
        default:
          throw new Error('unknown command: ' + command);
      }
    },
  };
})();
`;

/**
 * `--startup-failure`：把桥换成"启动就失败"的版本，验证**启动失败屏真的会出现**。
 *
 * 为什么非要在真 bundle 上验一次：这条路径的全部意义就是"用户能看到原因"，
 * 而 jsdom 里 `isDesktopShell()` 恒为 false，单测根本走不到 `readStartupFailure`。
 * Rust 侧本机编译不了，这里就成了唯一能执行到的证据。
 */
const FAILING_TAURI_BRIDGE = `
(() => {
  window.__TAURI_INTERNALS__ = {
    invoke: async (command) => {
      if (command === 'startup_failure') {
        return {
          code: 'missing_key',
          detail: '数据库里已有数据，但系统凭据管理器里找不到对应的密钥。为避免覆盖既有数据，应用不会新建密钥。',
          dbPath: 'C:\\\\Users\\\\tester\\\\AppData\\\\Roaming\\\\com.keyisland.desktop\\\\vault.db',
        };
      }
      if (command === 'storage_reveal') {
        return null;
      }
      throw new Error('unknown command: ' + command);
    },
  };
})();
`;

const MASTER = 'TestMaster#2026';
const MASK = '••••••••';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

/** 起一个只读静态服务器，模拟线上托管环境（SPA 回退到 index.html）。 */
async function loadCsp() {
  const config = JSON.parse(await readFile(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
  return config.app?.security?.csp ?? null;
}

async function serveDist(csp) {
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
      const headers = { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' };
      if (csp !== null) {
        headers['content-security-policy'] = csp;
      }
      res.writeHead(200, headers);
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

/** 页面内的小工具：React 受控组件必须用原生 setter + input 事件才认。 */
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
  clickAria(label) {
    const el = document.querySelector('[aria-label="' + label + '"]');
    if (!el) return false;
    el.click();
    return true;
  },
  clickEditOf(title) {
    const card = Array.from(document.querySelectorAll('[data-testid^="item-card-"]'))
      .find((node) => (node.innerText || '').includes(title));
    const btn = card && card.querySelector('[aria-label="编辑"]');
    if (!btn) return false;
    btn.click();
    return true;
  },
  setVisibility(value) {
    const select = Array.from(document.querySelectorAll('select'))
      .find((node) => Array.from(node.options).some((option) => option.value === value));
    if (!select) return false;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  text() { return document.body.innerText || ''; },
  has(t) { return (document.body.innerText || '').includes(t); },
};
true;
`;

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

  const csp = WITH_CSP ? await loadCsp() : null;
  if (WITH_CSP) {
    console.log(`已启用 tauri.conf.json 的 CSP（${csp === null ? '未配置' : `${csp.length} 字符`}）\n`);
  }
  const { server, port: httpPort } = await serveDist(csp);
  const origin = `http://127.0.0.1:${httpPort}`;
  const browser = await launchChrome({ chromePath, port: 9333 });
  let page;

  try {
    page = await openPage({ port: browser.port, url: origin });
    if (DESKTOP) {
      // 注册给**后续**的每一次导航，所以必须在下面那次 navigate 之前挂上。
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_TAURI_BRIDGE });
      console.log('已注入假 Tauri 桥：本次走桌面存储路径\n');
    }
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 860,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await page.send('Page.navigate', { url: origin });
    await sleep(1500);
    await page.evaluate(HELPERS);

    const shots = async (name) => {
      if (!SHOTS) {
        return;
      }
      const dir = join(ROOT, 'artifacts/e2e');
      await mkdir(dir, { recursive: true });
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(dir, `${name}.png`), Buffer.from(shot.data, 'base64'));
    };

    /**
     * 等到某段文案上屏，返回耗时毫秒；超时返回 -1。
     *
     * 为什么不用固定 `sleep`：首次设置第 3 步要等 Argon2 派生 + 落库完成才渲染恢复码，
     * 这段时间在冷启动 / 机器负载高时会明显变长。写死 1600ms 等于赌机器不忙，
     * 一忙就假红。这里改成有界轮询——断言本身没放松（文案必须出现），只是不再赌时间。
     */
    const waitForText = async (text, timeoutMs = 15000) => {
      const started = Date.now();
      for (;;) {
        if (await page.evaluate(`window.__ki.has('${text}')`)) {
          return Date.now() - started;
        }
        if (Date.now() - started >= timeoutMs) {
          return -1;
        }
        await sleep(200);
      }
    };

    // ── 首次设置三步向导 ──────────────────────────────────────────
    check('首屏是「设置主密码」', await page.evaluate(`window.__ki.has('设置主密码')`));
    await page.evaluate(`window.__ki.fill(['${MASTER}', '${MASTER}'])`);
    await sleep(250);
    await page.evaluate(`window.__ki.click('下一步')`);
    await sleep(900);
    await page.evaluate(`window.__ki.click('创建保险库')`);
    const recoveryMs = await waitForText('恢复码');
    check(
      recoveryMs >= 0 ? `生成恢复码（第 3 步，${recoveryMs} ms）` : '生成恢复码（第 3 步）',
      recoveryMs >= 0,
    );
    await page.evaluate(`(() => { const cb = document.querySelector('input[type=checkbox]'); if (cb) cb.click(); })()`);
    await sleep(300);
    await page.evaluate(`window.__ki.click('进入密岛')`);
    await sleep(1800);
    check('首次设置完成并进入主面板', await page.evaluate(`window.__ki.has('新建卡片')`));

    // ── 新建「遮罩」卡片 ─────────────────────────────────────────
    await page.evaluate(`window.__ki.click('新建卡片')`);
    await sleep(900);
    await page.evaluate(`window.__ki.setVal(window.__ki.fields()[1], '冒烟-遮罩卡片')`);
    await page.evaluate(`window.__ki.setVal(window.__ki.fields()[2], 'example.com')`);
    await page.evaluate(`window.__ki.setVal(window.__ki.fields()[3], 'masked-user@example.com')`);
    await page.evaluate(`window.__ki.setVal(window.__ki.fields()[4], 'Pa55w0rd-Demo!')`);
    // 补一个网址：桌面模式要验「打开链接」是否走 open_external（window.open 会被 Tauri 拦）。
    await page.evaluate(`window.__ki.setVal(window.__ki.fields()[5], 'https://example.com/login')`);
    await sleep(250);
    check('可见性可选「遮罩」', await page.evaluate(`window.__ki.setVisibility('masked')`));
    await sleep(250);
    await page.evaluate(`window.__ki.click('保存')`);
    await sleep(1500);

    let text = await page.evaluate(`window.__ki.text()`);
    check('列表出现该卡片', text.includes('冒烟-遮罩卡片'));
    check('账号被遮罩', text.includes(MASK));
    check('列表不含账号明文', !text.includes('masked-user@example.com'));
    check('显示「遮罩」角标', text.includes('遮罩'));
    await shots('01-masked-list');

    // ── 一键上锁 ────────────────────────────────────────────────
    await page.evaluate(`window.__ki.click('立即锁定')`);
    await sleep(1200);
    text = await page.evaluate(`window.__ki.text()`);
    check('上锁后主面板收起', !text.includes('新建卡片'));
    check('上锁后卡片标题不可见', !text.includes('冒烟-遮罩卡片'));

    // ── 错误主密码 ──────────────────────────────────────────────
    await page.evaluate(`(() => { const f = window.__ki.fields(); if (f[0]) window.__ki.setVal(f[0], 'WrongPass#9999'); })()`);
    await sleep(250);
    await page.evaluate(`window.__ki.click('解锁')`);
    await sleep(1500);
    check('错误主密码无法解锁', !(await page.evaluate(`window.__ki.has('新建卡片')`)));

    // ── 正确主密码 ──────────────────────────────────────────────
    await page.evaluate(`(() => { const f = window.__ki.fields(); if (f[0]) window.__ki.setVal(f[0], '${MASTER}'); })()`);
    await sleep(250);
    await page.evaluate(`window.__ki.click('解锁')`);
    await sleep(2000);
    text = await page.evaluate(`window.__ki.text()`);
    check('正确主密码解锁后恢复主面板', text.includes('新建卡片'));
    check('解锁后遮罩仍生效（无残留授权）', text.includes(MASK) && !text.includes('masked-user@example.com'));

    // ── 卡片二次验证 + 授权后自动续跑 ────────────────────────────
    check('点「编辑」唤起验证弹窗', await (async () => {
      await page.evaluate(`window.__ki.clickEditOf('冒烟-遮罩卡片')`);
      await sleep(1200);
      return page.evaluate(`window.__ki.has('验证以显示卡片')`);
    })());
    await shots('02-verify-dialog');

    await page.evaluate(`(() => { const f = window.__ki.fields(); const target = f.find((el) => el.type === 'password') || f[0]; if (target) window.__ki.setVal(target, '${MASTER}'); })()`);
    await sleep(250);
    await page.evaluate(`window.__ki.click('验证并查看')`);
    await sleep(2200);
    text = await page.evaluate(`window.__ki.text()`);
    check('验证后账号恢复显示', text.includes('masked-user@example.com'));
    check('验证后自动进入编辑（原始意图被执行）', text.includes('可见性') && text.includes('保存'));
    await shots('03-editor-after-grant');

    // ── 桌面路径专属：外部链接 + 刷新后数据仍在 ──────────────────
    if (DESKTOP) {
      await page.evaluate(`window.__ki.click('取消')`);
      await sleep(600);

      await page.evaluate(`window.__ki.clickAria('打开链接')`);
      await sleep(900);
      const opened = await page.evaluate(`window.__openedExternal`);
      check(
        '「打开链接」走 open_external（不是被 Tauri 拦掉的 window.open）',
        opened === 'https://example.com/login',
        `实际收到：${String(opened)}`,
      );

      // 刷新 = 模拟「关掉程序再打开」。桌面版必须能从这里恢复出库来。
      await page.send('Page.navigate', { url: origin });
      await sleep(2600);
      await page.evaluate(HELPERS);
      const afterReload = await page.evaluate(`window.__ki.text()`);
      check(
        '刷新后回到解锁页（说明库已落盘，不是空库）',
        afterReload.includes('主密码') && !afterReload.includes('设置主密码'),
        afterReload.replace(/\n+/g, ' ').slice(0, 80),
      );

      await page.evaluate(`(() => { const f = window.__ki.fields(); if (f[0]) window.__ki.setVal(f[0], '${MASTER}'); })()`);
      await sleep(300);
      await page.evaluate(`window.__ki.click('解锁')`);
      await sleep(2400);
      const afterUnlock = await page.evaluate(`window.__ki.text()`);
      check('解锁后卡片仍在（数据真的持久化了）', afterUnlock.includes('冒烟-遮罩卡片'));
      check('落盘后账号仍被遮罩（加密没被绕过）', afterUnlock.includes(MASK) && !afterUnlock.includes('masked-user@example.com'));
    }

    // ── 启动失败屏（`--startup-failure`）────────────────────────
    //
    // 这一段验的是「启动失败不可见」的修复：Rust 侧启动失败不再 panic 退出，
    // 而是把原因挂到状态上由前端整屏展示。真实壳里没法自动化，只能在
    // 生产包上用假桥模拟一次 `startup_failure` 的返回，确认文案与路径都上屏。
    if (STARTUP_FAILURE) {
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FAILING_TAURI_BRIDGE });
      await page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
      await page.send('Page.navigate', { url: origin });
      await sleep(2000);
      await page.evaluate(HELPERS);
      const failedText = await page.evaluate(`window.__ki.text()`);
      await shots('04-startup-failure');

      check(
        '启动失败：整屏显示「数据还在，但解开它的密钥不在了」',
        failedText.includes('数据还在，但解开它的密钥不在了'),
        failedText.replace(/\n+/g, ' ').slice(0, 120),
      );
      check(
        '启动失败：具体原因透传到界面（不是「存储读写失败」）',
        failedText.includes('系统凭据管理器里找不到对应的密钥') &&
          failedText.includes('不会新建密钥'),
      );
      check(
        '启动失败：给出数据文件路径',
        failedText.includes('com.keyisland.desktop') && failedText.includes('vault.db'),
      );
      check('启动失败：不再落回设置向导', !failedText.includes('设置主密码'));
    }

    const errors = page.consoleErrors();
    check('全程无 console 错误', errors.length === 0, errors.join(' | '));
  } finally {
    if (page) {
      await page.close();
    }
    await browser.close();
    server.close();
  }

  const failed = results.filter((item) => !item.pass);
  const mode = [
    DESKTOP ? '桌面存储' : '浏览器内存',
    WITH_CSP ? '真实 CSP' : null,
    STARTUP_FAILURE ? '含启动失败屏' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过（${mode}）`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
