# ADR-014：密岛 KeyIsland · Tauri 2 + Rust 接入前置架构评估

- **状态**：评估 / 提案（待 S0–S4 先行 Spike 结论后定稿）
- **日期**：2026-10-22
- **决策人**：架构师（高见远）
- **关联文档**：`SDD.md` v1.0（§2/§3/§5/§8/§13/§15）、`ADR-010`（TS 核心与存储端口，临时方案）、`prd.md` v1.0、`app/` 现有实现
- **环境前提**：本次评估机 **无 Rust / cargo / C 编译工具链**，因此本 ADR 仅产出设计文档与迁移计划，**不构建、不编译**。所有 Spike 与目标平台验证需在具备 Rust 工具链的 Windows 10/11 机器上执行。

---

## 1. 背景与目的

`SDD.md` 的目标架构即 **Tauri 2 + Rust + React + SQLCipher**（§2.1、§3、§5）。当前 `app/` 仓库是 Phase 0/1 的 **TypeScript 实现**：同一套 Vault 逻辑、同一套 UI，但加密跑在 `hash-wasm` + WebCrypto、存储为纯内存（`MemoryVaultStorage`）、剪贴板与热区均为浏览器能力。`ADR-010` 已显式把这套 TS 实现定位为"Tauri 落地前的临时方案"，并给出 Phase 1.5 迁移清单。

本 ADR 的目标，是对"把现有 Web/TS 工程接入 Tauri(Rust)"做**前置架构评估**，回答三件事：

1. 现有代码对 Tauri 的**就绪度**如何、可复用多少；
2. 集成的**推荐策略**与**关注点归属**（哪些留 TS、哪些必须下沉 Rust）；
3. 落地的**风险、先行 Spike、阶段路线与工作量**。

> 结论先说：现有架构对 Tauri 的就绪度**很高**，迁移的"应用逻辑"风险低；真正的高风险全部集中在 **Windows 平台能力**（SQLCipher 构建链、无焦点窗口输入、内存擦除可验证性、Hello、Native Messaging）。建议在完成 4 个先行 Spike（S0–S3）并确认可行后再全面铺开。

---

## 2. 现状盘点（已具备的 Tauri 就绪度）

| 现有资产 | 路径 | 对 Tauri 的意义 |
| --- | --- | --- |
| `VaultClient` 接口 | `app/src/services/vault-client.ts` | **与 SDD §5.2 command 契约 1:1 对应**（且是超集）。这是天然的"Tauri command 契约"，前端只依赖此接口。 |
| `VaultStorage` 端口 | `app/src/services/storage.ts` | 抽象了持久化。当前仅 `MemoryVaultStorage`；Tauri 下由 Rust `repository.rs` + SQLCipher 取代。 |
| `ClipboardPort` 端口 | `app/src/services/clipboard.ts` | 抽象了剪贴板能力。当前 `BrowserClipboardPort`（`navigator.clipboard`）；Tauri 下替换为 `TauriClipboardPort`（Win32 `OpenClipboard` + 序列号检测）。 |
| `core/crypto` | `app/src/core/crypto/{kdf,aead,random,digest,encoding}.ts` | Argon2id（参数版本化 `ARGON2_PARAMS_V1`）+ AES-256-GCM（AAD=`schemaVersion|itemId|fieldName`）。算法语义与 SDD §4.2 一致，是 Rust 端口的**参考实现 + 回归基线**。 |
| `core/vault` | `app/src/core/vault/*` | 密钥槽、会话状态机、冷却、可见性、最近使用、备份、审计——纯 TS、不依赖 React，可被 Rust 逐条对照实现。 |
| `VaultProvider`（Context 注入） | `app/src/app/VaultProvider.tsx` | 注释明确写道："Phase 1.5 换成 Tauri `invoke` 实现时，只需要替换这一处的实例来源。" |
| `SessionGate` | `app/src/features/session/SessionGate.tsx` | 监听 `visibilitychange` / `focus` 模拟系统锁屏。Tauri 下改为订阅 Rust 推送的 `session://*` / `system://*` 事件，状态机逻辑不变。 |
| `lib/hotzone.ts` | `app/src/lib/hotzone.ts` | 纯几何模块，注释声明："桌面版会把 `viewportWidth` 换成真实屏幕宽度，其余逻辑无需改动。" |
| `Island.tsx` | `app/src/features/island/Island.tsx` | 已区分 Web 与生产差异（Rust 侧窗口、`WS_EX_NOACTIVATE`）。 |
| 安全回归基线 | `app/tests/security/*.test.ts`（8 个文件） | 覆盖密钥槽双槽解包、篡改、隐藏卡访问、初始化回滚、会话边界、可见性、Phase2 回归、剪贴板隔离。**应保留为 Rust 端口的对照向量**。 |

