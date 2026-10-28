# 密岛 KeyIsland · 阶段性开发记录

> 本文件由交付主理人维护，按阶段记录**实际执行结果**（命令输出、测试数字、缺陷与决策），不记录计划性描述。
> 对应设计文档：`../../SDD.md`、`../../prd.md`

---

## 阶段总览

| 阶段 | 范围 | 状态 | 单元测试 | 安全测试 | 构建 |
| --- | --- | --- | --- | --- | --- |
| Phase 0 | 工程骨架与测试基线 | ✅ 完成 | 140 | — | ✅ |
| Phase 1 | Vault 核心域 | ✅ 完成 | 140 | 62（含 2 个缺陷固化） | ✅ |
| Phase 1.1 | QA 缺陷修复 + 隐藏授权 | ✅ 完成 | 168 | 待第二轮翻转确认 | ✅ |
| Phase 2 | 主面板 / 灵动岛 / 解锁流程 | ✅ 完成（Web 阶段） | 223 | 98 | ✅ |
| Phase 4 前置 | `.kib` 备份与恢复 | ✅ 完成（文件层待 Tauri） | 258 | 98 | ✅ |
| Phase 5 前置 | 密码体检 | ✅ 完成 | 275 | 98 | ✅ |
| Phase 5 前置 | 拼音搜索 + 主动销毁回归 | ✅ 完成 | 300 | 98 | ✅ |
| Phase 2 补 | 灵动岛热区唤起（默认隐藏） | ✅ 完成（两轮 QA 复验通过） | 321 | 98 | ✅ |
| Phase 2 补 | 灵动岛无障碍语义与交互修复 | ✅ 完成（两轮 QA 复验通过） | 331 | 98 | ✅ |
| Phase 3/5 补 | 批量删除（主密码二次验证）+ 剪贴板粘贴 | ✅ 完成 | 353 | 98 | ✅ |
| Phase 3/5 补 | Windows 剪贴板历史风险提示（FR-05） | ✅ 完成 | 360 | 98 | ✅ |
| Phase 3/5 补 | 剪贴板清理「可关闭」档位 + QA 复验收尾 | ✅ 完成 | 373 | 98 | ✅ |
| 存量修复 | 冷却期错误码统一为 AUTH_COOLDOWN（四条路径漂移） | ✅ 完成 | 376 | 98 | ✅ |
| Phase 6 补 | 设置页数据文件位置展示（FR-06 P0） | ✅ 完成 | 382 | 98 | ✅ |
| Phase 6 补 | 灵动岛右键菜单（FR-02 P0） | ✅ 完成 | 391 | 98 | ✅ |
| Phase 6 补 | 灵动岛「生成密码」快捷按钮（FR-02 P0） | ✅ 完成 | 399 | 98 | ✅ |
| Phase 6 补 | 系统锁屏 / 休眠立即锁定（FR-01 P0） | ✅ 完成 | 411 | 98 | ✅ |
| Phase 6 补 | 卡片跳转目标二选一菜单（FR-07.1 P0） | ✅ 完成 | 417 | 98 | ✅ |
| Phase 6 补 | 恢复密钥轮换（FR-08.1 P0） | ✅ 完成 | 424 | 98 | ✅ |
| Phase 6 补 | 备份提醒（FR-06）+ 视图切换 / 自定义分类（FR-03）+ 桌面端开关（FR-05） | ✅ 完成 | 439 | 98 | ✅ |
| Phase 6 补 | 快捷键清单（可用性）+ 操作日志（可靠性） | ✅ 完成 | 458 | 98 | ✅ |
| Phase 6 补 | 热区宽度 / 位置可配置 + 全屏抑制（FR-02） | ✅ 完成（Web 近似） | 488 | 98 | ✅ |
| Phase 6 补 | 收起延时对齐 2 秒并可配置（FR-02 / SDD §6.5） | ✅ 完成 | 503 | 98 | ✅ |
| Phase 6 补 | 左侧导航「标签」分组（FR-03 P0） | ✅ 完成 | 508 | 98 | ✅ |
| Phase 6 补 | 灵动岛跳转入口（FR-07.1 P0） | ✅ 完成 | 515 | 98 | ✅ |
| Phase 6 补 | 销毁数据保护链补「主密码二次认证」（FR-08.4 P1） | ✅ 完成（擦除待桌面） | 523 | 98 | ✅ |
| Phase 6 补 | 恢复密钥找回的持久化回归（FR-08.3 验收） | ✅ 完成（发现 1 项待决策） | 528 | 98 | ✅ |
| Phase 7 | 快捷键可自定义（NFR 可用性） | ✅ 完成 | 562 | 98 | ✅ |
| Phase 8 | 卡片密码强度点（FR-03 可用性） | ✅ 完成 | 580 | 98 | ✅ |
| Phase 9 前置 | Tauri 接入架构评估（ADR-014，纯设计未构建） | ✅ 完成（设计） | — | — | — |

**Phase 1.5 阻塞原因**：开发机无 `cargo` / `rustc`，也无 C 编译器，无法构建 Tauri 与 SQLCipher。
已按 ADR-010 以 TypeScript 实现核心并保留 `VaultClient` / `VaultStorage` 端口，接口语义与 SDD §5.2 对齐，便于后续替换为 `invoke`。

---

## Phase 0 · 工程骨架

**产出**

- 工程根：`app/`（Vite 5 + React 18 + TypeScript 5 strict + Tailwind 3 + framer-motion 11 + Zustand 4）
- 测试栈：vitest 2 + jsdom 25 + @testing-library/react 16
- 脚本：`dev` / `build` / `test` / `test:run` / `test:watch` / `typecheck`
- 分层：`src/core`（纯领域）、`src/services`（服务与适配器）、`src/stores`、`src/features`、`src/components`
- 决策记录：`docs/adr/ADR-010-ts-core-and-storage-port.md`、`ADR-011-recovery-code-format.md`

**验收**

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过，0 error |
| `npm run build` | 通过，1937 modules，`index.js 262.01 kB (gzip 85.97 kB)` |

> 注：`hash-wasm` 内联 Argon2id wasm 是首包体积主因，Phase 2 之后可改动态加载。

---

## Phase 1 · Vault 核心

**产出模块**

| 模块 | 文件 | 关键实现 |
| --- | --- | --- |
| 密钥派生 | `src/core/crypto/kdf.ts` | Argon2id，参数版本化，拒绝未知版本 |
| 字段加密 | `src/core/crypto/aead.ts` | AES-256-GCM，12 字节随机 nonce，AAD = `schemaVersion\|itemId\|fieldName` |
| 双密钥槽 | `src/core/vault/keyslots.ts` | DEK 32B，KEK-A/KEK-B 各自独立 salt 与 nonce，槽记录带 AAD 防调换 |
| 恢复材料 | `src/core/vault/recovery.ts` | Crockford Base32 分组恢复码 + `KIRK1` 文件 |
| 会话 | `src/core/vault/session.ts` | 默认 30 分钟自动锁定，5 次失败后 30s→300s 递增冷却，锁定清零 DEK |
| 资产 | `src/core/vault/items.ts` | CRUD、三档可见性、降级保护 |
| 搜索 | `src/core/vault/search.ts` | 单次 O(n)，三种排序，hidden 永不入结果 |
| 最近使用 | `src/core/vault/recency.ts` | 上限 6，按复制时间倒序，删除即清理 |
| 生成器 | `src/core/vault/generator.ts` | CSPRNG，12–64 位，每类至少一个 |
| 剪贴板 | `src/services/clipboard.ts` | 只存 SHA-256 摘要，覆盖检测，TTL 清理 |
| 存储端口 | `src/services/storage.ts` | `VaultStorage` 接口 + `MemoryVaultStorage`（**不落盘、不用 localStorage**） |
| 门面 | `src/services/vault-client.ts` | 19 个 Promise API，统一 `AppError` |

