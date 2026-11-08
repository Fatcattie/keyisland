# KeyIsland 六项优化 · 实施报告

> 对应任务说明：[`agent-improvement-plan.md`](agent-improvement-plan.md)。基线 `ec752ee`，应用版本保持 `0.1.20`（未提升版本号）。
> 实施日期：2026-11-08。本机**没有 Rust 工具链**；Rust 编译与测试已通过 PR #1 的 CI（Windows runner）验证，真实桌面行为仍未验证。

## 1. 完成状态总览

| 任务 | 状态 | 说明 |
|---|---|---|
| 3 · 失败测试 + CI | ✅ 完成，CI 在 PR #1 上首跑通过 | 6 个失败逐一定位修复；新增 `.github/workflows/ci.yml` |
| 1 · 整库替换原子化 | ✅ 完成，前端与 Rust（CI）均已验证 | `storage_commit` 单事务；覆盖导入 / 初始化 / 重设主密码改用原子提交 |
| 5 · 资产增量保存 | ✅ 完成，前端与 Rust（CI）均已验证 | 每卡一行 `item:<id>`；旧 `items` 行事务迁移；性能对照见 §5 |
| 2 · 剪贴板清理失败 | ✅ 服务层与 UI 提示完成；⚠️ Windows 真机未验证 | 失败不再报成功；有界重试；新复制取代旧任务 |
| 4 · 导入资源上限 | ✅ 完成 | 集中定义上限；读文件前、解析 / 解码 / KDF 前拒绝 |
| 6 · 文档统一 | ✅ 完成 | 去除现行文档中的 SQLCipher 说法；版本、路径、按钮名、换机说明与代码一致 |

## 2. 验证结果

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 通过 |
| `npm run test:run` | ✅ 125 个文件 / 874 个用例全部通过（基线 121 / 823，其中 6 个失败） |
| `npm run test:security`（新增脚本） | ✅ 8 个文件 / 98 个用例通过（此前 `verify` 根本不跑这组测试） |
| 两个原失败文件单独运行 | ✅ 通过 |
| `npm run build` | ✅ 通过（主包 > 500 kB 的 Vite 提示依旧，未处理，不属于本次范围） |
| `e2e:smoke`、`smoke --desktop`、`e2e:startup-failure`、`e2e:shell` | ✅ 通过（真实 Chrome + 假 Tauri 桥，已补上 `storage_commit` / `storage_load_items`） |
| `desktop:doctor` 命令契约 | ✅ 调用 17 · 注册 17 · 声明 17 |
| `npm run perf:items`（新增） | ✅ 已跑前后对照，见 §5 |
| `cargo test --locked` | ✅ CI（windows-latest，rustc 1.99.1）：27 个通过，含新增 11 个 SQLite 事务 / 迁移测试，无编译警告；本机无工具链未跑 |
| 桌面安装包与真机行为（失焦、缩成岛、锁定、断电） | ❌ **未执行**：无桌面构建环境 |
| GitHub Actions 实跑 | ✅ PR #1 run 42460296935：前端 2m12s、Rust 4m53s 均通过；runner 上 `desktop:doctor` 全绿 |

## 3. 任务 3：6 个失败测试的根因与修复

| 文件 · 用例 | 根因 | 修复 |
|---|---|---|
| SettingsBackup · 导出备份：锁定态拒绝… | 测试过期：按钮在 `84103c8` 改名为「导出完整备份」（与 `.kia` 资产迁移区分），测试仍找「导出备份」 | 测试改用现行文案 |
| SettingsBackup · 合并导入不需要确认词… | 同上，「导入备份」→「导入完整备份」 | 同上 |
| SettingsBackup · 选择 .kib 文件后内容进入粘贴区 | 同上 | 同上 |
| SettingsBackup · 覆盖导入必须同时提供确认词与当前库主密码 | 同上（认证要求未改动，仍断言确认词与主密码缺一不可） | 同上 |
| SettingsBackup · 导入失败时 toast 展示备份相关错误 | 同上 | 同上 |
| SettingsDestroy · 销毁后回到首次设置状态（E2E-09） | 时序：`resetVault` 要跑一次真实 Argon2 校验主密码，测试只等一次 `setTimeout(0)`；单独跑时够快能过，全量并行负载下来不及渲染「本地数据已清空」 | 改用 `findBy*` / `waitFor` 等真实结果 |

产品代码在这 6 处**都没有缺陷**；判断依据是 UI 文案改名有明确提交记录，且销毁逻辑单独运行稳定通过。
另外按要求加强了销毁测试：每个用例先建一张合成卡片，错误密码 / 锁定态之后断言**这张卡片仍在**，取代原来的 `length >= 0`。

