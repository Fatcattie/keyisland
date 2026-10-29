# 密岛 KeyIsland · app

Windows 单机私人账密管理工具。当前版本 **0.1.8**，已是可安装的桌面应用（Tauri 2），
主面板 / 解锁 / 建库 / 灵动岛常驻 / 白天黑夜主题 / 系统托盘 / 启动失败屏均已实现。

- 技术栈：React 18 + Vite 5 + Zustand + framer-motion（前端） / Tauri 2 + Rust（桌面壳）
- 打包产物：NSIS 安装包（`currentUser`，无需管理员），装到 `%LOCALAPPDATA%\KeyIsland`
- 数据：纯本地、加密落盘，不联网、不上传

## 快速开始（前端）

```bash
npm install
npm run dev            # 本地开发（浏览器预览，用内存存储，不落盘）
npm run typecheck      # TypeScript 严格模式检查（tsc --noEmit）
npm run test:run       # 单元测试（vitest，jsdom）
npm run build          # 生产构建（tsc + vite build → dist/）
```

包管理器固定为 **npm**（不要与 pnpm / yarn 混用 lockfile）。

## 桌面端（Tauri）

前置：Rust 工具链 + MSVC + Windows SDK。具体版本、环境变量四件套见
[`docs/DESKTOP-BUILD.md`](docs/DESKTOP-BUILD.md)。

```bash
npm run desktop:doctor   # 环境自检（Rust / MSVC / SDK / WebView2 / 图标等 9 项）
npm run desktop:dev      # 开发模式启动桌面应用（tauri dev）
npm run desktop:build    # 出 NSIS 安装包（release 编译 + 打包，首次约 17 分钟）
npm run desktop:probe    # 真机窗口探针：验「关闭 = 变岛、进程不退出」等 Win32 属性
npm run release:publish  # 出包 + 打 tag + 建 GitHub Release（加 -- --dry-run 只预检）
```

安装包输出：`src-tauri/target/release/bundle/nsis/KeyIsland_<版本>_x64-setup.exe`
未安装直跑本体：`src-tauri/target/release/keyisland.exe`

> **发版是独立的一步**：安装包在 `.gitignore` 里，`git push` 不会带上它。
> `release:publish` 会先校验三处版本号一致、工作区干净、HEAD 已推送、tag 未占用、
> 构建环境齐全、exe 版本资源匹配，任何一条不过就中止——宁可发不出去，也别发一个
> 「tag 与二进制对不上」的包。

> `desktop:probe` 需要**先启动已安装的 keyisland.exe**（或 `desktop:dev`）再跑；
> 加 `-- -SecondInstance` 可额外验单实例还原全形态。

## 验证基线

| 命令 | 覆盖 |
|---|---|
| `npm run typecheck` | TS 类型（0 error） |
| `npm run test:run` | 单元测试（jsdom） |
| `npm run e2e:smoke` | 生产包冒烟（真实 Chrome + 假 Tauri 桥） |
| `npm run e2e:startup-failure` | 启动失败屏 |
| `npm run e2e:shell` | 灵动岛生命周期（关闭→托盘→右键唤醒、只提示一次、退出前清剪贴板） |
| `npm run desktop:probe` | 真实进程的 Win32 窗口属性 |

> `vitest` 全跑在 jsdom 里（`isDesktopShell()` 恒 false，桌面端口 no-op）；`e2e:*` 跑在真实 Chrome
> + 假 `window.__TAURI_INTERNALS__` 桥上，验「前端 → 命令边界」；`desktop:probe` 才是对真实进程的
> 黑盒检查。三者互补，缺一不可。

## 目录结构

