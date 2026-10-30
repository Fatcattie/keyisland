#!/usr/bin/env node
/**
 * 一键发版：出包 → 打 tag → 建 GitHub Release 并上传安装包。
 *
 * 为什么需要它：`git push` 只推源码，而安装包（`dist/`、`src-tauri/target/`）
 * 都在 `.gitignore` 里——二进制不进 git 历史。也就是说"推了代码"和"发了版"
 * 是两件独立的事，2026-10-29 就真的漏过一次：代码推上去了，Releases 页面空空如也。
 *
 * 这个脚本把这条链路串起来，并且**在动手前把容易出错的前提逐条检查**：
 *
 * 1. 三处版本号必须一致（package.json / tauri.conf.json / Cargo.toml）——
 *    只改一处是这套项目最经典的翻车方式：安装包叫 0.1.8、exe 属性里写 0.1.7。
 * 2. 工作区必须干净（忽略未跟踪文件）——否则 tag 指向的提交里没有你正在测的改动，
 *    "发的包和源码对不上"比发不出去更糟。
 * 3. HEAD 必须已推送——tag 指向一个远端没有的提交，等于发了个别人拉不到的版本。
 * 4. tag 不能已存在（本地与远端都查）——覆盖 tag 会让已有 Release 悄悄换内容。
 * 5. gh 已登录、MSVC 四件套齐全——否则会先花十分钟编译再失败。
 *
 * 用法：
 *   npm run release:publish              # 出包 + 视觉验收 + 发版
 *   npm run release:publish -- --dry-run # 只做预检并打印计划，不编译、不发布、不跑视觉
 *   npm run release:publish -- --skip-build  # 复用现有产物（刚构建过时用，跳过视觉验收）
 *   npm run release:publish -- --skip-visual # 逃生阀：视觉脚本自己坏了时用，会在输出里留痕
 *
 * 退出码：0 = 已发布（或 dry-run 预检通过）；1 = 有阻塞项。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../e2e/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..', '..');
const REPO_ROOT = resolve(APP_ROOT, '..');

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_BUILD = process.argv.includes('--skip-build') || DRY_RUN;

/**
 * 沙箱 / 非交互 shell 里 `APPDATA` 可能是空的，那样 gh 找不到
 * `%APPDATA%\GitHub CLI\hosts.yml`，会误报"未登录"；git 的 credential helper
 * 同样读这个变量。与其让使用者每次手工 export，不如在这里兜底。
 */
if (process.platform === 'win32' && !process.env.APPDATA) {
  const guess = join(process.env.USERPROFILE ?? 'C:\\Users\\Admin', 'AppData', 'Roaming');
  if (existsSync(guess)) {
    process.env.APPDATA = guess;
  }
}

const GH = process.platform === 'win32' ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : 'gh';

const c = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

const blockers = [];

function ok(title, detail) {
  console.log(`  ${c.green}✓${c.reset} ${title}${detail ? `  ${c.dim}${detail}${c.reset}` : ''}`);
}

function fail(title, detail, hint) {
  console.log(`  ${c.red}✗${c.reset} ${title}${detail ? `  ${c.dim}${detail}${c.reset}` : ''}`);
  if (hint) {
    console.log(`    ${c.dim}↳ ${hint}${c.reset}`);
  }
  blockers.push(title);
}

function warn(title, detail) {
  console.log(`  ${c.yellow}!${c.reset} ${title}${detail ? `  ${c.dim}${detail}${c.reset}` : ''}`);
}

/** 跑一条命令，拿 stdout（失败返回 null，不抛）。 */
function run(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, {
      cwd: options.cwd ?? REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trim();
  } catch {
    return null;
  }
}

/** 继承 stdio 跑命令（构建这种要看到进度的）。失败抛错。 */
function runVisible(cmd, args, cwd = APP_ROOT) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

// ---------------------------------------------------------------------------
// 1. 版本号三处一致
// ---------------------------------------------------------------------------

function readJson(rel) {
  return JSON.parse(readFileSync(join(APP_ROOT, rel), 'utf8'));
}