**关键判断**：现有工程不是"一个需要推倒重来的 Web 原型"，而是一份**已经按 Tauri command 契约写好的 TS 参考实现**。迁移的本质是"把 backend 从进程内 TS 换成 Rust command，并把平台能力下沉"，**UI 几乎不动**。这是低风险的根本原因。

---

## 3. 目标架构（Tauri 2）

与 SDD §2.1 一致，落地形态为：

```text
+------------------------------+   invoke() / listen()
|   React + TS Renderer        |<--------------------------+
|   (WebView2, 仅 UI + DTO)   |                           |
|   features/*  stores/ui-store|                           |
|   services/vault-client.ts   |  TauriVaultClient 适配器   |
|     (实现 VaultClient 接口)   |                           |
+--------------+---------------+                           |
               | invoke('unlock_with_password', ...)        |
               v                                           |
+------------------------------+   Tauri event emit                        |
|   src-tauri (Rust)           |------------------------------------------>|
|   commands.rs  state.rs      |  session://* system://* clipboard://*     |
|   main.rs  tauri.conf.json   |  island://*                             |
|   capabilities/              |                                           |
+--------------+---------------+                                           |
               |                                                           |
+------------------------------+                                           |
|   app-commands (Rust services)                                          |
|   VaultService AuthService KeyslotService ItemService                   |
|   SearchService BackupService GeneratorService ClipboardService         |
|   WindowsService HotzoneService                                         |
+--------------+---------------+                                           |
               |                                                           |
+------------------------------+   crate: vault-core                       |
|   vault-core (Rust)          |                                           |
|   crypto.rs  keyslots.rs     |   DEK/KEK 永不出 Rust 进程                |
|   models.rs  repository.rs   |                                           |
|   backup.rs                  |                                           |
+--------------+---------------+                                           |
               |                                                           |
+------------------------------+   crate: windows-integration             |
|   SQLCipher SQLite  | AES-256-GCM | Argon2id                             |
|   Windows 热区/窗口/剪贴板/锁屏/Hello/ShellExecute                       |
+-------------------------------------------------------------------------+
```

完整分层 Mermaid 见 `ADR-014-target-architecture.mmd`。

---

## 4. 集成策略（核心结论）

### 4.1 推荐：**深移植（Rust 权威）**，而非"浅桥接"

存在两种集成深度：

- **浅桥接**：保留全部 TS 领域逻辑，仅把 `VaultClient` 调用经 `invoke()` 路由到 Rust command，Rust command 再调一份移植后的 Rust 逻辑。**但**这意味着 DEK 仍由前端 `ItemService` 持有（当前 `createItemService()` 接收 `dek`），明文在 WebView 的 JS 堆里解密——**直接违反 SDD §0.4"敏感操作全部经 Rust"与 §0 安全边界**。不可接受作为终态。
- **深移植**：把 `core/crypto`、`core/vault` 的敏感部分（密钥槽、会话/DEK 生命周期、ItemService 解密、备份、密码体检）整体下沉到 Rust `vault-core` / `app-commands`。前端 `VaultClient` 变为**薄异步代理**，只持有 `ItemSummary` / `ItemDetail` / `CopyReceipt` / `SessionState` 等 DTO，永不见 DEK。这满足 SDD §5.3 DTO 约束与 §0.4。

**本 ADR 推荐深移植**，并将现有 TS 代码定位为：① Rust 端口的**参考实现**；② 保留 `tests/security` 作为**语义回归基线**（ADR-010 第 8 条已要求）。

### 4.2 关注点归属矩阵（TS 留 / Rust 下沉）

