/**
 * 设置面板「导入 / 迁移」区块的视觉验收截图（真实 Chrome，跑 dist）。
 *
 * 为什么需要它：单测跑在 jsdom 上，**完全没有 CSS**。
 * 本项目历史上在深色主题下踩过一串只有截图才看得见的坑：
 * 语义浅色块（`bg-sky-50` 这类）没配 `dark:` 变体，深色下就是一整块亮斑；
 * 硬编码的白/黑在换主题后变成看不见或刺眼。这些断言抓不到，只能看。
 *
 * 覆盖四种状态：
 *   1. CSV 表头认不出来 → 手动映射（空下拉 + 提示）
 *   2. CSV 识别成功 → 预览计数 + 跳过行 + 报告按钮
 *   3. 资产批量迁移区块展开（含 sky 色提示块，深色下最容易翻车的地方）
 *   每种都在白天 / 黑夜各拍一张。
 *
 * 用法：npm run build && node scripts/e2e/settings-shots.mjs
 * 产物：artifacts/settings/*.png
 */

import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { findChrome, launchChrome, openPage, sleep } from './cdp.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'artifacts/settings');
const MASTER = 'Shots!2026-Aa1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

/** 表头是自定义英文，别名表认不出来 —— 强制走手动映射那条路。 */
const CSV_UNKNOWN = 'service,login,secret,备注\nGitHub,octocat,Pass-1-Aa1!,工作账号\n';
/** 标准表头：能自动识别，并带一行缺密码的记录，好让"跳过行"有东西可显示。 */
const CSV_KNOWN = [
  'name,username,password,url',
  'GitHub,octocat,Pass-1-Aa1!,https://github.com',
  'NoPass,someone@example.com,,',
].join('\n');

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