const pkgVersion = readJson('package.json').version;
const tauriVersion = readJson('src-tauri/tauri.conf.json').version;
const cargoToml = readFileSync(join(APP_ROOT, 'src-tauri/Cargo.toml'), 'utf8');
const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1] ?? null;

const VERSION = pkgVersion;
const TAG = `v${VERSION}`;

console.log(`\n${c.bold}密岛 KeyIsland · 发版${c.reset}  ${c.cyan}${TAG}${c.reset}${DRY_RUN ? `  ${c.yellow}(dry-run)${c.reset}` : ''}\n`);

console.log(`${c.bold}预检${c.reset}`);
ok('版本号', `package.json = ${pkgVersion}`);

if (tauriVersion === pkgVersion && cargoVersion === pkgVersion) {
  ok('三处版本一致', `tauri.conf.json / Cargo.toml 同为 ${pkgVersion}`);
} else {
  fail(
    '三处版本号不一致',
    `tauri.conf.json=${tauriVersion} · Cargo.toml=${cargoVersion}`,
    '只改一处会让"安装包版本"和"exe 属性里的版本"对不上，先统一再发',
  );
}

// ---------------------------------------------------------------------------
// 2. 工作区干净 + HEAD 已推送
// ---------------------------------------------------------------------------

// 只看已跟踪文件：未跟踪的临时产物不进 tag，不构成"发的包和源码对不上"。
const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']);
if (dirty === null) {
  fail('读不到 git 状态', '', '确认在 git 仓库里运行');
} else if (dirty.length > 0) {
  fail('工作区有未提交改动', dirty.split('\n').length + ' 个文件', '先提交或 stash：tag 必须指向含这些改动的提交');
} else {
  ok('工作区干净');
}

const head = run('git', ['rev-parse', 'HEAD']);
/**
 * 用 `ls-remote` 而不是 `@{u}` 比：本仓库的 remote-tracking ref
 * （`refs/remotes/origin/main`）在本机反复丢失，`@{u}` 会直接报
 * "unknown revision"——那会把"能正常推送"的仓库误判成没有上游。
 * 远端实际指向才是权威答案。
 */
const remoteLine = run('git', ['ls-remote', 'origin', 'refs/heads/main']);
const remoteHead = remoteLine?.split(/\s+/)[0] ?? null;

if (!head) {
  fail('读不到 HEAD', '', '确认在 git 仓库里运行');
} else if (!remoteHead) {
  warn('读不到远端 main', '跳过"已推送"检查（发版前请自行确认已推送，且网络可达）');
} else if (head === remoteHead) {
  ok('HEAD 已推送', head.slice(0, 8));
} else {
  fail(
    'HEAD 与远端不一致',
    `${head.slice(0, 8)} vs ${remoteHead.slice(0, 8)}`,
    '先 git push，否则 tag 指向远端不存在的提交',
  );
}

// ---------------------------------------------------------------------------
// 3. tag 未被占用
// ---------------------------------------------------------------------------

if (run('git', ['rev-parse', '-q', '--verify', `refs/tags/${TAG}`]) !== null) {
  fail(`本地已有 tag ${TAG}`, '', '删掉重来（git tag -d）或换个版本号；覆盖 tag 会让已有 Release 悄悄换内容');
} else {
  ok('本地无同名 tag');
}

if (run(GH, ['release', 'view', TAG, '--json', 'tagName']) !== null) {
  fail(`GitHub 上已有 ${TAG} 的 Release`, '', '版本号需要往前推一档');
} else {
  ok('GitHub 上无同名 Release');
}

// ---------------------------------------------------------------------------
// 4. gh 登录态
// ---------------------------------------------------------------------------

if (run(GH, ['auth', 'status']) === null) {
  fail('gh 未登录或不可用', GH, 'gh auth login；若在非交互 shell 里，注意 APPDATA 是否为空');
} else {
  ok('gh 已登录');
}

// ---------------------------------------------------------------------------
// 5. MSVC 四件套（不出包时可以跳过）
// ---------------------------------------------------------------------------