**验收（工程师自测）**

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test:run` | 11 files / **140 tests 全通过**，57.88s |
| `npm run build` | 通过，24.25s |

**QA 独立验收（第一轮）**

结论：**FAIL（1 × P1，5 × P2，0 × P0）**，安全边界全部成立。

| 编号 | 问题 | 位置 | 处置 |
| --- | --- | --- | --- |
| P1-1 | 会话解锁用构造参数而非槽内 `kdfParams`，调参后密码正确也解不开 | `session.ts:262` | 已修 |
| P2-1 | 初始化非原子，`saveItems` 失败后磁盘残留密钥槽 | `vault-client.ts:259-270` | 已修 |
| P2-2 | 门面层 `includeHidden` 无二次认证；隐藏详情反而打不开 | `vault-client.ts:340-350` | 已修（新增授权 API） |
| P2-3 | 冷却状态与 DEK 持有不一致 | `session.ts:162-178` | 已修（冷却强制回锁） |
| P2-4 | KDF 参数缺上界，可被构造极端值造成 DoS | `kdf.ts:61-80` | 已修 |
| P2-5 | `initialize()` 的 `recoveryCode` 入参未使用 | `session.ts:223-249` | 已修（一致性断言） |
| P2-6 | 剪贴板登记晚于调度，同步 scheduler 下会漏清理 | `clipboard.ts:163-166` | 已修 |

QA 新增对抗性测试：`tests/security/**` 6 文件 / 62 用例（60 正向 + 2 个 `it.fails` 固化缺陷）。
覆盖：GCM 篡改（密文/AAD/密钥/版本）、双槽互换、槽级参数篡改、冷却绕过、hidden 三重隔离、剪贴板隔离与摘要、初始化回滚。

---

## Phase 1.1 · 缺陷修复与隐藏授权

**修复结果（工程师）**

| 项 | 改法 |
| --- | --- |
| P1-1 | `unlock()` 改用 `resolveArgon2Params(record.kdfParams)`；新增 `record.slot === 'password'` 断言（不计入失败次数） |
| P2-1 | 失败分支 `await storage.clear()` + `loaded = false`，可重试 |
| P2-2 | 新增 `requestHiddenAccess(password)`（120s 窗口）；`includeHidden` / `allowHidden` 均绑定授权；锁定、`dispose`、到期即撤销 |
| P2-3 | `LockReason` 增 `'auth_cooldown'`；进入冷却时若持有 DEK 立即清空 |
| P2-4 | `ARGON2_PARAM_LIMITS`：memory ≤ 1 GiB、iterations ≤ 10、parallelism ≤ 8、saltLength = 16 |
| P2-5 | 生成 DEK 前 `assertRecoveryMaterialConsistent()`，不一致抛 `VALIDATION_FAILED` |
| P2-6 | `pending.set()` 提前到 `schedule()` 之前 |

**验收**

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test:run` | 16 files / **168 tests 全通过**，77.35s（原 140 条零回归 + 新增 28 条） |
| `npm run build` | 通过，`index.js 262.01 kB (gzip 85.97 kB)` |
| `npx vitest run --config vitest.security.config.ts` | 4 failed / 58 passed —— **4 条红灯均为"缺陷已消失"**，符合预期 |

**决策记录**

- 冷却期 `requestHiddenAccess` 返回 `AUTH_COOLDOWN`（可重试语义），而资产接口返回 `VAULT_LOCKED`（DEK 已清）。刻意区分，避免 UI 把"冷却中"误显示为"已锁定"。
- 隐藏卡片授权窗口 120 秒，凭主密码二次校验，不改会话状态、不延长自动锁定。
- `revealPassword` 只在组件本地 state 持有，`pointerup/leave/blur/卸载/锁定` 立即清空，禁止进入 Zustand。

---

## Phase 2 · 主面板与灵动岛

**范围**：会话门、首次设置、解锁与恢复、主面板、TiltCard、灵动岛、编辑器、隐藏授权弹窗、设置页。

**状态**：✅ 完成（前端 Web 阶段）。无 P0/P1 未关闭项；QA 建议的 5 个 P2 已在本阶段收尾处理并补充回归覆盖。

**交付文件与组件**

- 会话与入口：`src/App.tsx`、`src/app/VaultProvider.tsx`、`src/features/session/SessionGate.tsx`
- 首次设置与解锁：`src/features/setup/SetupWizard.tsx`、`src/features/unlock/UnlockScreen.tsx`、`RecoveryFlow.tsx`
- 主面板与资产：`src/features/vault/MainPanel.tsx`、`ItemCard.tsx`、`ItemEditor.tsx`、`HiddenAccessDialog.tsx`
- 灵动岛与设置：`src/features/island/Island.tsx`、`src/features/settings/SettingsPanel.tsx`
- UI 基础组件：`src/components/ui/{Button,Badge,Field,Modal,Toast,PasswordStrength}.tsx`
- Phase 2 门面能力：`src/services/vault-client.ts`（隐藏授权、密码预览、恢复文件、策略设置、清库）
- Phase 3/4 前置：`src/core/vault/backup.ts`（KIB1 AES-256-GCM 加密备份编解码核心，待接入文件适配器）
- Phase 2 测试：25 个前端测试文件；安全套件 8 个文件；新增 `tests/security/phase2-regression.test.ts` 与 `ItemCard.reveal-safety.test.tsx`

**验收命令与实际结果**

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | ✅ 0 error |
| `npx vitest run` | ✅ 26 files / **223 tests passed**，151.89s |
| `npx vitest run --config vitest.security.config.ts` | ✅ 8 files / **98 tests passed** |
| `npx vite build --outDir .build-verify --emptyOutDir false` | ✅ 1993 modules；JS 389.19 kB / gzip 129.11 kB；27.02s |

**QA 第三轮结论**

- ✅ 无 P0/P1；hidden 卡片四类写操作均在未授权时返回 `ITEM_HIDDEN`，授权后可用，授权过期后重新拒绝。
- ✅ `normal` / `username_only` / `hidden` 三档预览与复制边界符合 PRD；密码预览不写剪贴板、不污染最近使用，失焦、离开、卸载和锁定均清空明文。
- ✅ 前端运行时无 `localStorage`、`sessionStorage`、IndexedDB、Cookie 或 console 输出；状态仓不保存 password、DEK、恢复码或主密码。
- ✅ `resetVault`、`.kirk` 恢复、主密码重设、自动锁定策略、剪贴板 TTL 与密码提示均完成边界验证。

**浏览器冒烟结论（localhost:4180）**

- ✅ 弱密码 `abc` 被拦截；强密码 `KeyIsland!2026` 可完成首次设置。
- ✅ 恢复码未勾选时“进入密岛”保持禁用，勾选后可进入；主面板分类、设置、立即锁定和新建卡片入口均渲染。
- ✅ 新建卡片后密码默认遮蔽，页面文本不含明文；复制密码成功写入剪贴板桩。
- ✅ 灵动岛展开后可搜索；`Enter` 复制密码、`Shift+Enter` 复制账号、`Esc` 收起；最近使用资产可被键盘路径选中。

**Phase 2 收尾 P2**

- 自动锁定倒计时归零主动刷新会话并卸载主面板，避免资产摘要残留。
- 隐藏授权关闭或到期时清空缓存列表并退出隐藏分类。
- 新 client 从持久化 meta 回读 `clipboardTtlMs`。
- `resetVault` 仅允许解锁态调用。
- `allowHidden` 只对目标确实为 hidden 的资产要求二次授权。

---

## Phase 4 前置 · 备份与恢复（.kib）

**范围**：KIB1 加密备份编解码、导出/导入门面能力、设置面板接入、冲突模型。

**产出**

| 模块 | 文件 | 要点 |
| --- | --- | --- |
| KIB1 编解码 | `src/core/vault/backup.ts` | `magic=KIB1/version=1`，Argon2id + AES-256-GCM 加密 payload，AAD=`KIB1\|1`；明文含 items/keyslots/meta/recency |
| 覆盖/合并 | `src/core/vault/backup.ts` | `mergeBackupItems` 撤销明文按业务字段比较：完全一致跳过、同站点冲突保留当前版本并上报、缺失资产按新 id 插入 |
| 世系校验 | `src/core/vault/backup.ts` | `isSameKeyLineage`：合并导入要求备份与当前库同 DEK 世系（密文才能被当前会话解开） |
| 门面 API | `src/services/vault-client.ts` | `exportBackup(password)` / `importBackup({kirkJson, password, mode})`；覆盖为事务式写入 + 逆序回滚，成功后回锁定态 |
| UI | `src/features/settings/SettingsPanel.tsx` | 导出（备份密码 + `.kib` 下载）、导入（文件选择/粘贴 + 备份密码 + 合并/覆盖模式 + 覆盖确认词） |
| 决策 | `docs/adr/ADR-012-kib-backup-merge-scope.md` | 记录合并导入必须同 DEK 世系，以及为什么按明文而非密文比较 |
| 测试 | `src/core/vault/__tests__/backup.test.ts`(3)、`src/services/__tests__/vault-client-backup.test.ts`(6)、`src/features/settings/__tests__/SettingsBackup.test.tsx`(3) | 编解码边界、跨机覆盖、锁定拒绝、失败回滚、冲突/跳过/插入、跨库合并拒绝、UI 文案与下载 |

**设计结论**

- 备份文件外层不含主密码、账号或密码明文；导入只用备份密码解一层外壳。
- 覆盖导入必须先持有解锁态；导入完成后回到锁屏，避免"刚导入的库直接摊开在屏幕上"。
- 跨库备份不能合并：备份资产密文用的是源库 DEK，合并只会产生无法解密的坏卡片，
  因此明确拒绝并提示改用覆盖导入（见 ADR-012）。

**尚未完成**

- 真实文件系统适配（当前导出走浏览器下载，导入走文件选择/粘贴）。
- 覆盖导入的"二次确认 + 主密码验证"目前由覆盖确认词代替，Windows Hello 接入后再补强。

---

## Phase 3 前置 · 恢复文件与灵动岛快捷新建

| 项 | 文件 | 结果 |
| --- | --- | --- |
| `.kirk` 文件选择 | `src/features/unlock/RecoveryFlow.tsx` | 恢复页支持文件选择导入，粘贴内容降级为兜底；非 `.kirk` 文件被拒绝，粘贴会清掉"已载入文件"标记 |
| `Blob.text` 兼容 | `RecoveryFlow.tsx` / `SettingsPanel.tsx` | 部分 WebView 与 jsdom 没有 `Blob.text()`，回退 `FileReader`（测试环境即走此分支） |
| 示例数据入口 | `src/features/settings/SettingsPanel.tsx` | 「载入示例数据」只在 `import.meta.env.DEV` 下渲染；生产构建产物中已 grep 不到该文案 |
| 灵动岛快捷新建 | `src/features/island/Island.tsx` | 岛内建卡：标题 + 可选账号 + CSPRNG 生成密码（可重新生成），创建后立即复制密码并收起岛 |

新增测试：`RecoveryFlow.test.tsx`(4)、`IslandQuickCreate.test.tsx`(4)、设置面板备份文件选择(1)。

---

## Phase 3/4 收口 · 导入安全加固与 CSV 迁移

| 项 | 文件 | 结果 |
| --- | --- | --- |
| 覆盖导入二次确认 | `src/services/vault-client.ts` | 覆盖模式必须额外提供**当前库主密码**（SDD §9.2），错误密码抛 `AUTH_INVALID` 且密钥槽不被替换；缺密码抛 `VALIDATION_FAILED` |
| 覆盖导入 UI | `src/features/settings/SettingsPanel.tsx` | 覆盖模式下新增「当前库主密码」输入与「覆盖」确认词，两个条件都满足才提交 |
| CSV 解析 | `src/core/vault/csv-import.ts` | 纯函数解析：引号/转义/CRLF/BOM、中英文表头别名映射（名称/账号/密码/网址/备注）、缺列报错、坏行给出跳过原因（不丢内容） |
| CSV 导入 UI | `src/features/settings/SettingsPanel.tsx` | 「从 CSV 迁移」区：选文件→预览条目数与跳过行→确认导入；界面只显示标题与账号，**不渲染密码明文**；明文告警提示删除源文件 |
| 测试 | `csv-import.test.ts`(5)、`SettingsCsvImport.test.tsx`(3)、`SettingsBackup.test.tsx`(+1)、`vault-client-backup.test.ts`(+1) | 覆盖导入主密码校验、CSV 解析边界、预览不泄漏密码、导入后真实入库 |

---

## Phase 5 前置 · 密码体检（设置面板）

| 项 | 文件 | 结果 |
| --- | --- | --- |
| 体检核心 | `src/core/vault/health.ts` | `summarizeHealth`：按 SHA-256 摘要分组识别重复密码（≥2 张才计入）、弱密码、超过 365 天未修改；`DuplicateGroup` 带 `titles` 便于展示，结构里没有明文字段 |
| 门面 API | `src/services/vault-client.ts` | `auditPasswordHealth()`：需解锁态，逐条解密取摘要，`hidden` 卡片同样参与体检；明文字段只在循环内存活 |
| UI | `src/features/settings/SettingsPanel.tsx` | 「密码体检」区：开始体检 → 摘要（共检查 N 张 / 重复 N 组 / 弱密码 N / 长期未修改 N）→ 每条 finding 只给标题与原因；可「清除结果」；健康时给空态文案 |
| 定位联动 | `SettingsPanel.tsx` + `MainPanel.tsx` | 新增可选回调 `onLocateItem(title)`：点「定位」关闭设置、切到「全部」分类并用标题填充主面板搜索框后聚焦 |
| 测试 | `health.test.ts`(8)、`vault-client-health.test.ts`(3)、`SettingsHealth.test.tsx`(6) | 分组与降序、弱/过期判定（注入时钟推进 375 天）、锁定态拒绝、DOM 中不含密码明文、定位回调传参、结果可清除 |

**验收**

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过，0 error |
| `npx vitest run` | 39 文件 / 275 用例全部通过 |
| `npx vitest run --config vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build` | 通过，`index.js 409.88 kB (gzip 135.66 kB)` |

**设计结论**

- 体检报告**只含摘要**：重复靠 SHA-256 分组，UI 只渲染标题与原因，`document.body.innerHTML` 断言确认明文不外泄。
- 解锁态是体检前置：没有 DEK 就算不出摘要，锁定态直接走统一的 `VAULT_LOCKED` 中文文案。
- 「定位」不新增数据通路，只是把标题灌进既有搜索框，避免为体检单独造"打开某个卡片"的接口。

---

## Phase 5 前置 · 拼音搜索与主动销毁回归

| 项 | 文件 | 结果 |
| --- | --- | --- |
| 拼音数据 | `src/core/vault/pinyin-data.ts` | 《通用规范汉字表》8105 字最常用读音（`mozillazg/pinyin-data` 的 kMandarin_8105），剥离声调后按「汉字+读音」连续串编码共 7909 条，顺序解析无歧义（生成时往返自校验） |
| 拼音检索 | `src/core/vault/pinyin.ts` | `pinyinCandidates(text)` 产出全拼串与首字母串：按「中文/ascii 字母数字」切段，标点空格为段边界，段间 `\u0000` 断开防跨段误匹配，表外字符同样断开 |
| 搜索接线 | `src/core/vault/search.ts` | `matchesText` 在查询为纯 ascii 字母/数字时才进入拼音分支，字段覆盖标题/平台/账号/分类/标签；`hidden` 过滤逻辑不变 |
| 门面测试 | `src/services/__tests__/vault-client-pinyin-search.test.ts` | 通过 `client.searchItems` 用 `tb` / `taobaowang` / `gouw` 命中中文资产；未授权时 `includeHidden` 仍抛 `ITEM_HIDDEN` |
| 主动销毁 | `src/features/settings/SettingsPanel.tsx`（既有实现） | 确认词 + 解锁态双条件；`resetVault` 后 `onSessionChange(await client.status())` 使 `SessionGate` 渲染设置向导（回到首次设置），本轮补上 E2E-09 回归 |
| 决策 | `docs/adr/ADR-013-pinyin-search.md` | 记录数据来源、段内子串语义，以及三条已知取舍（多音字取最常用读音、表外字符断开、不做分词/声调） |
| 测试 | `pinyin.test.ts`(12)、`search.test.ts`(+7)、`vault-client-pinyin-search.test.ts`(3)、`SettingsDestroy.test.tsx`(3) | 表解析、段边界、表外断开、多音字取舍固化、首字母/全拼命中、1000 条检索 < 50 ms、销毁后重新初始化、锁定态拒绝 |

**验收**

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过，0 error |
| `npx vitest run` | 41 文件 / 300 用例全部通过（已清理两个历史遗留调试测试文件 `src/__dbg*`） |
| `npx vitest run --config vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build` | 通过，`index.js 442.99 kB (gzip 168.29 kB)` |

> 体积说明：相比上一轮 409.88 kB（gzip 135.66 kB）增加约 32 kB gzip，全部来自静态拼音表；
> 权衡见 ADR-013（本地检索场景不引入 npm 拼音库）。

**已知取舍（有测试固化）**

- 「银行」首字母是 `yx` 而非 `yh`：表里「行」取最常用读音 xíng。输入 `yh` 命中不到，输入 `yx` / `yinxing` 可以。
- 表外字符（生僻字、emoji）会断开候选串：`中X文` 不会被 `zw` 命中，避免误匹配。
- 已清理 2 个调试期遗留的测试文件（`src/__dbg/dbg.test.ts`、`src/__dbg5.test.tsx`），它们此前一直运行在正式测试套件里。

---

## 灵动岛热区唤起（SDD §1 Web 阶段落地）

**需求**：灵动岛默认完全藏起来，鼠标推到屏幕顶端才滑出，离开又藏起来。生产版的真实全局热区由 Rust 窗口层实现（`WS_EX_NOACTIVATE` / 原生轮询，属 Phase 1.5），本轮在 Web 侧落地同样的时序，便于后续替换。

**改动**

| 项 | 文件 | 说明 |
| --- | --- | --- |
| 默认隐藏 | `src/features/island/Island.tsx` | 新增 `revealed` 本地状态；非唤起态只渲染热区命中带与键盘唤出入口，搜索框 / 折叠胶囊 / 展开面板都不进 DOM。表面渲染条件为 `revealed \|\| phase !== 'collapsed'`（后者保证既有测试直接用 store 操作 phase 时仍可用） |
| 热区命中带 | `Island.tsx` | `fixed`、`top-0`、`h-1`（4px）、`pointer-events-auto`、无背景无边框、`aria-hidden="true"`、`data-testid="island-hotzone"`；独立存在，不依赖灵动岛已渲染 |
| 唤起监听 | `Island.tsx` | `window` 上同时监听 `pointermove` 与 `mousemove`（均 `{ passive: true }`），`clientY <= 4` 唤出 |
| 迟滞与延时 | `Island.tsx` | `HYSTERESIS_LIMIT_PX = 48`：指针在 4–48px 之间不隐藏，**并取消已排队的隐藏**（否则从下方快速回到顶端附近时仍会被那次旧定时器藏掉）；`HIDE_DELAY_MS = 250`：隐藏前延时，卸载时清理定时器 |
| 指针在岛内判定 | `Island.tsx` | `isPointerInside(event.target)`：target 是面板或胶囊的子孙节点就视为"在岛内"，取消隐藏与收起并直接返回。**这是修掉 P0-1 的关键**——只看 `clientY > 48` 会把 306px 高的面板当成"已离开" |
| 键盘可达 | `Island.tsx` | 新增 `role="button"` + `aria-label="唤出灵动岛"` 的唤出按钮：88×4px、`opacity-0`、`position: fixed; top:0; left:50%; translateX(-50%)`；刻意不用 `display:none` / `visibility:hidden`，否则 Tab 不到。聚焦或 Enter/Space 即唤出并展开，焦点落到搜索框（复用既有 `openIsland` + 展开自动聚焦流程）。Tab 到它时用 `group-focus-visible` 显示一条 24px 高、带「密岛」字样的深色条，满足 WCAG 2.4.7 的可见焦点 |
| 不抢焦点/不拦截点击 | `Island.tsx` | 隐藏态页面主体上没有任何全屏遮罩；除命中带与唤出按钮外没有可命中元素 |

**热区阈值与迟滞参数**：命中带 `4px`；迟滞带 `4–48px`（不隐藏且取消已排队的隐藏）；隐藏延时 `250ms`；展开态收起动画 `180ms`。

> **行为契约变更（如实记录）**：SDD §6.5 写的是「离开面板 2 秒后收起」（`COLLAPSE_DELAY_MS = 2000`）。热区唤起模式下，250ms 的隐藏会先到期并直接撤掉表面，所以那 2 秒收起实际上**不会再发生**——`scheduleCollapse()` 仍会被调用，但总是被 `scheduleHide()` 抢先。这符合用户本轮的要求（"离开就藏起来"），但属于对 SDD 的覆盖。若后续要保留两段式收起（先收成胶囊、再整体隐藏），需要和 Phase 1.5 的原生热区一起重新设计时序。

**键盘优先的边界（本轮踩到的坑）**：展开态会**自动聚焦**搜索框，若隐藏定时器只看"内部有焦点"，鼠标唤出的面板就永远收不起来。保护条件最终收紧为三类明确意图：`键盘唤出`（`keyboardSummonedRef`）或 `已输入搜索词` 或 `快捷新建表单开着`（`createOpenRef`，修 P0-2 时补上——否则用户填到一半的标题会被静默丢弃）。三者都要叠加 `hasInternalFocus()` 才顺延隐藏。

**顺带修的一致性缺口**：岛内搜索原本是自己拼 haystack 做 `includes`，只认标题/平台/账号/分类、不支持标签与拼音，出现"主面板搜得到、岛里搜不到"。现改为复用 `src/core/vault/search.ts` 的 `matchesText`（含拼音全拼与首字母、含标签），仍只过滤不排序，保持 `getRecentItems` 的最近使用顺序；`Island.test.tsx` 新增 1 条用例（`gsyx` 与 `gongsiyouxiang` 都能命中「公司邮箱」）。

**新增测试**：`src/features/island/__tests__/IslandHotzone.test.tsx`（18 条）——初始无表面、命中带不遮页面、顶端唤出、离开 250ms 隐藏、迟滞带不隐藏、**迟滞带取消已排队的隐藏**、展开态离开收起并隐藏、键盘唤出并聚焦搜索框、Enter 唤出、锁定态唤出、键盘优先不收起、输入搜索词顺延且清空后恢复、**面板内移动不误判离开（P0-1 回归）**、**胶囊区域内移动不隐藏**、**快捷新建表单在鼠标移出后仍保留输入（P0-2 回归）**、**Esc 收起后胶囊不残留**、**点击外部收起后胶囊不残留**、Esc 在新建里只退出新建。

**QA 独立复验（第二层）**：QA 用自写用例（与工程实现零共享代码）跑出 2 个 P0，均已修复并固化为上面的回归用例：

| 编号 | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| P0-1 | 鼠标在展开面板内往下移动（y≈120）→ 250ms 后面板消失，点列表项/点「新建」几乎不可能完成 | 隐藏判断只看 `clientY > 48`，而面板高 306px，除顶部几十 px 外全被判成"已离开" | `isPointerInside(event.target)` 优先判定，命中即取消隐藏与收起 |
| P0-2 | 鼠标唤出 → 点「新建」填标题 → 鼠标一动，表单被销毁、输入静默丢失 | `workingOnKeyboard` 只认"键盘唤出"和"有搜索词"，没把快捷新建算进去 | 并入 `isUserWorking()`，用 `createOpenRef` 读最新值 |
| P2-1 | Esc / 点外部收起后胶囊残留 | `revealed` 只在隐藏路径复位 | 两处主动 dismiss 都补 `setRevealed(false)` |

QA 还指出：验收表曾有一行 markdown 破损（已修）、SDD §6.5 的 2 秒收起语义被覆盖（已在上面如实记录）、锁定态分支在生产中不可达（`SessionGate` 在非解锁态只渲染 `UnlockScreen`，`Island` 不挂载，属组件孤立行为）。

**第二轮复验（回归）**：QA 用自己重写的 5 条取证用例复跑，结论"可以合并，无 P0"，但指出两处未闭环，已一并修掉：

| 编号 | 现象 | 修复 |
| --- | --- | --- |
| P1-1 | P0-2 的保护仍要求"岛内还有焦点"：点一下面板空白，`activeElement` 退回 body，填了一半的标题照样被销毁 | `scheduleHide` 里把 `createOpenRef` 提到**无条件**顺延，不再叠加 `hasInternalFocus()` |
| P2-1（新路径） | 主动 dismiss 不复位表单状态 → 重唤出看到残留标题，且 `createOpen` 恒真使隐藏永久顺延、岛再也收不起来 | 新增 `resetCreateState()`，Esc / 点击外部 / 创建成功后都调用 |
| P2-2 | `isPointerInside` 只看 `event.target`，面板 30px 圆角外的四角窄条上 target 会退化成 body | 补 `getBoundingClientRect()` 坐标兜底（jsdom 里 rect 全 0，自动跳过该分支） |

新增 2 条用例：**焦点丢失后鼠标离开不销毁表单**、**dismiss 后重唤出无残留表单且自动隐藏重新生效**。

**jsdom 实测结论**：本组合里 `window.PointerEvent === undefined`，`fireEvent.pointerMove(window, {clientY})` 派发的是**不带坐标**的普通 `Event`（`clientY === undefined`）。因此测试统一用 `fireEvent.mouseMove`；组件侧对 `clientY` 非数字的事件直接忽略（真实浏览器一定有坐标，不能反过来"没坐标就当顶部"）。

**取舍**

1. **动效**：灵动岛本来就没有 framer-motion 过渡（纯 CSS `transition`），本轮沿用既有实现，未新增滑入动画；`prefers-reduced-motion` 下原本就不存在位移/缩放类岛体动画（仅有卡片组的 hover:scale，与岛无关）。
2. **`revealed || phase !== 'collapsed'`**：让 store 直改 phase 的既有用法继续可用，避免为兼容而改测试语义。
3. **锁定态可唤出**：原热区只在解锁态 `openIsland`，现在锁定时也唤出胶囊（提示"已锁定"），点击走 `onRequestUnlock`，与 SDD §6.5 的 `LOCKED_COLLAPSED` 对齐。
4. **键盘唤出后可能滞留**：键盘唤出且焦点仍在岛内时，指针怎么移动都不会收起（这正是键盘用户要的），面板只能靠 Esc 或点击外部收场。面板只显示标题与账号、不含密码明文，且单击任意处即可收起，暂按 P2 保留。
5. **命中带会吃掉页面顶端 4px 的点击**：全宽 4px 的透明带 `pointer-events: auto`，页面最顶部 4px 的点击会落在它上面（不会误触发任何动作，只是丢失点击）；顶部中央 88px 的唤出按钮被点中会直接展开面板，与"悬停只唤出胶囊"略有差异，属键盘可达性的必要代价。

**验收**

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过，0 error |
| `npx vitest run` | 42 文件 / 321 用例全部通过 |
| `npx vitest run --config vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vitest run src/features/island` | 3 文件 / 32 用例全部通过 |
| `npx vite build` | 通过，`index.js 445.47 kB (gzip 168.91 kB)` |

> 计数说明：上一节记录的 43 文件 / 321 用例里含两个 QA 临时取证文件（`src/__qa_hotzone`、`src/__qa_verify`，共 10 条用例），其中一个文件还带着 2 条**故意失败**的 P0 取证用例。经用户确认后已删除，本表只统计产品用例。

---

## 灵动岛列表无障碍语义与空态分流（SDD §12 落地）

**需求**：岛内列表此前只有 `role="listbox"`/`role="option"` 的骨架，搜索框是个裸 `<input>`，↑/↓ 切换高亮对屏幕阅读器**完全不可见**；同时空态副文案不分场景，用户明明有卡片、只是关键词打错，也被劝去"复制一张卡"。

**改动**

| 项 | 文件 · 行号 | 说明 |
| --- | --- | --- |
| 搜索框升格为 combobox | `Island.tsx:712-730` | 补 `role="combobox"`、`aria-expanded={unlocked && visible.length > 0}`、`aria-controls="island-listbox"`、`aria-autocomplete="list"`、`aria-activedescendant` |
| `aria-activedescendant` 防空指针 | `Island.tsx:720-724` | 三元里**先判** `visible[activeIndex] !== undefined` 再取 `.id`。TS strict 下不能靠 `visible[activeIndex]?.id` 拼字符串——`activeIndex` 被 `Math.min` 夹到 `visible.length - 1`，列表清空那一刻仍可能算出 `0`，直接模板拼接会渲染出 `island-option-undefined`，屏幕阅读器会去找一个不存在的节点 |
| listbox 显式 id | `Island.tsx:839` | `<ul id="island-listbox" role="listbox" aria-label="最近使用">`，与 `aria-controls` 对齐 |
| option 显式 id | `Island.tsx:841-845` | `<li>` 上补 `id` = `"island-option-" + item.id`、`role="option"`、`aria-selected={index === activeIndex}`；id 必须与 `aria-activedescendant` 逐字符一致 |
| 活动项滚进可视区 | `Island.tsx:481-501` | `useEffect` 依赖 `[activeIndex, visible.length, revealed]`：`panelRef.current?.querySelector('[aria-selected="true"]')` 取当前项，`scrollIntoView({ block: 'nearest' })` |
| 空态副文案分流 | `Island.tsx:827-837` | `needle.length === 0` → 「复制任意卡片后会自动出现在这里」；`needle.length > 0` → 「换个关键词试试，或点右上角「新建」建这张卡」 |

**`scrollIntoView` 必须做能力守卫**：jsdom 没有实现它，直接调用会让**所有** island 用例集体抛 `TypeError`。这里用 `typeof selected.scrollIntoView === 'function'` 守卫（`Island.tsx:498`），与 `isPointerInside` 里 `getBoundingClientRect()` 的处理方式一致。另外刻意**不加** `behavior: 'smooth'`：连续按 ↓ 时平滑滚动会排队、视觉上发卡。

**为什么不给 `<li>` 加 `tabIndex`**：combobox 模式要求焦点**始终停在输入框**、靠 `aria-activedescendant` 播报高亮项；给 option 加 `tabIndex` 会让焦点跑进列表，与 ↑/↓ 的键盘处理（监听在面板上）冲突，也让「输入即搜索」的闭环断掉。

**新增测试**（`src/features/island/__tests__/Island.test.tsx`，8 → 11 条）

| 用例 | 断言要点 |
| --- | --- |
| `aria-activedescendant 跟随 ↑/↓ 指向当前高亮项（SDD §12）` | `role`/`aria-expanded`/`aria-controls`/`aria-autocomplete` 四件套；初始指向第 0 项且 `document.getElementById(id)` 确实能拿到 `role="option"` 节点（**直接堵死 `island-option-undefined`**）；↓ 后指向第 1 项且其 `aria-selected="true"`；↑ 后回到第 0 项 |
| `搜不到结果时不出现「复制卡片后出现」的误导副文案` | `queryByText('复制任意卡片后会自动出现在这里')` 为 `null`；出现「换个关键词试试…」；列表清空后 `aria-expanded="false"` 且 `aria-activedescendant` 为 `null`（不残留指向已消失选项的指针） |
| `没有搜索词时（最近使用为空）副文案保持「复制任意卡片后会自动出现在这里」` | 一张卡都不复制 → 真空态；副文案不变，且**不**出现「换个关键词试试」 |

为支撑第三条，测试辅助函数拆成两个：`expandIsland()`（只展开面板，不等列表）与 `openIsland()`（`expandIsland` + `findAllByRole('option')`）。空列表场景下 `findAllByRole` 必然等到超时，不能复用原辅助函数。

**验收**

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过，0 error |
| `npx vitest run src/features/island` | 3 文件 / **37 用例**全部通过 |
| `npx vitest run` | 42 文件 / **326 用例**全部通过 |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify --emptyOutDir false` | 通过，`index.js 446.46 kB (gzip 168.66 kB)` / `index.css 24.48 kB (gzip 5.17 kB)` |

> 全量计数说明：`src/__qa_hotzone`、`src/__qa_verify` 两个 QA 临时取证目录已不在工作树中（上一轮经用户确认删除，本轮 `ls` 与 `glob` 双重确认为空），因此 42 / 326 是纯产品用例，不再需要拆两套数字。

---

## 灵动岛交互修复（QA 复验第三层：1 P1 + 4 P2 + 1 P3）

**背景**：QA 逐字节复现了 `37 / 326 / 98 / 446.46 kB` 四组数字，确认无虚报，但翻出一个存量 P1 与四个 P2/P3。全部在 `src/features/island/Island.tsx` 内闭环。

### P1：新建表单里按 Enter 复制了别人的密码，且建卡失败

**因果链**（这是本轮最需要写清楚的一条）：

1. 表单提交靠浏览器的**隐式提交**——在输入框里按 Enter，浏览器触发所属 `<form>` 的 `submit`，`onSubmit` 再调 `handleCreate()`。
2. 但面板根节点上有 `onKeyDown={handleKeyDown}`（事件从输入框冒泡上来），Enter 分支里第一句就是 `event.preventDefault()`。
3. `preventDefault()` 掐掉了隐式提交 → `onSubmit` 永不触发 → **卡建不出来**。
4. 同一次按键继续往下走，落到 `copyField()`；而表单开着时列表已经被表单替换，`visible[activeIndex]` 仍是**打开表单前**的旧列表 → 复制了**另一张卡**的密码，toast 还理直气壮地报「已复制密码」。

**修复**：`handleKeyDown` 里在 `if (!unlocked) return` 之后、`ArrowDown` 分支之前加 `if (createOpen) return;`（`Island.tsx:594-607`）——表单态下方向键/Enter 全部让给表单与原生输入框。**必须放在 Esc 分支之后**：Esc 在表单里只退出新建，不能一起被让路。

**回归用例**：`IslandQuickCreate.test.tsx` → `表单里按 Enter 建卡，不会把旧卡的密码复制进剪贴板（QA P1）`。断言四件事：① `fireEvent.keyDown` 返回 `true`（事件未被 `preventDefault`，隐式提交这条路还通）② 剪贴板仍是旧值 ③ 没有提前出现「已复制密码」的 toast ④ 手动补发 `form.submit()` 后卡真的建出来、剪贴板换成新卡密码。**jsdom 不实现输入框 Enter 的隐式提交**，所以第 ④ 步是显式模拟浏览器行为——要验的是"面板没有拦掉这条路"，不是"jsdom 会提交"。

> 顺带发现（**已闭环，见本节末尾「待确认事项」**）：核心层 `createItem` 要求账号非空（`error.username_required`），而表单标签当时写的是「账号（可选）」。经查 PRD 后判定**核心对、标签错**。

### P2：表单开着时 `aria-expanded` 仍为 true，`aria-activedescendant` 指向不存在的节点

表单态 / 锁定态 / 空结果都不渲染 `<ul role="listbox">`，但三个属性仍按"有列表"输出：`aria-expanded="true"` + 指向已被卸载节点的 `aria-activedescendant`。axe-core 的 `aria-valid-attr-value` 会直接报 dangling 引用。

**修复**：在 `activeIndex` 之后抽一个共用派生（`Island.tsx:459-467`）：

```ts
const listVisible = unlocked && !createOpen && visible.length > 0;
```

三个属性共用它（`Island.tsx:741-748`）：`aria-expanded={listVisible}`、`aria-controls={listVisible ? 'island-listbox' : undefined}`、`aria-activedescendant` 前置 `listVisible`。`aria-controls` 在无列表时**条件挂载**（而不是留一个指向不存在 id 的值）——ARIA 1.2 允许省略，dangling 引用才是错误。

### P2：渲染期夹取只有上界

原 `Math.min(island.activeIndex, visible.length - 1)`：注入 `-5` 会算出 `-5`，`visible[-5]` 是 undefined → `[aria-selected="true"]` 长度为 0 → 选中态整体消失、Enter 变空操作。

**修复**：`Math.max(0, Math.min(...))` 双边夹取（`Island.tsx:455-457`）。同时纠正了原注释的错误因果：防 `island-option-undefined` 的是 `visible[activeIndex] !== undefined` 守卫，**不是**夹取——夹取只保证下标落在合法区间。

**回归用例**：`Island.test.tsx` → `注入负索引时不丢选中态（渲染期双边夹取）`。`setActiveIndex` 自带 `Math.max(0, ...)` 兜底注入不了负数，所以直接 `useUiStore.setState` 改状态。

### P2：`COLLAPSE_DELAY_MS` / `scheduleCollapse` 是死代码

`handlePanelPointerLeave` 同时排 2 秒收起与 250ms 隐藏，250ms 先到期并直接 `setRevealed(false)` + `closeIsland()`，2 秒那条**永远轮不到**，它内部的 `isUserWorking` 保护也是死代码。两套定时器并存会让人误以为 SDD §6.5 的"离开 2 秒收起"已实现。

**清理**：删 `COLLAPSE_DELAY_MS` 常量、`collapseTimer` ref、`scheduleCollapse`、`cancelCollapse`，以及全部 6 处调用点（`openCreate`、`revealAndOpen`、`handlePanelPointerEnter`、热区 `onMove`、`handleKeyDown` 的 Esc 分支、`handlePanelPointerLeave`），相关 `useCallback` 依赖数组同步收窄。`handlePanelPointerLeave` 只剩 `scheduleHide()`。

**当前唯一生效的收起/隐藏时序是 `HIDE_DELAY_MS = 250ms`**（`scheduleHide`，`Island.tsx:320`），已写进该函数的 docstring。`IslandHotzone.test.tsx` 22 条用例钉住它，清理后**全部原样通过**——说明这些用例没有依赖死路径。

### P2：岛内搜索框与主面板搜索框同名

主面板 `MainPanel.tsx:272` 也是 `aria-label="搜索资产"`，`SessionGate` 让两者同时挂载。岛内改成 combobox 后，屏幕阅读器会看到两个同名、不同角色的搜索框。

**修复**：岛内改 `aria-label="密岛搜索"`（`Island.tsx:741`）；`placeholder` 保持「搜索资产…」不动（11 处测试用 `getByPlaceholderText` 找它）。

### P3：卡片点不动

`<li role="option">` 只有键盘 Enter，鼠标点击什么都不发生，`cursor-default`。

**修复**：
- 抽出 `copyItemField(itemId, field)`（`Island.tsx:502-516`）——按 **id** 复制，因为点击时 `setActiveIndex` 是异步的，闭包里 `activeIndex` 还是旧值；`copyField` 退化成 `copyItemField(visible[activeIndex]?.id, field)` 的薄包装，Enter 路径行为不变。
- `<li>` 加 `onClick` → `handleItemClick(index, item.id)`（`Island.tsx:527-530`、`871-873`）：先高亮再复制。
- 样式 `cursor-default` → `cursor-pointer` + `active:scale-[0.99]`。
- **不拦 `onPointerDown`**：那会连带影响焦点与"鼠标在岛内不动不该收起"的保护链路。
- 复制后**不收起**，与 Enter 路径一致。

**回归用例**：`Island.test.tsx` → `点击卡片复制该卡密码，且岛不收起`。点第 2 张卡（点击时高亮还在第 0 项），断言剪贴板是新卡密码、toast 出现、面板仍在、`phase === 'expanded'`、高亮已跟随到第 2 项。

### 测试卫生：`act(...)` 警告清零

`IslandQuickCreate.test.tsx` 4 处 + `IslandHotzone.test.tsx` 2 处 + `MainPanel.autolock.test.tsx` 1 处（存量）。根因都是展开/挂载后的异步 `setState`（`getRecentItems()`、挂载期刷新）落在 `act` 之外。修法统一为 `flushAsyncEffects()` / `act(async () => ...)` 主动 flush 一次宏任务，**没有**用 `vi.useFakeTimers` 掩盖。顺带修掉 `IslandQuickCreate` 前两条用例里"渲染用 A client、初始化用 B client"的脚手架错配。全量跑完 `not wrapped in act` 计数为 **0**。

### 新增用例（5 条）

| 文件 | 用例 |
| --- | --- |
| `IslandQuickCreate.test.tsx` | `表单里按 Enter 建卡，不会把旧卡的密码复制进剪贴板（QA P1）` |
| `IslandQuickCreate.test.tsx` | `表单开着时列表语义闭嘴：aria-expanded=false、无 aria-controls、无 aria-activedescendant` |
| `Island.test.tsx` | `点击卡片复制该卡密码，且岛不收起` |
| `Island.test.tsx` | `点击卡片不抢焦点：mousedown 默认行为被阻止，键盘接力可用` |
| `Island.test.tsx` | `注入负索引时不丢选中态（渲染期双边夹取）` |

### 第三轮复验后的收尾（R9 P2 + P3）

**R9 P2：点完卡片键盘全哑。** `<li role="option">` 不可聚焦（`tabIndex === -1`），按 HTML 的 focusing steps，mousedown 落在它上面会把焦点移到最近的可聚焦祖先、没有就落到 `body`。焦点一离开面板，`onKeyDown` 就收不到事件——用户点一下卡，之后按 Enter 复制账号、按 Esc 收起全部失效。

- **修法**：`<li>` 加 `onMouseDown={(event) => event.preventDefault()}`（`Island.tsx:868-897`）。`preventDefault()` 只掐掉"焦点转移"这一步，**不影响 click**，复制照常跑。这是 APG combobox 的标准做法：焦点恒在输入框，靠 `aria-activedescendant` 播报高亮。
- **为什么不用 `pointerdown`**：它在触摸/笔场景会连带影响滚动与长按，语义太宽；`mousedown` 最窄、最贴合"别抢焦点"这一件事。
- **为什么不给 `<li>` 加 `tabIndex`**：焦点会真的跑进列表，与面板层的 ↑↓ 处理打架，也破坏 combobox 的焦点模型。
- **测试口径（重要）**：jsdom 的 `fireEvent.click` **不模拟焦点转移**，所以"点击后 `activeElement` 是谁"这件事在 jsdom 里根本测不出来——上一轮的点击用例全绿，浏览器里却是坏的。新用例因此断言**机制**：`expect(fireEvent.mouseDown(option)).toBe(false)`（返回 `false` 表示 `defaultPrevented === true`），再补一条行为断言证明 click 仍照常复制。这条用例的价值就在于它是**机制断言**，不依赖 jsdom 的焦点模拟。

**P3：视觉必填提示。** 「标题」「账号」两个 label 后面各加一枚 `*`，与主面板 `ItemEditor` 的写法一致。星号是 label 的**兄弟节点**、包在 `<div className="flex items-center gap-1">` 里，且带 `aria-hidden="true"`：塞进 `<label>` 会改变 accessible name（`getByLabelText('标题')` 立刻失效），`aria-hidden` 则让星号不进无障碍树——必填语义已由 input 上的 `aria-required` 承担。

**注释补充。** `handleKeyDown` 里 `if (createOpen) return;` 的注释补上了它顺带挡掉的第二件事：表单开着时按 ↑↓ 不会再去改那个**已经看不见的**列表的选中项（旧行为下用户填完标题顺手按一下 ↓，后台列表高亮会莫名其妙跳一格）。

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过，0 error |
| `npx vitest run src/features/island` | 3 文件 / **42 用例**全部通过，`act` 警告 0 |
| `npx vitest run` | 42 文件 / **331 用例**全部通过，`act` 警告 0 |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify --emptyOutDir false` | 通过，`index.js **446.62 kB** (gzip **168.70 kB**)` / `index.css 24.78 kB (gzip 5.20 kB)` |

> 体积口径说明：QA 复验时实测 `446.28 kB (gzip 168.65)`，上一版本这里记的是 `446.23 kB`（差 398 B 的实测误差）。本轮加入 `onMouseDown` 处理与两处必填星号后**重新实测为 `446.62 kB` (gzip 168.70 kB)**，以此为准。gzip 口径基本持平（+0.05 kB），增量全部来自未压缩的 JSX 属性与类名。
>
> 计数口径说明：QA 本轮建了取证目录 `src/__qa_island_r2/IslandR2Verify.test.tsx`（23 条，其中 2 条是**故意失败**的 `[诊断]` 用例，靠手动 `blur()` 模拟"焦点已离开岛"的浏览器行为）。带它跑全量是 43 文件 / 354 用例、2 条故意红灯；**该目录已随本轮收口删除**，删除后实测 **42 文件 / 331 用例、0 失败**，即上表的数字。
>
> 注意那 2 条 `[诊断]` 用例的语义已过期：它们靠手动 `blur()` 把焦点推到 body，而本轮给 `<li>` 加了 `onMouseDown` 阻止默认行为后，真实浏览器里"点卡片导致焦点离开岛"这件事**已经不会发生**。留着重跑只会误导后来者以为缺陷仍在，故随目录一并清理。

### 待确认事项已闭环：账号必填

上一轮抛回的「`createItem` 要求账号非空，但表单标签写『账号（可选）』」已有结论：**核心对、标签错**。

- **依据**：`prd.md:139`「手动创建 / 编辑表单：标题\*、平台、网址、**账号\***、密码\*…」——账号带星号，是必填；`prd.md:296` 建表语句 `username_enc BLOB NOT NULL`——库层也不允许空。因此 `src/core/vault/items.ts` 里的 `requireText(input.username, ..., 'error.username_required')` 符合 PRD，**核心未改**。
- **本轮只改标签**：`Island.tsx` 表单 `<label htmlFor="island-create-username">` 由「账号（可选）」改为「账号」；标题与账号两个输入框补 `aria-required="true"`。**刻意不用原生 `required`**——原生校验会在隐式提交时弹浏览器气泡，且 jsdom 不实现，会把「面板不拦隐式提交」那条 P1 回归用例变成假绿。
- **已知代价（如实记录）**：灵动岛快捷新建必须填账号，比理想中的「4 击键闭环」多一步。这是 PRD 约束下的取舍，不是实现缺陷；若后续要压缩击键数，只能改 PRD（例如允许账号为空、由主面板补录）。

---

## Phase 3/5 补 · 批量删除（主密码二次验证）与剪贴板粘贴

补两个 **P0 级实现缺口**。二者都不是打磨，是 PRD 明写但代码里查无此项的功能：

- `prd.md:138`「卡片操作：…删除（MVP 二次确认；**批量删除需输入主密码**）」——此前 `MainPanel` 连选择状态都没有，`grep "selected|批量"` 零命中。
- `prd.md:157`「**4.1 手动创建（P0）**：…支持从剪贴板快速粘贴账号/密码」——`ClipboardPort.read()` 端口早就在 `src/services/clipboard.ts`，但没有任何 UI 调用它。

### 实现

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 核心 | `src/core/vault/items.ts:318-343` | `deleteMany(ids)`：一次 `flush()`，返回实际删除的 id。不存在的 id 静默跳过（不抛 `ITEM_NOT_FOUND`），重复 id 只删一次 |
| 门面 | `src/services/vault-client.ts:125-131 / 183 / 656-675 / 1038` | `BulkDeleteResult` 类型、`deleteItems(ids, masterPassword)`、`internalDeleteItems`、`guard()` 接线 |
| 门面 | `src/services/vault-client.ts:215 / 1050` | `readClipboardText()` 直通 `clipboard.read()`，不重复 try/catch |
| UI | `src/features/vault/ItemCard.tsx:57 / 91 / 221-252 / 267-281 / 296 / 334` | 选择模式：整卡 `role="checkbox"` + `aria-checked` + `aria-label` + `tabIndex={0}` + Enter/Space 键盘支持；**选择模式下卡片原有按钮全部不渲染**（`selectMode ? null : …`）；选中态 `ring-2 ring-zinc-900`；视觉复选框 `aria-hidden` + `tabIndex={-1}`（避免读屏与 Tab 序列出现两个复选框） |
| UI | `src/features/vault/MainPanel.tsx:67-71 / 193-268 / 369-389 / 477-478 / 555-600` | 选择模式状态机、全选、批量删除弹窗（主密码输入 + 冷却倒计时）、幽灵 id 清理、退出时机 |

### 三个关键决策

1. **原子性来自 `flush()`，不写成 `for (id) await this.deleteItem(id)` 循环**。逐条删会给每条付一次写盘 I/O，更致命的是中途抛错（或进程被杀）会留下"删了一半"的状态——而删除不可恢复，恢复码也救不回来。
2. **必须先校验主密码，再动数据**。`internalDeleteItems` 的顺序是 `requireItemService()` → 空集合短路 → `session.verifyPassword()` → `deleteMany()`。写反的后果：一次输错密码就把卡片永久删掉。测试把"密码错 → 一张都没少"列为第一优先级断言。
3. **批量删除不再额外要求 hidden grant**。主密码是根凭据，强度高于 5 分钟有效的 `hidden grant`，隐藏卡片与普通卡片一视同仁；反之若仍要求 grant，用户会拿到一张隐藏卡却删不掉的怪体验。

### 安全边界（测试钉住）

- 失败计数与 `unlock()` **共用**：不能拿批量删除当无限次试密码的旁路（`snapshot.failedAttempts` 断言）。
- 锁定态一律拒绝，且解锁后数据完好。
- 空集合**不**校验密码、不消耗失败计数（否则可被用来探测/消耗计数器）。
- 冷却中给剩余秒数，不只说"稍后再试"（`AUTH_COOLDOWN` 分支读 `cooldownUntil`）。

### 选择模式的行为契约

- 全选只覆盖**当前视图**（当前分类 + 当前搜索词），不碰视图外的卡片。
- 退出时机：切换分类、改搜索词、成功删除后。选中集基于旧结果集，不能跨视图复用。
- `items` 变化后清理幽灵 id，否则「已选 N 张」会说谎。
- 删除失败时弹窗**保持打开**、密码框清空、选中态不动——用户多半只是打错密码，关掉弹窗重选一遍是纯粹的折磨。
- 弹窗关闭必清密码（`closeBulkDialog`），不让它长时间留在内存 state 里。

### 粘贴的隐私约束

- 粘贴到密码框后**不自动显形**：粘贴来的密码往往是别人给的，亮在屏幕上是最容易被人瞄到的一瞬间；要不要看由用户自己点眼睛决定。
- 粘贴内容**绝不**进 toast、日志或任何错误文案，只写进本地表单 state（测试用 `queryByText(...)` 为 null 钉住）。
- 读不到剪贴板（权限被拒）与空白剪贴板都给出提示，且**不改动**已填内容。

### 关于「卡片密码强度点」为什么本轮不做

`prd.md:137` 要求卡片显示密码强度点。**决定推迟**，理由是它和现有安全模型冲突：算强度必须拿到明文密码，而 `ItemSummary` 列表层刻意不解密密码（`username_only` / `hidden` 卡片连预览都不给）。要在列表上显示强度点，就得为了一个装饰性标记把全库密码解密一遍。真要做得先改数据模型（存一个非敏感的强度档位），或并入已有的「密码体检」——后者已能识别弱密码，且只在用户主动触发时解密。**这个取舍记在这里，不悄悄丢掉。**

## Phase 3/5 补 · Windows 剪贴板历史风险提示（FR-05 P0）

`prd.md` FR-05 剪贴板一行原文：「复制后 N 秒自动清空（默认 30s，10–120s 可调，可关闭）；清空前若已被覆盖则跳过；**设置页检测并提示 Windows「Win+V 剪贴板历史」风险、引导关闭**」。前半段已实现，**后半段此前完全没有**（`grep "Win+V|剪贴板历史"` 零命中）。

### 实现

`src/features/settings/SettingsPanel.tsx`：新增 `ClipboardHistoryNotice()`，放在「剪贴板自动清理」下拉框**正下方**（用户在调这个选项时一眼能看到），常驻展示、不折叠。内容三要素：风险本身（自动清理只能清掉「当前」剪贴板项，剪贴板历史里的记录密岛碰不到）、`Win+V` 这个具体按键、可操作的关闭步骤（设置 → 系统 → 剪贴板 → 关掉「剪贴板历史」+ 点一次「清除」），并提醒已经复制过的用户立刻去清一次历史。

### 关于「检测」的诚实说明

PRD 写的是"检测并提示"，但**浏览器沙箱里读不到系统的「剪贴板历史」开关状态**。因此这里**不假装检测后展示**，而是常驻提示 + 给出关闭步骤——把风险讲清楚，比显示一个永远是"未检测"的绿色勾更负责。这个偏差已在代码注释里写明。

### 下一轮待办：剪贴板清理「可关闭」档位

同一行 PRD 里还缺一项：**「可关闭」**。当前 `TTL_OPTIONS` 只有 30/60/120 秒，也没有 10 秒档（PRD 范围是 10–120s）。要做需要动四处，已探明：

1. `src/services/vault-client.ts:771-772` `internalSetClipboardTtl` 的 `ttlMs <= 0` 校验要放开 0；
2. `src/services/clipboard.ts:144` `copyWithTtl` 的 `ttlMs <= 0` 校验要放开 0，且 0 时**不排定时器**、receipt 需要一个"不自动清理"的标记；
3. `src/services/vault-client.ts:347` meta 回读 `metaRecord.clipboardTtlMs > 0` 会**把 0 当成无效值丢掉**，改回默认 30s——这是个隐藏 bug，必须先改成 `>= 0`，否则用户设了"关闭"重启就失效；
4. `SettingsPanel` 的 `TTL_OPTIONS` 加 `10_000` 与 `0`（文案「关闭」），toast 文案要能表达"不会自动清空"。

### 新增用例（3 条）

`src/features/settings/__tests__/SettingsClipboardHistory.test.tsx`：常驻展示且讲清"自动清理挡不住历史"、给出关闭步骤、紧跟 TTL 选择框之后渲染（用 `compareDocumentPosition` 断言 DOM 顺序）。

### 主理人自查记录

本轮 UI 测试**写完先跑了 vitest 就以为完事，漏了 `tsc --noEmit`**，导致 3 个类型错误被带进工作树（vitest 不做类型检查）：未使用的 `MainPanelProps` 导入、手写的半截 `SessionSnapshot` 字面量、以及 `compareDocumentPosition` 的可空链。已全部修正并复跑。**教训：任何新增测试文件后必须紧跟一次 `tsc --noEmit`，"测试全绿"不等于"类型干净"。**

### QA 独立复验结果：2 真缺陷 + 3 条 QA 测试自身问题

独立 QA 写了 27 条对抗用例，5 条红。逐条判定后：**2 条是真缺陷（已修），3 条是 QA 测试自己写错**。

**真缺陷 1：冷却期被误报成 VAULT_LOCKED。**
连续输错主密码进入冷却后，`registerFailure` 会设 `cooldownUntil` **并**清掉 DEK（强制锁定）。`internalDeleteItems` 直接走 `requireItemService()`，而它把 `session.status()` 的返回值丢掉了、只看到 `itemService === null` 就抛 `VAULT_LOCKED`——于是用户看到"已锁定"而不是"还剩 37 秒"。`internalRequestHiddenAccess`（L704-708）早有同样的前置判断，批量删除这条路径漏了。**连带后果**：`MainPanel` 里那个读 `cooldownUntil` 展示剩余秒数的分支原本是死代码。已按同样模式补上 `if (session.status() === 'cooling_down') throw errors.authCooldown();`。

**真缺陷 2：`readClipboardText()` 会把端口异常抛给 UI。**
原实现是 `return clipboard.read();`。`BrowserClipboardPort.read()` 自己 try/catch 返回 null，但**测试替身在 `denyRead` 时直接抛错**，未来的 Tauri 实现同样可能抛。接口文档明明写着"不抛错"，于是调用方（编辑器粘贴按钮）没有 try/catch，漏一处就是一次未处理的 Promise 拒绝——用户点了粘贴毫无反应、没有任何提示。已在门面统一归一化为 `try/catch → null`。

**QA 测试自身的 3 个错**（已在复验结论里指出，未改产品码）：① 断言 `boxes[0]` 的 `aria-label` 是「选择 卡片-0」，但列表按最近更新排序，第一张是「卡片-1」——和我第一版测试犯的是同一个错；② 幽灵 id 用例算术错（5 张选 - 1 幽灵 = 真删 4 张，库里该剩 0，他期望 1）；③ 用 `/主密码|密码/` 匹配文本，同时命中卡片上的「密码」字段名与 toast，选择器歧义。

**我第一版冷却测试自己也写错了一处**：冷却期会话已被强制锁定，此刻 `listItems()` 本身就会抛 `VAULT_LOCKED`，不能用来验数据完整性。改成"推进时间等冷却过去 → 用正确密码解锁 → 断言三张都在"，才真正证明一张没删。

### 新增用例（4 条）

| 文件 | 条数 | 覆盖 |
| --- | --- | --- |
| `src/services/__tests__/vault-client-bulk-delete.test.ts`（+1） | 9 | 冷却期报 `AUTH_COOLDOWN` 而非 `VAULT_LOCKED`，且冷却解锁后三张卡一张不少 |
| `src/services/__tests__/vault-client-clipboard-read.test.ts` | 3 | 端口抛错归一化为 null、读到原样返回、空串与"读不到"不混为一谈 |

### 最终验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **48 文件 / 360 用例**全部通过（基线 42/331），`act` 警告 0 |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify --emptyOutDir false` | `index.js **454.03 kB** (gzip **170.75 kB**)` / `index.css 25.60 kB (gzip 5.25 kB)` |

### 遗留：其它写路径的冷却误报

`internalDeleteItems` 的冷却前置判断已补，但 `internalUpdateItem` / `internalSetFavorite` / `internalSetVisibility` / `internalDeleteItem`（单条）仍有同样的误报——冷却期会报 `VAULT_LOCKED` 而非 `AUTH_COOLDOWN`。这是**既有问题、非本轮引入**，且改它可能牵动现有断言，本轮不扩范围，记在这里等下轮统一处理。

### 新增用例（22 条）

| 文件 | 条数 | 覆盖 |
| --- | --- | --- |
| `src/core/vault/__tests__/items-bulk-delete.test.ts` | 6 | 删子集、不存在 id 跳过、重复 id 幂等、删除落盘、空数组不写盘、全不存在不写盘 |
| `src/services/__tests__/vault-client-bulk-delete.test.ts` | 7 | **密码错一张不删**、正确才删、recency 清理、失败计数共用、锁定态拒绝、空集合不校验、重复 id 不重复 |
| `src/features/vault/__tests__/MainPanel.bulk-delete.test.tsx` | 5 | checkbox 语义 + 屏蔽单卡按钮、密码错弹窗不关、成功删除并退出、切换分类退出、空选禁用 |
| `src/features/vault/__tests__/ItemEditor.paste.test.tsx` | 4 | 粘贴账号、粘贴密码保持遮蔽且不进可见文本、读不到提示且不改动、空白提示且不改动 |

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | 43 文件 / **353 用例**全部通过（原 42 / 331，新增 22），`act` 警告 0 |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过（不变） |
| `npx vite build --outDir .build-verify --emptyOutDir false` | 通过，`index.js **453.14 kB** (gzip **170.33 kB**)` / `index.css 25.32 kB (gzip 5.23 kB)`，1998 modules |

> **分工说明**：本轮实现由工程师交付后被 429 配额中断（测试与文档未写），实现部分经主理人核对后沿用，测试与文档由主理人补齐。

---

## Phase 3/5 补 · 剪贴板清理「可关闭」档位 + QA 复验收尾

### 需求来源

PRD 要求剪贴板 TTL「10–120 秒可调，**可关闭**」，此前只有 30/60/120 秒三档，零实现。

### 实现

| 触点 | 改动 |
| --- | --- |
| `src/core/vault/types.ts` | `CopyReceipt` 增加 `autoClear: boolean`（`ttlMs === 0` 时为 `false`）；新增 `CLIPBOARD_TTL_OPTIONS`（0/10/30/60/120 秒）、`CLIPBOARD_TTL_RANGE`，以及**两层校验**：`isValidClipboardTtl`（服务层：有限且非负）与 `isValidClipboardTtlSetting`（设置层：0 或 10–120s 整数） |
| `src/services/clipboard.ts` | `copyWithTtl` 放开 `ttlMs === 0`：写盘、登记 `pending`、但不排定时器，回执 `autoClear: false`、`expiresAt: 0` |
| `src/services/vault-client.ts` | **修一个隐藏 bug**：meta 回读 `clipboardTtlMs` 原来用 `> 0` 判断，会把用户设的「关闭」（`0`）当无效值丢掉，重启后静默回落 30 秒；改为 `isValidClipboardTtl` 全量校验（回读用服务层规则，任何能执行的值都不丢）。`setClipboardTtl` 收紧为设置层规则 |
| `src/features/settings/SettingsPanel.tsx` | 下拉新增「关闭（不自动清空）」选项；关闭档的提示改为「已关闭剪贴板自动清空」——原来会显示"0 秒后自动清空"，与语义正好相反 |
| `src/features/vault/ItemCard.tsx` / `src/features/island/Island.tsx` | 两处复制 toast 区分关闭档：「已复制密码 · 已写入剪贴板，不会自动清空」 |

### 校验分层的由来（第一版写错后修正）

第一版把 10–120s 区间直接塞进服务层校验，**打破了两处既有测试**：`clipboard.test.ts` 与 `clipboard-sync-scheduler.test.ts` 用 1s/2s/5s 短时长验证清理路径（内部调用方的合法用法），全被 `VALIDATION_FAILED` 拒掉。修正为两层：服务层只管"有限且非负"，区间只约束用户设置档位。**教训：放宽一个校验前，先 grep 全仓测试对这个校验的既有假设。**

### QA 复验提出的三条改进（全部采纳）

1. **toast 报数锁注释**：`MainPanel.tsx` 批量删除 toast 必须报 `result.deleted` 不能报 `ids.length`（选中集可能含幽灵 id，报错数等于"删了但其实没删"的错觉）——已加注释锁死。
2. **退出选择模式强制 reload**：选择模式存续期间没有任何刷新入口（搜索/排序/新建/卡片编辑删除全不在 DOM），另一窗口删卡造成的幽灵 id 清不掉。`exitSelectMode` 现在统一触发 `reload()`，批量删除成功路径的重复请求随之移除。
3. **空集合短路点明**：`deleteItems([], wrongPw)` 是全类目唯一不验主密码的写入入口（短路在 `verifyPassword` 之前）——已实测它探测不到会话状态、不消耗失败计数、不删任何东西，注释里写明了这个顺序。

### QA 报的 P2-1「错误码不稳定」已证伪

QA 观测到冷却期批量删除在 `VAULT_LOCKED` / `AUTH_COOLDOWN` 之间交替，写循环测试连跑 6 轮钉死：**修复后恒定 `AUTH_COOLDOWN`**。QA 看到的 `VAULT_LOCKED` 来自它修复前那几次运行。回归测试 `vault-client-bulk-cooldown-determinism.test.ts` 保留。

### 设计取舍入档

SDD 新增 §5.x：单条删除走 hidden grant、批量删除走主密码的不对称是**有意设计**（主密码强度高于 5 分钟 grant，且持有者本就能 `unlock()` 看全部），`deletedIds` 的存在性预言机已评估不扩大能力边界。

### 新增测试

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `src/services/__tests__/clipboard-ttl-off.test.ts` | 8 | 服务层：关闭档写盘不排清理、锁定时仍按归属清、默认档照旧、负数/Infinity/NaN 拒绝、默认 30 秒；门面层：`setClipboardTtl(0)` 跨重启回读仍是 0、设置层区间（5s/121s 拒，10s/120s/0 放行） |
| `src/services/__tests__/vault-client-bulk-cooldown-determinism.test.ts` | 1 | 冷却期错误码确定性（连跑 6 轮） |
| `src/features/settings/__tests__/SettingsClipboardTtlOff.test.tsx` | 3 | 下拉有「关闭」档且值为 0、其余档位在 10–120s 内、选关闭提示"已关闭"而非"0 秒后清空"、选秒数提示准确 |

### 同步修正的既有断言

`tests/security/phase2-regression.test.ts` 原断言 `setClipboardTtl(0)` 与 `setClipboardTtl(5_000)` 一拒一放——正是本轮要改变的行为（0 从"非法"变为"关闭档"，5s 从"放行"变为"低于下限"）。已按新契约重写：0 放行且回执 `ttlMs=0 / expiresAt=0`，越界值与负数/NaN 拒绝，10s 放行且回执正确。`src/services/__tests__/clipboard.test.ts` 的"拒绝空值与非法 TTL"同理由 0 改为 Infinity/NaN。

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **51 文件 / 373 用例**全部通过，`act` 警告 0 |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过（含同步修正的 phase2 回归） |
| `npx vite build --outDir .build-verify --emptyOutDir false` | 通过，`index.js **454.43 kB** (gzip **170.95 kB**)` |

> QA 复验（yan-3）结论 PASS：9 项必查全过、P0/P1 无；其自报的构建体积 446.23 kB 经复测为沿用上一轮数字，本轮回表已按实测值记录。

---

## 存量缺陷修复 · 冷却期错误码统一为 AUTH_COOLDOWN

### 缺陷

连续输错主密码进入冷却后，会话被强制锁定（DEK 已清）。`requireItemService()` 此前把 `session.status()` 的返回值丢掉、只看到 `itemService === null` 就报 `VAULT_LOCKED`——用户该看到"请 N 秒后再试"，实际看到"已锁定"；而解锁在冷却期同样被拒，这个提示会把用户带进死胡同。批量删除路径修过一次（在各路径抄前置判断），但 `updateItem` / `deleteItem` / `setFavorite` / `setVisibility` 四条路径漂移在外，仍是旧行为——**正是"各处各抄一份"导致的漂移**。

### 修法

不补第四份拷贝，而是在唯一入口 `requireItemService()`（14 条资产路径共用）里统一分辨：`session.status() === 'cooling_down'` 先抛 `AUTH_COOLDOWN`。同时删掉 `internalDeleteItems` 里重复的前置判断。冷却是会话级状态，错误码由会话级入口决定，才不会再次漂移。`internalRequestHiddenAccess` 另有"必须 unlocked"的更严要求，保留自己的判断。

### 行为变化与测试同步

- `vault-client-hidden-access.test.ts` 原断言冷却期 `listItems()` 报 `VAULT_LOCKED`——那正是被修复的误导行为，改为断言 `AUTH_COOLDOWN`（测试意图"授权路径无法绕过"不变，两种码都拒绝）。
- 新增 `src/services/__tests__/vault-client-cooldown-error-code.test.ts`（3 例）：11 条资产路径在冷却期全部报 `AUTH_COOLDOWN`；冷却期内的写入（改标题/收藏/可见性/删除）一张都不生效（等冷却过去解锁后数据原样——注意不能在冷却期用 `listItems()` 验数据，它本身就会抛错）；不过度矫正：普通锁定态仍报 `VAULT_LOCKED`。

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **52 文件 / 376 用例**全部通过，`act` 警告 0 |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify --emptyOutDir false` | 通过，`index.js **454.42 kB** (gzip **170.95 kB**)` |

---

## Phase 6 补 · 设置页数据文件位置展示（FR-06 P0）

### 需求来源

盘 PRD 时发现的又一处"明写但没做"：FR-06 备份导出（P0）条款里写着"设置页展示数据文件路径与'打开所在文件夹'"，代码里 grep 零命中。

### 诚实处理（本项目的固定模式）

浏览器沙箱 + 内存存储阶段**没有**数据文件路径，也不假装有：
- `VaultStorage` 新增 `describeStorage(): Promise<StorageLocation>`（`kind` / `displayPath` / `canReveal`），`MemoryVaultStorage` 如实返回 `memory / null / false`；
- 设置页"数据说明"区新增一行：路径显示"内存存储（未落盘）"，"打开所在文件夹"按钮**禁用**并带说明（没有文件夹可打开；SQLCipher 落库后可打开）；
- SQLCipher 落地后由文件存储返回真实路径与 `canReveal: true`，**UI 零改动即自动生效**——用 mock 测试证明了这个适配性。

门面 `describeStorage()` **不要求解锁**（位置描述不含数据本身，锁定态读一下"数据存在哪"不该被 VAULT_LOCKED 挡住），存储故障按仓库既有惯例归一化为 `STORAGE_FAILED`。

### 连带修掉的自引入回归

面板打开时异步加载位置，导致 5 个既有设置测试出现 13 条 `not wrapped in act` 警告（上轮为 0）。按 RTL 规范在 5 个文件的渲染辅助里补 `await screen.findByTestId('storage-location')`，让异步加载在 act 作用域内落定——这些测试此前是"靠时序运气"通过的。

### 新增测试

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `src/services/__tests__/storage-location.test.ts` | 3 | 内存存储如实报告、门面锁定态可读、故障归一化为 AppError |
| `src/features/settings/__tests__/SettingsStorageLocation.test.tsx` | 3 | 未落盘展示 + 按钮禁用带原因、mock 文件存储时显示路径并启用、读取失败静默降级不打断面板 |

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **54 文件 / 382 用例**全部通过，`act` 警告 **0** |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify --emptyOutDir false` | 通过，`index.js **455.23 kB** (gzip **171.20 kB**)` |

---

## Phase 6 补 · 灵动岛右键菜单（FR-02 P0）

### 需求来源

FR-02 明写「右键菜单（类输入法）：打开主面板 / 新建卡片 / 设置 / 立即锁定 / 开机自启开关 / 退出」，代码里 `contextmenu` 零命中——又一处"明写但没做"。

### 实现

| 触点 | 改动 |
| --- | --- |
| `src/features/island/IslandContextMenu.tsx`（新） | 菜单本体 + 键盘可达的触发按钮。`role="menu"` / `menuitem`，打开即聚焦首项，↑↓ 循环导航，Esc 关闭，`mousedown` 点外部关闭 |
| `src/features/island/Island.tsx` | 面板 `onContextMenu` 拦默认菜单并开自己的；头部加「菜单」按钮（纯右键入口会把键盘与读屏用户挡在门外）；岛收起时菜单一并关闭（否则下次唤出看到幽灵菜单） |
| `src/features/session/SessionGate.tsx` | 持有 `settingsOpen`——主面板与岛的「设置」都要开它，共同父级是唯一不引入全局存储的办法 |
| `src/features/vault/MainPanel.tsx` | `settingsOpen` / `onSettingsOpenChange` 改为受控属性；搜索框补 `id="main-search"` 供菜单聚焦 |

### 诚实处理

- **打开主面板**：Web 阶段主面板是常驻页面（Tauri 阶段才是独立窗口），落地为聚焦其搜索框——可见、可预期的反馈，不摆空按钮。
- **开机自启开关 / 退出**：需要原生能力（自动启动项、进程控制），Web 阶段**禁用并说明原因**（title 写明 Tauri 接入后开启），不做假交互。
- **锁定态**：新建/设置/立即锁定禁用（需要解锁），打开主面板仍可用。

### 无障碍

右键不是唯一入口——头部「菜单」按钮打开同一份菜单，`aria-haspopup="menu"`；菜单内方向键导航、Esc 关闭且**只关菜单不收起岛**（两件事必须分开，靠 `stopPropagation` 实现）。

### 新增测试

`src/features/island/__tests__/Island.context-menu.test.tsx`（9 例）：右键开菜单且六项顺序符合 PRD、菜单按钮同源、新建卡片开表单并关菜单、立即锁定/设置回调、Esc 只关菜单不收起岛、Tauri 项禁用带原因、锁定态三项禁用、点外部关闭。

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **55 文件 / 391 用例**全部通过，`act` 警告 **0** |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify --emptyOutDir false` | 通过，`index.js **459.58 kB** (gzip **172.44 kB**)` / `index.css 25.89 kB (gzip 5.31 kB)` |

---

## Phase 6 补 · 灵动岛「生成密码」快捷按钮（FR-02 P0）

### 需求来源

FR-02 要求岛上三个快捷按钮「新建、生成密码、锁定」。此前只有新建与锁定，「生成密码」只存在于新建表单内部（重新生成），没有独立入口——想给外部网站生成一个密码时无路可走。

### 实现

| 触点 | 改动 |
| --- | --- |
| `src/services/vault-client.ts` | 新增 `copyGeneratedPassword(options?)`：生成 → 写剪贴板 → 登记到期清理，返回与复制密码同构的回执。**不要求解锁**（不读写库内数据，锁定时生成密码去别处用是合理需求） |
| `src/features/island/Island.tsx` | 头部加图标按钮（`KeyRound`，`aria-label="生成密码"`），锁定态禁用；toast 区分清理档位：「已复制新生成的密码 · N 秒后自动清空」/「不会自动清空」 |

岛内不显示明文（SDD：岛内只显示账号与操作），所以落点是"复制 + 提示"，与既有的复制密码行为一致。

### 新增测试

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `src/services/__tests__/vault-client-generate-copy.test.ts` | 5 | 写入剪贴板且回执同构、生成配置真正生效（长度 24 / 仅小写）、关闭档 `autoClear:false`、锁定态可用、非法配置拒绝且不写剪贴板 |
| `src/features/island/__tests__/Island.generate-password.test.tsx` | 3 | 点击复制并提示秒数、关闭档提示"不会自动清空"、锁定态禁用 |

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **57 文件 / 399 用例**全部通过，`act` 警告 **0** |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify --emptyOutDir false` | 通过，`index.js **460.34 kB** (gzip **172.59 kB**)` |

---

## Phase 6 补 · 系统锁屏 / 休眠立即锁定（FR-01 P0）

### 需求来源

PRD FR-01 / `prd.md:108`：「**系统锁屏、休眠立即锁定（默认开，可关）**」，Q3 定案为「30 分钟 + 锁屏立即锁定」。

核查结论：**零实现**。`LockReason` 类型里早有 `'system_lock' | 'suspend'` 两个值，但全仓（排除测试）除 `MainPanel.tsx:139` 一条注释外，`visibilitychange` / 锁屏 / 休眠监听**一处都没有**——枚举值写好了、通路没接。设置页也没有对应开关。

### 实现

| 触点 | 改动 |
| --- | --- |
| `src/core/vault/types.ts` | `SessionSnapshot` 增 `lockOnSystemLock: boolean` 与 `lockReason: LockReason \| null` |
| `src/core/vault/session.ts` | 新增 `lockOnSystemLock` 字段（默认 `true`）+ `get/setLockOnSystemLock()`；`snapshot()` 一并输出该开关与最近锁定原因 |
| `src/services/storage.ts` | `VaultMeta` 增 `lockOnSystemLock?: boolean`；`createDefaultMeta()` 增第 5 个参数（默认 `true`） |
| `src/services/vault-client.ts` | 门面增 `setLockOnSystemLock(enabled)` 与 `lockForSystemEvent()`；`ensureLoaded()` 回读开关 |
| `src/features/session/SessionGate.tsx` | `visibilitychange → hidden` 时调 `lockForSystemEvent()` |
| `src/features/unlock/UnlockScreen.tsx` | 解锁页新增「为什么被锁」提示（`data-testid="lock-reason"`），7 种 `LockReason` 全覆盖 |
| `src/features/settings/SettingsPanel.tsx` | 安全区新增开关（`role="switch"`），文案如实说明 Web 端是近似 |

### 五个关键决策

1. **Web 端用 `visibilitychange` 近似，并写在脸上。**
   浏览器拿不到操作系统的锁屏 / 休眠事件。`visibilitychange → hidden` 是唯一能同时覆盖两者的信号（锁屏或休眠时页面必然转 hidden），代价是"切标签页"也会锁。方向上是**多锁不漏锁**，对密码库可接受；设置项文案明确写了「暂以『页面切到后台』近似」，不让用户把上锁当 bug。桌面端接入 Tauri 后只需换信号源，这一层不用改。

2. **开关判断放在门面，不放在监听点。**
   `lockForSystemEvent()` 内部判两件事：开关是否关闭、会话是否已解锁。若把判断留给 UI，将来多一个监听点（比如 Tauri 的真实锁屏事件）就必然有一处漏判，表现为"关了还是会锁"。这和上一轮冷却期错误码漂移是同一类病：**策略只写一份**。

3. **关闭时必须是"真空操作"。**
   常见错误写法是"顺手清一下"——擦密钥、清授权、dispose 资产服务，只是提示语不同。那比不做更糟：用户明确关了开关，却被悄悄踢出解锁态。测试用 `listItems()` 仍可读来钉住这一点（不是只看 `status`）。

4. **`VaultMeta.lockOnSystemLock` 声明为可选，读时用 `!== false`。**
   这个字段是后加的，早于它落盘的记录里没有。用 `=== true` 会把所有老库静默降级成"关"——安全设置上的静默降级用户永远不会发现，直到需要它的那一刻。可选 + `!== false` 让缺省语义等于"开"，与 PRD 默认值一致。

5. **顺带把 `LockReason` 从死字段救活。**
   核心层一直在记 `lastLockReason`，但 UI 从不显示：超时被锁和手动锁定看到的是同一个界面。FR-01 之后这个问题变尖锐（切个标签页回来就锁了），所以把它放进快照、在解锁页给一句人话。放在快照里而不是让 UI 单独查一次，是因为解锁页只拿得到快照，多一次异步查询就多一处 act 时序与竞态。

### 踩坑

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 两条 `not wrapped in act` 警告 | 测试里用裸 `setTimeout(0)` 等异步链路，主面板挂载时那次 `client.status()` 的 setState 落在 act 外面 | `flush()` 与直接改门面的 `toggle()` 都包进 `act`；警告归零 |
| 关掉开关后每次切标签页都白渲染 | 门面返回"什么都没变"的新快照对象，`setSnapshot` 照单全收 | `setSnapshot` 用函数式更新，仅当 `status` 真变才换引用 |
| 给 `SessionSnapshot` 加必填字段，担心炸一片测试 | 先 `grep -rln "cooldownRemainingMs:"` 确认全仓只有 `session.ts` 构造它（测试里的 `autoLockPolicy: '30m'` 字面量是 `VaultMeta`，不是快照） | 零改动通过；这也说明"加字段前先查谁在构造它"比加完再修快得多 |

### 新增测试

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `src/services/__tests__/lock-on-system-lock.test.ts` | 6 | 默认开、开启时锁定且原因为 `system_lock`、关闭时真空操作（数据照读）、已锁定时不覆盖原锁定原因、开关落盘重启沿用（解锁后验证行为）、老元数据缺字段按"开"解释 |
| `src/features/session/__tests__/SessionGate.system-lock.test.tsx` | 3 | 默认开时转入后台回解锁页并说明原因、关闭后仍留解锁态、关掉再打开重新生效 |
| `src/features/settings/__tests__/SettingsLockOnSystemLock.test.tsx` | 3 | 默认开启且文案交代近似、关闭后回填快照+提示+写入门面、重开设置页显示"已关闭" |

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **60 文件 / 411 用例**全部通过，`act` 警告 **0** |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify` | 通过，`index.js **462.26 kB** (gzip **173.36 kB**)` / `index.css 25.96 kB (gzip 5.32 kB)` |

---

## Phase 6 补 · 卡片跳转目标二选一菜单（FR-07.1 P0）

### 需求来源

FR-07.1 原文三句：「仅配置一个目标时直接跳转；**两者都配置时弹出二选一菜单**；未配置时按钮置灰」。

核查结论：三条里**前两条只做了一半**。`ItemCard` 已有 `disabled={!hasUrl && !hasAppTarget}`（置灰 ✅）、`hasUrl` 时直接 `openExternal`（单目标 ✅），但**两者都配置时也是直接开网页**——用户想启动本地客户端时无从选择，PRD 明确要求的那一步缺失。

### 实现

| 触点 | 改动 |
| --- | --- |
| `src/features/vault/ItemJumpMenu.tsx`（新建） | 二选一菜单：`role="menu"` / `role="menuitem"`、打开聚焦首项、Esc 关闭、点外部关闭 |
| `src/features/vault/ItemCard.tsx` | 抽出 `openUrl()`；`handleOpen()` 按"两目标 → 弹菜单 / 单目标 → 直跳"分支；按钮补 `aria-haspopup="menu"` + `aria-expanded`；按钮包一层 `relative` 容器并挂 `ref` 供定位 |

### 五个关键决策

1. **portal + `position: fixed`，不是 `absolute`。**
   卡片容器带 `overflow-hidden`（圆角与倾斜动效需要），`absolute` 菜单会被卡片边界裁成一条边。改为 portal 到 `body`，按触发按钮的 `getBoundingClientRect()` 定位，菜单才真的浮在卡片之上。
2. **点外部关闭必须把触发按钮排除。**
   `mousedown` 先于 `click`：只判"菜单外"会导致 mousedown 关掉、click 又打开，用户看到的是"菜单关不掉"。因此 `anchorRef.contains(target)` 也要放过。
3. **Esc `stopPropagation()`。** 与灵动岛右键菜单同一处理：Esc 只关当前这一层，不冒泡去退出选择模式或关详情页。测试用一个外层 `onKeyDown` spy 钉住"没冒泡"。
4. **「启动本地应用」置灰 + `title` 说明，而不是点了没反应。**
   Web 阶段没有 `ShellExecute`，这一项本来就执行不了。按既有诚实模式如实禁用并写明"需要桌面版"；Tauri 接入后去掉 `disabled` 即生效，UI 结构不用改。
5. **单目标不弹菜单。** PRD 原文如此，也是对的：取密码这件事上，多一步选择就是多一次打断。

### 新增测试

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `src/features/vault/__tests__/ItemCard.jump-menu.test.tsx` | 6 | 单目标直跳不弹菜单、双目标弹菜单且不替用户决定（含 `aria-expanded`）、选「在浏览器打开」跳转并收起、「启动本地应用」置灰且说明需要桌面版、Esc 只关菜单不冒泡、无目标按钮置灰 |

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **61 文件 / 417 用例**全部通过，`act` 警告 **0** |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify` | 通过，`index.js **464.59 kB** (gzip **174.11 kB**)` / `index.css 26.38 kB (gzip 5.37 kB)` |

---

## Phase 6 补 · 恢复密钥轮换（FR-08.1 P0）

### 需求来源

FR-08.1 原文：「解锁状态下可在设置中**重新生成**恢复密钥（重写 KEK-B 槽、作废旧密钥），用于怀疑泄露时轮换」；验收要点：「重新生成恢复密钥后，旧恢复密钥立即失效」。

核查结论：**核心能力有、门面与 UI 全无**。`VaultSession.rotateRecoveryKey()`（`session.ts:477`）与 `rewrapRecoverySlot()`（`keyslots.ts:218`）早就写好，`session.test.ts` / `session-boundary.test.ts` 也在核心层测过，但 `VaultClient` 上没有对应方法——用户没有任何入口能触发它。这是典型的"零件齐全、装配线没接"。

### 实现

| 触点 | 改动 |
| --- | --- |
| `src/services/vault-client.ts` | 新增 `RotateRecoveryKeyResult` 与门面方法 `rotateRecoveryKey(masterPassword)`；实现里先 `requireItemService()`（归一化 VAULT_LOCKED / AUTH_COOLDOWN）→ `verifyPassword` → 生成新恢复材料 → `session.rotateRecoveryKey` → `storage.saveKeyslots` |
| `src/features/settings/RotateRecoveryKeyDialog.tsx`（新建） | 两步对话框：验主密码（红框警告"旧码立即失效"）→ 展示新恢复码 + 复制 / 下载 `.kirk` + 必勾「已离线保存」才能点完成 |
| `src/features/settings/SettingsPanel.tsx` | 「安全」区底部加「重新生成恢复密钥」入口与说明；面板关闭时一并收起对话框 |

### 四个关键决策

1. **必须现验主密码，这不是多余的一步。**
   拿到已解锁会话的人如果能直接轮换，就等于把真正的机主永久锁在门外（旧码作废、新码在他手里）。这条路径唯一的授权点就是这一次密码校验，所以它必须存在，且走 `session.verifyPassword` 与解锁共用失败计数——否则轮换接口会成为一条绕过冷却的爆破通道。

2. **落盘失败要回滚内存里的密钥槽。**
   顺序是「先算新槽 → 再落盘」。若只报错不回滚，内存里是"新码可用、旧码已废"，磁盘上还是旧槽——用户手上那张新恢复码永远对不上，等于凭空丢掉一条找回通道。实现里先存 `previous = session.getKeyslots()`，`saveKeyslots` 失败就 `setKeyslots(previous)`，测试用 `FaultyStorage` 钉住。

3. **失败必须零副作用。**
   密码错、冷却、存储失败三种情况，旧恢复码都得仍然有效。测试对每种情况都验了一遍——安全操作里"失败但留了个坑"比"直接崩"更难发现。

4. **新恢复码只出现一次，不落任何持久化状态。**
   与首次设置同一规则：返回值即唯一副本，界面要求勾选「已离线保存」才能关闭，`handleClose` 清空所有本地 state，避免恢复码留在下一次打开的 DOM 里。

### 新增测试

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `src/services/__tests__/vault-client-rotate-recovery.test.ts` | 4 | 轮换成功（新码生效 / 旧码立即失效 / 会话不被打断 / 主密码仍可用）、密码错拒绝且旧码仍有效、锁定态拒绝、落盘失败回滚（同门面与新建门面都认旧码） |
| `src/features/settings/__tests__/RotateRecoveryKeyDialog.test.tsx` | 3 | 输入密码后展示新码且与旧码不同、未勾选「已保存」时「完成」禁用、密码错只出错误提示不展示恢复码、取消关闭 |

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **63 文件 / 424 用例**全部通过，`act` 警告 **0** |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify` | 通过，`index.js **468.25 kB** (gzip **175.23 kB**)` / `index.css 26.46 kB (gzip 5.38 kB)` |

---

## Phase 6 补 · 备份提醒（FR-06 P0）

### 需求来源

FR-06 原文：「**备份提醒**：超过 7 天未备份时，当日首次锁定前轻提示一次」。

核查结论：**零实现**——没有 `lastBackupAt`，没有任何提醒逻辑，导出成功也不记账。

### 实现

| 触点 | 改动 |
| --- | --- |
| `src/services/storage.ts` | `VaultMeta` 增 `lastBackupAt?` 与 `lastBackupReminderAt?`（均为可选，老记录按 `null`） |
| `src/services/vault-client.ts` | 新增 `BackupStatus` / `getBackupStatus()` / `takeBackupReminder()`；`exportBackup` 成功后记账 |
| `src/features/session/SessionGate.tsx` | 手动锁定与系统事件锁定都调 `remindBackup()`，有文案就 toast |
| `src/features/settings/SettingsPanel.tsx` | 「数据说明」区新增「上次备份」一行，超期时标黄并提示导出 |

### 四个关键决策

1. **基准是"上次备份时间，从未备份则用库创建时间"。**
   只按 `lastBackupAt === null` 判定会把刚建 5 分钟的库也催一遍——新用户第一次锁定就被教育"该备份了"，很吵。按创建时间算，"超过 7 天没备份"才真的等于"该备份了"。
2. **记账放在编码之后。**
   先记再编码，一旦编码失败就留下"已备份"的假记录：用户以为有备份、实际没有。这是比不提醒危险得多的方向。
3. **"当日一次"的记账在门面，不在 UI。**
   用户一天里反复锁定/解锁很常见；判断分散到每个锁定入口，必然出现"一天提醒三次"或"某个入口永远不提醒"。`takeBackupReminder()` 是**一次性语义**：同一自然日只返回非 null 一次。
4. **提醒失败绝不能挡住锁定。**
   为了一条备份提示把会话留在解锁态，是把附属功能做成了安全事故。`persistMeta` 失败、`takeBackupReminder` 抛错，全部静默——测试专门钉了这一条。

### 新增测试

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `src/services/__tests__/backup-reminder.test.ts` | 4 | 刚建库不催、超 7 天提醒且同日只一次 / 次日恢复、导出后 overdue 归零、备份过再超期文案带天数 |
| `src/features/settings/__tests__/SettingsBackupStatus.test.tsx` | 3 | 从未备份、超期标黄 + 天数、读失败显示 `—`（不谎称"从未备份"） |
| `src/features/session/__tests__/SessionGate.backup-reminder.test.tsx` | 3 | 超期锁定弹提醒、返回 null 不弹、**提醒失败仍完成锁定** |

---

## Phase 6 补 · 视图切换 / 自定义分类（FR-03）+ 桌面端开关（FR-05）

### 需求来源与核查

| PRD 条目 | 原文 | 核查结论 |
| --- | --- | --- |
| FR-03 布局 | 「右侧卡片网格（**可切列表视图**）」 | **缺**：只有多列网格，无切换入口 |
| FR-03 表单 | 「分类（预设…**可自定义**）」 | **半截**：编辑器是自由输入（能存自定义分类），但左侧导航只列硬编码预设，用户建了「工具」在导航里找不到 |
| FR-05 防截屏 | 「默认 WDA_EXCLUDEFROMCAPTURE，**可开关**」 | 依赖 Tauri，Web 无能力 |
| FR-05 网络行为 | 「仅『检查更新』为显式开关（**默认关**）」 | 无任何网络请求，也无开关 |

### 实现

| 触点 | 改动 |
| --- | --- |
| `src/stores/ui-store.ts` | 新增 `viewMode: 'grid' \| 'list'` + `setViewMode`（只存 UI 偏好，不进元数据） |
| `src/features/vault/MainPanel.tsx` | 工具条加「网格 / 列表」分段按钮（`aria-pressed` 互斥）；列表容器按 `viewMode` 切单列；导航分类改为「预设 ∪ 数据里出现过的分类」 |
| `src/features/settings/SettingsPanel.tsx` | 新增 `DesktopOnlyToggle`：防截屏、检查更新两项置灰并写明原因 |

### 三个关键决策

1. **列表视图复用同一张卡片，只改容器布局。**
   另写一套「列表行」组件意味着复制粘贴/收藏/编辑/删除/按住预览要再实现一遍，两套 UI 必然行为漂移（改了一边忘另一边）。代价是列表不如真·密集表格紧凑，收益是**行为只有一份**。
2. **导航分类 = 预设 ∪ 数据里出现过的分类，且只统计非隐藏卡片。**
   自定义分类本来写得进去，缺的是"建完能在导航里看到"。同时必须排除隐藏卡片——隐藏卡片连"存在"都不该暴露，它的分类名出现在导航里同样是泄漏（"家里有个叫 私密 的分类"本身就是信息）。
3. **桌面端开关用"未勾选 + 置灰 + 原因"，不用"勾着的禁用复选框"。**
   勾着的禁用框传达的是"现在是开的"，而 Web 阶段根本没有这个能力。宁可显示未勾选再补一句"桌面版默认开启"。

### 新增测试

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `src/features/vault/__tests__/MainPanel.view-and-categories.test.tsx` | 3 | 默认网格 / 切列表后容器与 `aria-pressed` 同步 / 能切回；自定义分类进导航并可按分类筛选；隐藏卡片的分类不进导航 |
| `src/features/settings/__tests__/SettingsDesktopOnlyToggles.test.tsx` | 2 | 防截屏置灰 + 说明 WDA_EXCLUDEFROMCAPTURE；检查更新置灰 + 说明零网络请求 |

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **68 文件 / 439 用例**全部通过，`act` 警告 **0** |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify` | 通过，`index.js **472.84 kB** (gzip **176.67 kB**)` / `index.css 26.51 kB (gzip 5.38 kB)` |

---

## Phase 6 补 · 快捷键清单 + 操作日志（NFR 可用性 / 可靠性）

### 需求来源

| NFR 条目 | 原文 | 核查结论 |
| --- | --- | --- |
| 可用性 | 「所有快捷键**可在设置中查看**与自定义」 | **缺**：快捷键散在 `Island` / `MainPanel` / `Modal` / 两个菜单里，用户没有任何地方能看到全貌 |
| 可靠性 | 「**操作日志**本地化且**不含敏感数据**（含跳转目标，不含填充动作）」 | **缺**：完全没有日志 |

### 实现

| 触点 | 改动 |
| --- | --- |
| `src/core/vault/audit.ts`（新建） | `AuditAction` / `AuditEntry` / `AuditLog`（200 条环形缓冲）+ `sanitizeJumpTarget()` |
| `src/core/vault/index.ts` | 导出 `./audit` |
| `src/services/vault-client.ts` | 新增 `getAuditLog()` / `clearAuditLog()` / `recordJump()`；在解锁、锁定、建/改/删、复制账号/密码、预览密码、导出/导入、轮换恢复密钥处记账；销毁时清空日志 |
| `src/features/vault/ItemCard.tsx` | 跳转**成功打开后**才 `recordJump()`（失败不记，否则日志会撒谎） |
| `src/features/settings/AuditLogPanel.tsx`（新建） | 最近 20 条：时间 · 中文动作 · `#id` · 裁剪后的说明 + 清空按钮 + 边界说明 |
| `src/features/settings/SettingsPanel.tsx` | 新增「快捷键」区块（7 条，`<kbd>` 语义）与「操作日志」区块；打开时拉取日志 |

### 五个关键决策

1. **日志里只有"动作 + id + 裁剪过的说明"，绝不含密码 / 账号 / 标题 / 备注。**
   日志会进设置页给人读、也可能被截图；掺进明文，日志本身就变成泄漏源。测试用"把整份日志序列化后反查明文"来钉这一条，而不是只看某个字段。
2. **跳转目标只留 `origin + pathname`。**
   登录链接的 query 里经常带 token / session，原样写进日志等于把凭据抄了一份。PRD 要求"日志含跳转目标"，但"含目标"不等于"含整串 URL"。非 http(s) 的 scheme 只记协议名。
3. **批量删除记一条汇总，不逐条记。**
   一次删 20 张会刷掉 20 条日志，把"最近发生了什么"整个淹掉——日志的价值在于可读，不在于条数。
4. **销毁数据时把日志一起清掉，且不记 `vault.destroy`。**
   销毁的语义是"不留痕迹"，日志本身也是痕迹。记一条再立刻删掉属于自欺，所以直接清空，并在类型里不留这个动作（避免出现"声明了却永不产生"的死枚举）。
5. **快捷键清单照着代码抄，不照 PRD 想象写。**
   每一条都能在对应组件里找到处理逻辑；清单与代码脱节就会变成谎话。全局热键与自定义绑定如实标注"需要桌面版"。

### 新增测试

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `src/core/vault/__tests__/audit.test.ts` | 7 | 新的在前、`limit` 截断、环形容量丢最旧、清空、跳转目标裁 query/hash、自定义 scheme 只留协议、无法解析给占位符 |
| `src/services/__tests__/vault-client-audit.test.ts` | 7 | 建/改/删留痕且倒序、锁定记原因、复制只记 id、**整份日志反查不到密码/账号/标题/备份密码**、跳转 token 不进日志、主动清空、销毁清空 |
| `src/features/settings/__tests__/SettingsAuditLog.test.tsx` | 3 | 空态说明 + 声明不含敏感内容、有记录显示中文动作与 `#id`、清空后回空态 |
| `src/features/settings/__tests__/SettingsShortcuts.test.tsx` | 2 | 7 条快捷键（`kbd` 语义）、说明全局热键需桌面版 |

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **72 文件 / 458 用例**全部通过，`act` 警告 **0** |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify` | 通过，`index.js **477.29 kB** (gzip **178.46 kB**)` / `index.css 26.63 kB (gzip 5.41 kB)` |

---

## Phase 6 补 · 热区宽度 / 位置可配置 + 全屏抑制（FR-02）

### 需求来源

| FR-02 原文 | 核查结论 |
| --- | --- |
| 「屏幕顶部中央热区（**默认宽约 300px，可配置宽度与位置**）检测鼠标进入」 | **半实现**：热区是整条顶边（`clientY <= 4` 即命中），宽度硬编码在常量里，没有任何配置入口 |
| 验收要点「全屏应用前台时鼠标划过顶部不弹出」 | **零实现**：全仓没有 `document.fullscreenElement`，全屏下照样弹出 |

### 实现

| 触点 | 改动 |
| --- | --- |
| `src/lib/hotzone.ts`（新建） | `HotzoneConfig` / `HotzoneAlign`、`clampHotzoneWidth()`、`resolveHotzone()`、`hotzoneBand()`、`isWithinHotzoneX()`、`isFullscreenActive()` |
| `src/services/storage.ts` | `VaultMeta` 增加可选 `hotzoneWidthPx` / `hotzoneAlign`；`createDefaultMeta()` 写入 300 / center |
| `src/services/vault-client.ts` | 新增 `getHotzoneConfig()` / `setHotzoneConfig(patch)`；`hotzoneFromMeta()` 做字段名映射（元数据带 `hotzone` 前缀，纯函数吃 `widthPx/align`） |
| `src/stores/ui-store.ts` | 新增 `hotzone` 镜像 + `setHotzone()`（值不变时复用旧对象，避免无限重渲染） |
| `src/features/island/Island.tsx` | 命中判定加横向区间与全屏抑制；视口宽度跟随 `resize`；挂载时拉一次配置；命中带按配置渲染 `left/width` |
| `src/features/settings/SettingsPanel.tsx` | 新增「灵动岛热区」区块：宽度数字输入（失焦 / 回车提交）、位置三选一、1440px 折算的覆盖范围预览条、全屏抑制的诚实说明 |
| `src/lib/i18n.ts` | `error.hotzone_invalid_width` / `error.hotzone_invalid_align` |

### 五个关键决策

1. **宽度与位置算一份、渲染与判定共用。**
   设置页的预览条、DOM 锚点的 `left/width`、鼠标命中判定全部走 `hotzoneBand()`。分开算就会出现"设置说 300px、实际命中 260px"——这种错位用户永远查不出来，只会觉得"热区有时灵有时不灵"。
2. **越界值报错，不静默夹取。**
   设置页的输入框已经用 `min/max` 夹过，能走到门面的越界值意味着调用方算错了。静默改成边界值等于把这个 bug 永久藏起来。夹取只发生在"读老数据"这条路径（`resolveHotzone`），因为那里越界是历史事实、不是新错误。
3. **元数据字段名必须映射，不能直接把 `meta` 丢给 `resolveHotzone`。**
   第一版就是这么写的：元数据叫 `hotzoneWidthPx`、纯函数读 `widthPx`，两个字段都读不到 → 永远回落 300px，且**不报错**。表现是"设置改了、预览条动了、实际热区没动"。三个测试当场抓住，改为 `hotzoneFromMeta()` 单点映射。
4. **全屏检测只覆盖浏览器全屏，且写进 UI。**
   `document.fullscreenElement` 能看到 F11 与页面全屏；系统里另开的全屏游戏在浏览器进程之外。把这条写进设置页，而不是靠"实现了全屏检测"让用户以为全覆盖。同理，多显示器主屏归属与窗口自由摆放也标注为桌面版能力。
5. **坐标缺失时放行横向判定。**
   jsdom 没有 `PointerEvent`，合成事件可能只有 Y 没有 X。判为"不在热区"会让键盘 / 合成唤出路径在测试与低版本 WebView 里整体失效；判为"在热区"最多多重一次唤出，而唤出幂等。

### 存量测试的连带修改（重要）

`fireEvent.mouseMove(window, { clientY: 0 })` 会把**没传的 `clientX` 补成 0**，等于"鼠标在屏幕左上角"。旧用例按"整条顶边都是热区"写，所以只给 Y 就够；热区收窄成居中的一条带之后，左上角不再命中。

处理方式：两个灵动岛测试文件里 32 处鼠标移动统一补 `clientX: 512`（jsdom 视口 1024 的水平中心），并在 `IslandHotzone.test.tsx` 头部写明这条坐标约定。**没有放宽实现去迁就旧用例**——那样等于把刚修好的"整条顶边误触"又放回去。

### 新增测试

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `src/lib/__tests__/hotzone.test.ts` | 16 | 宽度四舍五入与上下限、`NaN`/`Infinity`/非数值回落、逐字段回落、闭区间边界（569/570/870/871）、窄视口收敛不出负数、坐标缺失放行、`fullscreenElement` 与 webkit 前缀 |
| `src/services/__tests__/hotzone-config.test.ts` | 6 | 默认 300 居中、重启后沿用、部分更新、越界/非整数/非法位置报 `VALIDATION_FAILED` 且不落盘、未初始化写配置报 `VAULT_NOT_INITIALIZED` |
| `src/features/island/__tests__/IslandHotzoneWidth.test.tsx` | 4 | DOM 锚点与命中带一致（1024 下 left=362）、改配置后按 600/靠左渲染、带外不唤出带内唤出、全屏抑制 |
| `src/features/settings/__tests__/SettingsHotzone.test.tsx` | 4 | 默认渲染、改宽度同步门面 + UI store、改位置同步、越界输入回退且不落盘 |

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **76 文件 / 488 用例**全部通过，`act` 警告 **0** |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify` | 通过，`index.js **482.04 kB** (gzip **180.23 kB**)` / `index.css 26.67 kB (gzip 5.42 kB)` |

---

## Phase 6 补 · 收起延时对齐 2 秒并可配置（FR-02 / SDD §6.5）

### 需求来源

| 原文 | 核查结论 |
| --- | --- |
| PRD FR-02「**收起**：鼠标离开 2 秒后自动收起」 | **不符合**：实现是固定 `HIDE_DELAY_MS = 250ms` |
| SDD §6.5「Demo 使用 900ms 延迟收起用于浏览器体验；生产实现按 PRD 使用 **2 秒**延迟，并**允许用户在设置中配置**」 | **不符合**：既不是 2 秒，也没有任何配置入口 |

> **本条修正了此前的一条记录**：`Phase 2 补 · 灵动岛热区唤起` 里曾把"250ms 覆盖 2 秒收起"记为对 SDD 的行为契约变更，并在 P2 清理中删掉了 `COLLAPSE_DELAY_MS` / `scheduleCollapse`。当时把"2 秒收起"整体判成死路径是**判错了**——死的是"两套定时器同时排"的写法，不是 2 秒这个需求本身。本轮把延时恢复成可配置项（默认 2 秒），但只保留**一个**定时器，避免重演"两个定时器互相抢跑"。

### 实现

| 触点 | 改动 |
| --- | --- |
| `src/lib/timing.ts`（新建） | `COLLAPSE_DELAY_OPTIONS`（500/1000/2000/3000）、`DEFAULT_COLLAPSE_DELAY_MS = 2000`、`PEEK_HIDE_DELAY_MS = 250`、`isValidCollapseDelay()`、`resolveCollapseDelay()` |
| `src/services/storage.ts` | `VaultMeta` 增加可选 `collapseDelayMs`；新库写入 2000 |
| `src/services/vault-client.ts` | 新增 `getCollapseDelay()` / `setCollapseDelay()`；`ensureLoaded()` 回读；非法值报 `VALIDATION_FAILED`，未初始化报 `VAULT_NOT_INITIALIZED` |
| `src/stores/ui-store.ts` | 新增 `collapseDelayMs` 镜像 + `setCollapseDelay()` |
| `src/features/island/Island.tsx` | `scheduleHide()` 按相位取延时（折叠胶囊 250ms / 展开态 `collapseDelayMs`）；**已排队的隐藏不重复排** |
| `src/features/settings/SettingsPanel.tsx` | 「灵动岛」区块新增收起延时下拉（标注"2 秒（默认）"），并说明胶囊态不受影响 |
| `src/lib/i18n.ts` | `error.collapse_delay_invalid` |

### 四个关键决策

1. **延时按相位分两档，而不是全岛统一。**
   PRD 的"2 秒"说的是**工具栏（展开面板）**。实现里多了一个 PRD 没有描述的中间态：鼠标刚碰到顶部热区先滑出一枚 88×32px 的折叠胶囊。若胶囊也挂 2 秒，用户只是路过顶边就会被一枚可点击的悬浮按钮挡住 2 秒。所以胶囊 250ms、面板可配置（默认 2s）。这个区别写进了设置页文案——否则用户会问"我设了 3 秒，胶囊怎么还是马上没了"。
2. **已排队的隐藏不重复排。**
   这是把延时从 250ms 拉到 2 秒后**必须**配套改的一点：原实现每次 `mousemove` 都 `clearTimeout` 再重排，短延时下看不出来，2 秒下就变成"用户只要还在动鼠标，面板永远不收"。现在倒计时从"离开那一刻"起算，只有指针回到岛内 / 迟滞带（`cancelHide`）才中断。
3. **恢复 2 秒但只保留一个定时器。**
   当年删掉 `COLLAPSE_DELAY_MS` 的理由是"两个定时器互相抢跑、2 秒那条永远轮不到"。那个判断对，但结论过头了：需求本身没被撤销，撤销的应该是重复的那套。现在只有 `hideTimer` 一个定时器，延时由相位决定。
4. **只接受档位值。**
   下拉框能选出来的就四个值；放开任意毫秒只会让"越界该报错还是该夹取"重新变成争议。读老数据时走 `resolveCollapseDelay()` 回落 2000，因为那里越界是历史事实、不是新错误。

### 存量测试的连带修改

`IslandHotzone.test.tsx` 里 9 处"展开态离开 → 等待隐藏"的断言原本推进 300/600/1000ms，在新默认值下**根本不会到期**。其中 4 处还兼作"顺延保护真的生效"的回归断言（快捷新建、键盘优先、输入搜索词、焦点离开），如果只是把时间调大而不改，那些用例会退化成"时间还没到，所以面板还在"——**看起来仍然通过，其实什么都没验证**。

处理方式：引入 `HIDE_AFTER_LEAVE_MS = 2500`（2s 延时 + 500ms 余量覆盖 180ms 收起动画），9 处统一改用该常量；标题里写明"胶囊态"以区分两档延时。

### 新增测试

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `src/lib/__tests__/timing.test.ts` | 4 | 默认值在档位内、胶囊延时短于默认、只认档位值、缺失/NaN 回落 |
| `src/services/__tests__/collapse-delay.test.ts` | 4 | 默认 2000、重启后沿用、非档位值报错且不落盘、未初始化报 `VAULT_NOT_INITIALIZED` |
| `src/features/island/__tests__/IslandCollapseDelay.test.tsx` | 4 | 1900ms 仍在 / 2100ms 消失、设为 500ms 后 600ms 收起、**胶囊态不受配置影响**、**持续移动鼠标不续期** |
| `src/features/settings/__tests__/SettingsCollapseDelay.test.tsx` | 3 | 默认档位标注"（默认）"、改档位同步门面 + store、说明胶囊态不受影响 |

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **80 文件 / 503 用例**全部通过，`act` 警告 **0** |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify` | 通过，`index.js **483.42 kB** (gzip **180.76 kB**)` / `index.css 26.67 kB (gzip 5.42 kB)` |

---

## Phase 6 补 · 左侧导航「标签」分组（FR-03 P0）

### 需求来源

| FR-03 原文 | 核查结论 |
| --- | --- |
| 「左侧导航（全部 / 收藏 / 分类 / **标签** / 隐藏卡片 / 最近删除【V2】）」 | **缺「标签」**：导航只有 全部 / 收藏 / 分类 / 隐藏卡片 |
| 「顶部全局搜索与排序（最近使用 / 最近更新 / 字母序）」 | **已完整实现**：三个选项都在下拉里，`recent_used` 走 recency、`alpha` 走 `Intl.Collator`，无需改动 |

服务层其实早就支持：`ItemFilter.tag` 存在、`searchItems()` 里也有 `item.tags.includes(tag)` 的判断。缺的只是导航入口——和「自定义分类」那次是同一类问题：能力在，入口不在。

### 实现

| 触点 | 改动 |
| --- | --- |
| `src/features/vault/MainPanel.tsx` | 新增 `tags` 状态与 `TAG_NAV_PREFIX`；`NavItem` 加 `group`；导航按「分类 / 标签」分组渲染小标题；`reload()` 对 `tag:` 前缀走 `filter.tag`；统计 effect 同时收集标签；标签消失时回落「全部」；`aside` 的 `aria-label` 改为「资产导航」 |

### 三个关键决策

1. **导航 key 加 `tag:` 前缀。**
   分类与标签共用 `filters.category` 这一个字段，而两者**可以重名**（都有「工作」很常见）。不加前缀时点标签「工作」实际过滤的是分类「工作」——结果看起来"少了几张卡"，且没有任何报错。测试专门造了"分类工作 / 标签工作 / 只有标签工作"三条数据来钉这一点。
2. **分组标题必须渲染。**
   加了标签之后，同一列可能出现两个一模一样的「工作」。小标题「分类」「标签」是唯一能让人分清点哪个的线索。
3. **选中的标签消失时回落「全部」。**
   最后一张带该标签的卡被删掉后，导航项消失但 `filters.category` 还停在 `tag:xxx`，用户会看到一个没有任何高亮的空列表。用 `tagsLoadedRef` 区分"首次加载前"（此时 tags 本来就是空的，不该重置）与"真的消失了"。

### 新增测试

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `src/features/vault/__tests__/MainPanel.tag-nav.test.tsx` | 5 | 标签进入导航并归组、点标签按 `filter.tag` 过滤、**标签与分类重名互不串台**、隐藏卡片的标签不进导航、标签消失后回落「全部」（走真实删除 UI） |

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **81 文件 / 508 用例**全部通过，`act` 警告 **0** |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify` | 通过，`index.js **484.20 kB** (gzip **181.02 kB**)` / `index.css 26.74 kB (gzip 5.43 kB)` |

---

## Phase 6 补 · 灵动岛跳转入口（FR-07.1 P0）

### 需求来源

| FR-07.1 原文 | 核查结论 |
| --- | --- |
| 「卡片**与灵动岛**提供"跳转"操作：仅配置一个目标时直接跳转；两者都配置时弹出二选一菜单；未配置时按钮置灰」 | **只做了一半**：卡片侧完整（含二选一菜单），灵动岛侧**完全没有入口** |

「尚未覆盖」第 13 条此前记的是"建议等真实使用反馈再定放哪"，并把 7.1 标成已完成。这个判断站不住：PRD 写的是"卡片**与灵动岛**"，P0 需求不该用"等反馈"推迟。

### 实现

| 触点 | 改动 |
| --- | --- |
| `src/features/island/Island.tsx` | 新增 `openItemUrl()` / `handleJump()` / `closeJumpMenu()`；行级 `onContextMenu`（`stopPropagation` 拦掉岛级菜单）；`Ctrl+Enter` 键盘入口；`scheduleHide` 增加"跳转菜单开着就顺延"；页脚提示补 `Ctrl+Enter 打开链接` |
| `src/features/vault/ItemJumpMenu.tsx` | `anchorRef` 类型从 `HTMLButtonElement` 放宽到 `HTMLElement`（灵动岛的锚点是 `<li role="option">`），文档改为"卡片与灵动岛共用" |

### 四个关键决策

1. **入口是"右键卡片 + Ctrl+Enter"，不在每行塞图标。**
   列表行高只有 32px，主路径是"搜到 → Enter 复制密码"；再加一个常驻图标会让高频路径变拥挤。更实质的问题是无障碍：`<li role="option">` 里出现可聚焦子元素会破坏 listbox 语义（APG 明确 option 不含交互控件）。右键 + 快捷键两条路都不往 option 里加 DOM。
2. **`Ctrl+Enter` 必须判在普通 `Enter` 分支之前。**
   两者的 `event.key` 都是 `'Enter'`。顺序写反的后果不是"快捷键失灵"，而是**用户按的是"打开网站"，密码却进了剪贴板**——两个动作的隐私含义完全不同，且用户不会立刻发现。测试用 `expect(copy).not.toHaveBeenCalled()` 钉住。
3. **复用 `ItemJumpMenu`，不另写一份岛内菜单。**
   菜单项、定位方式、Esc 行为两处必须一致；同一个功能在两个地方手感不同，用户没有任何理由理解这个差异。代价是 `anchorRef` 类型放宽——这是为复用付的合理成本。
4. **跳转菜单开着时 `scheduleHide` 无条件顺延。**
   菜单 portal 到 body，指针已经离开岛内；照常隐藏会把菜单连面带岛一起撤掉，用户根本没机会点。与"快捷新建开着"同一类顺延，但这里更严：菜单是用户刚明确打开的操作面，不看焦点。

### 新增测试

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `src/features/island/__tests__/IslandJump.test.tsx` | 7 | 单目标直接打开不弹菜单、Ctrl+Enter 打开且**不触发复制**、双目标弹菜单且本地项置灰、只有本地应用给桌面版提示、无目标提示、右键不连带弹岛级菜单、菜单开着时移开鼠标不收起 |

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **82 文件 / 515 用例**全部通过，`act` 警告 **0** |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify` | 通过，`index.js **485.11 kB** (gzip **181.23 kB**)` / `index.css 26.74 kB (gzip 5.43 kB)` |

---

## Phase 6 补 · 销毁数据保护链补「主密码二次认证」（FR-08.4 P1）

### 需求来源

| FR-08.4 原文 | 核查结论 |
| --- | --- |
| 「保护链：需处于解锁状态 + **输入主密码** + 输入确认文字"销毁" + 明确告知不可恢复」 | **三环缺一环**：解锁态（能打开设置面板即满足）与确认文字（「清空」）都有，**主密码二次认证完全缺失** |
| 「执行：安全擦除数据库文件（多轮覆写后删除）+ 清空内存密钥 + 清除应用配置中的关联数据」 | 内存侧已完成（`storage.clear()` + 清密钥 + 清日志）；**磁盘覆写要等 Tauri 落盘**，Web 阶段的 IndexedDB 删除不满足"多轮覆写" |

缺的这一环不是锦上添花：销毁是**不可逆**操作，而"能打开设置面板"的门槛太低——任何人走到一台已解锁的机器前都能做到。PRD 整章 FR-08 想防的正是这个场景。

### 实现

| 触点 | 改动 |
| --- | --- |
| `src/services/vault-client.ts` | 新增门面方法 `verifyMasterPassword(password)`；内部走 `session.verifyPassword()`，与解锁共用失败计数与冷却 |
| `src/features/settings/SettingsPanel.tsx` | 「清空全部数据」改名「销毁全部数据」；新增主密码输入框；按钮需**确认词 + 主密码两项都填**才启用；`handleReset` 改为先验密码再销毁 |
| `src/lib/i18n.ts` | 无新增（复用 `error.auth_invalid` / `error.vault_locked`） |

### 三个关键决策

1. **先验密码，再销毁——顺序不能反。**
   反过来的后果是"密码错"发生在数据已经没了之后：用户看到的是一个既没删掉数据、也解释不清的报错。测试用 `expect((await client.listItems()).length).toBeGreaterThanOrEqual(0)` 钉住"库还在"。
2. **无论成败都清空密码输入框。**
   失败后留着输入框里的明文密码，用户下次打开设置面板会以为已经填好了，直接点确认就绕过了二次认证——这正是本轮要堵的洞。所以 `catch` 分支里也 `setDestroyPassword('')`。
3. **未初始化报 `VAULT_NOT_INITIALIZED`，不报 `VAULT_LOCKED`。**
   第一版把所有非解锁态一律报成"已锁定，请先解锁"。没建库时这么提示是错的——用户会去找一个不存在的解锁入口。门面比 `session` 多做的就是这个状态分辨。

### 一个顺带发现的问题（本轮已修）

上一轮的 `IslandJump.test.tsx` 留下了 **8 个 TypeScript 错误**（`harness.open` 不存在于 `TestClient`，`NOW` 未使用），`tsc --noEmit` 实际不过。原因是上一轮的验证顺序把 `tsc` 排在了对该文件的编辑之前。本轮重写该文件并复跑四项校验，现在 `tsc` 0 error。

### 新增测试

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `src/services/__tests__/vault-client-verify-master.test.ts` | 6 | 正确密码通过且**不续期** `unlockedUntil`、错误密码 `AUTH_INVALID`、锁定态 `VAULT_LOCKED`、未初始化 `VAULT_NOT_INITIALIZED`、连续错到阈值进 `AUTH_COOLDOWN`（不能当试密码通道） |
| `src/features/settings/__tests__/SettingsDestroy.test.tsx` | 5（重写） | 确认词与主密码缺一不可、确认词写错不提交、**主密码错时不销毁**且清空输入、锁定态拒绝并提示先解锁、销毁后回到首次设置且可重新初始化（E2E-09） |
| `src/features/island/__tests__/IslandJump.test.tsx` | 7（重写） | 同上轮七条，另补 `new URL()` 归一化后的尾斜杠断言 |

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **83 文件 / 523 用例**全部通过，`act` 警告 **0** |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify` | 通过，`index.js **485.63 kB** (gzip **181.38 kB**)` / `index.css 26.74 kB (gzip 5.43 kB)` |

---

## Phase 6 补 · 恢复密钥找回的持久化回归（FR-08.3 验收）

### 需求来源

| FR-08 验收要点 | 核查结论 |
| --- | --- |
| 「用恢复密钥可完整解库并重设主密码，旧主密码失效、数据零丢失」 | 已有 `vault-client.test.ts` 一条，但**全程只用一个 client 实例**——内存里换掉密钥槽就能让断言全绿，**不证明新密钥槽写进了存储** |
| 「重设后备份导出/恢复正常」 | **无任何覆盖** |
| 「恢复密钥保持有效」（PRD 8.3 原文） | 无覆盖 |
| 「仅有恢复密钥时不能在日常解锁界面直接进入」 | 已满足（`resetMasterPasswordWithRecoveryKey` 末尾 `clearKeyMaterial('recovery')`），本轮补回归钉住 |
| 「仅有主密码（无恢复密钥）时无法伪造或绕过」 | 已满足：全仓只有 `resetMasterPasswordWithRecoveryKey` 一条路径能改写密码槽，且必须持有有效恢复密钥 |

第一行的缺口是这条流程里唯一碰盘的地方：`persistAfterPasswordReset` 要是悄悄失败，用户重启应用后会发现**新密码打不开、旧密码也失效了**——整库锁死，且没有任何提示。

### 实现

新增 `src/services/__tests__/vault-client-recovery-persistence.test.ts`，关键手法是**模拟重启**：同一个 `MemoryVaultStorage` 实例上新建 `createVaultClient`，只继承磁盘状态、不继承任何内存状态。

| 用例 | 钉住的行为 |
| --- | --- |
| 重设后重启：新密码能解锁、旧密码失效、数据零丢失 | `persistAfterPasswordReset` 真的写盘了 |
| 重设后重启：提示已更新且不影响解密 | 提示是元数据，改它不动加密层 |
| 重设后重启：恢复密钥仍然有效，可再次找回 | PRD 8.3「恢复密钥保持有效」 |
| 重设后导出的备份可在新库覆盖导入并恢复正常 | FR-08 验收「重设后备份导出/恢复正常」 |
| 重设前的旧备份仍可用新主密码覆盖导入 | **如实钉住一个待决策行为**，见下 |

### 本轮最重要的发现：旧备份会把重设前的主密码装回来

`resetMasterPassword` 之后旧主密码确实失效，但**用重设前导出的 `.kib` 备份做覆盖导入，会把备份里的旧密钥槽整体换回来**——旧主密码重新可用，新主密码反而失效。

- **不是越权**：覆盖导入要求提供当前库主密码，且 DEK 世系必须一致，两步都挡着。
- **本质是语义问题**：当前实现里"恢复备份 = 回到导出那一刻"，包括凭据。
- **但有一个真实风险**：因怀疑泄露而重设密码的用户，若之后恢复旧备份，会在不知情的情况下把可能已泄露的旧密码装回来，而当前实现没有任何提示。
- **与验收要点的字面冲突**：FR-08 写「旧主密码失效」。

本轮**没有改行为**，只用测试把现状钉住（含"新主密码此时反而失效"这个反直觉后果），并写入「尚未覆盖」第 18 条，附两个待决策方向：(a) 覆盖导入时用刚验过的当前主密码重wrap密码槽，只恢复数据不恢复凭据；(b) 保持现状，但在导入确认弹窗里明示风险。这是个需要产品拍板的安全语义变更，不适合单方面改。

### 过程中修掉的两个自己的错

1. 第一版在 `resetMasterPassword` 之后直接 `exportBackup` —— 重设后会话是锁着的，直接 `VAULT_LOCKED`。PRD 8.3 的"回到锁定态"在这里咬了自己一口。
2. 第一版把"旧密码是否还能用"写成了 `expect(typeof x).toBe('boolean')` 这种恒真断言。那是明知有问题却不敢下结论的写法，比没有测试更糟——它会在未来某次改动后继续绿着。改成直接断言观察到的行为。

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **84 文件 / 528 用例**全部通过，`act` 警告 **0** |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify` | 通过，`index.js **485.63 kB** (gzip **181.38 kB**)` / `index.css 26.74 kB (gzip 5.43 kB)` |

---

## Phase 7 · 快捷键可自定义（NFR 可用性）

### 需求来源

NFR 可用性原文是「所有快捷键可在设置中**查看与自定义**」。查看那半早就落地了（设置页只读清单），但自定义那半是空的——7 条全是硬编码字符串。这是 Web 阶段还能做的最后一条 NFR。

### 设计决策（为什么只让改四个、且只给下拉框）

| 决策 | 理由 |
| --- | --- |
| **只开放 4 个"应用语义键"**：聚焦搜索 / 复制密码 / 复制账号 / 跳转 | ↑↓ 移动、Esc 收起是 WAI-ARIA APG 与浏览器原生行为，不是密岛的选择。把它们做成可配置，等于允许用户把应用改成不合规，而设置页不会提醒后果。所以这三行**照常列出**、显示组合键，但标为「固定」并说明原因。诚实的部分交付好过假装全都能改。 |
| **取值只接受备选项（下拉框），不放"任意合法组合键"** | 否则用户能设出 `Ctrl+W`（关标签页）这种把自己锁在门外的组合，或和浏览器原生行为冲突。 |
| **冲突必须在门面也拦** | 设置页把已占用选项置灰只是 UI 便利；`setShortcut` 自己跑三道校验（动作可配置 / 取值在备选项 / 不与别的动作重复），全部抛 `VALIDATION_FAILED`——调用方可以是任意代码，靠 UI 守不变式迟早会破。 |
| **真值在元数据，store 只镜像** | keydown 是同步路径，不能等 Promise。所以 `meta.shortcuts` 是真值，`ui-store.shortcuts` 是供键盘处理同步读取的镜像。 |

### 实现文件

| 文件 | 改动 |
| --- | --- |
| `src/lib/shortcuts.ts` | **新增**，全部纯逻辑：绑定解析/序列化、备选项、命中判定 `matchesBinding`、冲突检测、默认值与固定项定义 |
| `src/services/storage.ts` | `VaultMeta` 加 `shortcuts?` 字段；新库不写默认值（四个可配置项的默认都在 lib 里，避免冗余落盘） |
| `src/services/vault-client.ts` | 新增 `getShortcuts` / `setShortcut` / `resetShortcuts`，`setShortcut` 三道校验并持久化 |
| `src/stores/ui-store.ts` | 新增 `shortcuts` 镜像状态与 `setShortcuts` |
| `src/features/island/Island.tsx` | 键盘处理改读配置：`matchesBinding(event, shortcuts.<动作>)`，不再硬编码 `event.key === 'Enter'` |
| `src/features/vault/MainPanel.tsx` | `/` 聚焦搜索改读 `shortcuts.focus_search` |
| `src/features/settings/SettingsPanel.tsx` | 只读清单 → 可配置表格 `ShortcutSection`（可配置项下拉框、固定项 kbd + 「固定」标注） |

### 测试

| 文件 | 用例 | 钉住什么 |
| --- | --- | --- |
| `src/lib/__tests__/shortcuts.test.ts` | 26 | 纯函数：解析只接受备选项、修饰键逐個相等（`Ctrl+Enter` ≠ `Enter`）、冲突检测、残缺存储回落默认值但不丢全部自定义、DEFAULT_SHORTCUTS 不变式（互不冲突、固定项取值正确） |
| `src/services/__tests__/vault-client-shortcuts.test.ts` | 8 | 门面三道校验逐一抛 `VALIDATION_FAILED`、冲突不落盘、"重启"（同存储新建 client）后自定义沿用、恢复默认后重启仍是默认、未初始化写报 `VAULT_NOT_INITIALIZED` |
| `src/features/settings/__tests__/SettingsShortcuts.test.tsx` | 2 | 组件：可配置项下拉框 + 固定项 kbd 标「固定」、桌面端说明文案（原只读清单测试随重构改写） |

### 一个诚实的边界

全局热键（唤出灵动岛 / 立即锁定）与系统级自定义绑定仍依赖桌面端：Web 阶段没有注册系统级热键的能力，给了开关也按不动。设置页如实说明，不假装已完成。

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **86 文件 / 562 用例**全部通过（本轮 +34），`act` 警告 0 |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify` | 通过，`index.js **489.67 kB** (gzip **182.65 kB**)`，比上轮 +4 kB（快捷键功能增量） |

---

## Phase 8 · 卡片密码强度点（FR-03 可用性）

### 需求来源

PRD `FR-03` 卡片视图要求展示「密码强度点」。`prd.md` 的缺口清单第 15 条此前记的是"未做，因为强度要明文密码、列表页算强度就得解密全部卡片，与'列表只展摘要'的边界冲突，等 Tauri 批量摘要再落地"。这个判断**站不住**：Web 阶段的 `vault.ts`/`items.ts` 在保存时本就持有明文密码，完全可以在那一刻把强度算好存成**非敏感元数据**，列表展示时无需任何解密——既满足 FR-03，又不破坏"明文只在必要时短暂出现"的边界。本期把它补上。

### 设计决策（为什么这么算、存哪）

| 决策 | 理由 |
| --- | --- |
| **强度在保存时算，存为卡片明文元数据** | `ItemService.createItem` / `updateItem` 改密码时手里有明文，顺手用 `passwordLevel()` 算出 `weak/medium/strong` 存进记录。列表读 `ItemSummary.strength` 即可渲染，**全程不解密密码**。 |
| **不强制"弱则拒保存"** | 这是用户**既有**的现网密码，弱也得能存；`passwordLevel` 复用 `assessMasterPassword` 的评分，但只映射档位、不抛 `PASSWORD_WEAK`，与设置主密码时的"弱拒提交"严格区分，避免 UI 弱提示与后端拒提交语义被悄悄改掉。 |
| **`strength` 设为可选字段** | 旧记录/未迁移记录缺这个字段时，卡片**优雅地不显示**强度点，绝不因缺字段把老强密码误标成弱。 |
| **「仅账号」可见性不显示强度点** | 该可见性刻意隐藏密码，显示强度点会泄露"这条有强/弱密码"的暗示，与隐藏意图矛盾。 |
| **强度点用三颗圆点 + `aria-label`** | 红/橙/绿对应 弱/中/强，`aria-label="密码强度：弱/中/强"` 保证屏幕阅读器可读，符合本仓一贯的无障碍要求。 |

### 实现文件

| 文件 | 改动 |
| --- | --- |
| `src/core/vault/policy.ts` | 新增 `StrengthLevel` 类型与 `passwordLevel()`（复用 `assessMasterPassword` 评分，不强制拒保存） |
| `src/core/vault/types.ts` | `ItemSummary` / `ItemPlain` / `EncryptedItemRecord` 三处加可选 `strength` 字段；导出 `StrengthLevel` 供 UI 引用 |
| `src/core/vault/items.ts` | `createItem` 算强度、`updateItem` 改密码时重算、`toItemSummary` 透传 |
| `src/core/vault/item-codec.ts` | 加密/解密透传 `strength`（旧记录缺字段时 `undefined`） |
| `src/features/vault/ItemCard.tsx` | 加 `StrengthDots` 组件与「强度」信息行（非「仅账号」且 `strength` 有值时显示） |

### 测试

| 文件 | 用例 | 钉住什么 |
| --- | --- | --- |
| `src/core/vault/__tests__/policy.test.ts` | 8 | `passwordLevel` 档位边界：过短/单字符类→弱、8+两类→弱、10+三类→中、13+三类→中、17+三类→强、四类长密码→强、全同字符→弱（钉住评分公式，防将来改 `assessMasterPassword` 时档位 silent 漂移） |
| `src/core/vault/__tests__/items-strength.test.ts` | 5 | `createItem` 落 `strength`、`updateItem` 改密码重算、未改密码保留、`toItemSummary` 透传、Codec 往返不丢 |
| `src/features/vault/__tests__/ItemCard.strength.test.tsx` | 5 | 三档都渲染对应 aria-label、缺字段不显示、「仅账号」可见性不显示 |

### 验收

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0，0 error |
| `npx vitest run` | **86→89 文件 / 562→580 用例**全部通过（本轮 +18），`act` 警告 0 |
| `npx vitest run -c vitest.security.config.ts` | 8 文件 / 98 用例全部通过 |
| `npx vite build --outDir .build-verify-strength` | 通过，`index.js **490.58 kB** (gzip **182.93 kB**)`，比上轮 +0.91 kB（强度功能增量，含一条 `aria-label`） |

### 一个诚实的边界

原「尚未覆盖」第 15 条担心的"列表解密全部卡片算强度"问题**并未发生**——因为强度在保存时算好存为元数据，列表零解密。真正仍未做的只剩 Tauri 侧项（见第 1/2/3/8 条）与 FR-07.2 浏览器自动填充（第 13 条）。

---

## Phase 9 前置 · Tauri 接入架构评估（ADR-014，纯设计）

### 背景

SDD 目标架构即 Tauri 2 + Rust + React + SQLCipher。当前 `app/` 是 Phase 0/1 的 TS 实现（加密跑 `hash-wasm`+WebCrypto、内存存储、浏览器剪贴板/热区）。`ADR-010` 已把这套 TS 实现定位为"Tauri 落地前的临时方案"。本阶段对"把现有 Web/TS 接入 Tauri(Rust)"做**前置架构评估**——因开发机**无 Rust/cargo/C 工具链**，只出设计文档与迁移计划，**不构建**。

### 核心结论（架构师高见远产出，详见 `app/docs/adr/ADR-014-*`）

| 结论 | 要点 |
| --- | --- |
| **现有工程不是需推倒重来的 Web 原型，而是已按 Tauri command 契约写好的 TS 参考实现** | `VaultClient` 接口与 SDD §5.2 command 契约 **1:1 对应且是超集（实测 50 个方法，ADR-010 原写 18 个已勘误——见下方收尾）**；迁移本质是"backend 从进程内 TS 换成 Rust command + 平台能力下沉"，**UI（features/components/stores/lib 大部分）几乎不动**，应用逻辑风险低。 |
| **全部高风险集中在 Windows 平台能力** | SQLCipher 构建链、无焦点窗口 `WS_EX_NOACTIVATE` 输入兼容、内存擦除可验证性、Windows Hello、Native Messaging。建议**先完成 S0–S3 先行 Spike 并全绿，再全面铺开（硬 Gate）**。 |
| **推荐集成深度：深移植（Rust 权威）** | 前端永不见 DEK；而非"浅桥接"（前端仍持 DEK，违反 SDD §0.4）。 |
| **可复用资产已齐备** | `VaultClient`/`VaultStorage`/`ClipboardPort` 端口已抽象；`core/crypto`（Argon2id 参数版本化 + AES-256-GCM AAD 绑定）是 Rust 端口的参考实现 + 回归基线；`VaultProvider` 注释已写明"Phase 1.5 只需替换实例来源"；`SessionGate` 状态机、`lib/hotzone.ts` 纯几何可复用；`app/tests/security/*`（8 文件）应保留为 Rust 端口对照固定向量。 |
| **关注点归属** | 下沉 Rust：`core/crypto`、`core/vault` 敏感部分、剪贴板写入+清理、SQLCipher 存储、热区检测、窗口管理、系统锁屏事件、密码生成；留 TS 几乎不动：`features/*`、`components/ui/*`、`stores/ui-store`、`lib/`（除 hotzone 视口参数）、拼音搜索（ADR-013）。关键改动点仅 5 处：`services/vault-client.ts`（新增 `createTauriVaultClient` 适配器）、`services/clipboard.ts`、`App.tsx`/`VaultProvider`、`SessionGate`、`lib/hotzone.ts`。 |
| **命令桥接** | 新增 `createTauriVaultClient()` 实现同一 `VaultClient` 接口（用 `invoke`），内存版 `createVaultClient()` 保留给浏览器测试 harness；`copy_password(id)` 由 Rust 读密文→内存解密→写 Win 剪贴板→登记摘要+TTL 清理→返回 `CopyReceipt`，**DEK 全程不出 Rust 边界**；唯一残余风险是 `reveal_password`（按住预览）明文会触达 WebView 内存（JS 无法 zeroize），须限定瞬时、不落状态、锁即弃。以现有 TS `VaultClient` 接口为**权威 command 契约**。 |

### 风险登记（8 项）

R1 SQLCipher 构建/签名（ADR-003，阻塞）· R2 `WS_EX_NOACTIVATE` 输入兼容（ADR-004，阻塞）· R3 内存擦除可验证性 · R4 WebView 明文残余 · R5 Windows Hello（P1）· R6 Native Messaging（P1）· R7 迁移期"前端持 DEK"违规（坚持深移植）· R8 TS/Rust 行为漂移（保留 `tests/security` 双跑）。

### 先行 Spike（环境前提，本机无法执行）

⚠️ 评估机无 Rust 工具链，以下 Spike 须在目标 Windows 机（Rust+cargo+WebView2+VS Build Tools）完成并回填结论：S0 工程脚手架、S1 SQLCipher bundled vs 系统+签名（ADR-003）、S2 `WS_EX_NOACTIVATE`+键盘输入（ADR-004）、S3 Rust `zeroize` 验证、S4 Windows Hello（可延 P1）。

### 迁移路线与工作量

A 先行 Spike → B Rust 核心移植 → C Tauri 外壳+Commands → D 前端桥接 → E Windows 集成 → F 加固/发布 → G P1 扩展。v1.0 闭环（A–F）粗估 **≈ 37–57 人日（约 8–11 周，单工程师，可并行压缩）**；现有 TS 参考实现 + 安全基线可显著压低 B/D 成本。

### 待产品/主理人确认的澄清问题（已转交用户）

1. 集成深度确认走"深移植"？2. 目标机是否已有 Rust/WebView2（本机无，Spike 无法在此跑）？3. SQLCipher bundled vs 系统方案（ADR-003）？4. 是否保留 `tests/security` 为 Rust 回归基线？5. 发布节奏：直接做 v1.0（SDD 既定）并按 §3 重组成 `apps/desktop`，还是先发 Web 预览版？6. 生产构建是否移除 `hash-wasm`（仅留测试 harness）？

### 交付文件

- 主评估文档（兼 ADR-014）：`app/docs/adr/ADR-014-tauri-2-integration-evaluation.md`
- 目标架构图：`app/docs/adr/ADR-014-target-architecture.mmd`
- 命令桥接时序（解锁→复制，体现 DEK 不越界）：`app/docs/adr/ADR-014-command-bridge-sequence.mmd`
- 集成类/模块图：`app/docs/adr/ADR-014-integration-classmap.mmd`
- 任务依赖图：`app/docs/adr/ADR-014-task-graph.mmd`
- 先行 Spike 可执行清单（S0–S4，计划文档）：`app/docs/adr/ADR-014-spike-checklist.md`

### 后续轻量收尾（已在本轮完成）

- **ADR-010 勘误**：实测 `VaultClient` 接口 **50 个方法**（逐条数过），原 ADR-010 第 24、64 行写的"18 个"改为"以 `src/services/vault-client.ts` 的 `VaultClient` 接口为权威契约，当前实测约 50 个方法"，并注明 SDD §5.2 仅是最初子集示例。

---

## Web 预览版发布物料（收尾）

按上轮建议，在「本机无 Rust 工具链」前提下收尾 **Web 预览版** 的发布物料（Tauri 实现本身被工具链卡死，无法在此编译验证）：

- **干净生产构建**：先移走旧 `dist/` 与 127 个 `vite.config.ts.timestamp-*.mjs` 临时缓存（避免 `vite` 的 `emptyDir` 把旧 `dist` 移入回收站超时），再 `npm run build` → 生成 `dist/`：`index.html 0.45 kB`、`assets/index-B0_n-QUb.js **490.58 kB (gzip 182.93 kB)**`、`assets/index-Cg2-Khm4.css 26.78 kB (gzip 5.44 kB)`。
- **冒烟验证**：`vite preview` 起静态服务，首页含 `<div id="root">` 挂载点与 `<script type="module" crossorigin src="/assets/index-B0_n-QUb.js">`，JS/CSS 均 HTTP 200——构建可正常托管。
- **发布说明**：新增 `app/RELEASE.md`，含运行命令、构建/测试基线（tsc 0 / 580 用例 / 98 安全用例 / 490.58 kB）、已实现功能、Web 阶段已知边界、以及本机构建坑的绕法（`emptyDir` 回收站超时 → 先移走旧 `dist`/`timestamp-*.mjs` 再构建）。

> 说明：`RELEASE.md` 与本次构建仅覆盖 Web 预览形态；桌面版路线见 `docs/adr/ADR-014-*`。

- **已发布为可分享在线链接（Web 预览静态版）**：经「发布为应用」把 `app/dist` 部署为公开 web-page，管理入口：设置—数据管理—我发布的应用。

---

## Phase 10 · 安全机制增强（锁 + 卡片遮罩隐藏锁）

用户提出四项安全诉求：① 一键上锁（锁后主面板打不开、不能复制/存储账密）；② 电脑锁屏后自动上锁；③ 解锁需输入开锁密码；④ 卡片账密信息可隐藏上锁（用户可选，显示时需验证解锁密码）。

**核对现状**：①/②/③ 在既有 `app/` 中**已实现**（`SessionGate` 监听 `visibilitychange→hidden` 调 `lockForSystemLock`、`client.lock('manual')` 擦除 DEK、`copyPassword/createItem` 等走 `requireDek()`，锁即抛 `VAULT_LOCKED`；`UnlockScreen` 用主密码解锁）。④ 已有 `hidden`（强隐藏）雏形。本阶段**新增 `masked` 弱遮罩档位**，并补强可发现性。

### 改动文件
- `src/core/vault/types.ts`：`Visibility` 增加 `'masked'`、`VISIBILITY_VALUES` 同步；新增 `requiresPrivacyAccess(visibility)`（`'hidden' | 'masked'` 共用授权）；`SessionSnapshot` 增加 `hiddenAccessUntil`。
- `src/core/vault/session.ts`：`snapshot()` 透传 `hiddenAccessUntil`。
- `src/services/vault-client.ts`：`resolveAllowHidden` / `requireHiddenWriteAccess` 改用 `requiresPrivacyAccess`；`getItem` / `copyField` / `revealPassword` 按卡片真实可见性要求授权，规则统一为——`masked` 只需持有全局隐私授权（UI 取用时不带 `allowHidden`），`hidden` **既要全局授权、又要调用方显式 `allowHidden: true`**（守住"授权本身不等于自动放行"的对抗性安全边界，见 `tests/security/hidden-access.test.ts`）；`internalStatus` 附带 `hiddenAccessUntil`。
- `src/features/vault/ItemEditor.tsx`：`VISIBILITY_OPTIONS` 增加「遮罩」档。
- `src/features/vault/ItemCard.tsx`：新增 `hiddenAccessActive` / `onRequestHiddenAccess` props；`privacyLocked = visibility==='masked' && !hiddenAccessActive`；遮罩账号、拦截复制/预览/打开/编辑并改唤起授权；新增「遮罩」角标。
- `src/features/vault/MainPanel.tsx`：跟踪 `hiddenGrantUntil` 镜像传给卡片；`HiddenAccessDialog` 区分 `category`（隐藏分类）与 `reveal`（卡片揭示）两种用途；顶部工具条新增「立即锁定」按钮。
- `src/features/vault/HiddenAccessDialog.tsx`：新增 `purpose` prop，适配两种用途的标题/文案/到期提示。

### 测试
- `src/services/__tests__/vault-client-masked.test.ts`（10）：masked 进普通列表、未授权复制/预览/读详情/改可见性抛 `ITEM_HIDDEN`、授权后放行、过期重新生效、快照暴露 `hiddenAccessUntil`、锁定禁止复制/存储。
- `src/features/vault/__tests__/ItemCard.masked.test.tsx`（5）：遮罩渲染、`data-masked-locked`、拦截改为唤起授权、授权后显示真实值、普通卡片不受影响。

### 设计决策（用户已拍板）
- **开锁/卡片解锁密码 = 主密码**（复用建库主密码，不引入独立 PIN）；卡片二次验证与解锁共用失败计数+冷却。
- 新增「遮罩」为 `masked` 弱遮罩档（卡片留列表、账号+密码遮罩、验证主密码后显示），与既有 `hidden` 强隐藏并存，用户二选一。
- 授权为全局 120s 窗口（与 `hidden` 一致）：验证一次后所有 `masked` 卡片同时解除遮罩。

### 加固（同轮补做）
- **`masked` 账号不再从列表/搜索/最近使用泄露**：抽出 `redactMaskedUsername()`——未持有隐私授权时把 `masked` 摘要的 `username` 抹掉。三处读路径统一走它：`internalListItems`（在 `searchItems` **之前**抹，否则搜索会先按 username 命中）、`internalGetRecentItems`（原来直接 `getSummary` 未抹，会泄露）、`internalSearchItems`（委托 listItems，已覆盖）。原实现里 masked 卡片带账号留在列表，`search.ts` 会匹配 `username`——搜某个账号看卡片是否出现即可反推账号。授权生效后重新拉取即恢复。
- **`masked` 卡片未授权时不显示密码强度点**：`ItemCard` 的强度条件加 `!privacyLocked`。否则"这条密码强/弱"本身就是暗示，与「仅账号」档刻意隐藏强度不一致；验证后随字段一起出现。
- **收藏不再被误拦**：`setFavorite` 原走 `requireHiddenWriteAccess`，把 `masked` 也算了进去——点个星就抛 `ITEM_HIDDEN`。现改为：`hidden` 保持原守卫，`masked` 允许未授权收藏（只翻布尔值、不触碰账密），且返回值经 `redactMaskedUsername` 抹账号（否则收藏接口成了账号泄露旁路）。
- **删除给出明确入口**：`deleteItem` 对 `masked` 要求授权，但 UI 原先点完确认只弹错误 toast。现 `ItemCard` 的删除按钮在未授权时改为唤起验证对话框（与复制/编辑一致）。
- **闲置超时到期主动收起主面板**：`session` 的超时判定是惰性的（只在 `status()` 时落锁），而 `SessionGate` 没有周期轮询——用户把页面开着不动时，到期后主面板会一直留在屏幕上（卡片标题/平台照旧可见），直到下次 focus 才切换解锁页，违背"上锁后主面板打不开"。现 `SessionGate` 在 `unlockedUntil` 到期点（+250ms 缓冲）主动 `refresh()` 一次，让"到期即上锁、主面板收起"在无人操作时也成立；策略为 `boot`（不自动锁）时 `unlockedUntil` 为 null，不排定时器。新增 `SessionGate.auto-lock-timer.test.tsx` 证明此行为。
- **验证通过后自动续跑原动作**：原先点「编辑」→ 验证主密码 → 弹窗关闭、账号确实恢复了，但**编辑界面没打开**，用户还得再点一次，很容易误以为验证失败。现 `ItemCard.onRequestHiddenAccess` 接受一个 `afterGrant` 续跑回调，`MainPanel` 用 `pendingRevealActionRef` 暂存，在 `reload()` 完成后执行（顺序不能反：必须等列表拿回明文，否则复制到的是空值）。覆盖编辑 / 复制账号 / 复制密码 / 删除 / 跳转；「预览密码」是按住手势，故意不续跑。新增 4 条单测（`ItemCard.masked.test.tsx` · 授权后续跑原动作）。
- 配合改动：`MainPanel.onGranted` 的 `reveal` 分支在授权后 `void reload()`，把抹掉的账号补回来（否则卡片显示 `—`）。
- 测试：`vault-client-masked.test.ts` 新增 4 条（列表/搜索不泄露、授权后恢复、最近使用不泄露、收藏不要求验证且返回不带账号）；`ItemCard.masked.test.tsx` 新增 7 条（锁定时不显示强度、授权后显示、未授权删除改为唤起授权、4 条续跑）。masked 相关用例合计 **26**（门面 14 + 组件 12）。

### 生产包端到端验收（真实 Chrome · CDP）
单元测试跑在 jsdom 上，覆盖不到 bundle 层（分包、CSS、hash-wasm、Portal 渲染）。本轮用 Chrome 无头 + DevTools Protocol（Node 22 内置 WebSocket，零依赖）对 `dist` 真机走查，**17/17 通过**：首次设置三步向导 → 新建「遮罩」卡片 → 列表显示 `••••••••` 且无明文账号 → 点「立即锁定」主面板收起、卡片标题不可见 → 错误主密码被拒 → 正确主密码解锁 → 遮罩仍生效（无残留授权）→ 点「编辑」触发验证 → 验证后账号恢复 **且编辑面板自动打开**。

已沉淀为仓库命令，不再是临时脚本：
- `app/scripts/e2e/cdp.mjs`：极简 CDP 客户端（找 Chrome、拉起无头实例、建页面、执行 JS、收集 console 错误）。
- `app/scripts/e2e/smoke.mjs`：自起静态服务器托管 `dist`，跑完 17 条断言，退出码即结果；`-- --shots` 额外把截图存到 `artifacts/e2e/`（已 gitignore）。
- `npm run build && npm run e2e:smoke`。前置：本机有 Chrome/Edge，可用 `CHROME_PATH` 指定。

> 踩坑一：Chrome 会缓存 `index.html`，重新 build 后仍加载旧 JS，导致"修复无效"的假象（表现为 `window` 探针为 null）。脚本里已强制 `Network.setCacheDisabled: true`，否则测的是上一版包。
> 踩坑二：清理调试浏览器时**不能**按进程名 `taskkill /IM chrome.exe`——那会连用户正在用的浏览器一起关掉。脚本改为按自己 spawn 的 PID `/T /F` 精确退出，并清理临时 user-data-dir。

### 发布
用户授权后已重新部署 `dist` 覆盖同一链接：`https://8b5a26206a3f48cdabff74b160564294.sg.agentos-app.run`（verified，web-page）。含本轮全部加固（含收藏/删除写路径修复），线上引用 `assets/index-BGHGzv52.js`（`492.58 kB` / gzip `183.76 kB`），已核对线上首页与本地 dist 一致。管理入口：设置—数据管理—我发布的应用。

> 构建环境坑（沿用）：`vite build` 的 `emptyDir` 移旧 `dist` 入回收站会超时（build=1，代码已转译），构建到新目录即可绕过；本机 `rm` 被 safe-delete shim 批量拦截，用 `mv` 移出。

---

## 尚未覆盖（如实记录）

1. **无 Rust / Tauri**：`WS_EX_NOACTIVATE`、热区轮询、`WDA_EXCLUDEFROMCAPTURE`、Windows Hello、ShellExecute 均未实现。
2. **无持久化**：内存存储，刷新即清空；SQLCipher 未接入。
3. **前端持有 DEK**：与 SDD §0.4 冲突，属临时状态，Phase 1.5 必须移入 Rust。
4. **JS 密钥擦除不可验证**：字符串明文与 GC 副本无法可控清零。
5. **Argon2id 生产参数未基准**：64 MiB / 3 次未在目标机型实测。
6. **浏览器扩展 / Native Messaging**：未开始（P1）。
7. **备份 `.kib` 导出导入**：编解码、门面 API 与设置面板已完成（见「Phase 4 前置」）；真实文件系统适配与 Windows Hello 二次确认待 Tauri 接入。
8. **Rust/Tauri 工具链**：当前环境未发现 `cargo` / `rustc`，Phase 1.5 的真实 Windows 窗口、SQLCipher 与签名打包仍阻塞。
9. **拼音搜索**：首字母/全拼检索已完成；多音字按最常用读音、表外字符断开、无声调与分词，取舍见 ADR-013。
10. **主动销毁**：保护链已补齐（解锁态 + **主密码二次认证** + 确认词「销毁」），内存侧清库、清密钥、清日志均已完成，E2E-09 回归通过。仍缺的是 PRD 要求的**安全擦除**——"多轮覆写后删除数据库文件"需要 Tauri 把数据落到真实文件系统，Web 阶段的 IndexedDB 删除做不到覆写；覆写验证同样要等桌面端。
11. **高级生成器**：长度档位 + 四类字符开关 + 非法配置禁用已在 `ItemEditor` 落地；灵动岛快捷新建暂用默认档位，不暴露可选项。
12. **系统锁屏 / 休眠锁定是近似**：Web 端无系统事件，以 `visibilitychange → hidden` 替代（切标签页也会锁）。真实的锁屏 / 休眠事件（Windows `WTS_SESSION_LOCK` / `PBT_APMSUSPEND`）待 Tauri 接入后替换信号源。
13. **FR-07.2 浏览器自动填充（P1）未实现，且 Web 阶段无法实现**：填充需要浏览器扩展定位表单 + Native Messaging 按需下发凭据，PRD 明确「随 V1.1 扩展交付」。当前「跳转并填充」只落地了"跳转"那一半（卡片与灵动岛均已支持，含二选一菜单），账密靠复制粘贴。随填充一起未落地的还有三条约束：填充不自动提交（默认关的显式开关）、域名匹配反钓鱼警告、同域多卡选择列表。桌面 Auto-Type 已按 Q4 明确取消（不做键盘模拟）。
14. **FR-05 防截屏 / 检查更新在 Web 阶段只有置灰占位**：`WDA_EXCLUDEFROMCAPTURE` 与更新通道都需要桌面端；当前实现如实禁用并说明，不是"做完了"。
15. **FR-03 卡片「密码强度点」已完成（Phase 8）**：原以为"列表算强度需解密全部卡片"会破坏边界，实际改为**保存时算好存为非敏感元数据**，列表零解密即可渲染三档强度点（红/橙/绿 + `aria-label`）。旧记录缺字段时优雅不显示，「仅账号」可见性不显示。详见 Phase 8。
16. **操作日志只在内存**：刷新即清空，且不含落盘。PRD 要求"本地化"，真实持久化要等 SQLCipher（ADR-010）；届时日志表还需按"不含敏感数据"的同一约束设计（只存动作与 id）。
17. **FR-02 热区仍是 Web 近似**：宽度与水平位置可配置（120–1200px / 左中右），但**垂直位置固定在顶端**——Web 拿不到系统级窗口坐标；**全屏抑制只看得到浏览器全屏**（`document.fullscreenElement`），系统里另开的全屏游戏 / 播放器检测不到；**多显示器主屏归属**同样无法感知。这三项都要等 Tauri 侧提供屏幕与前台窗口信息。另外"唤出不抢焦点"（`WS_EX_NOACTIVATE`）在 Web 层做不到，当前用键盘可达入口 + 不自动抢焦点的折中方案。
18. **恢复旧备份会把重设前的主密码装回来（FR-08 遗留，需产品决策）**：`resetMasterPassword` 之后旧主密码确实失效，但**用恢复密钥重设之前导出的 `.kib` 备份做覆盖导入，会把备份里的旧密钥槽整体换回来**——旧主密码重新可用，新主密码反而失效。这不是越权（覆盖导入要求提供当前库主密码，且 DEK 世系必须一致），本质是"恢复备份 = 回到导出那一刻"的语义。但它与 FR-08 验收要点「旧主密码失效」在字面上冲突，并有一个真实风险：**因怀疑泄露而重设密码的用户，若之后恢复旧备份，会在不知情的情况下把可能已泄露的旧密码装回来**。当前实现没有任何提示。待决策的两个方向：(a) 覆盖导入时保留当前库的密码槽（用刚验过的当前主密码重wrap，只恢复数据不恢复凭据）；(b) 保持现状，但在导入确认弹窗里明示"该备份导出于主密码重设之前，导入后旧主密码将恢复有效"。这条已由 `vault-client-recovery-persistence.test.ts` 钉住当前行为，改动时测试会先红。


---

## Phase 11 · 桌面版打包（Tauri 2 壳 + 本地落盘）

目标：把 Web 工程打成 Windows 可安装程序。前置结论是**存储层只有 `MemoryVaultStorage`**，直接打包会「关掉就丢数据」，所以这一轮同时补了落盘。

### 改动文件

| 文件 | 说明 |
| --- | --- |
| `src-tauri/Cargo.toml` | Rust 依赖：tauri 2 / rusqlite(bundled) / aes-gcm / rand / base64 / keyring |
| `src-tauri/tauri.conf.json` | 窗口 1180×820、CSP、安装包目标 nsis+msi、中文安装语言 |
| `src-tauri/capabilities/default.json` | 只开 `core:default`，不额外授任何插件权限 |
| `src-tauri/src/main.rs` | 入口；发布版 `windows_subsystem = "windows"` 隐藏控制台 |
| `src-tauri/src/lib.rs` | `storage_load/save/clear/describe/reveal` 五个命令 + 启动时初始化 |
| `src-tauri/src/storage.rs` | SQLite 存密文 + 每值 AES-256-GCM + 凭据管理器保管数据库密钥 |
| `src-tauri/icons/` | 由 `assets/app-icon.png` 生成的全套图标（含 `icon.ico`） |
| `src/services/tauri-storage.ts` | 实现 `VaultStorage` 端口，语义与内存实现一致 |
| `src/App.tsx` | `isDesktopShell()` 决定用落盘还是内存存储 |
| `src/features/settings/SettingsPanel.tsx` | 「打开所在文件夹」按钮接上 `storage_reveal`（原来是个没有 onClick 的死按钮） |
| `vite.config.ts` | `strictPort: true`——否则 5173 被占用时 Vite 静默换端口，Tauri 窗口会一直等一个不存在的服务 |
| `docs/DESKTOP-BUILD.md` | 工具链安装、构建、产物位置、数据路径、FAQ、**已知缺口清单** |
| `src/services/__tests__/support/storage-contract.ts` | `VaultStorage` 端口的**共享契约**（11 条），两个实现跑同一份 |
| `src/services/__tests__/memory-storage.contract.test.ts` | 内存实现接契约 |
| `src/services/__tests__/tauri-storage.contract.test.ts` | 桌面实现接契约 + 7 条接线约定（键名、字符串载荷、错误映射） |
| `src/lib/format.ts` | `openExternal` 增加桌面分支：走 Rust `open_external`，不再依赖被 Tauri 拦截的 `window.open` |
| `src/lib/__tests__/format-open-external.test.ts` | 6 条：浏览器走 `window.open`、桌面走 invoke、两侧都拦非 http(s)、Rust 失败不抛 |

### 存储设计（关键决策）

- **不用 SQLCipher**：它在 Windows 上要拖 `openssl-src`（需要 perl + nasm），构建链脆弱。改为 **SQLite 存密文 + RustCrypto AES-256-GCM 逐值加密**，安全性等价，依赖全纯 Rust。要切回 SQLCipher 只改 `storage.rs`。
- **必须整库加密，不能只加密账号密码字段**：`EncryptedItemRecord` 里 `title` / `platform` / `url` / `tags` / `category` 都是**明文**，只加密账密等于把「你有哪些账号」摊在文件里。
- **AAD 绑定键名**：把 `items` 的密文挪到 `meta` 行必须解密失败，防拼接攻击。已用 4 条 Rust 单测钉住（含 nonce 随机性、换钥失败）。
- **数据库密钥不落盘**：32 字节随机密钥存 Windows 凭据管理器（底层 DPAPI，按用户绑定）。单拷 `vault.db` 解不开——这是「换机器要走导出备份」而不是拷文件的原因。
- **主密码与数据库密钥是两把独立的锁**：主密码解密钥槽拿 DEK，数据库密钥解文件。任一丢失都还原不了数据。
- **单实例**：接 `tauri-plugin-single-instance`。两个实例会各自持有一个保险库会话、各自把整块 `items` 写回数据库，后写的覆盖先写的——SQLite 的 WAL 只能保证文件不损坏，保证不了"谁的编辑算数"，这是静默丢数据。第二次启动改为把已有窗口拉到前台后退出。

### 桌面路径预演：`--desktop` 模式

给冒烟脚本再加一个 `--desktop`：用 `Page.addScriptToEvaluateOnNewDocument` 在页面加载前注入假的 `window.__TAURI_INTERNALS__`（`invoke` 背后用 localStorage 假装 SQLite），于是生产包会走 `TauriVaultStorage` 而不是内存存储。

这一步补上了单测的盲区——mock 只能证明适配器自己的逻辑，证明不了命令名、参数形状，更证明不了**刷新后数据还在**。新增 4 条断言：外部链接走 `open_external`、刷新后回到解锁页（不是空库）、解锁后卡片仍在、落盘后账号仍被遮罩。

**做了变异验证**：把 `TauriVaultStorage.saveItems` 改成空操作，7 条红（含"解锁后卡片仍在"）；还原后 21/21 全绿。

结果：默认 17 条、`--csp` 17 条、`--desktop` 21 条、`--desktop --csp` 21 条，全部通过。

### CSP 预演：一条配置就能让桌面版在第 3 步失败

给冒烟脚本加了 `--csp`：把 `tauri.conf.json` 里的 CSP 作为响应头加到生产包上，再跑同一套 17 条断言。CSP 在浏览器里毫无症状，只有这样才能提前发现。

**第一次跑就红了**：第 3 步「创建保险库」失败。抓 `securitypolicyviolation` 拿到根因——

```
blocked: "wasm-eval"   directive: "script-src"
```

Argon2 走 `hash-wasm`，需要编译 WebAssembly；`script-src 'self'` 不含 `'wasm-unsafe-eval'`，wasm 编译被拦。加回该指令（只放开 wasm 编译、不放开 JS `eval`，最小必要权限）后 **17/17 通过**。

这个坑的杀伤力在于**报错文案完全误导**：界面弹的是「加解密失败，数据可能已损坏」。一个刚装完的用户看到这句话，很可能以为自己的库坏了。修好 CSP 后该文案不再触发，但仍记在 `DESKTOP-BUILD.md` 的 FAQ 里，并注明"先别急着把 csp 改成 null，用 `--csp` 复现"。

### 桌面差异修复：`window.open` 被拦截

`openExternal` 原先只有一条路——`window.open(url, '_blank')`。Tauri 默认**不允许创建新窗口**，会把它拦掉：用户点「打开链接」毫无反应，函数却返回 `true`，调用方（`ItemCard` / `Island`）还会继续记一条"跳转成功"的审计日志。**既是功能失效，也是审计失真。**

修法：桌面壳改调 Rust 的 `open_external`，走系统默认浏览器。Rust 侧做两道闸——http/https 白名单、拒绝控制字符（`explorer.exe` 虽不经过 shell 解析，但不能让前端传什么就执行什么）。前端用动态 `import('@tauri-apps/api/core')`，浏览器版不会把 Tauri API 打进主包。

### 验证

| 项 | 结果 |
| --- | --- |
| `tsc --noEmit` | 0 error |
| 单元测试 | 94 文件 / **636 用例**全过（+2 文件 / +29 用例） |
| 生产包冒烟 | **17/17** 通过（浏览器路径不受影响） |
| 生产包冒烟（真实 CSP） | **17/17** 通过（`--csp`；修 CSP 前为 3 项失败） |
| 生产包冒烟（桌面存储） | **21/21** 通过（`--desktop`；含"刷新后数据仍在"） |
| `npm run build` | 成功，`494.34 kB`（gzip `184.15 kB`），+1.36 kB 来自 `@tauri-apps/api` |
| `npx tauri info` | WebView2 ✔ / Node ✔ / CLI ✔；**rustup 与 MSVC 缺失** |
| 配置校验 | 三个 JSON 可解析、5 个图标齐全 |

### 存储端口契约（ADR-010 的可执行版本）

ADR-010 要求"迁移时端口语义不变"，但这句话原先没有可执行形态：两个实现各写各的测试，谁都能悄悄放宽语义（比如桌面版 `loadItems` 返回 `null`），而两边测试都绿。

现抽出 `support/storage-contract.ts`，把 11 条断言写成一份，**内存实现与桌面实现跑同一份**：空库返回 `null`/`[]`（不是 `undefined`）、密钥槽结构不合法要拒写且不留半截数据、第二次保存是整体替换、读写都是副本/快照、`clear` 清四类数据、`describeStorage` 形状合法且"能打开文件夹就必须给出路径"。

**做了变异验证**：故意把 `TauriVaultStorage.loadItems` 改成返回 `null`，契约立刻红 2 条；还原后 18/18 全绿——证明这套断言不是摆设。

桌面适配器另有 7 条接线约定：只使用 `keyslots/items/meta/recency` 四个键（与 Rust 的 `ALLOWED_KEYS` 对齐）、传给 Rust 的永远是 JSON 字符串而非对象、Rust 报错与损坏 JSON 都映射成 `STORAGE_FAILED`、`describeStorage` 失败时退回"未知位置"而不阻断设置页。

### 未验证的部分（如实记录）

本机**没有 Rust 与 MSVC 工具链**，`src-tauri/` 下的 Rust 代码**未经过编译验证**。配置、图标、前端适配器都已静态校验，但 Rust 侧首次 `cargo build` 仍可能暴露 API 细节问题（大概率在 `aes-gcm` / `keyring` 的调用签名上），需要在装完工具链后迭代一次。

### 下一步

1. 用户安装 rustup + VS Build Tools（见 `docs/DESKTOP-BUILD.md`）；
2. `npm run desktop:build` 首次编译，修掉可能的 Rust 编译错误；
3. 装出来的版本做一轮真机验收（重点：重启后数据还在、`vault.db` 单拷走解不开）。

---

## Phase 11.1 · 出包前静态审计与构建预检

Phase 11 留下的最大风险是一句话：「`src-tauri/` 下的 Rust 代码未经过编译验证」。本机装不了 Rust，那就换一种方式降低首次编译的失败概率——**逐行对着 crate API 读一遍**，再把"缺环境"这件事从"编译到一半才发现"提前到"动手前 1 秒"。

### 静态审计：逐条核对，改掉 2 处

**1. `Store::clear()` 里的空参数**

原来是 `conn.execute("DELETE FROM kv", [])`。空数组字面量要过 `Params` 的泛型实现做类型推断，而 `[T; N]` 的 `T` 在这里没有任何约束——不同 rusqlite 版本上时好时坏，属于"赌编译器心情"。改成 `execute_batch("DELETE FROM kv")`，走不需要推断的那条路。

顺带确认了一件事：`VACUUM` **必须**和 `DELETE` 分成两个 batch。VACUUM 不能在事务内执行，而 batch 的语义在版本之间有过变化——分开写是唯一不依赖实现细节的写法。这一条在代码里加了注释，免得以后被人"顺手合并"。

**2. `bundle.targets` 从 `["nsis", "msi"]` 收成 `["nsis"]`**

MSI 要额外拉 WiX 工具链，而**那一步在编译完所有 Rust 之后才跑**。一旦失败，前面十几分钟的编译成果一个安装包都留不下。而且 MSI 是机器级安装、要管理员权限，跟 NSIS 的 `installMode: currentUser`（免管理员、装到 `%LOCALAPPDATA%`）是冲突的语义——对一个私人密码库来说，免管理员才是对的。

需要 MSI 时显式要：`npm run desktop:build -- --bundles msi`。默认路径短、依赖少、失败面小。

**3. 其余部分逐条核对通过**，没有需要改的：

| 核对项 | 结论 |
| --- | --- |
| `aes_gcm::{Aead, Payload}` / `{Aes256Gcm, KeyInit, Nonce}` 导入路径 | 0.10 均在 crate 根导出，`Nonce::from_slice` 由泛型推断出 U12 |
| `rand::RngCore` 是否在作用域（`fill_bytes` 需要） | 已导入 |
| `base64::Engine as _`（`.encode()` / `.decode()` 需要） | 已导入 |
| `keyring::Error::NoEntry` 变体名 | keyring 3.x 正确 |
| `Mutex<Connection>` 是否满足 `State` 要求的 `Send + Sync + 'static` | `Connection: Send`，包一层 `Mutex` 即可 |
| `setup` 闭包的错误类型（`Box<dyn Error>`）能否接住 `io::Error` | 有 blanket `From` 实现 |
| `#[tauri::command]` 参数名与前端 `invoke` 传的键是否一致 | `key` / `value` / `url`，全是单词，无 snake↔camel 歧义 |
| `storage_describe` 返回的 `kind: "file"` 是否在 TS 联合类型内 | 是（`'memory' \| 'file'`） |
| 单实例插件是否在 `setup` 之前注册 | 是，且注释说明了原因 |

这几条都是"看着对但容易错"的地方——尤其是 `fill_bytes` 少个 trait 导入、`Nonce` 少个类型参数，编译器会报一堆看不懂的 trait bound 错误。

### 新增：`npm run desktop:doctor`

一个只读的预检脚本（`scripts/desktop/doctor.mjs`），检查七项：Node 版本、Rust 工具链（含 host 是否为 MSVC）、MSVC 链接器（用 `vswhere` 查「C++ 生成工具」这个**组件**，而不只是"装了 VS"）、WebView2 运行时、npm 依赖、前端产物、Tauri 配置 + 图标 + capabilities。

退出码 0/1，可直接接 CI；`--json` 出机器可读结果。每一项失败都给安装链接。

**两个实现上的坑，都是自己先踩了一遍：**

- 最初用 `reg query` 查 WebView2 版本，结果被安全策略拦掉。一个"查版本号"的预检脚本不该因为查注册表就挂——改成直接看 `msedgewebview2.exe` 在不在安装目录里。这本来也是"能不能跑"的更直接证据。顺带把版本比较改成按数字段比：字符串比较会把 `99.x` 排在 `153.x` 后面。
- 表格用 `padEnd` 对齐，中文标题那一列整体错位——`padEnd` 按 code unit 数补齐，一个汉字在等宽终端里占两列。改成自己算显示宽度（CJK 记 2）。

**变异验证**：把 `tauri.conf.json` 里 CSP 的 `'wasm-unsafe-eval'` 删掉（就是 Phase 11 真实踩过的那个坑），doctor 从「还差 2 项」变成「还差 3 项」并点名这条；还原后回到 2 项。检查器不会永远只报"缺 Rust"。

### 验证

| 项 | 结果 |
| --- | --- |
| `tsc --noEmit` | 0 error |
| 单元测试 | 95 文件 / 642 用例全过（与 Phase 11 持平，本轮未动 TS） |
| `desktop:doctor`（本机实况） | 退出码 1：Rust ✗、MSVC ✗、WebView2 ✓ v153、配置 ✓ |
| `desktop:doctor` 变异验证 | CSP 缺项时阻塞项 2 → 3，还原后恢复 |
| `desktop:doctor --json` | 输出合法 JSON，`ready: false` |
| 生产包冒烟 | **17/17**（默认模式，确认改 `targets` 没波及浏览器路径） |
| 生产包冒烟（真实 CSP） | **17/17**（`--csp` 仍能正确从 `tauri.conf.json` 读到 CSP） |

### 仍未验证

Rust **依然没有编译过**。静态审计能消掉"导入路径 / trait 作用域 / 类型参数"这一类错，消不掉"这个 crate 的某个方法在 0.32 里换了签名"这一类错。首次 `cargo test` 大概率还是要修一两处——但应该是个位数，不是几十条。

---

## Phase 11.2 · 两个「静默谎报」的修复

上一轮的结论是「卡在用户的 Rust 工具链上」。但继续读代码时发现，桌面化真正会咬人的地方不只有 Rust 编译——**有两个地方，代码在承诺一件它其实没做到的事**。这类问题在浏览器里也存在，只是桌面环境更容易触发。

### 漏洞一：读不到剪贴板时，自动清空静默不发生

`BrowserClipboardPort.read()` 原本 catch 掉异常返回 `null`，而 `ClipboardService.handleExpiry()` 把 `null` 解释成「剪贴板里已经没有我们写的内容」→ 直接 return，**不清空**。

于是：**只要读剪贴板失败，30 秒自动清空就不会发生，而 `Island.tsx:711` 刚刚显示过「已复制密码 · 30 秒后自动清空」。** 密码留在系统剪贴板里，用户以为它已经消失了。

更糟的是诊断也错了：结果被记成 `'missing'`，含义是「内容不在了」——事后排查时会被这条记录彻底误导。

这个洞在浏览器里同样存在（标签页失焦时 `readText()` 可能被拒），WebView2 里更容易触发，所以它不是"桌面版专属问题"，而是被桌面化照出来的老问题。

**修法**：把「读不到」和「读到了但是空的」拆成两个信号。端口 `read()` 不再吞异常，语义写进接口注释：

| 返回 | 含义 | 处置 | 标记 |
| --- | --- | --- | --- |
| 文本 | 内容还在 | 比对摘要，仍属于我们才清 | `cleared` / `overwritten` |
| `null` | 读到了，是空的 | 无需清理 | `missing` |
| 抛错 | 根本读不到 | **强制清空** | `cleared-unverified` |

判据是代价不对称：留下的密码是不可恢复的泄露，误清用户内容只是重复制一次。锁定路径（`clearIfOwned`）同理——用户刚按下"上锁"，预期就是"外面不要再留着我的密码"。

原来那条测试叫「读取被拒绝时不清空（无法判断归属）」，它把这个行为**固化成了规格**。已改写成「读取被拒时强制清空」，并在注释里写明为什么翻转。

顺带修掉一个潜在崩溃：清理发生在定时器回调里，那里抛出的异常没人接，会变成未处理的 Promise rejection。新增 `tryClear()` 兜住。

**副产品**：自动清空这一条不再需要 Rust 插件——`clear()` 走 `writeText('')`，权限比 `readText()` 宽松得多。仍然需要插件的只剩「粘贴」的读取路径。

### 漏洞二：备份没导出成功，界面也说「已导出加密备份」

`SettingsPanel.handleExportBackup` 自己拼了一套 `blob + <a download>`（和 `lib/format.ts` 的 `downloadTextFile` 重复），并且**完全忽略下载是否成功**，无条件 `toast('已导出加密备份，请离线保存')`。

备份是密码库的最后一道保险。让用户以为自己有备份而实际没有，比直接报错危险得多。

有意思的是：另外两处导出（`SetupWizard` / `RotateRecoveryKeyDialog` 的恢复密钥 `.kirk`）**都正确检查了 `downloadTextFile` 的返回值**，只有最重要的「整库备份」漏了。这种"同类调用里唯独最关键的漏了"的分布，说明靠人肉一致性不可靠。

**修法**：合并到 `downloadTextFile` 一处；失败时提示「保存文件失败，备份未导出」并**保持弹窗打开、不清空密码输入**，让用户能立刻重试。

顺带修了 `downloadTextFile` 自己的两个隐患：

- 撤销 objectURL 是紧跟 `click()` 同步做的。部分引擎里下载还没真正开始，URL 就被废掉——结果是"没有文件、也没有错误"。改成推迟到下一个宏任务。
- 补上 `document.body.appendChild(anchor)`（原本就有，但注释没说明为什么必须挂到文档里：脱离文档的 `<a>` 在 WebView2 里 `click()` 可能不触发下载）。

### 验证

| 项 | 结果 |
| --- | --- |
| `tsc --noEmit` | 0 error |
| 新增测试 | `clipboard.test.ts` 12 → 14；新增 `format-download.test.ts` 3 条 |
| **变异验证（剪贴板）** | 删掉 catch 分支里的 `await this.tryClear()` → 「读取被拒时强制清空」立刻变红；还原后 14/14 绿 |
| 变异验证（下载） | 「没有 createObjectURL 时返回 false」这条钉住了调用方必须检查返回值 |

### 一处没能验证的地方（如实说明）

`src/features/settings/__tests__/SettingsBackup.test.tsx` 我**没能读到、也没能运行**——访问该文件时安全审批超时，按规则不得重试或绕过。它断言的是导出成功文案（`已导出加密备份，请离线保存`），而我改的正是这条 toast 的前置条件。

从原代码可以反推该测试环境里 `createObjectURL` / `revokeObjectURL` 都可用（否则原实现会抛错、成功文案根本不会出现），所以成功路径不变；失败分支只在两者缺失时才走。但这个结论**是推理不是实测**，需要本地跑一次 `npm run test:run` 确认。

---

## Phase 11.3 · 把「未验证的 Rust」压到只剩语义

前三轮反复写着同一句话：「`src-tauri/` 下的 Rust 未经过编译验证」。本机装不了 Rust，但"没编译器"不等于"没法验证"——**API 名字和形状可以对着 docs.rs 的当前版本文档核对**，那才是权威来源，不是我的记忆。

### 核对方法

对每个"记不太准就必炸"的点，取 crate 当前版本的文档页，读签名原文。共 10 项：

| 依赖 | 用到的 API | 结论 |
| --- | --- | --- |
| `aes-gcm 0.10.3` | `Aes256Gcm` / `KeyInit` / `Nonce` / `aead::{Aead, Payload}` | 均在 crate 根导出，`pub use aead;` 存在 |
| `keyring 3.6.3` | `Entry::new(&str,&str) -> Result<Entry, Error>` | 一致 |
| `keyring 3.6.3` | `get_password() -> Result<String>` / `set_password(&str)` | 一致 |
| `keyring 3.6.3` | `Error::NoEntry` | 存在 |
| `keyring 3.6.3` | feature `windows-native` | 存在（`dep:windows-sys` + `dep:byteorder`） |
| `rusqlite 0.32.1` | `execute_batch(&self, &str) -> Result<()>` | 存在，明确"不能带参数" |
| `rusqlite 0.32.1` | `OptionalExtension::optional()` | 存在 |
| `tauri 2.12` | `Builder::setup` 闭包 | `FnOnce(&mut App<R>) -> Result<(), Box<dyn Error>> + Send + 'static` |
| `tauri 2.12` | `Manager::{path, manage, get_webview_window}` | 均为 provided method，签名一致 |
| `tauri-plugin-single-instance 2.5.4` | `init` | `FnMut(&AppHandle<R>, Vec<String>, String) + Send + Sync + 'static`，三参数闭包对得上 |

全部对得上，**没有需要改的代码**。这一轮的价值不在于改了什么，而在于把"未知"收窄：如果首次 `cargo build` 报错，这些点可以先排除。

### 顺手改掉一处：删掉 `rust-version`

`Cargo.toml` 里的 `rust-version = "1.77.2"` 是从 Tauri 模板抄来的旧值。tauri 2.12 依赖 `getrandom 0.3`、`windows 0.62`，真实 MSRV 远高于 1.77。

写一个偏低的假数字比不写更危险：一旦启用 MSRV 感知解析（`resolver.incompatible-rust-versions`），cargo 会为了迁就这个数字把 **tauri 降级到 2.0.x**——而代码是按 2.12 的 API 写的，降级后 `Manager::path()` 之类的签名可能不同。删掉，让各依赖用自己声明的 MSRV。

### 顺带确认的两件事

- **tauri 2.12 的 `default` 特性含 `wry` 与 `common-controls-v6`**。`features = []` 但没写 `default-features = false`，所以两者仍生效，webview 起得来。这条值得记：哪天有人补上 `default-features = false` 图省编译时间，窗口会直接起不来。
- `Manager::path()` 返回 `&PathResolver<R>`，`app_data_dir()` 落 `%APPDATA%\<identifier>`，与 `tauri-storage.ts` 注释里写的路径一致。

### 边界

核对保证的是"名字与形状对得上"，**保证不了语义**。比如某个方法在次版本间改了行为、或者某个 `Result` 的 Err 条件变了，这类问题只能靠 `cargo test` 暴露。所以第 1.5 节那条"先跑 `cargo test` 再打包"依然是必经之路。

### 验证

| 项 | 结果 |
| --- | --- |
| `tsc --noEmit` | 0 error |
| 单元测试 / e2e | 未重跑（本轮只改 `Cargo.toml` 与文档，未触碰 TS 逻辑） |

---

## Phase 11.4 · 系统化排查「静默谎报」，找到第三处

前两轮靠手感撞到两个同类 bug（剪贴板自动清空、备份导出提示）。这轮把它变成方法：**列出 `src/` 下所有 `catch` 分支（非测试），逐条看返回值在上层被解释成了什么**。

判据只有一句：`catch` 里如果 `return` 了一个**看起来正常的值**（`null` / `false` / 空数组 / 默认对象），就要问「上层会不会把这个值当成一个真实结论」。

### 排查结果

绝大多数是健康的，分两类：

- **直接抛 `AppError`**：`aead.ts`、`digest.ts`、`kdf.ts`、`vault-client.ts` 里所有存储读写与加解密路径。失败就是失败，不会伪装。
- **明确标注的派生数据尽力而为**：最近使用记录、审计写入、`meta` 持久化。失败不回滚主操作，且注释写明了为什么。

找到**第三处**同类问题：

### 第三处：备份的「已备份」记录写在文件落盘之前

`internalExportBackup()` 的顺序是：

1. `encodeBackup()` 产出密文（纯计算，必成功或抛错）；
2. `meta.lastBackupAt = now` 并持久化；
3. `audit.record('backup.export')`；
4. `return text` ← **文件还没写**。

真正的写盘发生在调用方（`SettingsPanel` → `downloadTextFile`），也就是第 4 步之后。

原代码的注释已经想到了这一层，但只防住了一半：

> 记账放在编码**之后**：先记再编，编码一失败就留下"已备份"的假记录

它防的是**编码失败**，没防**保存失败**。于是：下载没落盘时，`lastBackupAt` 已经被推到"刚刚"，审计日志也已经记了一条"导出备份"。后果是「超过 7 天未备份」的提醒会被静默重置 7 天，而审计里留下一条与实际不符的记录。

严重度比前两个低——因为 Phase 11.2 已经让下载失败会明确报错，用户当场就知道要重试。但记录本身仍然是假的。

### 为什么这轮不修

正确修法要拆 API：`exportBackup()` 只负责产出密文，新增 `confirmBackupSaved()` 在实际落盘后记账，由 `SettingsPanel` 在 `downloadTextFile()` 返回 true 之后调用。

这是 `VaultClient` 的公开方法签名变更，会波及 `backup-reminder` / `vault-client-backup` / `vault-client-audit` 等多个测试。而**唯一覆盖这条 UI 路径的 `SettingsBackup.test.tsx` 我当前无法运行**（连续两次审批超时，既读不到也跑不了）。在这种状态下改公开 API，很可能留下一个我自己无法确认的失败——比带着一个已知的、严重度低的问题更糟。

已记为待办：等能跑全量测试时再做（见下）。

### 另外：重新构建与预览

- 重建产物：`dist/assets/index-BfIMf59J.js` **495.71 kB（gzip 184.77 kB）**。
- 构建时 `vite build` 清理旧 `dist` 被安全删除 shim 卡住（`genie-trash ... ETIMEDOUT`），按既有做法把旧 `dist` 挪出目录再构建即可。`rm -rf` 同样会被 shim 接管并超时，**只能 `mv`**。
- 起了本地静态预览（`dist` 目录，4180 端口），供人工点验。

### 待办（按优先级）

1. **`SettingsBackup.test.tsx` 未验证**（阻塞于审批，非代码问题）。它断言「已导出加密备份，请离线保存」，而 Phase 11.2 给这条文案加了前置条件。
2. 拆 `exportBackup` / `confirmBackupSaved`，让「已备份」记录只在文件真正落盘后写入。
3. 用户的 Rust 工具链就绪后，`cargo test` → `desktop:build`。

### 验证

| 项 | 结果 |
| --- | --- |
| `tsc --noEmit` | 0 error（本轮未改 TS 源码） |
| `vite build` | 成功，495.71 kB / gzip 184.77 kB |
| 本地预览 | HTTP 200，加载的是新构建产物 |
| `SettingsBackup.test.tsx` | **未验证**（审批超时，两次） |

---

## Phase 11.5 · 试着把 Rust 装起来（失败），转而在出包前多堵两个洞

### 一、试着自己装工具链，结论是这条路在本环境走不通

前四轮都停在「本机没有 Rust」。这轮不再等，直接试：

1. 探测网络：`static.rust-lang.org` 的 `rustup-init.exe`（GNU 目标，14.7 MB）返回 200，可下载。
2. 下载成功（14,698,490 字节）。
3. 以 `-y --no-modify-path --profile minimal --default-host x86_64-pc-windows-gnu` 执行——**选 GNU 而不是 MSVC**，因为 GNU 工具链自带 MinGW 链接器，不需要 VS Build Tools 就能链接纯 Rust 代码；`--no-modify-path` 保证不动用户的 PATH。
4. 结果：**退出码 0，零输出，`~/.cargo` 与 `~/.rustup` 都不存在**。

再单独验证：`./rustup-init.exe --version` 与 `--help` 同样零输出、退出码 0。**一个能正常执行的程序不可能连版本号都打不出来**——这说明本环境禁止执行新下载的二进制，而且是静默禁止。

另外排查了系统里是否已有现成的 rustc（`~/.rustup`、`Program Files\Rust`、chocolatey、scoop、msys64），全部不存在。

**结论：Rust 侧编译在本环境不可能完成，只能由用户在自己机器上做。**这一条不再反复尝试。

### 二、把「图标尺寸」纳入预检

`tauri build` 的失败顺序很要命：先编译十几分钟 Rust，**最后打包时才校验图标**。尺寸不对就前功尽弃。

原来 doctor 只检查图标文件存不存在。这轮补成真实校验：读 PNG 的 IHDR（偏移 16/20）拿到真实宽高、读 ICO 的目录项拿到各档尺寸，再和文件名推断出的期望值对（`128x128@2x.png` 期望 256）。

本机实测：`32x32.png`=32、`128x128.png`=128、`128x128@2x.png`=256、`icon.ico` 6 档（16/24/32/48/64/256）、`icon.icns` 魔数正常——**全部合规**。

**变异验证**：把 `64x64.png` 覆盖到 `32x32.png`，doctor 从「还差 2 项」变成「还差 3 项」，并精确报出 `icons/32x32.png 尺寸应为 32×32，实际 64×64`；还原后回到 2 项。

### 三、桌面版里说错话的文案

设置页两个桌面专属开关（防截屏 / 检查更新）由 `DesktopOnlyToggle` **无条件置灰**，原因文案写死为「需要桌面版：Web 阶段无法…」。

也就是说：**在桌面版里，用户会看到「需要桌面版」**——而他明明就在桌面版里。这不是谎报数据，是谎报处境，同样会让人怀疑整个应用的可信度。

改成按环境分文案：Web 下保持原句（现有测试断言的就是这句，不能动）；桌面壳下改成「桌面版尚未接入这一项：需要……（见 docs/DESKTOP-BUILD.md §6.3）」。

这样两边都是实话：Web 里说"需要桌面版"，桌面里说"桌面版还没接这一项"。

### 验证

| 项 | 结果 |
| --- | --- |
| `tsc --noEmit` | 0 error |
| 全量单测（排除 `SettingsBackup.test.tsx`） | 见下方回归结果 |
| `desktop:doctor` 图标校验 | 5 个图标全部合规 |
| 变异验证（图标） | 覆盖成 64×64 后阻塞项 2 → 3 并点名；还原恢复 |
| rustup 安装 | **失败**：本环境禁止执行新下载的二进制 |

### 仍未解决

1. `SettingsBackup.test.tsx` 依旧无法运行（审批超时），断言的是「已导出加密备份」文案——Phase 11.2 给它加了前置条件。
2. `exportBackup` 的记账时机（Phase 11.4 记录）未修。这轮查明功能层测试用的是**真实 `createVaultClient`**（团队约定不 mock 加密层），所以"加新方法会打爆假 client"的顾虑不成立，技术上已经可以动手；但需要同时改 3–4 个服务层测试，留到能完整跑全量测试时做。
3. 出包仍卡在用户的 Rust 工具链。

---

## Phase 11.6 · 备份记账时机修正：把「已备份」从产出挪到落盘之后

Phase 11.4 找到的第三处「静默谎报」，当时以「唯一覆盖该 UI 路径的测试跑不了」为由搁置。这轮解除阻塞并修掉。

### 解除阻塞的依据

`src/features/__tests__/support/harness.tsx` 用的是 **`createVaultClient`（真实门面）**，不是手写的假 client——团队约定功能层测试不 mock 加密层。所以给 `VaultClient` 接口加方法是安全的，不会因为"假 client 少一个方法"而打爆测试。

（这正是上一轮记录里"技术上已可动手"的那条，这轮兑现。）

### 改动

**1. `exportBackup()` 只产出密文**

删掉末尾的三件事：更新 `lastBackupAt`、`persistMeta()`、`audit.record('backup.export')`。现在它就是一个纯函数式的"把当前库编成密文文本"。

**2. 新增 `confirmBackupSaved()`**

```
更新 meta.lastBackupAt → 持久化（尽力而为，失败不抛）→ audit.record('backup.export')
```

接口注释写明：**必须在文件真正保存成功之后调用**。在保存失败时调用它，等于告诉应用"已经备份过了"——`overdue` 归零、提醒被静默重置 7 天，而用户手上什么都没有。

**3. `SettingsPanel` 在落盘成功后才记账**

```ts
if (!downloadTextFile(filename, text)) {
  toast('保存文件失败，备份未导出；请重试，或改用其他方式保存');
  return;                        // 不记账、不关弹窗、不清密码
}
await client.confirmBackupSaved();   // ← 只有走到这里才算"备份过"
```

### 测试调整（含一处"空过"的隐患）

- 「导出成功即记账」→ 改名「确认落盘后记账」，并补 `confirmBackupSaved()` 调用。
- **新增「只导出、不确认落盘：不记账，超期提醒照旧」**——这条就是这次修复的行为定义。若 `exportBackup` 里还留着记账，它必然变红，等于自带变异验证。
- `vault-client-audit.test.ts` 补了一次 `confirmBackupSaved()`。原因是：那几条断言是「审计日志里查不到密码 / 账号 / 标题 / 备份密码」。如果不补，审计里**根本没有 `backup.export` 这条记录**，四条 `not.toContain` 会全部空过——测试是绿的，但什么都没测到。这类"因为没东西可查所以通过"的断言比失败更危险。

### 验证

| 项 | 结果 |
| --- | --- |
| `tsc --noEmit` | 0 error |
| 受影响的 4 个测试文件 | **24 条全过**（backup-reminder / vault-client-audit / vault-client-backup / vault-client-recovery-persistence） |
| 全量单测（排除 `SettingsBackup.test.tsx`） | 95 文件 / **644 用例**（+1） |
| `vite build` | 成功，`496.03 kB`（gzip `184.90 kB`） |

### 需要你确认的一件事（这轮风险最高处）

`SettingsBackup.test.tsx` 我仍然跑不了（审批超时）。而这次改动**正好经过它**：它点「导出备份」、断言成功文案，而现在那条路径中间多了一次 `client.confirmBackupSaved()` 调用。

如果该测试用的是真实 `createVaultClient`（按 harness 的约定，几乎可以肯定），新方法存在，行为等价，会通过。如果它自建了一个只实现部分方法的假 client，就会报 `confirmBackupSaved is not a function`。

**请跑一次 `npm run test:run`。** 预期 96 文件 / 648 用例全过。若那条红了，把报错贴给我——改法是给 SettingsPanel 加特性检测，或者给假 client 补方法，都很小。

---

## Phase 11.7 · Rust 里的一个静默数据毁灭路径

前面几轮把 TS 侧翻了个遍，Rust 侧只做过"API 名字对不对"的核对。这轮改读**逻辑**——立刻找到一个比之前所有 TS 问题都严重的。

### 问题：密钥丢了会「假装首次运行」，然后毁掉数据

原 `Store::open()` 第一行就是 `load_or_create_key()`：

```rust
match entry.get_password() {
    Ok(existing) => decode_key(&existing),
    Err(keyring::Error::NoEntry) => {   // ← 直接生成一把新密钥
        let mut key = [0u8; KEY_LEN];
        ...
    }
}
```

场景：`vault.db` 里存着用户的全部数据，但 Windows 凭据管理器里的密钥条目没了。这不是臆想——**换 Windows 用户、重装系统、组策略或清理工具清凭据，都会让 DPAPI 条目消失**。

此时 `get_password()` 返回 `NoEntry`，代码把它当成"首次运行"，**生成一把新密钥**。后果链：

1. 新密钥解不开旧密文 → `get("keyslots")` 失败；
2. 用户看到的是「解密失败：数据可能被篡改，或换过机器」——一句把责任推给"数据坏了"的话；
3. 更糟的是，只要有任何一次写入成功（`set()` 用的是当前内存里的新密钥），新旧密文就混进同一张 `kv` 表。**数据从此永久不可恢复**，连"只恢复一部分"都不可能。

这是典型的"失败路径返回了一个看起来正常的值"——和 Phase 11.2 / 11.4 修的那三处同一族，但代价从"少一次提醒"变成"数据全毁"。

### 修法：先建表、再数行、最后取密钥

顺序调换是关键：

```
建目录 → 开库 → 建表 → SELECT COUNT(*) FROM kv → 按 has_data 决定能不能新建密钥
```

新增 `missing_key_policy(vault_has_data)`：

| `kv` 里有数据 | 凭据管理器里没密钥 | 处置 |
| --- | --- | --- |
| 否（全新安装 / 用户刚清空过） | — | 生成新密钥，正常启动 |
| 是 | 是 | **拒绝启动**，报「已有数据但密钥丢失，为避免覆盖不会新建，请恢复凭据或从备份导入」 |

为什么是"拒绝启动"而不是"启动后只读"：只读模式下前端会拿到一堆 `STORAGE_FAILED`，用户分不清"库坏了"还是"密钥丢了"；而且只要有一个写路径漏判，就会污染数据。**宁可起不来，也不要起来之后悄悄写坏。**

### 顺带确认的一处 API

无参查询的 params 用 `()` 而不是 `[]`。查了 docs.rs：`impl Params for ()` 明确存在，且文档里"无参数"示例就同时给了 `()` 和 `[]` 两种写法。`()` 没有泛型推断问题，比 `[]` 稳。

### 连带发现的新缺口（已记入 DESKTOP-BUILD.md §6.7）

这条"拒绝启动"的错误，**在发布版里用户看不到**。

`main.rs` 有 `windows_subsystem = "windows"`，发布版没有控制台；`setup` 返回 Err 最终落到 `.expect("密岛启动失败")`，panic 在无控制台进程里 = 双击图标一闪而过。

所以这个修复目前只保护了"数据不被覆盖"，没解决"用户不知道为什么"。§6.7 给了三种修法，推荐第一种（`setup` 不返回 Err，把错误经 `storage_probe` 送进 UI，复用现有 `STORAGE_FAILED` 通道）。

### 验证

| 项 | 结果 |
| --- | --- |
| Rust 单测 | 4 → **6 条**（新增 `missing_key_with_existing_data_refuses` / `missing_key_with_empty_vault_is_allowed`） |
| 结构复核 | 逐行通读 `storage.rs` 全文，括号/分支/`\` 续行确认无误 |
| 编译 | **仍未验证**（本环境无法安装 Rust，见 Phase 11.5） |
| TS 侧 | 本轮未改动，不重跑 |

新增的两条测试钉的是**纯函数** `missing_key_policy`，不触碰凭据管理器，所以在任何平台上都能跑。

---

## Phase 11.9 · 启动失败终于能被看见了

Phase 11.7 收尾时留下了一个自己打自己脸的局面：那轮加了「密钥丢失就拒绝启动」，保护了数据不被新密钥覆盖，但**用户看不到任何原因**——发布版 `windows_subsystem = "windows"` 没有控制台，`setup` 返回 Err 一路 panic 到 `.expect("密岛启动失败")`，表现就是「双击图标，一闪而过」。

这轮按 §6.7 的修法 1 修掉，并顺手处理了三个相关缺口。

### 1. `setup` 永不返回 Err

原来：

```rust
.setup(|app| {
    let store = Store::open(dir.join("vault.db"))?;   // ← 失败 = 进程静默退出
    app.manage(store);
    Ok(())
})
```

现在：

```rust
.setup(|app| {
    let (db_path, inner) = match app.path().app_data_dir() {
        Ok(dir) => { let path = dir.join("vault.db"); (Some(path.clone()), Store::open(path)) }
        Err(error) => (None, Err(StartupError::DataDir(...))),
    };
    app.manage(AppState { inner, db_path });
    Ok(())                                            // ← 失败也照常开窗口
})
```

`AppState` 里存的是 `Result<Store, StartupError>`。所有 `storage_*` 命令走 `state.store()?`，失败时把同一句中文原因当错误返回——这是防线，正常情况下前端不会走到（首屏已经拦住了）。

### 2. `StartupError` 分成四类

原来 `Store::open` 返回 `Result<Self, String>`，只有一句 `format!` 出来的话。问题不在"有没有文字"，而在**这句话能不能指导行动**：

| code | 出路 |
| --- | --- |
| `missing_key` | 换回原 Windows 用户 / 导备份 / 留档后重建 |
| `credential` | 确认用户身份、看凭据管理器条目、重启 |
| `data_dir` | 查磁盘空间、加安全软件白名单 |
| `database` | 关掉重复进程、暂停同步盘、复制留档 |

压成一句「本地存储读写失败，请重试」时，用户除了重试无事可做——而「密钥丢了」重试一万次也不会好。分类的唯一目的就是让文案能给出可执行的动作。

### 3. 四层兜底，各管一段

| 层 | 覆盖 |
| --- | --- |
| `setup` 不返回 Err + `AppState` | 所有存储类失败（99% 的真实情况） |
| `startup_failure` 命令 | 让前端知道**为什么**，不只是"失败了" |
| `StartupFailureScreen` | 用户看得到原因 + 三步出路 + 「打开数据文件夹」 |
| `MessageBoxW` + panic hook | 窗口/WebView 本身起不来——那时前端没有任何机会说话 |

第 4 层刻意**手写 FFI**（`#[link(name = "user32")]`）而不引 `windows-sys`：只需要一个函数，多一个依赖就多一处版本风险（本机没有 Rust 工具链，加依赖无法当场验证能否编译），而 `MessageBoxW` 的签名二十年没变。

### 4. 顺带修掉的三处

- **`storage_reveal` 在目录不存在时失败**：启动就失败在"建目录"这一步时目录压根没有，`explorer /select` 会落到「文档」。现在先 `create_dir_all` 父目录；文件不存在时直接打开父目录而不是 `/select`（对不存在的目标 `/select` 同样会落到「文档」，用户以为点错了按钮）。
- **`storage_reveal` 不再依赖 `Store`**：它原来取 `state.path()`，而 `Store` 是启动失败时恰恰不存在的东西——最需要"打开文件夹"的时刻反而用不了。现在路径从 `AppState.db_path` 取。
- **`revealStorageFolder()` 的错误被吞成一句笼统文案**：Rust 抛的本来就是给人看的中文原因（"创建数据目录失败：拒绝访问"），设置页与失败屏现在优先透传，拿不到才退回通用文案。

### 验证

| 项 | 结果 |
| --- | --- |
| `tsc --noEmit` | 0 error |
| 单测 | 644 → **657 条**（新增 `startup-failure.test.ts` 8 条 + `StartupFailureScreen.test.tsx` 5 条） |
| `e2e:smoke` | 17/17 |
| `e2e:smoke -- --csp` | 17/17 |
| `e2e:startup-failure` | **25/25**（21 条桌面 + 4 条启动失败屏） |
| `vite build` | 499.57 kB（gzip 186.70 kB） |
| Rust 编译 / `cargo test` | **仍未验证**（本机无 `rustc`，见 Phase 11.5） |

新增的 e2e 模式是这轮最有价值的一件东西：`vitest` 全跑在 jsdom 上，`isDesktopShell()` 恒为 false，**启动失败那条分支在单测里根本走不到**。`--startup-failure` 用假 Tauri 桥在生产包上真跑一次，断言标题、具体原因、数据路径都上屏且不落回设置向导。这是 §6.7 那类 bug 唯一能自动抓到的检查。

### 一处已知的不稳定

全量跑时 `SettingsDestroy.test.tsx` 的「销毁后回到首次设置状态」偶发失败（等 toast `本地数据已清空` 超时），单独跑 5/5 通过。原因是 toast 在 `destroy()` 的异步链之后才出现，机器满负荷（本轮 97 个文件并行、environment 累计 1429s）时容易踩线。属测试时序问题，不是产品缺陷；要根治得把断言换成 `findByText`。

### 仍未解决

1. **`SettingsBackup.test.tsx` 依然读不到**（审批超时，第三次 SIGTERM）。按规则不绕过，如实标注"未验证"。它断言「已导出加密备份」文案，而 Phase 11.2 给这条文案加了前置条件。
2. **Rust 侧全部改动未经编译**。`StartupError` 的 `code()` 映射、`missing_key_policy` 文案、`MessageBoxW` 的 `extern "system"` 声明、`#[link(name = "user32")]`，都只做了逐行复核与 API 签名核对。

---

## Phase 11.10 · 堵住「前后端命令契约」这个自动化盲区

上一轮修完启动失败可见性后，回头盘了一遍"哪些错误是**两套自动化都盖不住**的"。答案是 Rust↔TS 的那条边界：

- `vitest` 里 `invoke` 是 mock，前端调什么名字都"成功"；
- `e2e` 用假 Tauri 桥，而桥是按前端的期望写出来的——前端把命令名拼错，桥照样应答。

两边全绿，装出来的程序才会炸，报错还是一句运行时的 `invoke` 失败。Phase 11.9 新增的 `startup_failure` 正好落在这个盲区里：如果哪天有人漏了注册，只有真机才发现。

### doctor 新增第 8 项：命令契约

静态比对三个集合：

```
前端 invoke('x')  ⊆  generate_handler![x]  ⊆  #[tauri::command] fn x
```

中间那一步最容易漏——写了 `#[tauri::command] fn x` 却忘了加进 `generate_handler![]`，**编译完全通过**，调用时才报 `command x not found`。所以这项不是"声明 vs 调用"两方比对，而是三方。

实现上刻意不做行匹配：`#[tauri::command]` 与 `fn` 之间可能夹着其它属性或空行，用 `#[tauri::command][\s\S]{0,400}?\bfn\s+(\w+)` 从属性往后找最近的 `fn`。前端侧排除 `__tests__` 与 `*.test.ts`（那里的 `invoke` 是 mock，不代表真实契约）。

### 变异验证（两项，都还原了）

| 变异 | 期望 | 实际 |
| --- | --- | --- |
| 丢一个 `invoke('storage_load_all')` 的临时文件到 `src/services/` | 变红并点名命令 + 文件 | `✗ 前端调了未注册的命令：storage_load_all（src/services/__contract_probe.ts）` |
| 从 `generate_handler![...]` 删掉 `startup_failure,` | 变红，且两个方向都报 | `✗ 前端调了未注册的命令：startup_failure（…）；声明了但没注册进 generate_handler!：startup_failure` |

第二项尤其值得做——它验的是**我刚加的那个分支**，而不是"检查能跑通"。只验通过不验失败，等于没验。

### 顺带

- `desktop:verify` 改为跑 `--startup-failure`（21 条桌面 + 4 条启动失败屏 = 25 条）。原来的 `--desktop` 只覆盖 21 条，新增的检查项不写进标准流程就等于没加。
- 文档 §1.4 的检查表从"六项"更正为"八项"（Node 与命令契约此前都漏记），§1.5 的 `cargo test` 期望从 6 条更正为 8 条。

### 仍未解决（环境所致，非代码问题）

| 项 | 状态 |
| --- | --- |
| Rust 编译 / `cargo test` | `rustup-init.exe --version` 退出码 0 但**零输出**，确认新下载的二进制被环境静默拦截；`~/.cargo`、`Program Files\Rust*`、`choco`/`scoop` 均不存在。即便装上 rustup，`rusqlite` 的 `bundled` 特性还要 `cc` 编译 sqlite3.c，绕不开 MSVC Build Tools（数 GB + 管理员权限）。**不再尝试。** |
| `SettingsBackup.test.tsx` | 本轮再次尝试运行，工具层返回 `SENSITIVE_APPROVAL=TIMED_OUT` 并扣留输出，明确要求本轮不得重试。**尊重该决定，不再碰。** 它覆盖的行为已由 `backup-reminder.test.ts` 的两条（「确认落盘后记账」「只导出、不确认落盘：不记账」）独立覆盖，但那个文件本身仍属"未验证"。 |
| `SettingsDestroy.test.tsx` 的偶发超时 | 该文件同样被判定为敏感、用户拒绝共享，无法修改。单独跑 5/5 通过，全量跑偶发一次。 |

---

## Phase 11.11 · Rust 真的装上了（并推翻了自己两轮前的结论）

Phase 11.5 和 11.10 都写着「本环境禁止执行新下载的二进制，不再尝试」。这句话是错的。

真相：那次 `/tmp/rustup-init.exe` 是**残包**——14,698,490 字节，而官方 x86_64-pc-windows-msvc 的包约 12.7 MB。重新下载 12,724,224 字节的包后，`--version` 立刻正常输出 `rustup-init 1.29.2`。

**教训**：二进制"能执行但零输出"时，第一反应应该是**对大小**，而不是归因于环境。我把"零输出"读成了"被拦截"，于是两轮都跳过了唯一能验证 Rust 的路径。归因于环境是最省事的解释，也最容易错。

### 装了什么

```
rustup toolchain install stable --profile minimal
→ rustc 1.99.1 (58cf8f9c3 2026-10-13)
→ cargo 1.99.1 (5f94df478 2026-08-27)
→ host: x86_64-pc-windows-msvc
```

`cargo metadata` **全量通过**，tauri 2.12.5、libsqlite3-sys 0.30.1 等全部可解析。这验证了一件此前只能"对照 docs.rs 核对"的事：`Cargo.toml` 里的版本约束与 feature 名（`keyring/windows-native`、`rusqlite/bundled`、`tauri = "2"`）**全部真实有效**，不是照着记忆写的。

沙箱里的一个细节：`~/.cargo/bin` 的 shim 是硬链接，硬链接被拦后留下一堆 **0 字节空壳**，而真身在 `~/.rustup/toolchains/<tc>/bin` 完好。所以 `cargo --version` 一开始也是零输出——这次我没有再误判，直接去 toolchains 下找，正常。

### `cargo check` 的真实卡点

```
error: linking with `link.exe` failed: exit code: 1
error: could not compile `serde_core` (build script)
error: could not compile `proc-macro2` (build script)
error: could not compile `quote` (build script)
```

**还没轮到本项目代码。** 这带来一个此前没想清楚的结论：build script 本身是可执行文件，编译它就需要链接器，所以"先只检查类型、不链接"这条捷径**不存在**。MSVC 不是"最后打包才需要"，是第一步就需要。

（也因此，换 GNU 工具链不是解法：`rusqlite` 的 `bundled` 特性要用 C 编译器现场编 sqlite3.c，会从"缺一个链接器"变成"缺一整套 C 环境"，还要赌 Tauri 在 windows-gnu 上的兼容性。）

### doctor 加固：区分"没装"与"装了但 PATH 没刷新"

原来 `checkRust` 只找两个地方：PATH、`~/.cargo/bin`。而 shim 缺失时它两处都落空，于是报「未找到 rustc / cargo」——用户会去重装一个已经装好的东西。

改成三级查找：PATH → `~/.cargo/bin` → `~/.rustup/toolchains/*/bin`（stable 优先，多版本共存时不乱挑）。并且把"找得到但不在 PATH"单独判成 **fail** 而不是 ok：

| 状态 | 输出 |
| --- | --- |
| 未安装 | `✗ 未找到 rustc / cargo` |
| 已装、PATH 里没有 | `✗ rustc 1.99.1 · cargo 1.99.1 · host=x86_64-pc-windows-msvc（已安装，但当前终端的 PATH 里没有）` |
| PATH 就绪 | `✓ rustc 1.99.1 · cargo 1.99.1 · host=x86_64-pc-windows-msvc` |

为什么"不在 PATH"要判 fail：`cargo test` 用绝对路径还能跑，但 `npm run desktop:build` 不行（Tauri CLI 直接 spawn `cargo`）。判成 warn 的话 doctor 会说"环境就绪"，然后构建在最后一步报 `cargo not found`——正是这个脚本要防的事。

三种状态都实测过（PATH 那一项用 `PATH=…bin:$PATH node …` 模拟）。

### 交付给用户的工具链目录

`%USERPROFILE%\Downloads\keyisland-toolchain\`

| 文件 | 用途 |
| --- | --- |
| `vs_BuildTools.exe` | 4,474,800 字节，aka.ms → `download.visualstudio.microsoft.com`，来源已核 |
| `1-install-buildtools-as-admin.cmd` | 静默装 VCTools + `--includeRecommended`，右键以管理员运行 |
| `2-finish-rust-setup.cmd` | 补 shim、写用户 PATH、打印自检结果，不需要管理员 |
| `README.txt` | 两步流程 + 排错（1602 / 5007 / 3010）+ 为什么不用 MinGW |

`.cmd` 内容**全 ASCII**：带中文的批处理在非 UTF-8 代码页下会乱码，而"看起来正常的乱码脚本"比报错更危险。中文说明放在 `README.txt` 里。

### 仍未验证

Rust 代码本身**仍然没编译过**——卡在 `link.exe`。这是目前唯一挡在 `cargo test` 前面的东西，而且只有管理员权限能解决。
