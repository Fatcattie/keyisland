# 灵动岛常驻化 · 真机验证清单（6 项 + 关闭→托盘→右键唤醒）

> 配套代码：`app/src-tauri/src/shell/*`（Rust 壳）、`app/src/features/shell/*`（前端桥与窗口层）、
> `app/src/features/vault/MainPanel.tsx`（「收进岛」入口）。
> 自动化覆盖：`scripts/e2e/shell.mjs`（`npm run e2e:shell`）、`scripts/desktop/window-probe.ps1`（`npm run desktop:probe`）、
> `src-tauri/src/shell/state_file.rs` 的 `cargo test`。

---

## 总览：哪些已自动覆盖，哪些仍需人工

| 项 | 内容 | 自动覆盖情况 |
|---|---|---|
| ① | 托盘图标外观（是否偏糊） | ✅ 已改为**专用 32×32 简化图**（`assets/icon-src/tray-icon.svg` → 裸 RGBA `include_bytes!`，编译期断言尺寸、exe 逐字节比对通过）/ ⚠️ 最终观感仍需人眼 |
| ② | `transparent` + `decorations:false` 在 Windows 下兼容 | ✅ 属性自动（`window-probe.ps1` 验 `WS_EX_LAYERED` 运行时位 + 静态验 `tauri.conf.json` 的 `transparent=true`）/ ⚠️ 像素人工（"透出来的是不是桌面"仍需肉眼） |
| ③ | 岛位置记忆跨屏 / 不同 DPI | ✅ 已修代码 + 逻辑核验；建议真机抽验 |
| ④ | 单实例二次启动是否还原全形态 | ✅ `window-probe.ps1 -SecondInstance` 自动验 |
| ⑤ | `desktop:probe` 的 WS_EX_TOOLWINDOW / 无标题栏 / 进程存活 | ✅ `window-probe.ps1` 自动验 |
| ⑥ | 首次关闭提示 toast 观感 + `close_hint_seen` 只弹一次 | ✅ `e2e:shell` 验「只一次」逻辑 + `cargo test` 验翻转；toast 观感需人工 |

---

## ① 托盘图标外观（已改为专用小图 + 人工终判）

**之前的问题**：托盘用 `app.default_window_icon()`，那是 1024px 的**整张插画**（含星星、远岛、海浪、高光）。
Windows 托盘实际只显示 16–32px，整图缩下去会糊成一团——32px 下基本是"暗色方块 + 小红球 + 噪点"。

**已做的改动（2026-10-28）**：
- 新增 `app/assets/icon-src/tray-icon.svg`：与主图标同一视觉语言，但**刻意简化**——
  去掉星星 / 远处小岛 / 海浪 / 高光 / 条纹，只留「暖黄气球 + 深色吊篮 + 一点锁光」。
- 渲染成 32×32 裸 RGBA（4096 B）存 `app/src-tauri/assets/tray-32.rgba`。
- `tray.rs` 改为 `include_bytes!("../../assets/tray-32.rgba")` + `tauri::image::Image::new(rgba, 32, 32)`，
  并用 `const _: () = assert!(len == 32*32*4)` 做**编译期尺寸断言**（对不上直接编译失败）。
- 验证：Python 逐字节比对 `tray_rgba_embedded = True`；exe 相比上一版**恰好 +4096 B**。
- 对照图：`app/.iconwork/tray-compare.png`（左=旧整图缩放，右=新专用图，浅/深底各一行）。

**仍需人眼的部分**：像素级观感、以及 100%/150%/200% DPI 下 Windows 的最终缩放效果。

**怎么查**：
1. 安装并启动密岛（或 `npm run desktop:dev`）；
2. 关闭主面板 → 看任务栏通知区（系统托盘）的密岛图标；
3. 在 100% 与 150% 缩放下各看一次，确认是**暖黄气球**、轮廓干净、不是一团暗色。

**判通过**：托盘图标 = 气球、在 100%/150% 缩放下都清晰可辨。

---

## ② `transparent` + `decorations:false` 兼容（人工 + 代码层）

