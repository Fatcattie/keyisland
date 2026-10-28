#!/usr/bin/env node
/**
 * 桌面版构建预检（doctor）。
 *
 * 为什么需要它：Tauri 出包依赖四样本机环境（Rust 工具链、MSVC 链接器、
 * WebView2 运行时、前端产物），缺任何一样都会在 `tauri build` 的最后阶段炸掉。
 * 而那个阶段前面已经编译了十几分钟 Rust——报错信息还常常是
 * "program not found" 这种看不出所以然的英文。
 *
 * 这个脚本在动手前把它们逐条列清楚：缺什么、去哪装、装完怎么验。
 *
 * 用法：
 *   npm run desktop:doctor
 *   npm run desktop:doctor -- --json     # 机器可读
 *
 * 退出码：0 = 可以出包；1 = 有阻塞项。
 *
 * 注意：这里**只读**环境，不装任何东西、不改任何文件。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..', '..');
const TAURI_ROOT = join(APP_ROOT, 'src-tauri');

const JSON_MODE = process.argv.includes('--json');
const NO_COLOR = process.argv.includes('--no-color') || !process.stdout.isTTY || JSON_MODE;

const c = {
  reset: NO_COLOR ? '' : '\u001b[0m',
  dim: NO_COLOR ? '' : '\u001b[2m',
  bold: NO_COLOR ? '' : '\u001b[1m',
  red: NO_COLOR ? '' : '\u001b[31m',
  green: NO_COLOR ? '' : '\u001b[32m',
  yellow: NO_COLOR ? '' : '\u001b[33m',
  cyan: NO_COLOR ? '' : '\u001b[36m',
};

/** 状态：ok / warn / fail。只有 fail 会把退出码变成 1。 */
const results = [];

function record(status, title, detail, hint) {
  results.push({ status, title, detail, hint: hint ?? null });
}

/**
 * 跑一个命令并拿到 stdout。
 *
 * 刻意不用 shell：`execFileSync` 直接 exec，避免 Windows 上 `cmd /c` 那层
 * 引号与路径转义带来的假失败（doctor 自己误报比不报更糟）。
 */
function run(file, args = [], { timeout = 15000 } = {}) {
  try {
    const stdout = execFileSync(file, args, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: stdout.trim() };
  } catch (error) {
    return { ok: false, out: (error.stdout ?? '').trim(), error };
  }
}

function firstLine(text) {
  return (text ?? '').split(/\r?\n/)[0].trim();
}

// ---------------------------------------------------------------------------
// 1. Node
// ---------------------------------------------------------------------------
function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) {
    record('ok', 'Node 运行时', `v${process.versions.node}`);
  } else {
    record('fail', 'Node 运行时', `v${process.versions.node} 过低`, '升级到 Node 18+（Vite 5 要求）');
  }
}

