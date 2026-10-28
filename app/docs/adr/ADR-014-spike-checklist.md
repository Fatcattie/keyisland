# ADR-014 · 先行 Spike 可执行清单（S0–S4）

> 配套文档：`ADR-014-tauri-2-integration-evaluation.md`
> 用途：在**具备 Rust 工具链的目标 Windows 机**上，于全面铺开 Tauri 移植前，先验证 4 个最高风险项（S0–S3）可行性。本清单是**计划文档**，不依赖本评估机（本机无 cargo/rustc/C 编译器，无法执行）。
> 硬 Gate：S0–S3 **全部通过**后，才允许进入 ADR-014 路线 B（Rust 核心移植）。S4 可延至 P1。

---

## 通用环境前提（所有 Spike 共用）

| 项 | 要求 |
| --- | --- |
| Rust 工具链 | `rustup` + `stable` + `rustfmt`/`clippy`；`cargo` 可离线或配置镜像 |
| Tauri 2 | `@tauri-apps/cli` v2 + `tauri-build`/`tauri` crate；`tauri.conf.json` 模板 |
| WebView2 | 目标 Windows 10/11 已装 Runtime（或应用 bundled）；Linux/macOS 对应 webkit |
| 原生构建 | Windows：`Visual Studio Build Tools` + `Windows 10/11 SDK`（C/C++ 桌面） |
| 代码签名（S1/S3 产物） | 有效的 Authenticode 证书或自签测试证书 |

> 任一前提不满足，对应 Spike 直接判「阻塞」，回填结论后**停在 Gate**，不进入 B 阶段。

---

## S0 · 工程脚手架（最小空壳）

- **目标**：验证"能在本机从零拉起一个 Tauri 2 空白窗口，并能 `invoke` 一个无副作用的 command"。
- **步骤**：
  1. `cargo new` + 接入 `tauri` 2.x；`npm create` 出 React 渲染层（`features/*` 暂不需要，先用占位页）。
  2. 配 `tauri.conf.json`（窗口无边框/透明/置顶留到 S2，这里先用普通窗口）。
  3. 写一个 `ping() -> String` command，前端 `invoke('ping')` 并打印结果。
  4. `tauri dev` 起开发，`cargo build --release` 出生产包。
- **通过标准**：开发态窗口出现；`ping` 往返成功；release 包可启动。
- **产物**：可复用的 `src-tauri/` 骨架 + `tauri.conf.json` 基线（后续 Spike 在其上叠加）。
- **解除风险**：R7（"能否在本机跑起 Tauri"这一最基础前提）。
- **阻塞依赖**：通用环境前提。

---

## S1 · SQLCipher 构建 / 签名（对应 R1，硬阻塞）

- **目标**：确认 SQLCipher 在 Tauri 侧的**落地方式**——`bundled` 编译进 `rusqlite` vs 系统库 + 签名；并验证加密库能开、能安全删。
- **步骤**：
  1. `rusqlite` 启用 `sqlcipher` feature（bundled 路径）；或链接系统 `sqlcipher` 动态库（系统路径）。
  2. 用固定 key 打开/创建库，`PRAGMA key` / `PRAGMA cipher_compatibility` / `PRAGMA secure_delete=ON` 全部生效。
  3. 建一张与 SDD §4.3 同构的 `items` 表，写入并读取一条记录。
  4. release 构建：若走系统库，确认打包时带上并**签名**；若走 bundled，确认静态链接不引出版权/分发问题。
  5. 验证 `secure_delete` 真的覆写（或在应用层做多轮覆写，关联 S3）。
- **通过标准**：库在 key 正确时可读写、key 错误时拒绝；release 包在干净机器上能跑（不缺运行库）；签名链可被系统信任（或自签测试通过）。
- **产物**：SQLCipher 选型结论（bundled vs 系统）+ 最小可工作的 `repository.rs` 原型，填回 ADR-003。
- **解除风险**：R1（SQLCipher 构建/签名，ADR-003）。
- **阻塞依赖**：S0、通用环境前提。

---

## S2 · 无焦点窗口 + 键盘输入（对应 R2，硬阻塞）