| 关注点 | 当前位置 | Tauri 目标 | 理由 |
| --- | --- | --- | --- |
| Argon2id / AES-256-GCM / 随机数 | `core/crypto` (TS) | **Rust** `crypto.rs` | DEK 永不出 Rust |
| 密钥槽 create/unwrap/rewrap/rotate | `core/vault/keyslots` (TS) | **Rust** `keyslots.rs` | SDD §5.1 KeyslotService |
| 会话 / DEK / KEK 生命周期、冷却、锁定擦除 | `core/vault/session` (TS) | **Rust** `AuthService` | 前端只见 `SessionState` |
| Item CRUD / 可见性 / 收藏（含解密） | `core/vault/items` (TS, 持 dek) | **Rust** `ItemService` | 移除前端的 `dek` 持有 |
| 搜索（解密后内存检索） | `core/vault/search` (TS) | **Rust** `SearchService` | 明文仅存 Rust |
| 密码体检（逐条解密算摘要） | `core/vault/health` (TS) | **Rust** | 须解密 → 必须 Rust |
| 备份 .kib 导出/导入 | `core/vault/backup` (TS) | **Rust** `BackupService` | 加解密本就在 Rust |
| 剪贴板写入 + TTL 清理 + 覆盖检测 | `services/clipboard` (TS+浏览器) | **Rust** `ClipboardService` + Win32 | SDD §7.3 要求 |
| 存储 / SQLCipher | `MemoryVaultStorage` (TS) | **Rust** `repository.rs` | 前端不再持存储端口 |
| 热区检测 | `lib/hotzone` (TS, 视口) | **Rust** `HotzoneService` | 注入真实屏幕宽度 |
| 窗口管理（island/main/unlock/confirm） | DOM/React | **Rust** Tauri window + Win32 样式 | `WS_EX_NOACTIVATE` 等 |
| 系统锁屏/休眠事件 | `visibilitychange`（近似） | **Rust** Windows 会话事件 | 精确 |
| 密码生成 | `core/vault/generator` (TS) | **Rust** `GeneratorService` | 单一 RNG 源，SDD §5.1 |
| 审计日志 / 策略 / 回收站 | `core/vault/audit,policy,recency` | 可留 TS（非敏感）或 Rust | 建议 Rust（持久化更简） |
| 拼音搜索 | `core/vault/pinyin*` (TS) | **留 TS**（纯数据，非敏感） | ADR-013，无需下沉 |
| UI 组件 / 状态 / 快捷键 / 格式化 / i18n | `features/*` `stores/*` `lib/*` | **留 TS，几乎不动** | 仅改 VaultClient 来源与事件订阅 |

> 结论：**`features/`、`components/ui/`、`stores/`、`lib/`（除 hotzone 的视口参数）全部保留**；改动集中在 `services/vault-client.ts`（新增 Tauri 适配器）、`services/clipboard.ts`（Tauri 端口）、`App.tsx`/`VaultProvider`（换实例来源）、`SessionGate`（换事件订阅）、`lib/hotzone.ts`（注入屏幕宽度）。

### 4.3 命令桥接设计

- 新增 `createTauriVaultClient(): VaultClient`，内部用 `window.__TAURI__.invoke` 实现同一 `VaultClient` 接口；`createVaultClient()`（内存存储版）**保留给浏览器测试 harness**。
- DTO 序列化：**camelCase**，与现有 TS 类型（`ItemSummary`/`ItemDetail`/`CopyReceipt`/`SessionState`）一致，前端零改类型。
- `password` 作为 `invoke` 字符串参数跨 IPC 传入 Rust 解锁；**不在日志/磁盘出现**（Tauri IPC 不落盘）。解锁后前端仅持 `SessionState`。
- `copy_password(id)`：Rust 读密文 → 内存解密 → 写 Windows 剪贴板 → 登记摘要+定时清理 → 返回 `CopyReceipt`。**DEK 全程不越 Rust 边界**。
- `reveal_password(id)`（按住预览）：Rust 解密后把明文字符串回传 WebView，**瞬时展示、不进全局状态、pointerup/leave/blur/unmount/lock 立即丢弃**（SDD §5.2 约束）。此路径明文会触达 WebView 内存，属**残余风险**（JS 无法 `zeroize`），见 §6 R4。
- Rust → 前端通过 Tauri `emit` 推送：`session://locked`、`system://suspend|resume|workstation-locked`、`clipboard://cleared|overwritten`、`island://hotzone-enter|leave`。`SessionGate` 改订阅这些事件，状态机逻辑复用。

命令桥接时序（解锁 → 复制密码，体现 DEK 不越界）见 `ADR-014-command-bridge-sequence.mmd`。

---

## 5. 与现有 `VaultClient` 接口的对齐