// ---------------------------------------------------------------------------
// 2. Rust 工具链
// ---------------------------------------------------------------------------
function checkRust() {
  // rustup 装到 ~/.cargo/bin，但新开的终端才刷新 PATH。
  // 所以先按 PATH 找，找不到再按默认安装位置找——避免"明明装了却报没有"。
  //
  // 第三个地方也要找：`~/.rustup/toolchains/<tc>/bin/`。rustup 在 `~/.cargo/bin`
  // 里放的是**硬链接**，硬链接建不出来（杀软拦截、文件系统不支持、权限不足）时
  // 那里会留下一堆 0 字节空壳，而真身完好无损地在 toolchains 下面。
  // 只看 shim 目录就会得出"没装 Rust"的错误结论。
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const shimDir = join(home, '.cargo', 'bin');
  const toolchainsDir = join(home, '.rustup', 'toolchains');
  const exeName = process.platform === 'win32' ? '.exe' : '';

  const candidates = (name) => {
    const list = [name];
    const shim = join(shimDir, `${name}${exeName}`);
    if (existsSync(shim)) list.push(shim);
    if (existsSync(toolchainsDir)) {
      const toolchains = readdirSync(toolchainsDir).sort((a, b) => {
        // 默认工具链优先：多版本共存时不该随便挑一个。
        const rank = (value) => (value.startsWith('stable') ? 0 : 1);
        return rank(a) - rank(b) || a.localeCompare(b);
      });
      for (const toolchain of toolchains) {
        const exe = join(toolchainsDir, toolchain, 'bin', `${name}${exeName}`);
        if (existsSync(exe)) list.push(exe);
      }
    }
    return list;
  };

  const probe = (name) => {
    for (const file of candidates(name)) {
      const result = run(file, ['--version']);
      if (result.ok) {
        // 只有裸名字走 PATH 才算"在 PATH 里"；其它都是绝对路径回退。
        return { ...result, exe: file, onPath: file === name };
      }
    }
    return { ok: false, out: '', exe: null, onPath: false };
  };

  const rustc = probe('rustc');
  const cargo = probe('cargo');

  if (!rustc.ok || !cargo.ok) {
    // 分开报：只缺 cargo 时如果说"未找到 rustc / cargo"，用户会去重装 rustc，
    // 而真正缺的那个还是缺着。
    const missing = [!rustc.ok && 'rustc', !cargo.ok && 'cargo'].filter(Boolean).join(' / ');
    record(
      'fail',
      'Rust 工具链',
      `未找到 ${missing}`,
      '安装 rustup：https://rustup.rs/ （Windows 选默认的 x86_64-pc-windows-msvc）',
    );
    return;
  }

  // 用解析出来的真实路径跑 -vV：从 toolchains 回退找到时，裸 `rustc` 根本不在 PATH 上。
  const verbose = run(rustc.exe, ['-vV']);
  const hostLine = (verbose.out ?? '').split(/\r?\n/).find((line) => line.startsWith('host:'));
  const host = hostLine ? hostLine.replace('host:', '').trim() : '未知';

  const detail = `${firstLine(rustc.out)} · ${firstLine(cargo.out)} · host=${host}`;

  // 找得到但不在 PATH：`cargo test` 用绝对路径还能跑，`npm run desktop:build` 不行
  // ——Tauri CLI 是直接 spawn `cargo` 的。这属于"没就绪"，必须拦住。
  if (!rustc.onPath || !cargo.onPath) {
    // 提示里要给「真正躺着可执行文件的那个目录」，不能写死 %USERPROFILE%\.cargo\bin。
    // 理由就是上面第三条查找路径：硬链接建不出来时 .cargo\bin 里全是 0 字节空壳，
    // 照着旧提示把空壳目录加进 PATH，只会把"明明加了却没生效"再演一遍。
    // 所以从实际探测到的绝对路径反推目录。
    const absolute = [rustc.exe, cargo.exe].filter((file) => file && isAbsolute(file));
    const realDir = absolute.length > 0 ? dirname(absolute[0]) : shimDir;
    record(
      'fail',
      'Rust 工具链',
      `${detail}（已安装，但当前终端的 PATH 里没有）`,
      `重开一个终端；仍不行就把 ${realDir} 加进 PATH（真身在这个目录里，${shimDir} 可能只有 0 字节空壳），否则 npm run desktop:build 会报 cargo not found`,
    );
    return;
  }
  if (host.includes('msvc')) {
    record('ok', 'Rust 工具链', detail);
  } else {
    record(
      'warn',
      'Rust 工具链',
      detail,
      `当前 host 不是 MSVC（${host}）。Tauri 在 Windows 上只对 MSVC 有官方支持，建议重装成 x86_64-pc-windows-msvc`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. MSVC 链接器（VS Build Tools）
// ---------------------------------------------------------------------------
function checkMsvc() {
  if (process.platform !== 'win32') {
    record('warn', 'MSVC 链接器', '非 Windows 平台，跳过', null);
    return;
  }

  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');

  if (!existsSync(vswhere)) {
    record(
      'fail',
      'MSVC 链接器',
      '未找到 Visual Studio Installer（vswhere.exe 不存在）',
      '装 VS Build Tools：https://aka.ms/vs/17/release/vs_BuildTools.exe，勾选「使用 C++ 的桌面开发」',
    );
    return;
  }

  // 只要「C++ 生成工具」这个组件——装了 VS 但没勾 C++ 是最常见的坑。
  const query = run(vswhere, [
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath',
    '-latest',
  ]);

  if (query.ok && query.out.length > 0) {
    record('ok', 'MSVC 链接器', `已安装 C++ 生成工具 · ${firstLine(query.out)}`);
    return;
  }

  const anyVs = run(vswhere, ['-products', '*', '-property', 'installationPath', '-latest']);
  if (anyVs.ok && anyVs.out.length > 0) {
    record(
      'fail',
      'MSVC 链接器',
      `找到了 Visual Studio（${firstLine(anyVs.out)}），但缺少「C++ 生成工具」组件`,
      '打开 Visual Studio Installer → 修改 → 勾选「使用 C++ 的桌面开发」→ 安装',
    );
  } else {
    record(
      'fail',
      'MSVC 链接器',
      '没有可用的 Visual Studio 安装',
      '装 VS Build Tools：https://aka.ms/vs/17/release/vs_BuildTools.exe，勾选「使用 C++ 的桌面开发」',
    );
  }
}

// ---------------------------------------------------------------------------
// 3.5 Windows SDK（导入库）
// ---------------------------------------------------------------------------
// 为什么 MSVC 之外还要单独查这一项：MSVC 和 Windows SDK 是**两个独立的包**，
// 装了「C++ 生成工具」不等于装了 SDK。真实踩过：`link.exe` 在、`vswhere` 认得出、
// doctor 报「MSVC ✓」，但 `cargo build` 直接死在
// `LNK1181: 无法打开输入文件 kernel32.lib`——因为 Windows Kits 下连 `Lib` 目录都没有。
// 只验 link.exe 会把「编译器齐了但缺导入库」判成通过，这是最贵的一种漏报：
// 前面编译十几分钟，最后一步才炸。
function checkWindowsSdk() {
  if (process.platform !== 'win32') {
    record('warn', 'Windows SDK', '非 Windows 平台，跳过', null);
    return;
  }

  const kitsRoot = join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Windows Kits',
    '10',
  );
  const libDir = join(kitsRoot, 'Lib');
  const includeDir = join(kitsRoot, 'Include');

  // 版本目录名形如 10.0.26100.0，倒序取最新的先试。
  const versions = existsSync(libDir)
    ? readdirSync(libDir)
        .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
        .sort()
        .reverse()
    : [];

  for (const version of versions) {
    // 两个都要：um 提供 kernel32.lib 等系统导入库，
    // ucrt 提供 ucrt.lib/libucrt.lib（C 运行时）。缺任一都链接不过。
    const umLib = join(libDir, version, 'um', 'x64', 'kernel32.lib');
    const ucrtLib = join(libDir, version, 'ucrt', 'x64', 'ucrt.lib');
    if (existsSync(umLib) && existsSync(ucrtLib)) {
      record('ok', 'Windows SDK', `${version} · kernel32.lib + ucrt.lib 齐全`);
      return;
    }
  }

  // 两种缺法给的动作不一样，不能压成一句「未安装」：
  // 有版本目录 = 装了一半；连目录都没有 = 根本没装。
  if (versions.length > 0) {
    record(
      'fail',
      'Windows SDK',
      `有 ${versions.join(' / ')}，但缺 um\\x64\\kernel32.lib 或 ucrt\\x64\\ucrt.lib`,
      'Visual Studio Installer → 修改 → 勾选「Windows 11 SDK」→ 完成；或直接跑 Windows SDK 安装程序，勾「Windows SDK for Desktop C++ x64 Apps」',
    );
    return;
  }

  record(
    'fail',
    'Windows SDK',
    existsSync(includeDir) || existsSync(libDir)
      ? 'Windows Kits\\10 下没有可用的 SDK 版本目录（只落了 UCRT 之类的零碎组件）'
      : '未安装（Windows Kits\\10\\Lib 不存在）',
    '装 Windows SDK：Visual Studio Installer → 修改 → 勾选「Windows 11 SDK」。少了它 link.exe 会报 LNK1181 打不开 kernel32.lib',
  );
}

// ---------------------------------------------------------------------------
// 4. WebView2 运行时
// ---------------------------------------------------------------------------
function checkWebView2() {
  if (process.platform !== 'win32') {
    record('warn', 'WebView2 运行时', '非 Windows 平台，跳过', null);
    return;
  }

  // 查目录而不是查注册表：`reg.exe` 在受限环境里会被安全策略拦掉，
  // 一个预检脚本不该因为查个版本号就被拦。而 msedgewebview2.exe 在不在，
  // 本来就是这个运行时"能不能跑"的最直接证据。
  const roots = [
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'EdgeWebView', 'Application'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'EdgeWebView', 'Application'),
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'EdgeWebView', 'Application'),
  ];

  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    const versions = readdirSync(root)
      .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
      .filter((name) => existsSync(join(root, name, 'msedgewebview2.exe')))
      .sort((a, b) => compareVersion(b, a));
    if (versions.length > 0) {
      record('ok', 'WebView2 运行时', `v${versions[0]} · ${root}`);
      return;
    }
  }

  // Win11 与打过补丁的 Win10 通常自带；查不到不代表一定不能跑，所以只 warn。
  record(
    'warn',
    'WebView2 运行时',
    '默认安装目录里没找到 msedgewebview2.exe',
    'Windows 11 一般自带。若安装后白屏，装 Evergreen Runtime：https://developer.microsoft.com/microsoft-edge/webview2/',
  );
}

