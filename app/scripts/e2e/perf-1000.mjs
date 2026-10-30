/**
 * 1000 张卡的真实体感测量（真实 Chrome，跑 dist）。
 *
 * 为什么需要它：`search.test.ts` 里有一条「1000 条 ≤ 50 ms」的断言，但那是**纯函数**。
 * 用户真正会卡的环节全在它之外——1000 个 ItemCard 一次性进 DOM、每次搜索触发全量
 * 重渲染、导入时整表解密。这些在 jsdom 里量不出来（没有布局与绘制），只能开真浏览器。
 *
 * 怎么灌数据：走 **CSV 导入**。不往 window 上挂测试钩子——那会为了测量而改产品代码，
 * 测到的就不是用户那条路径了。顺带把 CSV 导入在大批量下的表现一起量了。
 *
 * 用法：npm run build && node scripts/e2e/perf-1000.mjs [--rows=1000]
 * 产物：artifacts/perf/report.json
 */

import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { findChrome, launchChrome, openPage, sleep } from './cdp.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'artifacts/perf');
const MASTER = 'Perf!2026-Aa1';

const ROWS = (() => {
  const arg = process.argv.find((value) => value.startsWith('--rows='));
  const parsed = arg === undefined ? Number.NaN : Number(arg.slice('--rows='.length));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1000;
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

/**
 * 静态服务器。
 *
 * 注意：`settings-shots.mjs` 里有一份等价实现（没抽公共模块，因为那个脚本是发布
 * 链路的第 7.5 步，改动要重新验证一遍）。将来统一时以这里为准。
 */
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
window.__perf = {
  setVal(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
  fields() {
    return Array.from(document.querySelectorAll('input,textarea'))
      .filter((el) => el.type !== 'hidden' && !el.disabled && el.type !== 'checkbox' && el.type !== 'file');
  },
  fill(vals) { const f = window.__perf.fields(); vals.forEach((v, i) => { if (f[i]) window.__perf.setVal(f[i], v); }); },
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
  /** 列表里当前渲染了多少张卡（没有列表时为 0）。 */
  listCount() {
    const list = document.querySelector('[data-testid=item-list]');
    return list === null ? 0 : list.children.length;
  },
  nodeCount() { return document.querySelectorAll('*').length; },
  /**
   * 单次按键 → 下一帧的延迟（毫秒），取多次的中位数。
   *
   * 这是"打字跟不跟手"的直接度量，也是判断卡片 memo 有没有生效的**唯一**可靠办法：
   * 没有 memo 时每次按键都要重建 1000 张卡，延迟会随卡片数线性增长；
   * 有 memo 时卡片 props 没变、整片跳过，延迟与卡片数基本无关。
   * 所以只要对比「200 张」与「1000 张」两次的读数，就能判断修没修好，
   * 不必回头去 checkout 旧代码跑基线。
   *
   * 为什么在页面内做：CDP 往返会被主线程渲染阻塞排队，测出来的是排队时间。
   */
  measureKeystrokes(times, ch) {
    return new Promise((resolve) => {
      const box = window.__perf.searchBox();
      if (box === null) { resolve(null); return; }
      const base = box.value;
      const samples = [];
      const run = (left) => {
        if (left === 0) {
          samples.sort((a, b) => a - b);
          resolve(samples[Math.floor(samples.length / 2)]);
          return;
        }
        const started = performance.now();
        window.__perf.setVal(box, base + ch);
        requestAnimationFrame(() => {
          const cost = performance.now() - started;
          samples.push(cost);
          // 复位也要渲染一次，等它画完再测下一发，别把两次测量叠在一起。
          window.__perf.setVal(box, base);
          requestAnimationFrame(() => setTimeout(() => run(left - 1), 0));
        });
      };
      run(times);
    });
  },
  searchBox() {
    return Array.from(document.querySelectorAll('input'))
      .find((el) => (el.placeholder || '').includes('搜索标题')) || null;
  },
  setSearch(value) {
    const box = window.__perf.searchBox();
    if (box === null) return false;
    window.__perf.setVal(box, value);
    return true;
  },
  /**
   * 页面内完成「逐字符输入 → 等列表变成 expected 张」，返回毫秒。
   *
   * 为什么不在 Node 侧循环：每次 CDP evaluate 都要等主线程空闲，页面正在渲染
   * 1000 张卡时这条命令会被排队——测出来的就成了「渲染耗时 × 输入次数」，
   * 而不是用户感知的输入延迟。放在页面内用 setTimeout 让出主线程，才是真实节奏。
   */
  measureType(text, gapMs, expected) {
    return new Promise((resolve, reject) => {
      const box = window.__perf.searchBox();
      if (box === null) { reject(new Error('找不到搜索框')); return; }
      const started = performance.now();
      let index = 0;
      const step = () => {
        index += 1;
        window.__perf.setVal(box, text.slice(0, index));
        if (index < text.length) { setTimeout(step, gapMs); return; }
        const check = () => {
          if (window.__perf.listCount() === expected) { resolve(performance.now() - started); return; }
          if (performance.now() - started > 120000) { reject(new Error('搜索超时')); return; }
          setTimeout(check, 30);
        };
        check();
      };
      step();
    });
  },
};
true;
`;

/** 造一份不会触发去重的 CSV：每行标题/账号/网址都不同。 */
function buildCsv(rows) {
  const lines = ['name,username,password,url,category'];
  for (let index = 1; index <= rows; index += 1) {
    const id = String(index).padStart(4, '0');
    lines.push(
      `site-${id},user${id}@example.test,Pass-${id}-Aa1!,https://site${id}.example.test,开发`,
    );
  }
  return `${lines.join('\n')}\n`;
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
    console.error('找不到 Chrome/Edge。可用 CHROME_PATH 指定。');
    process.exit(1);
  }

  await mkdir(OUT, { recursive: true });
  const csvPath = join(OUT, `fixture-${ROWS}.csv`);
  await writeFile(csvPath, buildCsv(ROWS), 'utf8');

  const { server, port: httpPort } = await serveDist();
  const origin = `http://127.0.0.1:${httpPort}`;
  const browser = await launchChrome({ chromePath, port: 9336 });
  let page;

  const waitForText = async (text, timeoutMs = 60000) => {
    const started = Date.now();
    for (;;) {
      if (await page.evaluate(`window.__perf.has(${JSON.stringify(text)})`)) {
        return Date.now() - started;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`等不到文本：${text}`);
      }
      await sleep(100);
    }
  };

  /** 轮询一个页面内表达式，返回它成立的耗时（毫秒）。 */
  const waitFor = async (expression, timeoutMs = 60000) => {
    const started = Date.now();
    for (;;) {
      if (await page.evaluate(expression)) {
        return Date.now() - started;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`等不到条件：${expression}`);
      }
      await sleep(100);
    }
  };

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
    // 用真实常见视口，别放大：高度会影响一次渲染多少张卡，放大等于作弊。
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await page.send('Page.navigate', { url: origin });
    await sleep(1600);
    await page.evaluate(HELPERS);

    // ── 建库 ────────────────────────────────────────────────────
    await page.evaluate(`window.__perf.fill(['${MASTER}', '${MASTER}'])`);
    await sleep(250);
    await page.evaluate(`window.__perf.clickExact('下一步')`);
    await sleep(900);
    await page.evaluate(`window.__perf.clickExact('创建保险库')`);
    await waitForText('恢复码');
    await page.evaluate(`(() => { const cb = document.querySelector('input[type=checkbox]'); if (cb) cb.click(); })()`);
    await sleep(300);
    await page.evaluate(`window.__perf.clickExact('进入密岛')`);
    await sleep(1800);

    // ── 打开设置 → CSV 导入 ─────────────────────────────────────
    await page.evaluate(`window.__perf.clickExact('设置')`);
    await waitForText('备份与恢复');
    await page.evaluate(`window.__perf.clickExact('导入 CSV')`);
    await sleep(600);

    // 预览：塞文件 → 等"可导入 N 张"
    const previewStart = Date.now();
    await setFile('#settings-csv-file', csvPath);
    await waitForText(`可导入 ${ROWS} 张`);
    const previewMs = Date.now() - previewStart;

    // 导入：点按钮 → 等 toast
    const importStart = Date.now();
    const clicked = await page.evaluate(`window.__perf.clickContains('张卡片')`);
    if (!clicked) {
      throw new Error('找不到「导入 N 张卡片」按钮');
    }
    await waitForText(`已导入 ${ROWS} 张`);
    const importMs = Date.now() - importStart;

    // ── 列表渲染 ────────────────────────────────────────────────
    // 关掉设置面板，看主面板把 1000 张卡铺出来要多久。
    const renderStart = Date.now();
    await page.evaluate(`window.__perf.clickExact('关闭')`);
    await waitFor(`window.__perf.listCount() === ${ROWS}`, 120000);
    const listMs = Date.now() - renderStart;
    const nodes = await page.evaluate('window.__perf.nodeCount()');

    // ── 按键延迟 ────────────────────────────────────────────────
    // 列表此刻是满的，最坏情况。取 5 发中位数。
    const keystrokeMs = await page.evaluate('window.__perf.measureKeystrokes(5, "x")');
    await page.evaluate(`window.__perf.setSearch('')`);
    await sleep(400);

    // ── 搜索：先自检防抖，再对比「一次性输入」与「逐字符输入」────────
    // 搜索目标必须跟着行数走：写死 'site-0500' 的话，--rows=200 时这张卡根本不存在，
    // 后面"等列表只剩 1 张"会一直等不到（第一次跑 200 就是这么挂的）。
    const TARGET = `site-${String(ROWS).padStart(4, '0')}`;

    // 自检：setSearch 之后**立刻**查，列表应当还没变（说明输入与筛选之间有一层去抖）。
    // 若这里就已经变成 1，说明去抖没生效，后面的对比也没意义。
    await page.evaluate(`window.__perf.setSearch(${JSON.stringify(TARGET)})`);
    const immediate = await page.evaluate('window.__perf.listCount()');
    const debounceWorks = immediate === ROWS;
    await waitFor(`window.__perf.listCount() === 1`, 120000);
    await page.evaluate(`window.__perf.setSearch('')`);
    await waitFor(`window.__perf.listCount() === ${ROWS}`, 120000);

    // 一次性输入：理想路径，只有一次筛选。
    const onceMs = Math.round(
      await page.evaluate(`window.__perf.measureType(${JSON.stringify(TARGET)}, 0, 1)`),
    );
    await page.evaluate(`window.__perf.setSearch('')`);
    await waitFor(`window.__perf.listCount() === ${ROWS}`, 120000);

    // 逐字符输入（50ms 间隔）：真实打字节奏，落在去抖窗口内 → 只筛一次。
    const searchMs = Math.round(
      await page.evaluate(`window.__perf.measureType(${JSON.stringify(TARGET)}, 50, 1)`),
    );
    await page.evaluate(`window.__perf.setSearch('')`);
    await waitFor(`window.__perf.listCount() === ${ROWS}`, 120000);

    // 逐字符输入（250ms 间隔）：间隔大于去抖窗口 → 每次输入都真的筛一次。
    // 这就是"没有去抖"的等价场景，用来量化去抖到底省了多少。
    const slowTypeMs = Math.round(
      await page.evaluate(`window.__perf.measureType(${JSON.stringify(TARGET)}, 250, 1)`),
    );

    // 清空搜索：回到 1000 张
    const clearStart = Date.now();
    await page.evaluate(`window.__perf.setSearch('')`);
    await waitFor(`window.__perf.listCount() === ${ROWS}`, 120000);
    const clearMs = Date.now() - clearStart;

    const errors = page.consoleErrors();
    const report = {
      rows: ROWS,
      previewMs,
      importMs,
      listMs,
      keystrokeMs,
      onceMs,
      searchMs,
      slowTypeMs,
      clearMs,
      debounceWorks,
      nodes,
      consoleErrors: errors,
      at: new Date().toISOString(),
    };
    await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

    console.log(`\n${ROWS} 张卡片 · 真实 Chrome 1280×900\n`);
    console.log(`  CSV 预览                 ${previewMs} ms`);
    console.log(`  CSV 导入落库              ${importMs} ms`);
    console.log(`  列表渲染 ${ROWS} 张          ${listMs} ms`);
    console.log(`  按键延迟（中位数）        ${keystrokeMs === null ? '（找不到搜索框）' : `${keystrokeMs.toFixed(1)} ms`}`);
    console.log(`  搜索·一次性输入           ${onceMs} ms`);
    console.log(`  搜索·逐字符（50ms，去抖内）${searchMs} ms`);
    console.log(`  搜索·逐字符（250ms，等效无去抖）${slowTypeMs} ms`);
    console.log(`  清空搜索回 ${ROWS} 张      ${clearMs} ms`);
    console.log(`  去抖生效                  ${debounceWorks ? '是' : '否（输入后列表立刻变化）'}`);
    console.log(`  DOM 节点总数              ${nodes}`);
    if (errors.length > 0) {
      console.log(`\n  ⚠ console 错误 ${errors.length} 条：`);
      for (const error of errors.slice(0, 5)) {
        console.log(`    ${error}`);
      }
    }
    console.log(`\n报告：${join(OUT, 'report.json')}\n`);

    if (errors.length > 0) {
      process.exit(1);
    }
  } finally {
    if (page !== undefined) {
      await page.close().catch(() => undefined);
    }
    await browser.close().catch(() => undefined);
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
