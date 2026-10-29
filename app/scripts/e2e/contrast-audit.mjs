/**
 * 文字对比度审计（真实 Chrome，跑 dist）。
 *
 * 为什么需要它：主题改造后最容易出的问题不是"颜色错了"，而是"看得见但很吃力"——
 * 深色下次级文字用同一套 zinc 刻度，感知对比度会明显低于亮色。这类问题
 * jsdom 完全测不到（它没有布局也没有计算样式），肉眼又容易漏掉一两处。
 *
 * 做法：遍历页面上所有"直接包含文字"的元素，向上合成实际背景色（含半透明层），
 * 按 WCAG 公式算对比度，低于阈值就报出来。
 *
 * 阈值刻意不取 WCAG AA 的 4.5：本项目的 `text-fg-faint` 是刻意做淡的提示文字，
 * 按 4.5 卡会长期红一片，久了就没人看。这里卡 3.0 —— 低于 3.0 基本就是
 * "努力才能看清"，那才是真问题。
 *
 * 用法：
 *   npm run build && node scripts/e2e/contrast-audit.mjs
 *   node scripts/e2e/contrast-audit.mjs --threshold=3.5
 * 产物：artifacts/settings/contrast-<theme>.json，退出码 1 表示有违规项。
 */

import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { findChrome, launchChrome, openPage, sleep } from './cdp.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'artifacts/settings');
const MASTER = 'Audit!2026-Aa1';

const thresholdArg = process.argv.find((arg) => arg.startsWith('--threshold='));
const THRESHOLD = thresholdArg ? Number(thresholdArg.split('=')[1]) : 3.0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

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

/**
 * 页面内审计函数（整段塞进 Runtime.evaluate）。
 *
 * 背景合成是这里的核心：`bg-surface-muted` 这类半透明/嵌套层，
 * 只看元素自己的 background-color 会算出错误的底色（多半是透明），
 * 必须从根往下逐层 alpha 合成，否则对比度全是假的。
 */
const AUDIT_SOURCE = `
(() => {
  const parse = (value) => {
    const match = value && value.match(/rgba?\\(([^)]+)\\)/);
    if (!match) return null;
    const parts = match[1].split(',').map((n) => Number(n.trim()));
    if (parts.some((n) => Number.isNaN(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const ratio = (a, b) => {
    const la = luminance(a);
    const lb = luminance(b);
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  };

  /** 从根节点向下合成背景，得到元素背后"真实"的颜色。 */
  const effectiveBackground = (el) => {
    const chain = [];
    let node = el;
    while (node) {
      chain.push(node);
      node = node.parentElement;
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (const item of chain.reverse()) {
      const bg = parse(getComputedStyle(item).backgroundColor);
      if (bg && bg.a > 0) base = over(bg, base);
    }
    return base;
  };

  const skipAncestor = (el) => {
    let node = el;
    while (node) {
      if (node.disabled === true) return true;
      if (node.getAttribute && node.getAttribute('aria-disabled') === 'true') return true;
      node = node.parentElement;
    }
    return false;
  };

  const results = [];
  for (const el of document.querySelectorAll('body *')) {
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ')
      .trim();
    if (own.length === 0) continue;

    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (Number(style.opacity) < 0.15) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (skipAncestor(el)) continue;

    const fg = parse(style.color);
    if (!fg) continue;
    const bg = effectiveBackground(el);
    const composed = fg.a < 1 ? over(fg, bg) : fg;
    const value = ratio(composed, bg);
    if (!Number.isFinite(value)) continue;

    results.push({
      tag: el.tagName.toLowerCase(),
      text: own.slice(0, 40),
      className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
      color: style.color,
      background: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
      fontSize: style.fontSize,
      ratio: Math.round(value * 100) / 100,
    });
  }
  results.sort((a, b) => a.ratio - b.ratio);
  return results.slice(0, 40);
})()
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
  const { server, port: httpPort } = await serveDist();
  const origin = `http://127.0.0.1:${httpPort}`;
  const browser = await launchChrome({ chromePath, port: 9335 });
  let page;
  let failures = 0;

  const waitForText = async (text, timeoutMs = 15000) => {
    const started = Date.now();
    for (;;) {
      if (await page.evaluate(`(document.body.innerText || '').includes(${JSON.stringify(text)})`)) {
        return true;
      }
      if (Date.now() - started >= timeoutMs) {
        return false;
      }
      await sleep(200);
    }
  };

  const audit = async (label, theme) => {
    const rows = await page.evaluate(AUDIT_SOURCE);
    await writeFile(join(OUT, `contrast-${label}-${theme}.json`), JSON.stringify(rows, null, 2), 'utf8');
    const bad = rows.filter((row) => row.ratio < THRESHOLD);
    console.log(`\n── ${label} · ${theme} ── 取样 ${rows.length}，低于 ${THRESHOLD} 的 ${bad.length} 处`);
    for (const row of bad.slice(0, 8)) {
      console.log(
        `   ${row.ratio.toFixed(2)}  <${row.tag}> "${row.text}"  ${row.color} on ${row.background}`,
      );
    }
    if (rows.length > 0 && bad.length === 0) {
      const lowest = rows[0];
      console.log(`   最低 ${lowest.ratio.toFixed(2)}  <${lowest.tag}> "${lowest.text}"`);
    }
    failures += bad.length;
    return bad;
  };

  try {
    page = await openPage({ port: browser.port, url: origin });
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1180,
      height: 1500,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await page.send('Page.navigate', { url: origin });
    await sleep(1600);

    // 建库
    await page.evaluate(`(() => {
      const setVal = (el, v) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const inputs = Array.from(document.querySelectorAll('input')).filter((el) => el.type === 'password');
      inputs.forEach((el) => setVal(el, '${MASTER}'));
      const clickExact = (text) => {
        const el = Array.from(document.querySelectorAll('button')).find((n) => (n.innerText || '').trim() === text);
        if (el) el.click();
        return Boolean(el);
      };
      clickExact('下一步');
    })()`);
    await sleep(900);
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find((n) => (n.innerText||'').trim() === '创建保险库')?.click()`);
    if (!(await waitForText('恢复码'))) {
      throw new Error('建库失败');
    }
    await page.evaluate(`(() => { const cb = document.querySelector('input[type=checkbox]'); if (cb) cb.click(); })()`);
    await sleep(300);
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find((n) => (n.innerText||'').trim() === '进入密岛')?.click()`);
    await sleep(1800);

    // 主面板
    await audit('main', 'light');
    await page.evaluate(`document.querySelector('[role=switch]')?.click()`);
    await sleep(600);
    await audit('main', 'dark');

    // 设置面板（含 CSV / 资产迁移两块新 UI）
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find((n) => (n.innerText||'').trim() === '设置')?.click()`);
    if (!(await waitForText('备份与恢复'))) {
      throw new Error('设置面板没打开');
    }
    await sleep(400);
    await audit('settings', 'dark');
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find((n) => (n.innerText||'').includes('资产批量迁移'))?.click()`);
    await sleep(500);
    await audit('settings-bundle', 'dark');
    await page.evaluate(`document.querySelector('[role=switch]')?.click()`);
    await sleep(600);
    await audit('settings-bundle', 'light');

    console.log(
      failures === 0
        ? `\n对比度审计通过（阈值 ${THRESHOLD}）。`
        : `\n有 ${failures} 处低于阈值 ${THRESHOLD}，见 artifacts/settings/contrast-*.json`,
    );
    process.exitCode = failures === 0 ? 0 : 1;
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