CI（`.github/workflows/ci.yml`）：PR 与 `main` 推送触发；`permissions: contents: read`；`windows-latest` 上
`npm ci` → typecheck → 单元测试 → 安全测试 → build；另一个 job 先构建 `dist/`（`generate_context!` 编译期需要）再跑
`desktop:doctor` 与 `cargo test --locked`。不打包、不发布、不使用任何凭据。

## 4. 任务 1 + 5：原子存储与增量写入

**接口**（`src/services/storage.ts`）：`VaultStorage` 新增
- `commit(batch)`：`keyslots` / `meta` / `items`（整体替换）/ `recency` 任意组合，**全有或全无**；
- `applyItemChanges({ upserts, deletes })`：只写点名的卡片，同样原子；
- `saveItems` 保留，语义为 `commit({ items })`。

**Rust**（`src-tauri/src/storage.rs`、`lib.rs`）：
- 新命令 `storage_commit`、`storage_load_items`；`storage_load/save` 的允许键收窄为 `keyslots/meta/recency`（前端再也不能写旧 `items` 行）。
- `Store::commit` 在开事务前完成全部加密与校验（JSON 合法、内容 `id` 与行身份一致、批内不重复、同一 id 不能既写又删），事务里只剩 SQL，出错即 drop 回滚。
- 资产每卡一行 `item:<id>`，AAD 为完整键名；前端字段级 AAD 本就绑定卡片 id，**无需改动密文格式**，nonce 仍随机、认证照旧。
- 旧布局迁移：首次读（或首次增量写）时，在一个事务里把 `items` 拆成 `item:<id>` 并删除旧行；失败回滚、旧行保留；旧行与新行并存时拒绝并报错。

**门面**（`vault-client.ts`）：初始化、覆盖导入、重设主密码（密钥槽 + 提示）均改为一次 `commit`；**提交成功后才**切换会话与内存状态。
覆盖导入删除了原来的"反向补偿写入"。合并导入改为只 `upsert` 新增卡片，不再整体重写（避免盖掉合并期间别处的修改）。

**其他多键写入路径的检查结论**：

| 路径 | 处理 | 理由 |
|---|---|---|
| 初始化 | 改用 `commit` | 四段必须同生同死（P2-1） |
| 覆盖导入 | 改用 `commit` | 任务 1 主场景 |
| 重设主密码（含提示） | 改用 `commit` | 密钥槽与提示分开落盘会让提示与可用密码对不上 |
| 轮换恢复密钥 | 保持 `saveKeyslots` | 只写一个键，单条语句本身原子 |
| 合并导入 / `.kia` / CSV 导入 / 批量删除 | `applyItemChanges` | 只涉及资产，一次调用一个事务 |
| 最近使用 `saveRecency` | 保持 | 派生数据、单键，失败不回滚主流程（原设计） |
| 销毁 `clear` | 保持 | 单条 `DELETE` + `VACUUM` |

**`ItemService`**：写操作串行队列（同一卡片并发修改不会乱序落盘）；落盘失败时内存回滚到写之前；
锁定（`dispose`）后排队中 / 加密中的写入不再落盘（锁定会清零 DEK，避免写下一张永远解不开的卡）。

**验证证据**
- 前端（已执行）：`vault-client-atomic-storage.test.ts`——覆盖导入只发一次 `commit`；在 keyslots / meta / items / recency 每个阶段注入故障后，
  当前会话仍解锁可用、"重启"后旧主密码能解锁且旧卡能解密；成功后"重启"可用备份主密码解锁、资产可解密；单卡修改只加密 1 张、其余 19 张密文逐字节不变；
  批量删除失败一张不删；并发修改按发起顺序落盘；锁定后排队写入报 `VAULT_LOCKED` 且不落盘。共享契约新增 4 条原子 / 增量断言，内存实现与 Tauri 适配器都跑。
- Rust（CI 已运行通过）：`storage.rs` 新增 11 个测试，在系统临时目录的隔离数据库上：提交后重开仍在；7 个写阶段逐一注入故障后重开仍是完整旧库；
  开事务写入新密钥槽与新卡后既不提交也不回滚、直接关闭连接，重开仍是旧库；增量写不改动无关行密文；批量增量逐阶段故障全有或全无；
  非法批次在写入前被拒；旧布局迁移、损坏旧布局原样保留、新旧并存拒绝、整体替换顺带删除旧行；键名规范解析。

## 5. 性能对照（`npm run perf:items`，合成数据，本机 Node 24 / Windows 10）

"写入量"是交给存储端口的 JSON 字节数，即桌面端一次 IPC 载荷及 Rust 要重新加密写入的数据量。

