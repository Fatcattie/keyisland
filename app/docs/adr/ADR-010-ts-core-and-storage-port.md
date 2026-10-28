# ADR-010：以 TypeScript 实现 Vault 核心，并保留 `VaultClient` / `VaultStorage` 端口

- 状态：已接受（临时方案，Phase 1.5 需复核）
- 日期：2026-10-20
- 决策人：工程师（寇豆码）
- 相关文档：SDD §2.1、§4、§5、§13 Phase 0/1；ADR-003（SQLCipher 集成）

## 背景

SDD 的目标架构是 **Tauri 2 + Rust + React**，加密、密钥槽、SQLCipher 与剪贴板写入都在 Rust 侧完成，前端只接收最小 DTO。

但当前开发机的事实约束是：

- Windows 环境可用 Node v22 / npm 10；
- **没有 Rust、cargo 与 C 编译工具链**，因此无法编译 Tauri，也无法编译 SQLCipher。

在这种前提下，"先搭 Rust 工程再写代码"会直接卡死，无法产出任何可运行、可测试的成果。

## 决策

Phase 1 的 Vault 核心以 **TypeScript** 实现，但严格保持与 SDD §5.2 command 契约相同的语义边界，并预留两个端口：

1. `VaultClient`（`src/services/vault-client.ts`）
   前端唯一入口。方法与 SDD §5.2 的 command 语义一一对应（下表为 SDD §5.2 原始子集示例：`status` / `initialize` / `unlock` / `lock` / `recover` / `resetMasterPassword` / `listItems` / `getItem` / `createItem` / `updateItem` / `deleteItem` / `setFavorite` / `setVisibility` / `copyPassword` / `copyUsername` / `getRecentItems` / `searchItems` / `generatePassword`）。全部返回 `Promise`，全部错误为 `AppError { code, messageKey, retryable }`。**注意**：随功能演进，`VaultClient` 接口现已扩展至实测约 50 个方法（见 ADR-014），上面仅是最初的 SDD 子集示例，迁移以接口为准。

2. `VaultStorage`（`src/services/storage.ts`）
   `loadKeyslots` / `saveKeyslots` / `loadItems` / `saveItems` / `loadMeta` / `saveMeta` / `loadRecency` / `saveRecency` / `clear`。本轮只有 `MemoryVaultStorage`，不做任何持久化。

具体实现要点：

- 加密使用 WebCrypto（`crypto.subtle`）与 `hash-wasm` 的 `argon2id`，二者在浏览器与 Node 22 下都可用，因此迁移到 Tauri WebView 时算法语义不变。
- Argon2id 参数集中在 `src/core/crypto/kdf.ts` 并带 `version` 字段；密钥槽记录持久化该参数，未来调参必须新增版本并保持旧版本可解析。
- 字段加密 AAD 固定为 `schemaVersion|itemId|fieldName`，与 SDD §4.2 一致，防止密文在字段或资产之间搬移。
- 会话状态机、冷却策略、可见性规则、最近使用、剪贴板摘要清理全部在纯 TS 层实现，不依赖 React，可被 Rust 侧逐条对照实现。

## 明确不做的降级

- **不使用 `localStorage` / `sessionStorage` 保存密码、恢复密钥或密文**（SDD §0.3）。本轮存储为纯内存，应用重启即清空。
- 不把明文写入日志、URL、异常消息。代码中没有任何 `console` 输出。
- 不引入 `any` 到核心公共 API，不使用 `@ts-ignore`。

## 后果

正面：

- 在没有 Rust 工具链的机器上也能完成 Phase 0/1 的可运行、可测试交付。
- 密码学语义（Argon2id + AES-GCM + 双槽 + AAD 绑定）与目标架构一致，Rust 迁移是"换实现"而不是"换设计"。
- 端口边界清晰，后续替换实现时调用方（UI、store）无需修改。

负面 / 风险：

1. **内存存储不持久**：重启丢数据，不能用于真实用户。必须由 Phase 1.5 的 SQLCipher 取代。
2. **JS 无法保证密钥擦除**：`zeroize` 只能清零 `Uint8Array`，字符串明文与 GC 副本不可控。SDD §12.1 要求"锁定清理敏感内存上下文"在 JS 层只能做到尽力而为，Rust `zeroize` 才是可验证方案。
3. **前端持有 DEK**：与 SDD §0.4"敏感操作全部经 Rust"相冲突。这是临时状态，Phase 1.5 必须把 DEK 移入 Rust 进程，前端只拿 `CopyReceipt` / `ItemSummary`。
4. **Argon2id 参数未基准**：当前生产参数 64 MiB / 3 次迭代未在目标机型上做耗时基准，需在 Phase 1.5 用 Rust 实现后重新标定并版本化。
5. **时序与侧信道**：JS 常量时间比较只能覆盖显式比较，底层 `subtle.decrypt` 与 `hash-wasm` 的行为依赖运行库实现。
6. **剪贴板语义**：浏览器 `navigator.clipboard.readText` 需要权限且可能被拒；Windows 原生剪贴板需要 `OpenClipboard` + 序列号检测才能可靠判断"是否被覆盖"。

## Phase 1.5 迁移清单（必须保持接口语义不变）

1. `crates/vault-core/src/crypto.rs`：Argon2id（`argon2` crate）+ AES-256-GCM（`aes-gcm` crate），参数版本表与 TS 侧 `ARGON2_PARAMS_V1` 完全对齐。
2. `crates/vault-core/src/keyslots.rs`：实现 `create_keyslots` / `unwrap_dek` / `rewrap_password_slot` / `rewrap_recovery_slot`，AAD 字符串保持 `keyslot|{slot}|{version}`。
3. `crates/vault-core/src/repository.rs`：SQLCipher 打开、迁移、`PRAGMA secure_delete`、WAL；表结构照 SDD §4.3。
4. `src-tauri/src/commands.rs`：把 `VaultClient` 的方法逐个映射为 `#[tauri::command]`，DTO 字段名保持 camelCase 序列化。**以 `src/services/vault-client.ts` 中的 `VaultClient` 接口为权威契约——当前实测约 50 个方法**（ADR-014 复核），早已超出 SDD §5.2 原始 command 子集；迁移时逐个照接口映射，而非照 SDD 文本。
5. `src/services/vault-client.ts`：新增 `createTauriVaultClient()`，用 `invoke` 实现同一 `VaultClient` 接口；`createVaultClient()` 保留给测试与 Web 预览。
6. `src/services/clipboard.ts`：新增 `TauriClipboardPort`，用 `OpenClipboard` + `GetClipboardSequenceNumber` 判断覆盖，替代 `readText`。
7. 删除前端 DEK 持有路径：`ItemService` 不再接收 `dek`，改为调用 command。
8. 补齐 Rust 侧测试（SDD §12.1），并保留现有 TS 测试作为语义回归基线（对照 `tests/fixtures` 中的固定向量）。
9. 迁移完成后更新本 ADR 状态为"已取代"，并新增 ADR 记录 SQLCipher 构建链结论。

## 验收

- `npm run typecheck` / `npm run test:run` / `npm run build` 全部通过。
- 双密钥槽、恢复码、会话冷却、三档可见性、剪贴板清理均有单元测试覆盖（见 SDD §12.1）。
- 全仓库无 `console.*` 输出明文，无 `localStorage` 使用。