**代码事实**：`tauri.conf.json` 的 `main` 窗口设了 `"transparent": true`（**创建期属性，运行时改不了**）；
岛形态由 Rust 在运行时 `set_decorations(false)` + `set_skip_taskbar(true)` + `set_always_on_top(true)`。
`app/src/styles/island-window.css` 把 `html[data-app-mode='island'] body/#root` 设为 `background: transparent !important`，
让窄条/岛面以外的区域透出桌面。

**自动化覆盖（2026-10-27 补）**：`window-probe.ps1` 现已两项增强，把"属性齐备"这一层钉死，不再只靠人工：
- 运行时：发 `WM_CLOSE` 进入岛形态后断言 `ExStyle` 含 `WS_EX_LAYERED (0x80000)` —— 这是 `transparent:true`
  真正生效的 Win32 前提位；若此位缺失，透明属性等于失效（只会是黑/白底）。
- 静态：`Resolve-Path` 读 `src-tauri/tauri.conf.json`，断言 `app.windows[]` 中 `label=main` 的 `transparent === true`
  （创建期属性，运行时改不了，故放到静态校验而非运行时断言）。

跑法：`npm run desktop:probe`（或 `npm run desktop:probe -- -SecondInstance`）。它会在既有的
"进程存活 / 可见 / 缩小 / WS_EX_TOOLWINDOW / 无 WS_CAPTION" 之外，再加打上述两条。

**怎么查**（像素层面仍须肉眼，自动化鞭长莫及）：在目标 Windows 版本（Win10 22H2 / Win11 各版本）上：
1. 关闭主面板 → 岛形态；
2. 确认窗口四周**没有不透明白边/黑边**，岛面与桌面自然融合；
3. 确认透明区域**不接收鼠标穿透**（点岛面外的透明区不会"点了没反应"）—— 这由 `island-window.css` 把 `island-panel`
   撑满小窗来兜底。

**降级预案**（若某版本透明失效，窗口变成白块）：在 `island-window.css` 的岛形态规则里把
`background: transparent` 改为一个**不透明深色渐变**（与岛胶囊同色系），保证至少是"深色小组件"而非"白块"。
**当前未启用降级**，因为 Win10/11 该组合稳定；仅在真机踩到时才切。

**判通过**：岛形态窗口无白/黑边、透明区不透点、观感为悬浮深色小组件。

---

## ③ 岛位置记忆跨屏 / 不同 DPI（已修 + 建议真机抽验）

**之前的问题**：`morph_into_island` 只调用 `save_island_pos` 把位置写盘，**从不读回**。
用户拖动岛之后，再次进入岛形态会从"全窗口顶边居中"重新算，拖过的位置等于没存 —— 跨重开/二次进入都回弹。

**修复**（`src-tauri/src/shell/mod.rs`）：进入岛形态时先 `state_file::load(app).island_pos`，
- 有记忆：以记忆的顶左边作锚点（并把 `cur` 当成岛尺寸，`anchored_top_center` 保持不动）→ 贴回原处；
- 无记忆：仍从全窗口顶边居中收起（首次行为不变）。

配合已有的 `on_scale_changed`（DPI/分辨率变化后重新夹取进工作区）与 `clamp_into_work_area`（不跑出屏幕），
跨屏/跨 DPI 的位置都会落回可见区。

**怎么查**：
1. 关闭主面板 → 把岛拖到屏幕右下角；
2. 打开主面板 → 再关闭（或退出重开）→ 岛应**回到右下角**，而非顶部居中；
3. 把主面板拖到副屏、关闭，再在主屏打开关闭 → 岛应夹进主屏工作区（不跑到副屏外）。

**判通过**：拖动持久化；跨屏/DPI 不丢失、不越界。

---

## ④ 单实例二次启动（自动 · `window-probe.ps1 -SecondInstance`）

`tauri_plugin_single_instance` 已在 `lib.rs` 挂好，二次启动回调走 `shell::reveal_main`
（还原全形态 + 聚焦，而不是再开一个岛/托盘）。

**怎么查**：
```
npm run desktop:probe -- -SecondInstance
```
脚本会再启一次 exe，断言进程数仍为 1，且 `main` 窗口被还原成全形态（宽 ≥ 900 且高 ≥ 600）。

**判通过**：`单实例：第二次启动没有产生新进程` 与 `单实例：main 已还原为全形态` 均 PASS。

