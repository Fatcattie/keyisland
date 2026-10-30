/**
 * 换机端到端验收（真实 Chrome，跑 dist）。
 *
 * 为什么单测不够：`machine-migration.test.ts` 用两个 `MemoryVaultStorage` 代表两台机器，
 * 验的是**服务层**的合并/覆盖语义。但用户真正走的那条路上还有一堆单测碰不到的东西：
 * 导出到底有没有落成文件、`.kib` 能不能被文件选择框读进来、
 * 覆盖导入之后**主密码到底换没换**（UI 是不是还拿着旧会话）、
 * 换过来的卡片在列表里长什么样。
 *
 * 这里用「清空浏览器存储 + 重新导航」模拟换一台机器——对前端来说，
 * 新机器就是"没有任何本地数据的同一个 origin"。
 *
 * 三个剧本：
 *   A. 整库接管：A 机器导出 `.kib` → B 机器建新库 → 覆盖导入 → 主密码应变成 A 的；
 *   B. 增量并入：导出 `.kia` → C 机器建新库 → 增量导入 → 主密码应仍是 C 的；
 *   C. 密码不对就得拦住：`.kia` 用错主密码时不能导入。
 *
 * 用法：npm run build && npm run e2e:migration
 * 前置：本机有 Chrome / Edge（可用 CHROME_PATH 指定）。
 */

import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { findChrome, launchChrome, openPage, sleep } from './cdp.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const DIST = join(ROOT, 'dist');
const ARTIFACTS = join(ROOT, 'artifacts/e2e');
const DOWNLOADS = join(ARTIFACTS, 'migration-downloads');

/** 三台"机器"各自的主密码，刻意全不相同——换机最容易错的就是"密码没跟着换"。 */
const MASTER_A = 'MachineA!2026';
const MASTER_B = 'MachineB!2026';
const MASTER_C = 'MachineC!2026';
const BACKUP_PW = 'Backup!2026-Aa1';

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

/** 页面内工具。React 受控组件必须走原生 setter + input 事件。 */
const HELPERS = `
window.__mig = {
  setVal(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
  byId(id) { return document.getElementById(id); },
  fill(id, v) { const el = document.getElementById(id); if (!el) return false; window.__mig.setVal(el, v); return true; },
  /** 受控 <select> 要显式派发 change，React 才认。 */
  select(id, v) {
    const el = document.getElementById(id);
    if (!el) return false;
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  click(text) {
    const el = Array.from(document.querySelectorAll('button,[role=button],a,label'))
      .find((node) => (node.innerText || '').trim().includes(text));
    if (!el) return false;
    el.click();
    return true;
  },
  clickExact(text) {
    const el = Array.from(document.querySelectorAll('button,[role=button],a,label'))
      .find((node) => (node.innerText || '').trim() === text);
    if (!el) return false;
    el.click();
    return true;
  },
  has(t) { return (document.body.innerText || '').includes(t); },
  text() { return document.body.innerText || ''; },
  /** 列表里的卡片文本（按 DOM 顺序，整段）。 */
  cardTitles() {
    return Array.from(document.querySelectorAll('[data-testid^="item-card-"]'))
      .map((node) => (node.innerText || '').replace(/\\s+/g, ' ').trim());
  },
  cardCount() { return document.querySelectorAll('[data-testid^="item-card-"]').length; },
  /** 面板里的错误提示文本（带 role=alert 的元素），没有就返回空串。 */
  alertText() {
    const el = document.querySelector('[role=alert]');
    return el ? (el.innerText || '').trim() : '';
  },
  /** 某张卡片上能不能看到这段文字（用来验遮罩是否仍然生效）。 */
  cardHas(title, text) {
    const card = Array.from(document.querySelectorAll('[data-testid^="item-card-"]'))
      .find((node) => (node.innerText || '').includes(title));
    return card ? (card.innerText || '').includes(text) : false;
  },
  /** 唯一那个 type=password 的输入框（解锁页用）。 */
  fillPassword(v) {
    const el = Array.from(document.querySelectorAll('input[type=password]')).find((node) => !node.disabled);
    if (!el) return false;
    window.__mig.setVal(el, v);
    return true;
  },
};
true;
`;