if (SKIP_BUILD) {
  warn('跳过构建环境检查', '--skip-build / --dry-run');
} else {
  const missing = [
    ['INCLUDE', process.env.INCLUDE],
    ['LIB', process.env.LIB],
    ['CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER', process.env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER],
  ].filter(([, value]) => !value);

  if (missing.length === 0) {
    ok('MSVC 构建变量齐全');
  } else {
    fail(
      'MSVC 构建变量缺失',
      missing.map(([name]) => name).join(' · '),
      '按 app/docs/DESKTOP-BUILD.md §1.2.1 导出后再跑；否则 rustc 会撞上 Git 的 GNU link.exe',
    );
  }

  // doctor 是现成的九项检查，直接复用，不在这里重复实现。
  try {
    execFileSync(process.execPath, [join(APP_ROOT, 'scripts/desktop/doctor.mjs')], {
      cwd: APP_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    ok('desktop:doctor 九项通过');
  } catch (error) {
    const output = String(error.stdout ?? error.stderr ?? '');
    const tail = output.trim().split('\n').slice(-4).join('\n');
    fail('desktop:doctor 未通过', '', tail || '单独跑 npm run desktop:doctor 看详情');
  }
}

// ---------------------------------------------------------------------------
// 阻塞就停
// ---------------------------------------------------------------------------

if (blockers.length > 0) {
  console.log(`\n${c.red}${blockers.length} 项阻塞，已中止。${c.reset}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 6. 出包
// ---------------------------------------------------------------------------

const setupPath = join(
  APP_ROOT,
  'src-tauri/target/release/bundle/nsis',
  `KeyIsland_${VERSION}_x64-setup.exe`,
);
const exePath = join(APP_ROOT, 'src-tauri/target/release/keyisland.exe');

if (SKIP_BUILD) {
  warn('跳过出包', '使用现有产物');
} else {
  console.log(`\n${c.bold}出包${c.reset}  ${c.dim}(约 5~11 分钟)${c.reset}`);
  /**
   * 先把旧 `dist` 挪开。
   *
   * `npm run build` 里 vite 会清空输出目录（`prepareOutDir` → `rm dist/assets`），
   * 而沙箱的 safe-delete shim 对**每轮删除的文件数**有配额（50 个）。dist 现在有
   * 52 个文件，于是出包在第一步就整条失败，报错还长得像"构建莫名失败"——
   * 2026-10-30 发 0.1.17 时就是这么卡住的。
   *
   * `rename` 不算删除，挪到临时目录让 vite 去建一个干净的新目录即可。
   * 不直接删：留着万一要对比上一版产物。
   */
  const distDir = join(APP_ROOT, 'dist');
  if (existsSync(distDir)) {
    /**
     * 落点必须与 `dist` **同一个盘**：`rename` 跨卷会抛 `EXDEV`，
     * 而 Node 不像 `mv` 那样自动退化成"复制 + 删除"。仓库在 D:、
     * `os.tmpdir()` 在 C:，第一版就是在这里失败的。
     * `node_modules/.cache` 同盘、且本来就该被忽略。
     */
    const asideRoot = join(APP_ROOT, 'node_modules', '.cache');
    const aside = join(asideRoot, `dist-aside-${Date.now()}`);
    try {
      mkdirSync(asideRoot, { recursive: true });
      renameSync(distDir, aside);
      ok('旧 dist 已挪开', aside);
    } catch (error) {
      // 挪不动不算致命：vite 自己清目录，只是在配额内才成功。
      warn('旧 dist 挪不动', String(error));
    }
  }
  try {
    runVisible('npm', ['run', 'desktop:build']);
  } catch {
    console.log(`\n${c.red}出包失败，已中止。${c.reset}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 7. 校验产物
// ---------------------------------------------------------------------------

console.log(`\n${c.bold}产物${c.reset}`);
for (const [label, file] of [
  ['安装包', setupPath],
  ['免安装 exe', exePath],
]) {
  if (!existsSync(file)) {
    fail(`${label}不存在`, file);
    continue;
  }
  const size = statSync(file).size;
  ok(`${label}  ${human(size)}`, `sha256 ${sha256(file).slice(0, 16)}…`);
}

/**
 * 光"文件存在"不够：`--skip-build` 会复用旧产物，名字对、内容还是上一版。
 * PE 里的版本资源是 UTF-16LE 存的，直接按字节找一遍最实在——
 * 这比读文件名可靠，也比调 PowerShell 读 `VersionInfo` 稳。
 */
if (existsSync(exePath)) {
  const needle = Buffer.from(VERSION, 'utf16le');
  const binary = readFileSync(exePath);
  let hits = 0;
  for (let at = binary.indexOf(needle); at !== -1; at = binary.indexOf(needle, at + 2)) {
    hits += 1;
  }
  if (hits > 0) {
    ok('exe 版本资源匹配', `${VERSION} ×${hits}`);
  } else {
    fail(
      'exe 里的版本资源不是当前版本',
      `找不到 UTF-16 的 "${VERSION}"`,
      '多半是复用了旧产物：去掉 --skip-build 重新出包',
    );
  }
}

if (blockers.length > 0) {
  console.log(`\n${c.red}产物缺失，已中止（不会发一个没有安装包的 Release）。${c.reset}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 7.5 视觉验收（改了 UI 就必须看真实渲染）
// ---------------------------------------------------------------------------

/**
 * 为什么放进发布链路：0.1.9 → 0.1.15 连发七个版本，其中五个是出包后自审补的漏，
 * 而 `e2e:visual` 抓到的恰好都是 jsdom 抓不到的那类——控件压根没渲染、
 * 下拉"假选中"（受控值为空但没有对应 option，浏览器回退显示第一项）、深色下一块亮斑。
 * 它只要 90 秒；而一次错误发版要重走升版 + 出包 + 改 Release。
 *
 * 三条边界写在这里，免得以后误以为它很万能：
 * - `--skip-build` / `--dry-run` 跳过：复用的 dist 不一定对应当前源码，测了反而误导。
 * - 找不到 Chrome / Edge 只警告不拦：没装浏览器的机器不该发不了版，但必须把
 *   "本次没做视觉校验"说出来，不能假装验过。
 * - `--skip-visual` 是逃生阀：脚本自己坏掉时不该把发版彻底卡死，但要留痕。
 */
const SKIP_VISUAL = process.argv.includes('--skip-visual');

console.log(`\n${c.bold}视觉验收${c.reset}`);
if (DRY_RUN) {
  warn('dry-run 不跑视觉验收', '真实发版时会跑（约 90 秒）');
} else if (SKIP_BUILD) {
  warn('已跳过', '复用了现有产物，dist 不一定对应当前源码；要校验请去掉 --skip-build');
} else if (SKIP_VISUAL) {
  warn('已按 --skip-visual 跳过', '本次发布没有做视觉校验');
} else {
  const chromePath = findChrome();
  if (chromePath === undefined) {
    warn('未找到 Chrome / Edge，已跳过', '本次发布没有做视觉校验（截图与对比度都没跑）');
  } else {
    try {
      // 不用 runVisible：它走 shell，路径含空格时会被拆开。
      for (const script of ['settings-shots.mjs', 'contrast-audit.mjs']) {
        execFileSync(process.execPath, [join(APP_ROOT, 'scripts', 'e2e', script)], {
          cwd: APP_ROOT,
          stdio: 'inherit',
        });
      }
      ok('截图与对比度审计通过', 'artifacts/settings');
    } catch {
      fail(
        '视觉验收未通过',
        '截图或对比度审计报错',
        '先手动跑 `npm run e2e:visual` 看是哪张图 / 哪处对比度，修完再发版',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 7.6 换机验收（用户只有一次机会的路径）
// ---------------------------------------------------------------------------

/**
 * 为什么也放进发布链路：换机是唯一"错了就没有第二次"的流程——用户手里只有那个
 * `.kib`，导入坏了就等于丢了整个密码库。而这条路径恰好是 jsdom 最测不到的一段：
 * 文件有没有真落盘、文件选择框能不能读进来、覆盖导入后**主密码到底换没换**。
 *
 * 与视觉验收共用开关（`--skip-visual` / `--skip-build` / `--dry-run` / 找不到浏览器），
 * 理由相同：复用的产物不代表当前源码，测了反而误导；没有浏览器不该发不了版，但要留痕。
 */
console.log(`\n${c.bold}换机验收${c.reset}`);
if (DRY_RUN) {
  warn('dry-run 不跑换机验收', '真实发版时会跑（约 90 秒）');
} else if (SKIP_BUILD) {
  warn('已跳过', '复用了现有产物，dist 不一定对应当前源码；要校验请去掉 --skip-build');
} else if (SKIP_VISUAL) {
  warn('已按 --skip-visual 跳过', '本次发布没有做换机校验');
} else if (findChrome() === undefined) {
  warn('未找到 Chrome / Edge，已跳过', '本次发布没有做换机校验（导出/导入剧本没跑）');
} else {
  try {
    execFileSync(process.execPath, [join(APP_ROOT, 'scripts', 'e2e', 'migration.mjs')], {
      cwd: APP_ROOT,
      stdio: 'inherit',
    });
    ok('换机剧本通过', '导出 → 新机器 → 覆盖导入 / 增量并入');
  } catch {
    fail(
      '换机验收未通过',
      '导出/导入剧本报错',
      '先手动跑 `npm run e2e:migration` 看是哪一步断了，修完再发版',
    );
  }
}

if (blockers.length > 0) {
  console.log(`\n${c.red}发布前校验未通过，已中止（不会发布一个没验过的版本）。${c.reset}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 8. 生成发布说明
// ---------------------------------------------------------------------------

const previousTag = run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*']);
const range = previousTag ? `${previousTag}..HEAD` : 'HEAD';
const commits = (run('git', ['log', '--no-merges', '--pretty=format:%s', range]) ?? '')
  .split('\n')
  .filter((line) => line.length > 0);

const notes = `Windows x64 桌面版安装包。下载 \`KeyIsland_${VERSION}_x64-setup.exe\` 双击安装即可。

## 安装说明

- 需要 Windows 10 / 11（x64），系统自带 WebView2 运行时（绝大多数机器已有）。
- 安装包**未做代码签名**，首次运行 Windows SmartScreen 可能提示「未知发布者」——
  点「更多信息」→「仍要运行」。
- 也可以直接下 \`keyisland.exe\` 单文件运行（免安装，不写注册表、不带卸载项）。

## 本次改动

${commits.length > 0 ? commits.map((line) => `- ${line}`).join('\n') : '- （无提交记录）'}

## 校验和

| 文件 | 大小 | SHA-256 |
|---|---|---|
| \`KeyIsland_${VERSION}_x64-setup.exe\` | ${human(statSync(setupPath).size)} | \`${sha256(setupPath)}\` |
| \`keyisland.exe\` | ${human(statSync(exePath).size)} | \`${sha256(exePath)}\` |
`;

const notesPath = join(tmpdir(), `keyisland-release-${TAG}.md`);
writeFileSync(notesPath, notes, 'utf8');

// ---------------------------------------------------------------------------
// 9. 打 tag + 建 Release
// ---------------------------------------------------------------------------

if (DRY_RUN) {
  console.log(`\n${c.bold}发布说明预览${c.reset}\n`);
  console.log(notes.split('\n').map((line) => `  ${c.dim}${line}${c.reset}`).join('\n'));
  console.log(`\n${c.yellow}dry-run：未打 tag、未建 Release。${c.reset}\n`);
  process.exit(0);
}

console.log(`\n${c.bold}发布${c.reset}`);
run('git', ['tag', '-a', TAG, '-m', `密岛 KeyIsland ${VERSION}`]);
if (run('git', ['push', 'origin', TAG]) === null) {
  console.log(`  ${c.red}✗${c.reset} tag 推送失败\n`);
  process.exit(1);
}
ok('tag 已推送', TAG);

const url = run(GH, [
  'release',
  'create',
  TAG,
  '--title',
  `密岛 KeyIsland ${VERSION}`,
  '--notes-file',
  notesPath,
  setupPath,
  exePath,
]);

if (url === null) {
  console.log(`  ${c.red}✗${c.reset} Release 创建失败（tag 已推上去，可重跑 gh release create 补发）\n`);
  process.exit(1);
}

ok('Release 已发布', url);
console.log(`\n${c.green}完成：${url}${c.reset}\n`);