| 库规模 | 操作 | 改动前 耗时 / 写入量 / 重新加密卡片数 | 改动后 |
|---|---|---|---|
| 100 | 新增 1 条 | 56.4 ms / 60.1 KB / 101 | 0.6 ms / 0.6 KB / 1 |
| 100 | 编辑 1 条 | 58.5 ms / 60.0 KB / 101 | 0.7 ms / 0.6 KB / 1 |
| 100 | 删除 1 条 | 56.8 ms / 59.5 KB / 100 | 0.0 ms / < 0.1 KB / 0 |
| 100 | 再批量导入 100 条 | 122.5 ms / 119.4 KB / 200 | 53.0 ms / 59.9 KB / 100 |
| 1000 | 新增 1 条 | 519.6 ms / 598.5 KB / 1001 | 0.5 ms / 0.6 KB / 1 |
| 1000 | 编辑 1 条 | 534.8 ms / 598.6 KB / 1001 | 0.5 ms / 0.6 KB / 1 |
| 1000 | 删除 1 条 | 507.0 ms / 597.9 KB / 1000 | 0.0 ms / < 0.1 KB / 0 |
| 1000 | 再批量导入 100 条 | 492.7 ms / 659.0 KB / 1100 | 48.3 ms / 61.1 KB / 100 |
| 10000 | 新增 1 条 | 5116.9 ms / 6088.8 KB / 10001 | 0.6 ms / 0.6 KB / 1 |
| 10000 | 编辑 1 条 | 5065.6 ms / 6088.9 KB / 10001 | 0.8 ms / 0.7 KB / 1 |
| 10000 | 删除 1 条 | 5161.1 ms / 6088.2 KB / 10000 | 0.0 ms / < 0.1 KB / 0 |
| 10000 | 再批量导入 100 条 | 5208.5 ms / 6149.8 KB / 10100 | 51.5 ms / 61.6 KB / 100 |

建库时一次导入 N 条两边相同（都要加密 N 张）。"改动前"数字是在 `ec752ee` 的临时 worktree 上跑同一脚本得到的。
这些数字只测前端加密 + 端口调用，不含 Rust 侧 AES 与 SQLite I/O（本机无法运行）；但改动前每次都要把约 6 MB 整体重新加密写入，
改动后只写一行，桌面端的收益只会更大。加密强度、AAD 与认证校验均未减弱。

## 6. 任务 2：剪贴板

- `BrowserClipboardPort.clear()` 不再吞异常（抛 `CLIPBOARD_WRITE_FAILED`）。
- 新结果 `clear-failed` 与 `superseded`；`clear()` 失败时**不**记 `cleared` / `cleared-unverified`、不触发 `onCleared`。
- 到期清理失败有界重试 1s / 3s / 10s，每次重试重新核对内容摘要；期间用户覆盖则记 `overwritten` 不清。用尽后记 `clear-failed` 并 `onClearFailed`。
- 新的复制**取代**旧任务（取消其定时器与重试）。这修复了一个原有竞态：A 到期时若读不到剪贴板会强制清空，抹掉刚复制的 B。
  原测试「多次复制各自独立结算」的前提（两个任务并存）因此改变，已改写为断言取代行为，"A 不能清掉 B"的原意保留。
- 锁定 / 退出：`cancelAll` 返回 `{ clearFailed }`，失败记 `clear-failed` 并通知，不再重试（会话已结束）。
- UI：`VaultClient.onClipboardNotice` → `SessionGate` 弹出"剪贴板未能自动清空…请手动清除"。通知只含字段名，不含明文。
- 兜底：定时器回调里的 rejection 与 UI 回调异常都被接住，不会产生未处理的 Promise rejection。
- **原生剪贴板适配器：评估后未引入**。可选方案是 `tauri-plugin-clipboard-manager`，但它需要新增 Rust 依赖与 capability 权限，
  本机无法编译验证；且它同样只能清"当前内容"，清不掉 Win+V 历史。建议在具备 Rust 环境后再做，届时需定义：读失败按"无法验证 → 强制清空"、
  写失败按本次的 `clear-failed` 语义上报，并与浏览器预览版保持同一 `ClipboardPort` 契约。
- 测试：`clipboard-clear-failure.test.ts` 覆盖清理一直失败 / 中途成功 / 读写都失败 / 读失败写成功 / 重试期间被覆盖 / 重试期间再复制 / 连续 3 次复制 /
  锁定时失败 / 锁定发生在重试排队期 / 回调抛错 / 浏览器端口不吞异常 / 门面通知与退订。
- **未验证**：Windows 桌面版窗口失焦、缩成岛、锁定时 WebView 对 `navigator.clipboard` 的真实读写行为。

## 7. 任务 4：导入上限

定义集中在 `src/core/vault/import-limits.ts`（依据写在文件头注释里）：