```text
app/
├─ docs/                       # 文档
│  ├─ DESKTOP-BUILD.md         # 桌面构建与工具链
│  ├─ PHASE-LOG.md             # 阶段日志
│  ├─ island-persistent-*.md   # 灵动岛常驻化 PRD / 设计 / 验证清单
│  ├─ user-guide.html/.md      # 终端用户使用手册
│  └─ adr/                     # 架构决策记录
├─ scripts/
│  ├─ desktop/                 # doctor.mjs · window-probe.ps1
│  └─ e2e/                     # smoke.mjs · shell.mjs · cdp.mjs
├─ src/
│  ├─ core/                    # 纯领域逻辑（crypto / vault），不依赖 React
│  ├─ services/                # 适配器：剪贴板、存储端口、Vault 门面、window-shell 端口
│  ├─ stores/                  # Zustand（仅 UI 状态，不保存密钥）
│  ├─ features/                # island / session / settings / setup / shell / startup / unlock / vault
│  ├─ styles/                  # 全局样式（含 island-window.css 的岛形态覆盖）
│  └─ App.tsx / main.tsx
├─ src-tauri/
│  └─ src/
│     ├─ lib.rs / main.rs      # 应用装配、单实例、启动错误
│     ├─ storage.rs            # 本地加密存储（SQLCipher / 落盘）
│     └─ shell/                # 窗口状态机 mod.rs · geometry.rs · state_file.rs · tray.rs · commands.rs
└─ vitest.setup.ts
```

## 灵动岛（单窗口变形）

只有一个 `main` 窗口，在「全形态 1180×820 有装饰」与「岛形态 320×44 / 400×460 无边框置顶半透明
不占任务栏」之间切换，**零跨窗口密钥传输**。

- 关闭主面板 ≠ `window.hide()`：岛形态用「缩小 + 去装饰 + 置顶 + 不占任务栏」表达，窗口始终可见，
  以免触发 `visibilitychange → hidden` 而误锁库；只有未建库时才真 `hide()`。
- 状态真值源在 Rust（`appMode`），前端只做镜像；`island.phase`（collapsed/expanded/closing）与
  `appMode` 语义正交。
- 右键岛 → 「打开主面板 / 锁定保险库 / 退出密岛」；托盘同样三项。
- 展开后滚轮翻卡，Enter 复制密码 / ⇧Enter 复制账号，**中键（按下滚轮）退出选择**。

## 主题（白天 / 黑夜）

颜色收在一层 CSS 变量里（`src/index.css` 的 `:root` / `.dark` 各 14 个 `--ki-*` 令牌），
Tailwind 侧通过 `rgb(var(--ki-x) / <alpha-value>)` 暴露成 `bg-surface` / `text-fg` / `border-line`
这类语义类；`darkMode: 'class'`，由 `src/stores/theme-store.ts` 切 `<html class="dark">`。

- **亮色取值与改造前逐位相等**：没切主题时界面像素不变——这是"加主题"不该顺手改视觉的底线。
- **灵动岛恒为深色**，不参与主题（它是一块浮在桌面上的暗玻璃）。
- 用户没手动选过时跟随系统；选过之后以用户为准，跟随系统时**不落盘**。
- 语义浅色块（`bg-amber-50` 这类）必须配 `dark:` 变体，否则深色下是一整块亮斑。

## 安全边界（务必遵守）

- 主密码、恢复码、DEK、KEK、资产明文**不得**进入日志、URL、`localStorage` / `sessionStorage`。
- 桌面端数据加密落盘（`src-tauri/src/storage.rs`）；浏览器预览用 `MemoryVaultStorage`，重启即清空，
  **禁止用于真实数据**。
- 锁定时清空 DEK 与内存明文缓存，并取消剪贴板清理任务（若内容仍属于密岛则立即清空）。
- 剪贴板只保存内容摘要，到期仅清理仍属于本次写入的内容。

## 已知限制

- **仅 Windows**（Tauri 目标），依赖 WebView2 运行时（Win10/11 一般预装）。
- JS 层密钥擦除只能尽力而为（无 GC 保证）。
- 更多背景见 `docs/adr/`。