/** 按数字段比较版本号（字符串比较会把 99 排在 153 后面）。 */
function compareVersion(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 5. 前端产物
// ---------------------------------------------------------------------------
function checkFrontendDist() {
  const distDir = join(APP_ROOT, 'dist');
  const indexHtml = join(distDir, 'index.html');

  if (!existsSync(indexHtml)) {
    record('warn', '前端产物 dist/', '尚未构建', 'tauri build 会自动跑 npm run build；也可先手动 npm run build 试一次');
    return;
  }

  const assetsDir = join(distDir, 'assets');
  const assets = existsSync(assetsDir) ? readdirSync(assetsDir).length : 0;
  // 用本地时间：`toISOString()` 给的是 UTC，直接贴出来会差 8 小时，
  // 用户会以为自己刚构建的产物是一早上生成的。
  const built = statSync(indexHtml).mtime;
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${built.getFullYear()}-${two(built.getMonth() + 1)}-${two(built.getDate())} ${two(built.getHours())}:${two(built.getMinutes())}`;
  record('ok', '前端产物 dist/', `index.html 存在 · assets ${assets} 个 · 构建于 ${stamp}`);
}

// ---------------------------------------------------------------------------
// 6. Tauri 配置 + 图标
// ---------------------------------------------------------------------------

/**
 * 校验单个图标文件。
 *
 * 只查"文件在不在"不够：Tauri 打包时对尺寸有硬要求，而**这些错在编译完所有
 * Rust 之后的打包阶段才报**——代价是十几分钟。这里直接读 PNG 的 IHDR 与 ICO
 * 的目录项来对，1 毫秒出结果。
 */
function validateIcon(absPath, rel) {
  if (!existsSync(absPath)) {
    return [`图标缺失：${rel}`];
  }
  const buf = readFileSync(absPath);
  const lower = rel.toLowerCase();

  if (lower.endsWith('.png')) {
    const size = readPngSize(buf);
    if (size === null) {
      return [`${rel} 不是合法 PNG`];
    }
    const expected = expectedPngSize(rel);
    if (expected !== null && (size.width !== expected || size.height !== expected)) {
      return [`${rel} 尺寸应为 ${expected}×${expected}，实际 ${size.width}×${size.height}`];
    }
    return [];
  }

  if (lower.endsWith('.ico')) {
    const sizes = readIcoSizes(buf);
    if (sizes === null) {
      return [`${rel} 不是合法 ICO`];
    }
    const missing = [16, 32, 48, 256].filter((target) => !sizes.some((entry) => entry.width === target));
    if (missing.length > 0) {
      return [`${rel} 缺少 ${missing.join(' / ')} 像素档`];
    }
    return [];
  }

  if (lower.endsWith('.icns')) {
    return buf.length >= 4 && buf.toString('ascii', 0, 4) === 'icns' ? [] : [`${rel} 不是合法 ICNS`];
  }

  return [];
}

/** 从文件名推断应有的像素尺寸（`128x128@2x.png` → 256）。 */
function expectedPngSize(rel) {
  const name = rel.split(/[\\/]/).pop() ?? '';
  const match = /^(\d+)x(\d+)(@2x)?\.png$/i.exec(name);
  if (match === null) {
    return null;
  }
  const base = Number(match[1]);
  return match[3] ? base * 2 : base;
}

/** 读 PNG 的 IHDR 尺寸（偏移 16/20，大端）。 */
function readPngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    return null;
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** 读 ICO 目录项里的各档尺寸；宽高字节为 0 表示 256。 */
function readIcoSizes(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    return null;
  }
  const count = buf.readUInt16LE(4);
  if (count === 0) {
    return null;
  }
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const offset = 6 + i * 16;
    if (offset + 2 > buf.length) {
      return null;
    }
    sizes.push({
      width: buf[offset] === 0 ? 256 : buf[offset],
      height: buf[offset + 1] === 0 ? 256 : buf[offset + 1],
    });
  }
  return sizes;
}

function checkTauriConfig() {
  const confPath = join(TAURI_ROOT, 'tauri.conf.json');
  if (!existsSync(confPath)) {
    record('fail', 'Tauri 配置', 'src-tauri/tauri.conf.json 不存在', null);
    return;
  }

  let conf;
  try {
    conf = JSON.parse(readFileSync(confPath, 'utf8'));
  } catch (error) {
    record('fail', 'Tauri 配置', `JSON 解析失败：${error.message}`, null);
    return;
  }

  const problems = [];

  const csp = conf?.app?.security?.csp ?? '';
  // 这条是踩过的坑：Argon2 走 hash-wasm 要编译 WebAssembly，
  // CSP 缺 'wasm-unsafe-eval' 时建库会失败，界面还会误报"数据可能已损坏"。
  if (!csp.includes('wasm-unsafe-eval')) {
    problems.push('CSP 缺少 \'wasm-unsafe-eval\'，建库时会因 wasm 被拦而失败');
  }

  const identifier = conf?.identifier ?? '';
  if (!identifier || identifier === 'com.tauri.dev') {
    problems.push('identifier 未设置或仍是模板默认值');
  }

  const windows = conf?.app?.windows ?? [];
  if (!windows.some((w) => w?.label === 'main')) {
    problems.push('没有 label 为 "main" 的窗口（单实例插件与 capabilities 都按这个 label 找人）');
  }

  const icons = conf?.bundle?.icon ?? [];
  if (icons.length === 0) {
    problems.push('bundle.icon 为空');
  } else {
    // 只查"文件在不在"是不够的：尺寸不对会在**编译完所有 Rust 之后**的打包阶段才失败，
    // 代价是十几分钟。这里直接把 PNG 的 IHDR 和 ICO 的目录项读出来对。
    for (const rel of icons) {
      const iconProblems = validateIcon(join(TAURI_ROOT, rel), rel);
      problems.push(...iconProblems);
    }
  }

  if (problems.length > 0) {
    record('fail', 'Tauri 配置', problems.join('；'), null);
  } else {
    const targets = (conf?.bundle?.targets ?? []).join(', ') || '默认';
    record('ok', 'Tauri 配置', `identifier=${identifier} · 出包目标=${targets} · 图标 ${icons.length} 个（尺寸已校验）`);
  }

  // capabilities 单独报，因为它的失败模式是"命令调不通"而不是"编译不过"。
  const capPath = join(TAURI_ROOT, 'capabilities', 'default.json');
  if (!existsSync(capPath)) {
    record('warn', 'capabilities', '没有 default.json', '自定义命令默认放行，但窗口类 API 会缺权限');
  } else {
    try {
      const cap = JSON.parse(readFileSync(capPath, 'utf8'));
      const perms = cap?.permissions ?? [];
      if (perms.length === 0) {
        record('warn', 'capabilities', 'permissions 为空', null);
      } else {
        record('ok', 'capabilities', `${cap.identifier ?? '未命名'} · ${perms.join(', ')}`);
      }
    } catch (error) {
      record('fail', 'capabilities', `JSON 解析失败：${error.message}`, null);
    }
  }
}

// ---------------------------------------------------------------------------
// 7. 依赖是否装好
// ---------------------------------------------------------------------------
function checkDeps() {
  const cli = join(APP_ROOT, 'node_modules', '@tauri-apps', 'cli', 'package.json');
  const api = join(APP_ROOT, 'node_modules', '@tauri-apps', 'api', 'package.json');
  const missing = [];
  for (const [name, path] of [['@tauri-apps/cli', cli], ['@tauri-apps/api', api]]) {
    if (!existsSync(path)) missing.push(name);
  }
  if (missing.length > 0) {
    record('fail', 'npm 依赖', `缺少 ${missing.join(', ')}`, 'npm install');
  } else {
    const cliVersion = JSON.parse(readFileSync(cli, 'utf8')).version;
    const apiVersion = JSON.parse(readFileSync(api, 'utf8')).version;
    record('ok', 'npm 依赖', `cli ${cliVersion} · api ${apiVersion}`);
  }
}

// ---------------------------------------------------------------------------
// 8. 前后端命令契约
// ---------------------------------------------------------------------------

/**
 * 把 Rust 侧 `#[tauri::command]` 的声明、`generate_handler!` 的注册、以及前端
 * `invoke('...')` 的调用名三方对齐。
 *
 * 为什么值得单列一项：**这条边界两边的自动化都盖不住**。
 * - `vitest` 里 `invoke` 是 mock，前端调什么名字都"成功"；
 * - `e2e` 用假 Tauri 桥，桥是按前端的期望写出来的——前端把名字拼错，桥照样应答。
 *
 * 于是「前端调了一个 Rust 根本不存在的命令」只有在装好的程序里才会炸，报错还是一句
 * 运行时的 invoke 失败。这里静态对一遍，1 毫秒出结果。
 *
 * 三个集合的关系，缺任何一处都是运行时失败：
 *
 * ```
 * 前端 invoke('x')  ⊆  generate_handler![x]  ⊆  #[tauri::command] fn x
 * ```
 *
 * 中间那一步最容易被忘：写了 `#[tauri::command] fn x` 却漏加进 `generate_handler![]`，
 * 编译完全通过，调用时才报 "command x not found"。
 */
function checkCommandContract() {
  const rsDir = join(TAURI_ROOT, 'src');
  if (!existsSync(rsDir)) {
    record('warn', '命令契约', 'src-tauri/src 不存在，跳过');
    return;
  }

  const rsFiles = [];
  const collectRs = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        collectRs(full);
      } else if (entry.name.endsWith('.rs')) {
        rsFiles.push(full);
      }
    }
  };
  // 递归扫：命令按模块拆到 `src/shell/commands.rs` 之后，只看顶层 .rs 会把
  // `#[tauri::command]` 的声明漏掉一半，报告里的"声明 N"立刻变成假数字。
  collectRs(rsDir);
  const sources = rsFiles.map((full) => ({
    name: relative(rsDir, full).replace(/\\/g, '/'),
    source: readFileSync(full, 'utf8'),
  }));

  // `#[tauri::command]` 与 `fn name(` 之间可能夹着其它属性或空行，
  // 所以不按行匹配，而是从属性往后找最近的 `fn`。
  const declared = new Set();
  for (const { source } of sources) {
    for (const match of source.matchAll(/#\[tauri::command\][\s\S]{0,400}?\bfn\s+(\w+)\s*[(<]/g)) {
      declared.add(match[1]);
    }
  }

  const handler = sources
    .map(({ source }) => /generate_handler!\s*\[([\s\S]*?)\]/.exec(source))
    .find((match) => match !== null);
  if (handler === undefined || handler === null) {
    record(
      'fail',
      '命令契约',
      '没找到 generate_handler![...]',
      'lib.rs 的 invoke_handler 是前端所有 invoke 的唯一入口，不能缺',
    );
    return;
  }
  const registered = new Set(
    handler[1]
      .split(',')
      .map((part) => part.trim())
      .filter((part) => /^\w+$/.test(part)),
  );

  const invoked = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // 测试目录里的 invoke 是 mock 调用，不代表真实契约。
        if (entry.name === '__tests__') continue;
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const source = readFileSync(full, 'utf8');
        // `invoke('x')` 与 `invoke<T>('x')` 两种写法都要认；泛型里不含尖括号嵌套。
        for (const match of source.matchAll(/\binvoke\s*(?:<[^<>]*>)?\s*\(\s*['"]([\w]+)['"]/g)) {
          if (!invoked.has(match[1])) {
            invoked.set(match[1], relative(APP_ROOT, full).replace(/\\/g, '/'));
          }
        }
      }
    }
  };
  walk(join(APP_ROOT, 'src'));

  const unregisteredCall = [...invoked.entries()].filter(([name]) => !registered.has(name));
  const unregisteredDecl = [...declared].filter((name) => !registered.has(name));

  if (unregisteredCall.length > 0 || unregisteredDecl.length > 0) {
    const parts = [];
    if (unregisteredCall.length > 0) {
      parts.push(
        `前端调了未注册的命令：${unregisteredCall.map(([name, file]) => `${name}（${file}）`).join('、')}`,
      );
    }
    if (unregisteredDecl.length > 0) {
      parts.push(`声明了但没注册进 generate_handler!：${unregisteredDecl.join('、')}`);
    }
    record('fail', '命令契约', parts.join('；'), '补进 lib.rs 的 generate_handler![...]，或改正命令名');
    return;
  }

  const unused = [...registered].filter((name) => !invoked.has(name));
  record(
    'ok',
    '命令契约',
    `调用 ${invoked.size} · 注册 ${registered.size} · 声明 ${declared.size} · 三方对得上` +
      (unused.length > 0 ? `（未调用：${unused.join(', ')}）` : ''),
  );
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
checkNode();
checkRust();
checkMsvc();
checkWindowsSdk();
checkWebView2();
checkDeps();
checkFrontendDist();
checkTauriConfig();
checkCommandContract();

const blockers = results.filter((r) => r.status === 'fail');
const warnings = results.filter((r) => r.status === 'warn');

if (JSON_MODE) {
  console.log(JSON.stringify({ ready: blockers.length === 0, results }, null, 2));
  process.exit(blockers.length === 0 ? 0 : 1);
}

const badge = {
  ok: `${c.green}✓${c.reset}`,
  warn: `${c.yellow}!${c.reset}`,
  fail: `${c.red}✗${c.reset}`,
};

/**
 * 终端里的显示宽度。
 *
 * `padEnd` 按 code unit 数补齐，但一个汉字在等宽终端里占两列——
 * 直接用 padEnd 会让中文标题那一列整体错位，越往下偏得越多。
 */
function displayWidth(text) {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

console.log(`\n${c.bold}密岛 KeyIsland · 桌面版构建预检${c.reset}`);
console.log(`${c.dim}${TAURI_ROOT}${c.reset}\n`);

const width = Math.max(...results.map((r) => displayWidth(r.title)));
for (const r of results) {
  const pad = ' '.repeat(width - displayWidth(r.title));
  console.log(`  ${badge[r.status]} ${r.title}${pad}  ${r.detail}`);
  if (r.hint && r.status !== 'ok') {
    console.log(`    ${c.dim}↳ ${r.hint}${c.reset}`);
  }
}

console.log('');

if (blockers.length === 0) {
  console.log(`${c.green}${c.bold}环境就绪。${c.reset} 可以出包了：\n`);
  console.log(`  ${c.cyan}cd src-tauri && cargo test${c.reset}   ${c.dim}# 先跑 8 条存储单测（十几秒）${c.reset}`);
  console.log(`  ${c.cyan}npm run desktop:build${c.reset}      ${c.dim}# 出安装包，产物在 src-tauri/target/release/bundle/${c.reset}`);
  if (warnings.length > 0) {
    console.log(`\n${c.yellow}有 ${warnings.length} 条提醒，不阻塞构建。${c.reset}`);
  }
  console.log('');
  process.exit(0);
}

console.log(`${c.red}${c.bold}还差 ${blockers.length} 项，现在出包会在最后阶段失败。${c.reset}\n`);
console.log(`${c.dim}按上面的 ↳ 提示逐条装完，再跑一次 npm run desktop:doctor。${c.reset}\n`);
process.exit(1);