| 项 | 上限 | 依据 |
|---|---|---|
| `.kib` / `.kia` | 32 MB | 实测 1 万张典型卡片 ≈ 8 MB，留 4 倍余量；字段写满的极端卡片也能容纳约 2900 张 |
| CSV | 8 MB | 一行通常 < 300 字节，≈ 2.7 万行 |
| `.kirk` | 64 KB | 真实文件几百字节 |
| 单次条目 | 2 万张 | 产品容量目标 |
| 导入文件声明的 Argon2 | ≤ 256 MiB / 10 轮 / 8 线程 | 本应用导出一律 64 MiB / 3 / 1；本地密钥槽仍允许到 1 GiB（兼容），但外来文件收紧 |

- 文件选择：`readTextFile` 先查 `File.size`，超限不读一个字节（备份、资产包、CSV、`.kirk` 四处统一）。
- 领域入口（粘贴 / 直接调用也绕不过）：`importBackup` / `importAssetTransfer` 在 `JSON.parse` 前查长度，在 Base64 解码与 KDF 前查 KDF 参数与 salt/nonce 长度；
  解密后查条目数；覆盖导入还要求备份内**密钥槽**的 KDF 参数在导入上限内（否则导入后每次解锁都会被拖垮）。CSV 在逐字符解析前查长度、解析后查行数；门面 `importCsvItems` 再查一次数组长度。
- 被拒时不调用任何存储写入（测试断言 `commit` / `applyItemChanges` 未被调用，密钥槽 / 元数据 / 资产逐项相等），提示只说"太大 / 太多"，不回显内容。
- **Worker / 进度 / 取消：未引入**。2 万张上限附近，解析与解密仍在主线程，可能卡顿数秒。取舍：加进度条而不移出主线程没有意义，
  而 Worker 需要把 DEK 传进另一个上下文，扩大密钥暴露面，应单独设计。已写进 README「已知限制」。

## 8. 任务 6：文档

- 根 `README.md`、`app/README.md`、用户指南（md + html）、设置页「数据说明」文案：不再称 SQLCipher，改为"SQLite + 每值 AES-256-GCM + Windows 凭据管理器中的存储密钥"，
  并明确**只拷 `vault.db`、只有主密码都无法换机恢复**。设置页文案原先在桌面版也写着"当前版本使用内存存储"，现按真实存储类型显示。
- `app/README.md` 版本 0.1.13 → 0.1.20；新增「存储与数据安全」（三把钥匙、原子写入、增量与迁移、降级风险、导入上限）。
- 用户指南：数据文件默认路径更正为 `%APPDATA%\com.keyisland.desktop\vault.db`；按钮名更正为「导出完整备份」「导入完整备份」；
  换机原理补上 `.kib` 外层的备份密码与"本机外壳"；补导入上限、覆盖导入原子性、剪贴板失败提示及 Win+V 历史清不掉的说明。
- `DESKTOP-BUILD.md` §4：表布局、事务、迁移、`cargo test` 验证方式；把"与 SQLCipher 安全性等价"改为如实说明差异（键名与行数可见）。
- 历史文档保留原语境：`ADR-010` 加后续变更说明与链接，`RELEASE.md` 标注为 Web 预览阶段的历史文档；`PHASE-LOG.md`、`ADR-014` 未改。
- `package.json`：新增 `test:security`（README 与配置注释早就引用它，但脚本不存在）、`perf:items`；`verify` 现在包含安全测试；`description` 去掉"Phase 0/1 工程骨架"。
- 本地文档链接 14 处全部有效；文档中 20 个 `npm run` 命令与 `package.json` 一致。

## 9. 剩余风险与未完成项

1. **Rust 只在 CI 上验证过**：`cargo test` 在 GitHub 的 Windows runner 上 27/27 通过，但未出安装包，
   也没在真机上验证旧库升级迁移（测试用的是合成的旧布局数据）。建议发版前用一份真实旧库的副本，在隔离的 Windows 用户下试升级一次。
2. **降级不兼容**：迁移到每卡一行后装回 0.1.20 及以前的版本，会看到空库；旧版若再写入，再升级时会因两种布局并存而拒绝读取（数据不丢，但需人工处理）。已写进 README 与 DESKTOP-BUILD。
   如需更平滑，可后续加一个"导出旧布局"的应急命令。
3. 合并导入与同一时刻的新建卡片理论上可能分到同一个 id（合并按"读库时的最大 id + 1"编号，与内存中的 `ItemService` 不同源）。概率极低（需要两者并发），未处理。
4. 剪贴板在 Windows 真机（失焦、缩成岛、锁定）上的行为未验证；未引入原生剪贴板适配器。
5. 导入大文件仍在主线程解析与解密，接近上限时会卡顿。
6. CI 工作流未在 GitHub 上实跑；`desktop:doctor` 在 runner 上的结果未知（本地缺 Rust / MSVC / SDK 时它会失败，runner 上这些应当齐备）。
7. Vite 主包 > 500 kB 的提示仍在，未处理（不在本次范围）。
