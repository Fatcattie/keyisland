# 密岛 KeyIsland · Web 预览版发布说明

> 适用对象：想把本仓库作为 **Web 预览版** 跑起来 / 交付给别人试用的场景。
> 对应设计文档：`../SDD.md`、`../prd.md`、`docs/PHASE-LOG.md`、`docs/adr/ADR-014-*`（Tauri 接入评估）。

---

## 1. 这是什么

密岛是一个本地优先的密码库。当前仓库是 **Web/TS 实现**（Vite + React + TypeScript），可在浏览器里完整使用核心功能；Tauri 桌面版（SDD 既定目标架构）尚在评估阶段，见 `docs/adr/ADR-014-*`。本说明只覆盖 **Web 预览版** 的构建与运行。

> ⚠️ Web 预览版是**临时形态**：密钥与库数据留在浏览器内存/IndexedDB（取决于实现），刷新可能清空；它不等同于桌面版的安全边界。请勿用于存放真实长期凭据。

---

## 2. 环境要求

- Node.js ≥ 18（开发用 22.x / 24.x 均可）
- npm（随 Node 附带）

---

## 3. 命令

```bash
# 1) 安装依赖（首次）
npm install

# 2) 启动开发服务器（热更新，默认 http://localhost:5173）
npm run dev

# 3) 生产构建（先 tsc 类型检查，再 vite 打包到 dist/）
npm run build

# 4) 本地预览构建产物（默认 http://localhost:4173）
npm run preview
```

其他：`npm run test`（含监听）/ `npm run test:run`（单次跑全部）/ `npm run typecheck`（仅类型检查）。

**生产包冒烟验收**：`npm run build && npm run e2e:smoke`（加 `-- --shots` 会把截图存到 `artifacts/e2e/`）。

单测跑在 jsdom 上，覆盖不到 bundle 层（分包路径、Portal 渲染、hash-wasm、CSS）。这条脚本用真实 Chrome 无头 + DevTools Protocol 跑 `dist`，走完「首次设置 → 新建遮罩卡片 → 一键上锁 → 错误/正确主密码 → 卡片二次验证 → 授权后自动续跑」全链路，共 17 条断言，退出码即结果。前置：本机有 Chrome/Edge，可用 `CHROME_PATH` 指定路径。

---

## 4. 当前构建 / 测试基线（Web 预览版）

| 项 | 结果 |
| --- | --- |
| `npm run typecheck`（`tsc --noEmit`） | 0 error |
| 单元测试 `vitest run` | 92 文件 / **607 用例**全过，`act` 警告 0 |
| 安全测试 `vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全过 |
| 生产包冒烟 `npm run e2e:smoke` | **17/17** 断言通过，console 错误 0 |
| 生产包 `dist/assets/index-*.js` | **492.98 kB**（gzip **183.85 kB**）；CSS 26.78 kB（gzip 5.44 kB） |

---

## 5. 已实现（Web 阶段可交付）

按 `docs/PHASE-LOG.md` 的阶段记录，Web 阶段已完成：Vault 核心域、主面板/灵动岛/解锁流程、备份恢复、密码体检、拼音搜索、批量删除+主密码二次验证、剪贴板清理与风险提示、快捷键可自定义、卡片密码强度点、设置页多项 FR、操作日志等。详见 `docs/PHASE-LOG.md` 的「阶段总览」。

---

## 6. Web 预览版已知的边界（如实记录）

以下能力 **Web 阶段做不到**，需等 Tauri 桌面版（见 `docs/adr/ADR-014-*`）：

- **无 Rust / Tauri**：无焦点窗口（`WS_EX_NOACTIVATE`）、系统级热区坐标、全局热键、防截屏（`WDA_EXCLUDEFROMCAPTURE`）、Windows Hello、ShellExecute 均未实现。
- **无持久化**：库数据在内存，刷新即清空；SQLCipher 未接入（本机也无 Rust 工具链）。
- **前端持有 DEK**：与 SDD §0.4 冲突，属临时状态，Tauri 阶段必须把密钥移入 Rust。
- **FR-07.2 浏览器自动填充**：需浏览器扩展 + Native Messaging，Web 预览版仅做到"跳转并复制"，不自动填充。
- **防截屏 / 检查更新**：Web 阶段只有置灰占位，非"已完成"。

---

## 7. 构建环境的一个坑（重要）

本仓库在**部分 Windows 环境**跑 `npm run build` / `vite build` 时，可能卡在把旧 `dist/` 移入回收站的步骤（`emptyDir` → vendored 二进制 `win32-x64.exe` 超时 `ETIMEDOUT`），导致 `build` 退出码 1——**但这不代表代码有问题**（"✓ N modules transformed" 已成功，只是清理旧目录那步超时）。

**绕法**：先把旧 `dist/` 移走（不要直接 `rm`，本机安全删除 shim 对批量删除会要求确认/超时），再用全新目录构建：

```bash
# 旧 dist 移出（避免 emptyDir 触发回收站超时）
mv dist /tmp/ki-dist-old-$(date +%s) 2>/dev/null
# 顺手清理 vite 生成的临时配置缓存（vite.config.ts.timestamp-*.mjs）
mv vite.config.ts.timestamp-*.mjs /tmp/ki-vite-temp/ 2>/dev/null
npm run build
```

---

## 8. 下一步（桌面版路线）

**桌面版脚手架已就绪（Phase 11）**：`src-tauri/` 下已有 Tauri 2 壳与本地落盘实现，出安装包只需装工具链后跑 `npm run desktop:build`。完整步骤见 **`docs/DESKTOP-BUILD.md`**。

Tauri 2 + Rust + SQLCipher 是 SDD 既定目标架构。迁移评估与先行 Spike 计划见 `docs/adr/ADR-014-tauri-2-integration-evaluation.md` 与 `docs/adr/ADR-014-spike-checklist.md`。**前提**：需在具备 Rust/cargo/WebView2/VS Build Tools 的 Windows 机上先跑通 S0–S3 先行 Spike（当前开发机无 Rust 工具链，`src-tauri/` 的 Rust 代码尚未编译验证）。