const HELPERS = `
window.__shot = {
  setVal(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
  fields() {
    return Array.from(document.querySelectorAll('input,textarea'))
      .filter((el) => el.type !== 'hidden' && !el.disabled && el.type !== 'checkbox' && el.type !== 'file');
  },
  fill(vals) { const f = window.__shot.fields(); vals.forEach((v, i) => { if (f[i]) window.__shot.setVal(f[i], v); }); },
  /** 只点文字完全相等的元素，避免「设置」误命中「设置主密码」这类前缀重合。 */
  clickExact(text) {
    const el = Array.from(document.querySelectorAll('button,[role=button],a,label'))
      .find((node) => (node.innerText || '').trim() === text);
    if (!el) return false;
    el.click();
    return true;
  },
  clickContains(text) {
    const el = Array.from(document.querySelectorAll('button,[role=button],a,label'))
      .find((node) => (node.innerText || '').trim().includes(text));
    if (!el) return false;
    el.click();
    return true;
  },
  has(t) { return (document.body.innerText || '').includes(t); },
  text() { return document.body.innerText || ''; },
  toggleTheme() {
    const sw = document.querySelector('[role=switch]');
    if (!sw) return false;
    sw.click();
    return true;
  },
  isDark() { return document.documentElement.classList.contains('dark'); },
  scrollTo(id) {
    const el = document.getElementById(id);
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    return true;
  },
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
    console.error('找不到 Chrome/Edge。可用 CHROME_PATH 指定。');
    process.exit(1);
  }

  await mkdir(OUT, { recursive: true });
  const csvUnknownPath = join(OUT, 'fixture-manual.csv');
  const csvKnownPath = join(OUT, 'fixture-known.csv');
  await writeFile(csvUnknownPath, CSV_UNKNOWN, 'utf8');
  await writeFile(csvKnownPath, CSV_KNOWN, 'utf8');

  const { server, port: httpPort } = await serveDist();
  const origin = `http://127.0.0.1:${httpPort}`;
  const browser = await launchChrome({ chromePath, port: 9334 });
  let page;

  const waitForText = async (text, timeoutMs = 15000) => {
    const started = Date.now();
    for (;;) {
      if (await page.evaluate(`window.__shot.has(${JSON.stringify(text)})`)) {
        return true;
      }
      if (Date.now() - started >= timeoutMs) {
        return false;
      }
      await sleep(200);
    }
  };

  const shot = async (name) => {
    const image = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(OUT, `${name}.png`), Buffer.from(image.data, 'base64'));
    console.log(`  ✓ ${name}.png`);
  };

  /** 用 CDP 直接给 <input type=file> 塞文件，等价于用户点选。 */
  const setFile = async (selector, filePath) => {
    await page.send('DOM.enable');
    const doc = await page.send('DOM.getDocument', { depth: -1 });
    const node = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!node.nodeId) {
      throw new Error(`找不到文件输入框：${selector}`);
    }
    await page.send('DOM.setFileInputFiles', { files: [filePath], nodeId: node.nodeId });
  };

  try {
    page = await openPage({ port: browser.port, url: origin });
    // 高度放大：设置面板内容很长，矮视口会把下半截裁掉，等于没验。
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1180,
      height: 1500,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await page.send('Page.navigate', { url: origin });
    await sleep(1600);
    await page.evaluate(HELPERS);

    // ── 建库（三步向导）──────────────────────────────────────────
    await page.evaluate(`window.__shot.fill(['${MASTER}', '${MASTER}'])`);
    await sleep(250);
    await page.evaluate(`window.__shot.clickExact('下一步')`);
    await sleep(900);
    await page.evaluate(`window.__shot.clickExact('创建保险库')`);
    if (!(await waitForText('恢复码'))) {
      throw new Error('建库失败：等不到恢复码');
    }
    await page.evaluate(`(() => { const cb = document.querySelector('input[type=checkbox]'); if (cb) cb.click(); })()`);
    await sleep(300);
    await page.evaluate(`window.__shot.clickExact('进入密岛')`);
    await sleep(1800);

    // ── 打开设置 ────────────────────────────────────────────────
    if (!(await page.evaluate(`window.__shot.clickExact('设置')`))) {
      throw new Error('找不到侧栏「设置」按钮');
    }
    await sleep(800);
    if (!(await waitForText('备份与恢复'))) {
      throw new Error('设置面板没打开');
    }

    // ── 状态 1：CSV 表头认不出来 → 手动映射 ─────────────────────
    await page.evaluate(`window.__shot.clickContains('导入 CSV')`);
    await sleep(500);
    await setFile('#settings-csv-file', csvUnknownPath);
    if (!(await waitForText('手动指定名称、账号和密码'))) {
      throw new Error('手动映射态没出现');
    }
    await sleep(400);
    await page.evaluate(`window.__shot.scrollTo('settings-csv-file')`);
    await sleep(300);
    await shot('01-csv-manual-light');

    // ── 状态 2：标准表头 → 预览 + 跳过行 ────────────────────────
    await setFile('#settings-csv-file', csvKnownPath);
    if (!(await waitForText('可导入'))) {
      throw new Error('预览态没出现');
    }
    await sleep(400);
    await page.evaluate(`window.__shot.scrollTo('settings-csv-file')`);
    await sleep(300);
    await shot('02-csv-preview-light');

    // ── 状态 3：资产批量迁移区块 ────────────────────────────────
    await page.evaluate(`window.__shot.clickContains('资产批量迁移')`);
    await sleep(600);
    if (!(await waitForText('导出加密资产包'))) {
      throw new Error('资产迁移区块没展开');
    }
    await page.evaluate(`window.__shot.scrollTo('settings-bundle-export-password')`);
    await sleep(300);
    await shot('03-bundle-light');

    // ── 切深色，同样三屏再来一遍 ────────────────────────────────
    if (!(await page.evaluate(`window.__shot.toggleTheme()`))) {
      throw new Error('找不到主题开关');
    }
    await sleep(600);
    const dark = await page.evaluate(`window.__shot.isDark()`);
    console.log(`  深色已生效：${dark}`);
    await shot('04-bundle-dark');

    await page.evaluate(`window.__shot.scrollTo('settings-csv-file')`);
    await sleep(300);
    await shot('05-csv-preview-dark');

    // 回到手动映射态：换一份认不出来的表头
    await setFile('#settings-csv-file', csvUnknownPath);
    if (!(await waitForText('手动指定名称、账号和密码'))) {
      throw new Error('深色下手动映射态没出现');
    }
    await sleep(400);
    await page.evaluate(`window.__shot.scrollTo('settings-csv-file')`);
    await sleep(300);
    await shot('06-csv-manual-dark');

    console.log(`\n完成：${OUT}`);
  } finally {
    if (page) {
      await page.close?.();
    }
    await browser.close?.();
    server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