const results = [];
function check(name, pass, extra = '') {
  results.push({ name, pass });
  const mark = pass ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  console.log(`${mark}  ${name}${pass || !extra ? '' : `\n      → ${extra}`}`);
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

  await mkdir(DOWNLOADS, { recursive: true });
  // 上一轮的文件必须清掉，否则"等新文件出现"会立刻命中旧文件。
  for (const name of await readdir(DOWNLOADS)) {
    await rm(join(DOWNLOADS, name), { force: true });
  }

  const { server, port: httpPort } = await serveDist();
  const origin = `http://127.0.0.1:${httpPort}`;
  const browser = await launchChrome({ chromePath, port: 9337 });
  let page;

  /** 等到页面上出现某段文案；超时返回 false。 */
  const waitForText = async (text, timeoutMs = 30000) => {
    const started = Date.now();
    for (;;) {
      if (await page.evaluate(`window.__mig.has(${JSON.stringify(text)})`)) {
        return true;
      }
      if (Date.now() - started >= timeoutMs) {
        return false;
      }
      await sleep(200);
    }
  };

  /** 等到列表里出现 N 张卡。 */
  const waitForCards = async (count, timeoutMs = 30000) => {
    const started = Date.now();
    for (;;) {
      if ((await page.evaluate('window.__mig.cardCount()')) >= count) {
        return true;
      }
      if (Date.now() - started >= timeoutMs) {
        return false;
      }
      await sleep(200);
    }
  };

  /**
   * 等下载目录里出现一个指定后缀的文件，并读出内容。
   *
   * 为什么要等：`downloadTextFile` 是 Blob + `<a download>`，文件由浏览器异步落盘，
   * 点完按钮那一刻文件还不存在。直接读会读到"没有文件"。
   */
  const waitForDownload = async (suffix, timeoutMs = 20000) => {
    const started = Date.now();
    for (;;) {
      const files = (await readdir(DOWNLOADS)).filter((name) => name.endsWith(suffix));
      for (const name of files) {
        const path = join(DOWNLOADS, name);
        const info = await stat(path);
        // 大小稳定才算写完（Chrome 会先建文件再写内容）。
        if (info.size > 0) {
          await sleep(150);
          const again = await stat(path);
          if (again.size === info.size) {
            return { name, path, text: await readFile(path, 'utf8') };
          }
        }
      }
      if (Date.now() - started >= timeoutMs) {
        return null;
      }
      await sleep(200);
    }
  };

  /** 清空本站数据并重新导航——这就是"换一台机器"。 */
  const switchMachine = async () => {
    await page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await page.send('Page.navigate', { url: origin });
    await sleep(1500);
    await page.evaluate(HELPERS);
  };

  /** 走完首次设置三步向导。 */
  const createVault = async (master) => {
    await page.evaluate(`window.__mig.fill('setup-password', ${JSON.stringify(master)})`);
    // 向导第一步可能没有 id：退化成"填前两个输入框"。
    await page.evaluate(`(() => {
      const inputs = Array.from(document.querySelectorAll('input[type=password]')).filter((el) => !el.disabled);
      if (inputs.length >= 2) {
        window.__mig.setVal(inputs[0], ${JSON.stringify(master)});
        window.__mig.setVal(inputs[1], ${JSON.stringify(master)});
      }
    })()`);
    await sleep(250);
    await page.evaluate(`window.__mig.click('下一步')`);
    await sleep(900);
    await page.evaluate(`window.__mig.click('创建保险库')`);
    const ready = await waitForText('恢复码');
    if (!ready) {
      return false;
    }
    await page.evaluate(
      `(() => { const cb = document.querySelector('input[type=checkbox]'); if (cb) cb.click(); })()`,
    );
    await sleep(300);
    await page.evaluate(`window.__mig.click('进入密岛')`);
    return waitForText('新建卡片', 30000);
  };

  /** 新建一张卡片（走真实编辑器）。 */
  const addCard = async ({ title, username, password, tags, notes, visibility }) => {
    await page.evaluate(`window.__mig.clickExact('新建卡片')`);
    await sleep(600);
    await page.evaluate(`window.__mig.fill('editor-title', ${JSON.stringify(title)})`);
    await page.evaluate(`window.__mig.fill('editor-username', ${JSON.stringify(username)})`);
    await page.evaluate(`window.__mig.fill('editor-password', ${JSON.stringify(password)})`);
    if (tags !== undefined) {
      await page.evaluate(`window.__mig.fill('editor-tags', ${JSON.stringify(tags)})`);
    }
    if (notes !== undefined) {
      await page.evaluate(`window.__mig.fill('editor-notes', ${JSON.stringify(notes)})`);
    }
    if (visibility !== undefined) {
      await page.evaluate(`window.__mig.select('editor-visibility', ${JSON.stringify(visibility)})`);
      await sleep(150);
    }
    await page.evaluate(`window.__mig.clickExact('保存')`);
    return waitForText(title, 20000);
  };

  /** 解锁：填密码 → 点「解锁」。 */
  const unlock = async (password) => {
    await page.evaluate(`window.__mig.fillPassword(${JSON.stringify(password)})`);
    await sleep(200);
    await page.evaluate(`window.__mig.clickExact('解锁')`);
    await sleep(1200);
  };

  try {
    page = await openPage({ port: browser.port, url: origin });
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // 让下载落到指定目录（无头模式下不设这个，<a download> 会静默什么都不做）。
    await page.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOADS,
      eventsEnabled: true,
    });

    // ═══════════════════════════════════════════════════════════════
    // 机器 A：建库 → 建卡 → 导出 .kib
    // ═══════════════════════════════════════════════════════════════
    console.log('\n── 机器 A：建库、建卡、导出整库备份 ──');
    await switchMachine();
    check('A：建库完成（三步向导走通）', await createVault(MASTER_A));

    check(
      'A：新建普通卡片',
      await addCard({
        title: 'GitHub',
        username: 'octo@example.test',
        password: 'Pass-A1!',
        tags: '工作,常用',
        notes: '公司主账号',
      }),
    );
    check(
      'A：新建遮罩卡片',
      await addCard({
        title: 'BankCard',
        username: 'holder@example.test',
        password: 'Pass-A2!',
        visibility: 'masked',
      }),
    );
    const aCards = await page.evaluate('window.__mig.cardCount()');
    check('A：列表里有 2 张卡', aCards === 2, `实际 ${aCards}`);

    await page.evaluate(`window.__mig.clickExact('设置')`);
    check('A：打开设置面板', await waitForText('备份与恢复'));
    await page.evaluate(`window.__mig.click('导出完整备份')`);
    await sleep(400);
    await page.evaluate(`window.__mig.fill('settings-backup-password', ${JSON.stringify(BACKUP_PW)})`);
    await sleep(200);
    await page.evaluate(`window.__mig.click('导出 .kib 文件')`);
    const kib = await waitForDownload('.kib');
    check('A：导出的 .kib 真的落盘了', kib !== null, kib === null ? '下载目录里没有 .kib' : '');
    check(
      'A：备份文件是 KIB1 格式',
      kib !== null && kib.text.includes('"KIB1"'),
      kib === null ? '' : kib.text.slice(0, 60),
    );
    if (kib !== null) {
      await writeFile(join(ARTIFACTS, 'migration-backup.kib'), kib.text, 'utf8');
    }

    // ═══════════════════════════════════════════════════════════════
    // 机器 B：新机器 + 覆盖导入（整库接管）
    // ═══════════════════════════════════════════════════════════════
    console.log('\n── 机器 B：新机器 → 覆盖导入 → 主密码应换成 A 的 ──');
    await switchMachine();
    check('B：新机器建库完成', await createVault(MASTER_B));
    check('B：新库里没有卡片', (await page.evaluate('window.__mig.cardCount()')) === 0);

    await page.evaluate(`window.__mig.clickExact('设置')`);
    await waitForText('备份与恢复');
    await page.evaluate(`window.__mig.click('导入完整备份')`);
    await sleep(400);

    // 走文件选择框（真实用户的路径），而不是粘贴。
    if (kib !== null) {
      await page.send('DOM.enable');
      const doc = await page.send('DOM.getDocument', { depth: -1 });
      const node = await page.send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: '#settings-backup-file',
      });
      await page.send('DOM.setFileInputFiles', { files: [kib.path], nodeId: node.nodeId });
      await sleep(600);
      const filled = await page.evaluate(
        `(window.__mig.byId('settings-backup-text') || {}).value?.length ?? 0`,
      );
      check('B：选文件后内容进了粘贴区', filled > 100, `粘贴区长度 ${filled}`);
    }

    await page.evaluate(`window.__mig.fill('settings-import-password', ${JSON.stringify(BACKUP_PW)})`);
    await page.evaluate(`window.__mig.select('settings-import-mode', 'overwrite')`);
    await sleep(400);
    await page.evaluate(`window.__mig.fill('settings-import-confirm', '覆盖')`);
    await page.evaluate(`window.__mig.fill('settings-import-master', ${JSON.stringify(MASTER_B)})`);
    await sleep(300);
    await page.evaluate(`window.__mig.click('开始导入')`);
    await sleep(2500);

    // 覆盖导入会替换密钥槽，所以必然回到锁定态。
    check('B：导入后回到锁定态（要求重新解锁）', await waitForText('解锁', 20000));

    await unlock(MASTER_B);
    check(
      'B：用 B 自己的旧主密码解不开（密钥槽确实被替换了）',
      await waitForText('主密码不正确', 20000),
    );

    await unlock(MASTER_A);
    const unlocked = await waitForCards(2, 30000);
    check('B：用 A 的主密码解锁成功，卡片回来了', unlocked);

    const titles = await page.evaluate('window.__mig.cardTitles()');
    check(
      'B：两张卡的标题都在',
      titles.some((t) => t.includes('GitHub')) && titles.some((t) => t.includes('BankCard')),
      JSON.stringify(titles),
    );
    check(
      'B：账号跟着搬过来了',
      await page.evaluate(`window.__mig.cardHas('GitHub', 'octo@example.test')`),
    );
    check(
      'B：遮罩卡仍然是遮罩的（账号不该明文可见）',
      (await page.evaluate(`window.__mig.cardHas('BankCard', 'holder@example.test')`)) === false,
    );

    // ═══════════════════════════════════════════════════════════════
    // 机器 C：增量并入（.kia）——主密码不该被换掉
    // ═══════════════════════════════════════════════════════════════
    console.log('\n── 机器 C：.kia 增量并入 → 主密码应仍是 C 的 ──');
    await page.evaluate(`window.__mig.clickExact('设置')`);
    await waitForText('备份与恢复');
    await page.evaluate(`window.__mig.click('资产批量迁移')`);
    await sleep(400);
    await page.evaluate(`window.__mig.fill('settings-bundle-export-password', ${JSON.stringify(MASTER_A)})`);
    await sleep(200);
    await page.evaluate(`window.__mig.click('导出加密资产包')`);
    const kia = await waitForDownload('.kia');
    check('C：导出的 .kia 真的落盘了', kia !== null);
    if (kia !== null) {
      await writeFile(join(ARTIFACTS, 'migration-assets.kia'), kia.text, 'utf8');
    }

    await switchMachine();
    check('C：新机器建库完成', await createVault(MASTER_C));
    await page.evaluate(`window.__mig.clickExact('设置')`);
    await waitForText('备份与恢复');
    await page.evaluate(`window.__mig.click('资产批量迁移')`);
    await sleep(400);
    if (kia !== null) {
      await page.send('DOM.enable');
      const doc = await page.send('DOM.getDocument', { depth: -1 });
      const node = await page.send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: '#settings-bundle-file',
      });
      await page.send('DOM.setFileInputFiles', { files: [kia.path], nodeId: node.nodeId });
      await sleep(700);
    }
    // 先用错密码试一次：不能悄悄导进去。
    // 判据不写死文案（错误措辞会变），只认两件事：**没有出现预览结果**，且有错误提示。
    await page.evaluate(`window.__mig.fill('settings-bundle-import-password', ${JSON.stringify(MASTER_C)})`);
    await sleep(200);
    await page.evaluate(`window.__mig.click('预览导入结果')`);
    await sleep(1500);
    const wrongAlert = await page.evaluate('window.__mig.alertText()');
    const wrongPreviewed = await page.evaluate(`window.__mig.has('预计新增')`);
    check(
      'C：用错主密码预览会被拦住（不出现预览结果 + 有错误提示）',
      wrongPreviewed === false && wrongAlert.length > 0,
      `预览出现=${wrongPreviewed}，提示="${wrongAlert}"`,
    );

    await page.evaluate(`window.__mig.fill('settings-bundle-import-password', ${JSON.stringify(MASTER_A)})`);
    await sleep(300);
    await page.evaluate(`window.__mig.click('预览导入结果')`);
    const previewed = await waitForText('预计新增', 20000);
    check('C：正确密码下能看到预览', previewed);
    await page.evaluate(`window.__mig.click('确认增量导入')`);
    await sleep(2000);
    await page.evaluate(`window.__mig.clickExact('关闭')`);
    check('C：卡片并进来了', await waitForCards(2, 30000));

    // 关键：增量并入不动密钥槽，C 的主密码必须还能用。
    await page.evaluate(`window.__mig.clickExact('锁定')`);
    await waitForText('解锁', 20000);
    await unlock(MASTER_C);
    check(
      'C：主密码仍是 C 的（增量导入没有替换密钥槽）',
      await waitForCards(2, 30000),
    );

    const errors = page.consoleErrors();
    check('全程无 console 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

    const passed = results.filter((item) => item.pass).length;
    console.log(`\n结果：${passed}/${results.length} 通过\n`);
    if (passed !== results.length) {
      process.exitCode = 1;
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