---

## ⑤ 窗口属性（自动 · `window-probe.ps1`）

对**真实进程**发 `WM_CLOSE`（等同点 × / Alt+F4），断言：
- 进程仍存活（关闭 ≠ 退出）；
- 窗口仍可见（没 `hide()`，因此不误触 `visibilitychange → 锁库`）；
- 窗口缩小到 ≈320×44（DPI 感知，150% 下为 480×66，按"明显变小"判）；
- 扩展样式含 `WS_EX_TOOLWINDOW`（不占任务栏 / 不进 Alt+Tab）；
- 窗口样式不含 `WS_CAPTION`（无标题栏；注意**标题文本仍保留**，只查样式不查文本）。

**怎么查**：
```
npm run desktop:probe
```
**判通过**：以上 5 条均 PASS（脚本逐条打印 PASS/FAIL）。

---

## ⑥ 首次关闭提示 + 只弹一次（自动 · `e2e:shell` + `cargo test`）

**逻辑真相在 Rust**：`state_file::take_close_hint(app)` 读 `shell.json` 的 `close_hint_seen`，
没看过→返回 `true` 并把标记翻成 `true`；看过→永远返回 `false`。前端只负责弹 toast，不持有该标记。

**两层自动保障**：
1. `src-tauri/src/shell/state_file.rs` 的 `take_close_hint_logic` 单测：
   `false → (true,true)`，`true → (false,true)` —— 钉死"只一次"语义。
2. `scripts/e2e/shell.mjs`：真实点「收进岛」首次进入断言 `showCloseHint=true` 且 toast 文案上屏；
   二次进入断言 `showCloseHint=false`（假桥镜像了同一逻辑，确定性、不依赖 toast DOM 是否还在）。

**toast 观感（人工）**：确认提示是轻量的、几秒后自动消失、不挡操作、文案清楚
（当前为："密岛已收进托盘，灵动岛仍可使用。彻底退出：托盘或岛右键 → 退出"）。

**怎么查**：
```
npm run build && npm run e2e:shell
cargo test -p keyisland-shell state_file   # 需桌面构建环境四件套
```
**判通过**：e2e 中「首次进入 showCloseHint=true」「二次进入 showCloseHint=false」均 PASS；cargo 单测 PASS。

---

## 关闭 → 托盘 → 右键唤醒（桌面冒烟，自动 · `e2e:shell`）

这条就是把上面 ③④⑤⑥ 串成用户真实路径的端到端：

1. 主面板工具栏点「收进岛」（或点窗口 × / 最小化）→ 进程不退出、缩成置顶小岛 + 进托盘；
2. 右键岛窗口 → 菜单三项「打开主面板 / 锁定保险库 / 退出密岛」，顺序固定、锁定时置灰；
3. 点「打开主面板」→ `shell_show_main` 被调用、回到全形态、主面板重新可见；
4. 托盘左键 / 右键菜单同样能打开主面板与退出。

`e2e:shell` 在**真实 bundle + 假 Tauri 桥**上把 1→3 走了一遍（含关闭提示只一次、退出前先清剪贴板再 `shell_quit`）。
而"窗口真的变成 320×44、任务栏有没有条目、托盘图标长什么样"只有 `desktop:probe` 在真机上能验。

**判通过**：`e2e:shell` 全绿 + `desktop:probe`（含 `-SecondInstance`）全绿。

---

## 一键跑法（真机）

```bash
# 1) 前端→命令边界的岛形态生命周期（关闭→托盘→右键唤醒 + 只提示一次 + 退出前清剪贴板）
npm run build && npm run e2e:shell

# 2) 真实窗口属性：关闭≠退出 / WS_EX_TOOLWINDOW / 无标题栏 / 进程存活
#    先手动启动装好的 keyisland.exe（或 npm run desktop:dev），另开一个终端：
#    现额外断言 WS_EX_LAYERED（透明前提位）+ 静态校验 tauri.conf.json transparent=true
npm run desktop:probe
npm run desktop:probe -- -SecondInstance   # 单实例还原

# 3) Rust 层单元测试（关闭提示只一次 + 几何/夹取）
cd src-tauri && cargo test
```