- SDD §5.2 仅列举了"最小 command 契约"（约 18 个），但现有 `VaultClient` 接口实际有 **~50 个方法**（额外含 `rotateRecoveryKey`、`auditPasswordHealth`、`takeBackupReminder`、`getAuditLog`、`setAutoLockPolicy`、`setClipboardTtl`、`recoverWithKirk` 等）。
- **建议**：以现有 TS `VaultClient` 接口为**权威 command 契约**（它是已实现的超集），据此生成 Tauri command 清单；SDD §5.2 的文本视为"最小子集示例"。同步修订 ADR-010 第 4 条的"18 个方法"措辞，避免文档漂移。
- `recoverWithKirk` / `resetMasterPasswordWithKirk` 等 `.kirk` 路径在 SDD §5.2 未单列，需补进 command 清单（Rust 侧已有 `recover_with_code`，扩展 `recover_with_kirk`）。

---

## 6. 风险登记

| 编号 | 风险 | 来源 | 影响 | 缓解 / 先行 Spike |
| --- | --- | --- | --- | --- |
| R1 | **SQLCipher Windows 构建与签名链** | SDD §15 高风险① / ADR-003 | 阻塞整个持久化层 | S1：评估 bundled SQLCipher（rusqlite `sqlcipher` feature，静态链接 + 自签名）vs 系统 SQLCipher；确定 FIPS/合规要求 |
| R2 | **无焦点窗口（`WS_EX_NOACTIVATE`）接收键盘输入的兼容性** | SDD §15 高风险② / ADR-004 / §7.2 | 灵动岛核心取密闭环体验 | S2：优先"不激活窗口但收定向键盘输入"；不兼容则降级"点击热区激活岛窗口"（须设置说明，不偷抢焦点） |
| R3 | **锁定后明文内存擦除的可验证性** | SDR §15 高风险③ / ADR-010 负面② | DEK/明文残留 | S3：Rust `zeroize`/`azure` 验证；前端明文按"尽力而为"处理并文档化 |
| R4 | **WebView 内明文暴露（reveal_password）** | §4.3 残余 | JS 堆明文不可擦 | 限定为瞬时、不落状态、锁即弃；评估可否用一次性 DOM 文本节点 + 立即卸载降低残留 |
| R5 | **Windows Hello / 系统凭据 API 异常恢复** | SDD §15 高风险④ / ADR-005 | P1 快速解锁不可用 | S4：绑定系统凭据容器，PIN/生物不落库；异常回退主密码 |
| R6 | **Native Messaging 安装/权限** | SDD §15 高风险⑤ | P1 浏览器扩展填充 | P1 阶段单独 Spike |
| R7 | **迁移期"前端持 DEK"违规** | §4.1 浅桥接陷阱 | 安全回退 | 坚持深移植；在 `ItemService` 移除 `dek` 参数前不宣布集成完成 |
| R8 | **TS 参考实现与 Rust 端口行为漂移** | 双实现维护 | 回归基线失效 | 保留 `tests/security` 固定向量，并补 Rust 等价测试，CI 双跑 |

---

## 7. 必须的先行 Spike（环境前提）

> ⚠️ **本评估机无 Rust 工具链，以下 Spike 均无法在本环境执行**，必须在目标 Windows 机（Rust + cargo + WebView2 + VS Build Tools）完成，结论回填本 ADR 后才进入全面迁移。

- **S0｜工程脚手架**：Tauri 2 + Rust + React 空壳可启动/关闭/托盘运行；CI 能跑 `cargo test` 与前端测试。→ 出口：Phase 0 空壳（SDD §13）。
- **S1｜SQLCipher 构建链**：确定 bundled vs 系统方案与签名。→ 关联 ADR-003。
- **S2｜`WS_EX_NOACTIVATE` + 键盘输入**：验证灵动岛"唤起不抢焦点但能输入"。→ 关联 ADR-004。
- **S3｜内存擦除验证**：Rust `zeroize` 在释放路径生效的验证手段。
- **S4｜Windows Hello**：P1，但建议现在评估可行性（可延后到 P1）。

**Gate**：S0–S3 全绿，方可进入 Phase B–F。任一阻塞则需替代方案（如 SQLCipher 不可行→退而求其次的可审计加密存储，但**绝不降级为明文 SQLite**，ADR-003）。

---

## 8. 迁移路线图 / 阶段