- **目标**：验证 `WS_EX_NOACTIVATE` 窗口能"唤出不抢焦点"且**仍收到键盘/热区相关输入**——这是灵动岛热区与全局热键的底层前提。
- **步骤**：
  1. 用 `SetWindowLong(GetWindowLong(hwnd, GWL_EXSTYLE) | WS_EX_NOACTIVATE)` 给 Tauri 窗口加无焦点样式（通过 `tauri-plugin` 或 `windows` crate 调 Win32 API；注意跨平台用条件编译）。
  2. 启动窗口，**聚焦另一个应用**后点灵动岛区域，确认另一个应用焦点不变、灵动岛仍响应（`pointerdown`/`mousemove` 收到）。
  3. 在同一窗口上验证键盘事件可达（为全局热键/热区键盘交互铺路）。
  4. 记录 macOS/Linux 等价实现差异（macOS 用 `NSWindow` 级别；Linux 视 compositor）。
- **通过标准**：窗口可见且不抢焦点；在别的应用聚焦时，灵动岛仍能交互；键盘事件可达。
- **产物**：`windows-integration` crate 的窗口样式封装原型（含跨平台占位）。
- **解除风险**：R2（`WS_EX_NOACTIVATE` 输入兼容，ADR-004）。
- **阻塞依赖**：S0、通用环境前提。

---

## S3 · Rust `zeroize` 验证（对应 R3/R4）

- **目标**：证明 DEK/KEK/明文密码等敏感缓冲区在使用后被**可控清零**，解决"JS 密钥擦除不可验证"与"WebView 明文残余"。
- **步骤**：
  1. 定义敏感类型（`Dek`、`Kek`、解密出的 `PlaintextPassword`）包 `zeroize::Zeroize`/`ZeroizeOnDrop`。
  2. 在 `unwrap_dek` / 解密 / 复制回执生成后立即 `drop` 并验证清零。
  3. 用内存扫描（或 `hexdump` 进程内存 / `dhat` 类工具）确认敏感明文在 `drop` 后不在残留页出现。
  4. 明确边界：`reveal_password`（按住预览）的明文**会**触达 WebView（JS 无法 zeroize）——记录为已知残余风险 R4，约束为瞬时、不落状态、锁即弃（前端策略，不在本 Spike 解决）。
- **通过标准**：Rust 侧敏感缓冲在 drop 后内存中不再含明文；R4 的边界在文档里被显式约束。
  5. **产物**：`vault-core` 的 `secret.rs`（零化封装）+ 内存验证脚本。
- **解除风险**：R3（内存擦除可验证）、部分 R4（Rust 侧残余消除；WebView 侧仅约束）。
- **阻塞依赖**：S0、通用环境前提。

---

## S4 · Windows Hello（对应 R5，可延 P1，非硬 Gate）

- **目标**：验证能否用 Windows Hello 替代/辅助主密码解锁（PRD 生物识别方向，P1）。
- **步骤**：
  1. 通过 `webauthn` / `windows-sys` 调 `Win32` 凭据 API，弹出 Hello 提示。
  2. 成功后用返回的断言去解 DEK（需要设计"Hello 解锁后如何拿到 DEK"的密钥封装，初版可仅做概念验证）。
- **通过标准**：Hello 提示出现并完成；能据此完成一次解锁流程的概念验证。
- **产物**：Hello 集成的 PoC 代码片段，回填到 R5 评估。
- **解除风险**：R5（Windows Hello，P1）。
- **阻塞依赖**：S0、通用环境前提；建议 B 阶段后或并行做。

---

## 回填与 Gate 决策

每个 Spike 完成后，在 `ADR-014` 对应风险条目下回填：**结论 / 选型 / 残留问题 / 是否解除**。

- **全部 S0–S3 通过** → 解除 Gate，进入 ADR-014 路线 **B（Rust 核心移植）**；
- **任一硬阻塞（S1/S2）失败或环境前提不满足** → **停在当前阶段**，把阻塞原因与所需资源（证书、SDK、目标机）上报，等条件具备再重试，**不进入 B**；
- **S3 仅部分通过**（Rust 侧过、WebView 残余 R4 仍在）→ 允许进入 B，但 R4 作为已知风险继续挂在加固阶段 F。

> 本清单由主理人在评估机产出（设计态），**不消耗 Rust 工具链**；执行必须由具备工具链的目标机完成。