| 阶段 | 内容 | 关键交付 | 依赖 |
| --- | --- | --- | --- |
| **A. 先行 Spike** | S0–S3（S4 可延 P1） | 可行性结论 + 工具链 | — |
| **B. Rust 核心移植** | `vault-core`（crypto/keyslots/models/repository/backup）+ Rust 测试（对照 `tests/security` 向量） | crate 通过测试 | A |
| **C. Tauri 外壳 + Commands** | `src-tauri`（main/commands/state/conf/capabilities）+ 窗口（island/main/unlock/confirm） | command 契约可用 | B |
| **D. 前端桥接** | `createTauriVaultClient`；`App`/`VaultProvider` 换源；`SessionGate` 换事件订阅；`hotzone` 注屏幕宽；移除生产存储依赖 | WebView 经 Tauri 跑通主路径 | C |
| **E. Windows 集成** | 热区轮询、锁屏/休眠事件、WDA_EXCLUDEFROMCAPTURE、ShellExecute、Hello(P1)、Native Messaging(P1) | 平台能力闭环 | D |
| **F. 加固与发布** | 常驻内存 < 80MB、启动默认锁定、0 网络、签名/安装包 | v1.0 内测包 | E |
| **G. P1 扩展** | 浏览器扩展 + Native Messaging、热键捕获、CSV 导入、拼音搜索（已 TS）、主动销毁、TOTP 等 | 按 SDD P1 | F |

任务依赖图见 `ADR-014-task-graph.mmd`。

### 8.1 工作量粗估（单工程师，可并行压缩）

| 阶段 | 人日 |
| --- | --- |
| A 先行 Spike（S0–S3） | 9–15 |
| B Rust 核心移植 + 测试 | 8–12 |
| C Tauri 外壳 + Commands | 6–8 |
| D 前端桥接 | 4–6 |
| E Windows 集成 | 6–10 |
| F 加固/签名/安装包 | 4–6 |
| **v1.0 闭环合计（A–F）** | **≈ 37–57 人日（约 8–11 周）** |
| G P1 扩展 | 按特性另计 |

> 注：现有 TS 参考实现 + 安全回归基线可显著压低 B/D 的实现与验证成本（"换实现不换设计"）。

---

## 9. 待澄清问题（请主理人/产品确认）

1. **集成深度**：确认走"深移植（Rust 权威，前端不持 DEK）"——而非"浅桥接"过渡？本 ADR 建议深移植（SDD §0.4 要求）。
2. **目标环境**：目标 Windows 机是否已具备 Rust/cargo/WebView2？本评估机无 Rust 工具链，S0–S4 无法在此执行。
3. **SQLCipher 方案**：bundled（静态链接+自签名）vs 系统 SQLCipher？涉及构建链与合规，需定 ADR-003。
4. **回归基线**：是否保留 `app/tests/security` 作为 Rust 端口固定向量，并补 Rust 等价测试？本 ADR 建议保留。
5. **发布节奏/仓库结构**：是否将 Tauri 集成直接作为 v1.0（SDD 既定目标），并把 `app/` 重组为 SDD §3 的 `apps/desktop` 结构（同仓 monorepo）？还是先发 Web 预览版再接入？
6. **`hash-wasm` 处置**：Tauri 生产构建中 `hash-wasm`（TS Argon2id）将不再被 crypto 路径使用，是否仅保留给浏览器测试 harness，从生产依赖移除？

---

## 10. 结论与建议

- **就绪度高**：现有 `app/` 是"按 Tauri command 契约写好的 TS 参考实现"，UI 几乎全可复用，迁移本质是"换 backend + 下沉平台能力"。应用逻辑风险低。
- **风险集中**：全部高风险都在 **Windows 平台能力**（R1–R3 为阻塞级）。
- **推荐动作**：① 以 `VaultClient` 接口冻结为权威 command 契约；② 采用**深移植**；③ 先完成 **S0–S3** 再全面铺开（Gate）；④ 保留 TS 安全测试为 Rust 回归基线。
- **Go / No-Go**：**建议 Go**，但**以 S0–S3 全绿为硬门槛**；任一阻塞需先有 ADR 记录的替代方案。

---

## 附录

- 目标架构图：`ADR-014-target-architecture.mmd`
- 命令桥接时序：`ADR-014-command-bridge-sequence.mmd`
- 集成类/模块图：`ADR-014-integration-classmap.mmd`
- 任务依赖图：`ADR-014-task-graph.mmd`
