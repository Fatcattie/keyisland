# 密岛 KeyIsland · 桌面版打包指南

把 `app/` 这个 Web 工程打成 **Windows 可安装程序**（`-setup.exe`），壳是 Tauri 2，数据落本机 SQLite。

---

## 0. 一句话流程

```bash
# 一次性：装工具链（约 3–6 GB，30–60 分钟）
# 然后随时用这条命令确认"还缺什么"，缺什么它会直接告诉你：
npm run desktop:doctor

# 每次发版：
npm run desktop:build
# 产物：src-tauri/target/release/bundle/nsis/KeyIsland_0.1.0_x64-setup.exe
```

> 只出 NSIS（`-setup.exe`，免管理员、装到当前用户目录）。
> 需要 MSI（企业批量部署）时显式指定：`npm run desktop:build -- --bundles msi`。
> 默认不带上 MSI，是因为它要额外拉 WiX 工具链——那一步在**编译完所有 Rust 之后**才跑，
> 一旦失败，前面十几分钟的编译成果一个安装包都留不下。

---

## 1. 装工具链（只需一次）

### 1.1 Rust

打开 <https://rustup.rs/> 下载 `rustup-init.exe`，一路回车（默认 `x86_64-pc-windows-msvc`）。

装完**重开一个终端**验证：

```bash
rustc --version    # 期望 rustc 1.7x 及以上
cargo --version
```

> **本机当前状态（2026-10-25）**：已经装好了 `rustc 1.99.1` / `cargo 1.99.1`（`host=x86_64-pc-windows-msvc`），
> 位置在 `%USERPROFILE%\.rustup\toolchains\stable-x86_64-pc-windows-msvc`。
> 缺的只是 `%USERPROFILE%\.cargo\bin` 里的 shim 与 PATH 条目——`Downloads\keyisland-toolchain\2-finish-rust-setup.cmd` 一键补齐。
> 依赖图也已用 `cargo metadata` 验证通过（tauri 2.12.5、libsqlite3-sys 0.30.1 全部可解析）。

**一个必须记住的坑：`rustup-init.exe` 执行后零输出 = 下载残包，不是"环境禁止运行二进制"。**

判断方法只有一条——**对大小**。官方 `rustup-init.exe`（x86_64-pc-windows-msvc）约 **12.7 MB**：

```bash
curl -L -o rustup-init.exe https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe
./rustup-init.exe --version      # 期望：rustup-init 1.29.2 (…)
```

`--version` 有输出才往下走。曾经因为拿到一个 14.7 MB 的残包（退出码 0、零输出），
连续两轮误判成"本环境不允许执行新下载的二进制"，白白搁置了 Rust 验证。
**残包的典型特征就是"能执行、但什么都不说"。**

### 1.2 MSVC C++ 生成工具

下载 <https://aka.ms/vs/17/release/vs_BuildTools.exe>，安装时勾选：

- **使用 C++ 的桌面开发**（Desktop development with C++）
- 右侧详情里确认包含：**MSVC v143 生成工具** + **Windows 10/11 SDK**

> **只有这一步需要管理员权限**，其它步骤都不需要。
> 本机已备好 `Downloads\keyisland-toolchain\1-install-buildtools-as-admin.cmd`（右键 → 以管理员身份运行），
> 它跑的就是下面这条静默命令，等价于勾选「使用 C++ 的桌面开发」，但不用在图形界面里担心右侧面板被取消勾选：
>
> ```bat
> vs_BuildTools.exe --quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended
> ```
>
> `--includeRecommended` 会把 Windows SDK 一起带上——少了它，`link.exe` 找得到，但链接时会缺
> `kernel32.lib` 之类的导入库，报错更难懂。
>
> ⚠️ **这条命令必须写在一行里。** 早期版本用 `^` 续行写成三行，而文件混进了裸 LF 行尾，
> cmd 的续行因此静默断裂：参数被当成独立命令丢掉，安装器**无参数运行并退出 0**，
> 看起来成功、实际一个文件都没装。教训有两条，对任何调用外部安装器的脚本都成立：
>
> 1. 批处理一律用**纯 CRLF**，改完校验 `CRLF 数 == 总行数 && 裸 LF == 0`；
>    不要用会重写行尾的编辑器/工具去改 `.cmd`。
> 2. **退出码会撒谎**，成功判据只能是磁盘上是否出现了预期产物
>    （`...\2022\BuildTools\VC\Tools\MSVC` 与 `Windows Kits\10\Include`）。
>    脚本 v2 已经按这两条改写：单行命令、纯 CRLF、结尾打印 `VERIFY OK` / `VERIFY FAILED`。

**为什么绕不开**：`cargo check` 在**第一批 build script**（`serde_core` / `proc-macro2` / `quote`）
就死在 `linking with link.exe failed`——还没轮到我们自己写的代码。因为 build script 本身是
可执行文件，编译它就需要链接器。所以"先只检查类型、不链接"这条捷径不存在。

> 只装 VS Build Tools 就够，不需要完整的 Visual Studio。

**MSVC 和 Windows SDK 是两个独立包。** 装了「使用 C++ 的桌面开发」通常会一起带上 SDK，
但两者的安装状态可以不一致——本机就遇到过：Build Tools 装到 `D:\VisualStudio\BuildTools`，
x64 `link.exe` 齐全，可是 `Windows Kits\10` 下只有 `Catalogs` / `Redist`，
`Lib` / `Include` / `bin` 都不存在，`cargo check` 报 `LNK1181 无法打开 kernel32.lib`。

> **诊断只看磁盘，不看 VS 的组件勾选状态。** 本机的 SDK 曾经是个「幽灵组件」：
> VS 日志里 `Component.Windows11SDK.26100` 是 `DetectionState: Present, PlannedAction: None`，
> 连「修复」都跳过它，而磁盘上根本没有文件。检测依据只是注册表里一条
> `HKLM\SOFTWARE\Classes\Installer\Dependencies\Win11SDK_10.0.26100,en,10.0.26100`；
> **删掉标记没用**——只要实例状态里组件还打着勾，跑一次修复就会把它写回去。
> 解法是在 VS Installer「修改 → 单个组件」里勾一个**从没被标记过**的 SDK
> （本机用的是 `Windows 10 SDK (10.0.19041.0)`，但实际落地成了 `10.0.26100.0`）。

### 1.2.1 构建环境变量（本机必须）

本机的 VS 实例注册对**非提权进程不可见**（`vswhere` 返回 `[]`，`rustc` 因此找不到
`link.exe`，会退化到 PATH 撞上 Git 自带的 GNU `link.exe`，报 `link: extra operand`）。
所以构建前必须有下面这组用户级环境变量，它们已经写进 HKCU（不需要管理员）：

| 变量 | 值 |
|------|-----|
| `INCLUDE` | `<MSVC>\include` + `<Kits>\Include\10.0.26100.0\{ucrt,shared,um,winrt,cppwinrt}` |
| `LIB` | `<MSVC>\lib\x64` + `<Kits>\Lib\10.0.26100.0\{ucrt,um}\x64` |
| `CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER` | `<MSVC>\bin\Hostx64\x64\link.exe` |
| `Path`（追加） | `<MSVC>\bin\Hostx64\x64` + `<Kits>\bin\10.0.26100.0\x64`（`rc.exe` / `mt.exe`） |

其中 `<MSVC>` = `D:\VisualStudio\BuildTools\VC\Tools\MSVC\14.44.35207`，
`<Kits>` = `C:\Program Files (x86)\Windows Kits\10`。改完要**重开终端**才生效。

> 只设 `VSINSTALLDIR` / `VCINSTALLDIR` 不够——实测 rustc 1.99 不会据此发现 `link.exe`。
> 也不要只设 linker 不设 `LIB`：那样会从 `LNK1104` 变成另一个找不到 `.lib` 的错误。

### 1.3 WebView2 运行时

Windows 10/11 通常已预装。本机检测到 `153.0.4234.48`，**无需额外安装**。
若目标机器是精简版系统，需单独装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。

### 1.4 验证环境

```bash
npm run desktop:doctor
```

它会把出包需要的东西逐条列出来，缺哪样就直接给安装链接：

```
  ✓ Node 运行时      v22.22.2
  ✗ Rust 工具链      未找到 rustc / cargo
    ↳ 安装 rustup：https://rustup.rs/ （Windows 选默认的 x86_64-pc-windows-msvc）
  ✗ MSVC 链接器      未找到 Visual Studio Installer（vswhere.exe 不存在）
    ↳ 装 VS Build Tools：https://aka.ms/vs/17/release/vs_BuildTools.exe，勾选「使用 C++ 的桌面开发」
  ✗ Windows SDK      未安装（Windows Kits\10\Lib 不存在）
    ↳ 装 Windows SDK：Visual Studio Installer → 修改 → 勾选「Windows 11 SDK」。少了它 link.exe 会报 LNK1181 打不开 kernel32.lib
  ✓ WebView2 运行时  v153.0.4234.48 · C:\Program Files (x86)\Microsoft\EdgeWebView\Application
  ✓ npm 依赖         cli 2.12.4 · api 2.12.4
  ✓ 前端产物 dist/   index.html 存在 · assets 2 个
  ✓ Tauri 配置       identifier=com.keyisland.desktop · 出包目标=nsis · 图标 5 个
  ✓ capabilities     default · core:default
  ✓ 命令契约         调用 7 · 注册 7 · 声明 7 · 三方对得上

还差 3 项，现在出包会在最后阶段失败。
```

退出码 0 = 就绪，1 = 有阻塞项，可以直接接进 CI。加 `--json` 出机器可读结果。

**为什么要有这一步**：缺 Rust 或 MSVC 时，`tauri build` 会先跑完前端构建、再编译十几分钟 Rust，
最后才用一句 `program not found` 报错。doctor 把这件事提前到 1 秒内。

它检查的九项，每一项都对应一次真实踩过的坑：

| 检查 | 不做会怎样 |
| --- | --- |
| Node 运行时 | 后续命令全部跑不起来 |
| Rust 工具链 | `cargo metadata ... program not found`；**已装但 PATH 没刷新**时还会误报"未安装" |
| MSVC 链接器 | 编译到链接阶段才炸，报 `link.exe not found`；装了 VS 但没勾「C++ 生成工具」同样炸 |
| Windows SDK | 编译器在、`link.exe` 在，`cargo build` 仍报 `LNK1181 无法打开 kernel32.lib`——MSVC 和 SDK 是两个独立包，装了前者不等于装了后者 |
| WebView2 运行时 | 装完能开，但窗口白屏 |
| npm 依赖 | `tauri` 命令本身不存在 |
| 前端产物 | 出包后界面空白（`frontendDist` 指了个空目录） |
| Tauri 配置 | CSP 少了 `'wasm-unsafe-eval'` → 建库失败，且界面误报「数据可能已损坏」 |
| 命令契约 | 前端 `invoke` 了没声明的命令，或声明了却漏注册进 `generate_handler!` → 装好后某条功能运行时才炸 |

**Windows SDK 这一项是补出来的**，起因是一次真实的漏报：机器上 `vswhere` 认得出 Build Tools、
x64 `link.exe` 齐全、doctor 报「MSVC ✓」，但 `cargo check` 直接死在
`LNK1181: 无法打开输入文件 kernel32.lib`。查下去才发现 `Windows Kits\10` 下连 `Lib` 目录都没有，
而 VS 的组件列表里「Windows 11 SDK」明明打着勾——**元数据认为装了，磁盘上没有**。
所以这一项不看 VS 的组件标记，只按文件找 `Lib\<ver>\um\x64\kernel32.lib` 与
`Lib\<ver>\ucrt\x64\ucrt.lib`，两个都得在。也只认 `vswhere` 报出的安装位置，
不写死 `C:\Program Files (x86)\...`——VS 允许装到别的盘（本机就在 `D:\VisualStudio\BuildTools`）。

**命令契约这一项堵的是一个自动化盲区**：`vitest` 里 `invoke` 是 mock，调什么名字都"成功"；`e2e` 用假 Tauri 桥，而桥是按前端的期望写的——前端把命令名拼错，桥照样应答。两边都绿，装出来的程序才会炸。doctor 静态比对三个集合：

```
前端 invoke('x')  ⊆  generate_handler![x]  ⊆  #[tauri::command] fn x
```

中间那一步最容易漏：写了 `#[tauri::command] fn x` 却忘了加进 `generate_handler![]`，**编译完全通过**，调用时才报 `command x not found`。

三项都是**变异验证过的**：

- 把 CSP 里的 `'wasm-unsafe-eval'` 删掉 → doctor 立刻从「还差 2 项」变成「还差 3 项」并点名这条。
- 往 `src/services/` 丢一个 `invoke('storage_load_all')` 的临时文件 → 变红并点名 `storage_load_all（src/services/xxx.ts）`。
- 从 `generate_handler![...]` 里删掉 `startup_failure,` → 变红并同时报出「前端调了未注册的命令」与「声明了但没注册进 generate_handler!」，两边都点名。

Rust 那一项也做过同类验证。它现在按三个地方找 `rustc` / `cargo`：PATH → `~/.cargo/bin` → `~/.rustup/toolchains/<tc>/bin`。
第三个位置是必要的：rustup 在 `~/.cargo/bin` 里放的是**硬链接**，硬链接建不出来时（杀软拦截、文件系统不支持、权限不足）
那里会剩下一堆 **0 字节空壳**，而真身完好地在 toolchains 下面——只看 shim 目录就会得出"没装 Rust"的错误结论。

两种状态都实测过：

| 场景 | 输出 |
| --- | --- |
| PATH 里没有 cargo，但 toolchains 里有 | `✗ rustc 1.99.1 · cargo 1.99.1 · host=x86_64-pc-windows-msvc（已安装，但当前终端的 PATH 里没有）` |
| PATH 就绪 | `✓ rustc 1.99.1 · cargo 1.99.1 · host=x86_64-pc-windows-msvc` |

"已装但不在 PATH" 判成 **fail** 而不是 warn：`cargo test` 用绝对路径还能跑，但 `npm run desktop:build` 不行
（Tauri CLI 直接 spawn `cargo`）。判成 warn 的话 doctor 会说"环境就绪"，然后构建在最后一步报 `cargo not found`——
正是这个脚本存在的意义要防的事。

`npx tauri info` 也能看环境，但它只报版本号，不判断"这个组合能不能出包"。两个都跑不冲突。

### 1.5 先单独验证加密层（强烈建议）

装完工具链**先别急着打包**，用 Rust 单测把存储加密层验一遍——它比整包构建快得多，报错也具体：

```bash
cd src-tauri
cargo test
```

期望 8 条全过：

```
test storage::tests::round_trip_with_same_key ... ok
test storage::tests::wrong_key_name_fails ... ok
test storage::tests::wrong_key_fails ... ok
test storage::tests::nonce_is_random ... ok
test storage::tests::missing_key_with_existing_data_refuses ... ok
test storage::tests::missing_key_with_empty_vault_is_allowed ... ok
test storage::tests::startup_errors_are_classified ... ok
test storage::tests::missing_key_error_keeps_actionable_detail ... ok
```

前 4 条钉住加密本身的安全不变量：**同钥可解、换钥解不开、把 `items` 的密文挪到 `meta` 行解不开、同明文两次加密结果不同**（nonce 随机）。

中间 2 条钉住一条数据安全规则：**`kv` 表里已有密文、而系统凭据管理器里找不到密钥时，必须拒绝启动，不许新建密钥**。新建会解不开旧数据，后续写入还会让新旧密文混进同一张表——永久不可恢复。

后 2 条钉住「失败原因要能指导行动」：`StartupError` 的四个分类必须各自有稳定的 `code` 与非空 `detail`，且「密钥丢失」那句文案不能被泛化成「存储失败」——它是启动失败屏选文案的唯一依据。

如果这里就报编译错，大概率是 `aes-gcm` / `keyring` 的调用签名与当前版本有出入——把报错贴出来即可，改动只在 `src-tauri/src/storage.rs`。

### 1.6 已核对的 crate API 契约

本机没有 Rust 工具链，所以下面这些**逐个对着 docs.rs 的当前版本文档核对过**（不是凭记忆）。目的是把"首次编译报一堆看不懂的 trait bound 错"的概率压下去。若真报错，可以先排除这些：

| 依赖 | 用到的 API | 核对结果 |
| --- | --- | --- |
| `aes-gcm 0.10.3` | `aes_gcm::{Aes256Gcm, KeyInit, Nonce}`、`aead::{Aead, Payload}` | 均在 crate 根导出；`pub use aead;` 存在 |
| `keyring 3.6.3` | `Entry::new(&str, &str) -> Result<Entry, Error>` | 签名一致 |
| `keyring 3.6.3` | `get_password() -> Result<String>`、`set_password(&str) -> Result<()>` | 签名一致 |
| `keyring 3.6.3` | `Error::NoEntry` 变体 | 存在（无凭据时返回） |
| `keyring 3.6.3` | feature `windows-native` | 存在（`= ["dep:windows-sys", "dep:byteorder"]`） |
| `rusqlite 0.32.1` | `Connection::execute_batch(&self, &str) -> Result<()>` | 存在，且明确"不能带参数" |
| `rusqlite 0.32.1` | `OptionalExtension::optional()` | 存在，`Result<T> → Result<Option<T>>` |
| `tauri 2.12` | `Builder::setup` 闭包 | `FnOnce(&mut App<R>) -> Result<(), Box<dyn Error>> + Send + 'static`，与代码一致 |
| `tauri 2.12` | `Manager::{path, manage, get_webview_window}` | 均为 provided methods，签名一致 |
| `tauri-plugin-single-instance 2.5.4` | `init` | `FnMut(&AppHandle<R>, Vec<String>, String) + Send + Sync + 'static`，与代码的三参数闭包一致 |
| `tauri 2.12` | `Builder::run(context) -> tauri::Result<()>` | 返回 `Result`（不是 `!`），所以 `run()` 里能接住"窗口起不来"而不必 panic |
| `user32`（手写 FFI） | `MessageBoxW(HWND, PCWSTR, PCWSTR, u32) -> i32` | 签名与 Win32 头文件一致；`#[link(name = "user32")]` 在 MSVC / GNU 下都由默认 SDK 提供。**刻意不引 `windows-sys`**：只要一个函数，多一个依赖就多一处版本风险 |

另外确认了两件事：

- **tauri 2.12 的 `default` 特性包含 `wry` 与 `common-controls-v6`**。`Cargo.toml` 里写的是 `features = []` 而没有 `default-features = false`，所以这两项仍然生效——webview 能正常起来。若哪天有人加上 `default-features = false`，窗口会直接起不来。
- **`Cargo.toml` 里不写 `rust-version`**。模板给的 `1.77.2` 是旧值（tauri 2.12 依赖 `getrandom 0.3`、`windows 0.62`），写一个偏低的假数字在 MSRV 感知解析下会让 cargo 把 tauri 降级到 2.0.x，而代码是按 2.12 的 API 写的。

> 这些核对能保证"API 名字和形状对得上"，**不能保证语义正确**——比如某个方法的行为在版本间变了。那类问题只能靠 `cargo test` 暴露。

---

## 2. 构建

### 开发态（热更新）

```bash
npm run desktop:dev
```

会先起 Vite（5173），再开一个原生窗口加载它。改前端代码即时生效；改 Rust 代码会自动重编译。

### 出安装包

```bash
npm run desktop:build
```

首次编译要下载并编译全部 Rust 依赖（`rusqlite` 会编译 SQLite C 源码），**5–15 分钟**属正常；之后增量编译几十秒。

产物：

```
src-tauri/target/release/bundle/
├── msi/KeyIsland_0.1.0_x64_en-US.msi          ← 双击安装
└── nsis/KeyIsland_0.1.0_x64-setup.exe         ← 双击安装（推荐）
```

只想出其中一种，改 `src-tauri/tauri.conf.json` 的 `bundle.targets`。

### 2.3 出包前的四种验收模式

装 Rust 之前，先把这四条跑一遍——它们能在**浏览器里模拟桌面版**，覆盖掉大部分"装完才发现"的问题。

```bash
npm run build

npm run e2e:smoke                      # ① 浏览器内存存储（基线，17 条）
npm run e2e:smoke -- --csp             # ② 加真实 CSP（验白屏/wasm）
npm run e2e:smoke -- --desktop --csp   # ③ 桌面存储 + CSP（21 条，最接近真机）
npm run e2e:startup-failure            # ④ ③ + 启动失败屏（25 条）
```

| 模式 | 验什么 | 能抓到 |
| --- | --- | --- |
| 默认 | 业务流程 | 功能回归 |
| `--csp` | 把 `tauri.conf.json` 的 CSP 当响应头 | 白屏、wasm 被拦、样式失效 |
| `--desktop` | 注入假 Tauri 桥，走 `TauriVaultStorage` | 命令名/参数形状错、**刷新后数据丢失** |
| `--startup-failure` | 假桥返回一次 `startup_failure` | **启动失败的原因上不了屏**（§6.7） |
| 叠加 | 上述全部 | 最接近装出来的程序 |

`--desktop` 用 `localStorage` 假装是 SQLite，所以能验「关掉再开，数据还在」；同时会检查「打开链接」是否走了 `open_external` 而不是被 Tauri 拦掉的 `window.open`。

`--startup-failure` 会额外导航一次、把桥换成"启动就失败"的版本，断言标题、具体原因、数据路径都上屏且**不落回设置向导**。这是 §6.7 那类 bug 唯一能自动抓到的检查——`vitest` 全跑在 jsdom 上，`isDesktopShell()` 恒为 false，根本走不到那条分支。

> 它验的是**前端到命令边界**这一段。边界之后的 Rust 实现（SQLite、AES-GCM、凭据管理器、启动失败分类）仍然只有 `cargo test` 才能验。

### 2.4 视觉验收（改了 UI 就必须看）

上面四种模式都只断言"文字/元素在不在"，**完全不涉及长相**。颜色、对比度、元素有没有被挤没，
只有真实渲染才看得见。两条命令补这一块：

```bash
npm run e2e:settings-shots   # 截图：CSV 手动映射 / 预览 / 资产迁移，白天+黑夜各一张
npm run e2e:contrast        # 对比度审计：两种主题下遍历可见文字，低于 3.0 就报
```

产物都在 `app/artifacts/settings/`（`*.png` 与 `contrast-*.json`）。

**这两步已经接进 `npm run release:publish`**（第 7.5 步，在"校验产物"之后、"打 tag"之前）：
视觉不通过就直接中止，不会发布一个没人看过的界面。三条边界：

| 情况 | 行为 |
| --- | --- |
| `--dry-run` | 跳过（预检不跑 90 秒截图），输出里会写明 |
| `--skip-build` | 跳过（复用的 dist 不一定对应当前源码，测了反而误导） |
| 找不到 Chrome / Edge | 只警告不拦，但明确写出"本次没做视觉校验" |
| 视觉脚本自身坏掉 | `--skip-visual` 逃生阀，留痕但放行 |

**为什么阈值定 3.0 而不是 WCAG AA 的 4.5**：`text-fg-faint` 这类提示文字是刻意做淡的，
按 4.5 卡会长期红一片，久了就没人看审计结果。3.0 以下基本是"努力才能看清"，那才是真问题。

**这套检查抓不到什么**（很重要，别把它当保险）：控件"没渲染"、下拉"显示成第一项"、
布局被挤扁——这些是结构与状态问题，靠**断言控件存在 + 初始值**来抓，不是靠看颜色。
本次 0.1.9→0.1.11 连续两个补丁都是这类问题，都是先被截图看出来的，然后才补成断言。

### 2.5 性能基线（卡片多的时候还跟不跟手）

单元测试里有「1000 条 ≤ 50 ms」的断言，但那是**纯函数**。用户真正会卡的环节全在它之外：
1000 个 `ItemCard` 一次性进 DOM、每次筛选整片重建、导入时整表解密。jsdom 没有布局与绘制，
这些一个都量不出来，只能开真浏览器：

```bash
npm run build            # 必须先出 dist，脚本跑的是产物不是 dev server
npm run e2e:perf         # 默认 1000 张
npm run e2e:perf -- --rows=200
```

产物：`app/artifacts/perf/report.json`（每次运行覆盖，要对比就自己留档）。

**2026-10-30 基线**（本机，真实 Chrome，1280×900，无头）：

| 指标 | 200 张 | 1000 张 | 说明 |
| --- | --- | --- | --- |
| DOM 节点总数 | 12,323 | 61,123 | 每张卡约 61 个节点 |
| **按键延迟（中位数）** | **14.7 ms** | **14.9 ms** | **与卡片数无关，这是卡片 memo 生效的证据** |
| 搜索·一次性输入 | 433 ms | 813 ms | 一次筛选 = 一次整片重建 |
| 搜索·逐字符（50ms，落在去抖窗口内） | 823 ms | 1,259 ms | 9 次按键合并成 1 次筛选 |
| 搜索·逐字符（250ms，等于没去抖） | 3,498 ms | 6,983 ms | 9 次筛选，≈ 9 × 单次 |
| 清空搜索回全量 | 600 ms | 2,085 ms | **最贵的一条：从零重建全部卡片** |

同一份脚本在修之前（0.1.17 之前）的 1000 张读数：列表重渲染 1,465 ms、一次性输入 8,324 ms、
逐字符 8,677 ms。差别的来源是两处：`ItemCard` 加了 `memo`，以及 `now` 从
「每次渲染 `Date.now()`」改成每分钟跳一次的状态——后者是关键，`now` 每次渲染都变的话，
memo 会被它一个人废掉（1000 张卡全判 props 变了）。

**怎么读这些数字**（不看这条会得出错误结论）：

- **绝对值不可横向比较**。同一份代码，导入落库曾在 2.5 s / 8.6 s / 4.9 s / 3.2 s 之间跳，
  机器负载的波动比要测的差异还大。只有**同一次运行内的比值**、**不同行数的倍数**可靠。
- **测量必须在页面内做**。Node 侧循环 `evaluate` 会被主线程渲染阻塞排队，测出来的是
  「渲染耗时 × 命令条数」，不是用户感知的延迟。脚本里 `measureKeystrokes` / `measureType`
  都是页面内 `requestAnimationFrame` + `performance.now()`。
- 判断"卡片 memo 还有没有效"，**只看按键延迟是否随行数增长**。它一旦开始跟着行数涨，
  说明有某个 prop 的引用不稳定了（新增 props 时尤其注意：内联箭头函数会让 memo 形同不存在）。

**已知剩余瓶颈**：清空搜索/切换分类要 2.0 s，单次筛选 0.8 s——根因是 6.1 万个 DOM 节点，
memo 只解决了"不该重渲染时别重渲染"，解决不了"真的要把 1000 张画出来"。
再往下要么列表虚拟滚动（只渲染视口内的），要么分页；两者都会影响批量选择、滚动位置恢复
与截图脚本的假设，属于结构级改动，动手前先确认真实数据规模。

---

## 3. 装完之后

| 项 | 位置 |
| --- | --- |
| 程序本体 | 按安装时选择，默认 `%LOCALAPPDATA%\KeyIsland` |
| 数据文件 | `%APPDATA%\com.keyisland.desktop\vault.db` |
| 数据库密钥 | Windows 凭据管理器 → 条目 `KeyIsland / storage-key` |

设置页「数据文件」一栏会显示真实路径，「打开所在文件夹」按钮可直接定位。

---

## 4. 数据是怎么保护的

```
主密码 ──Argon2id──> KEK ──解开──> DEK（仅内存，锁定时擦除）
                                      │
数据库密钥（随机 32 字节，存凭据管理器）│
        └──AES-256-GCM(每值独立 nonce)─┴──> vault.db 里的密文
```

- **`vault.db` 单独拷走解不开**：密钥在凭据管理器里，按当前 Windows 用户绑定。
- **主密码不落盘**，忘了只能靠恢复码；恢复码也丢了就真的没了。
- 换机器要迁移，请用设置页的**导出加密备份**，不要直接拷 `vault.db`。

> 为什么不是 SQLCipher：SQLCipher 在 Windows 上要拖 `openssl-src`（需要 perl + nasm），构建链脆弱。当前实现是"SQLite 存密文 + RustCrypto AES-GCM 加密每个值"，安全性等价，依赖全是纯 Rust。要切回 SQLCipher 只需改 `src-tauri/src/storage.rs` 一个文件。

---

## 5. 常见问题

**`cargo build` 报 linker not found**
MSVC 生成工具没装全，回到 1.2 勾选"使用 C++ 的桌面开发"。

**`npm run desktop:build` 卡在 `beforeBuildCommand`**
它会先跑 `npm run build`（含 `tsc --noEmit`）。先单独跑一次 `npm run build` 看具体报错。

**安装时 Windows 提示"未知发布者" / SmartScreen 拦截**
未做代码签名，属正常现象。点"更多信息 → 仍要运行"。要做正式分发需要买代码签名证书。

**装完打开是白屏 / 卡在第 3 步「创建保险库」**
多半是 CSP 拦了资源。**先别急着把 `csp` 改成 `null`**——用下面这条命令在本地复现，它会用 `tauri.conf.json` 里的真实 CSP 跑一遍完整流程：

```bash
npm run build && npm run e2e:smoke -- --csp
```

已知必踩的一个：**Argon2 走 hash-wasm，需要编译 WebAssembly**，`script-src` 必须含 `'wasm-unsafe-eval'`。缺了它的症状极具误导性——界面弹出「**加解密失败，数据可能已损坏**」，看着像库坏了，实际只是 CSP 少了一条。

> `'wasm-unsafe-eval'` 只放开 wasm 编译，不放开 JS `eval`，是这里的最小必要权限。

**想改窗口标题 / 尺寸 / 安装包语言**
改 `src-tauri/tauri.conf.json`：`app.windows[0]` 与 `bundle.windows.nsis`。

**双击图标第二次没反应，只是把已有窗口拉到前台**
这是**故意的**。已接 `tauri-plugin-single-instance`：两个实例会各自持有一个保险库会话、各自把整块数据写回数据库，后写的覆盖先写的，等于静默丢数据。

**双击图标后一闪而过 / 弹了「密岛启动失败」框**
分两种情况，先看有没有弹框：

- **弹了框**（`MessageBoxW`）：窗口或 WebView 本身没起来，框里写着具体原因。最常见是 WebView2 运行时缺失或被组策略禁掉。
- **没弹框、直接进了「启动失败」整屏**：存储初始化失败。屏幕上会写明是哪一类——密钥丢失、凭据管理器访问不了、数据目录建不出来、数据库打不开——每类都给了三步出路，还有「打开数据文件夹」按钮（**启动失败时它也能用**，因为路径不依赖数据库）。

两类都**不要先删 `vault.db`**。尤其「数据还在，但解开它的密钥不在了」这条：文件是好的，删了就真没了。先点「打开数据文件夹」把 `vault.db` 复制一份留档。

排查顺序：`%APPDATA%\com.keyisland.desktop\vault.db` 在不在 → 「凭据管理器 → Windows 凭据」里有没有 `KeyIsland` 条目 → 是不是用另一个 Windows 用户登录的。

> 这条路径的回归检查：`npm run e2e:startup-failure`（见 2.3）。

---

## 6. 桌面版已知缺口（如实列出）

打包能跑起来 ≠ 桌面版做完。以下是**明确还没做**的，按优先级排：

### 已处理的桌面差异（记录一下，免得以后重复踩）

- **`window.open` 在 Tauri 里被拦截**：默认不允许创建新窗口，点「打开链接」会**没反应且不报错**，而调用方还会以为成功去记一条跳转日志。已改为桌面壳走 Rust 的 `open_external`（系统默认浏览器），并在 Rust 侧做 http/https 白名单 + 控制字符过滤。浏览器版行为不变。
- **端口被占用时 Vite 会静默换端口**：`strictPort: true` 让它响亮失败，否则 Tauri 会一直等 5173。
- **双击图标开两个窗口会静默丢数据**：已接 `tauri-plugin-single-instance`。

### 6.1 剪贴板仍依赖浏览器 API（安全，建议优先）

**(a) 关窗时剪贴板不会被清空。** 复制密码后 30 秒自动清空，靠的是 JS 定时器。**关掉窗口，定时器随进程一起消失，密码就留在剪贴板里了**，直到被下一次复制覆盖。

修法（Rust 侧，约 20 行）：监听 `WindowEvent::CloseRequested`，若当前剪贴板内容是我们写入的（比对序列号或指纹），用 `arboard` / `clipboard-win` 清空后再退出。

**(b) 读剪贴板可能被 WebView2 拒绝。** 「粘贴账号 / 粘贴密码」走 `navigator.clipboard.readText()`，Chromium 系要用户手势 + 权限，WebView2 里可能静默失败（表现为提示"读取剪贴板失败"）。写（复制）通常没问题。

修法：换成 `tauri-plugin-clipboard-manager`，读写都走系统 API，顺带解决 (a)——插件支持在 Rust 侧注册清理回调。

#### 已在 Phase 11.2 修掉的相关漏洞：读被拒时自动清空会静默失效

上面 (b) 里"读取可能被拒"这件事，原先在服务层造成的后果比"粘贴失败"严重得多：

`BrowserClipboardPort.read()` 把异常 catch 掉返回 `null`，而上层把 `null` 解释成"剪贴板里已经没有我们写的内容了"→ **直接跳过清理**。结果是：**只要读剪贴板失败，30 秒自动清空就不会发生，而界面刚刚承诺过「N 秒后自动清空」。** 密码留在系统剪贴板里，用户却以为它已经消失了。

这个洞在浏览器里也存在（标签页失焦时 `readText()` 可能被拒），桌面 WebView2 里更容易触发。

已修，规则改成：**读不到 ≠ 内容不在了**。

| 端口返回 | 含义 | 处置 | 结果标记 |
| --- | --- | --- | --- |
| 文本 | 读到了，内容还在 | 比对摘要，仍属于我们才清 | `cleared` / `overwritten` |
| `null` | 读到了，剪贴板是空的 | 无需清理 | `missing` |
| 抛错 | 根本读不到 | **强制清空**（安全优先） | `cleared-unverified` |

判据是代价不对称：留下的密码是**不可恢复的泄露**，误清用户内容只是**重复制一次**。锁定路径同理（用户刚按下"上锁"，预期就是"外面不要再留着我的密码"）。

这也意味着**自动清空这一条不再需要 Rust 插件**——`clear()` 走的是 `writeText('')`，通常比 `readText()` 权限宽松。仍然需要插件的只有 (b) 的"粘贴"读取路径。

### 6.2 系统锁屏仍是 `visibilitychange` 近似

Web 层拿不到 OS 的锁屏 / 休眠事件。桌面版可以：订阅 `WM_WTSSESSION_CHANGE`（`WTSRegisterSessionNotification`）拿真实的 `WTS_SESSION_LOCK`，或监听 `WM_POWERBROADCAST` 拿休眠。拿到后调用现有命令即可，会话状态机不用改。

### 6.3 防截屏 / 窗口内容保护

`SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` 可让窗口在截屏与录屏里显示为黑块。Windows 10 2004+ 支持。需要拿到窗口 HWND（`window.hwnd()`）。

### 6.4 Windows Hello 解锁

用 `Windows.Security.Credentials.UI.UserConsentVerifier` 做生物识别，验证通过后用它保护的密钥解 DEK。属于「便利性提升」，不替代主密码。

### 6.5 全局热键唤出

`tauri-plugin-global-shortcut` 可注册系统级热键（Web 层做不到，浏览器里只能应用内快捷键）。配合 `WS_EX_NOACTIVATE` 才能做到「唤出不抢焦点」。

### 6.6 安装包没有代码签名

用户会看到「未知发布者」和 SmartScreen 拦截。正式分发需要买代码签名证书（OV/EV），再配 `bundle.windows.certificateThumbprint`。

### 6.7 启动失败在发布版里是静默的 —— 已在 Phase 11.9 修复

**原始问题**：`main.rs` 里有 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`，发布版没有控制台。而 `lib.rs` 的 `setup` 里 `Store::open` 失败会返回 Err，最终落到 `.expect("密岛启动失败")`——**panic 在没有控制台的进程里，表现就是「双击图标，一闪而过，什么也没发生」**。Phase 11.7 新增的「密钥丢失拒绝启动」正好走这条路径：它保护了数据不被覆盖，但用户看不到任何原因，只会以为程序坏了，然后可能去删 `vault.db` 重装。

**修法**：`setup` 永不返回 Err，四层兜底。

| 层 | 做什么 | 覆盖什么 |
|---|---|---|
| 1 | `setup` 成功/失败都返回 `Ok`，把 `Result<Store, StartupError>` 挂进 `AppState` | 所有存储类失败（99% 的真实情况） |
| 2 | 新增 `startup_failure` 命令，返回 `{ code, detail, dbPath }` | 让前端知道**为什么**失败，而不是只知道失败了 |
| 3 | `App.tsx` 首屏探测，失败则整屏渲染 `StartupFailureScreen` | 用户看得到原因 + 三步出路 + 「打开数据文件夹」 |
| 4 | `run()` 返回 Err 时弹原生 `MessageBoxW`；另装 panic hook | 窗口/WebView 本身起不来——那时前端没有任何机会说话 |

`StartupError` 分成四类，因为它们的出路完全不同：

| code | 含义 | 给用户的出路 |
|---|---|---|
| `missing_key` | 库里已有密文，凭据管理器里没有密钥 | 换回原 Windows 用户 / 导备份 / 留档后重建 |
| `credential` | 凭据管理器访问不了 | 确认用户身份、看「凭据管理器」条目、重启 |
| `data_dir` | 数据目录建不出来 | 查磁盘空间、加安全软件白名单 |
| `database` | `vault.db` 打不开 | 关掉重复进程、暂停同步盘、复制留档 |

**为什么不用一个 `String` 混过去**：压成一句「本地存储读写失败，请重试」时，用户除了重试无事可做——而「密钥丢了」重试一万次也不会好。分类的唯一目的就是让文案能给出可执行的动作。

`MessageBoxW` 是**手写 FFI**（`#[link(name = "user32")]`）而不是引入 `windows-sys`：只需要一个函数，多一个依赖就多一处版本风险，而 `MessageBoxW` 的签名二十年没变。同理，`storage_reveal` 现在不依赖 `Store`（启动失败时也要能打开文件夹），并且会先 `create_dir_all` 父目录——目录不存在时 `explorer /select` 会落到「文档」，用户以为点错了按钮。

**验证到什么程度**：

- 前端这一半是**可执行验证**的：`npm run e2e:smoke -- --startup-failure` 在生产包上用假 Tauri 桥返回一次 `startup_failure`，断言标题、具体原因、数据路径都上屏且不落回设置向导（25/25 通过）。
- Rust 那一半仍然**只有装完工具链才能验**：本机没有 `rustc`，`cargo test` / `cargo build` 都跑不了。`StartupError` 的分类映射与 `missing_key_policy` 的文案有单测（`storage.rs` 里 8 条），但没被执行过。

---

## 7. 目录结构

```
app/
├── src-tauri/
│   ├── Cargo.toml          Rust 依赖
│   ├── tauri.conf.json     窗口、CSP、安装包配置
│   ├── capabilities/       权限（当前只开 core:default）
│   ├── icons/              各尺寸图标（由 assets/app-icon.png 生成）
│   └── src/
│       ├── main.rs         入口（发布版隐藏控制台）
│       ├── lib.rs          storage_* / startup_failure 命令 + 启动
│       └── storage.rs      SQLite + AES-GCM + 凭据管理器 + StartupError
├── assets/app-icon.png     图标源图（1024×1024，由 assets/icon-src/app-icon.svg 渲染）
├── assets/icon-src/app-icon.svg   图标的 SVG 源（改设计改这个）
└── src/
    ├── services/tauri-storage.ts          前端存储适配器 + 启动失败探测
    └── features/startup/StartupFailureScreen.tsx   启动失败整屏
```

改图标：改 `assets/icon-src/app-icon.svg` → 渲染成 1024 PNG 覆盖 `assets/app-icon.png`
→ 跑 `npx tauri icon assets/app-icon.png -o src-tauri/icons`。
（`installerIcon` 指向 `icons/icon.ico`，重新生成后安装器图标会跟着变，不用另外改配置。）

### 7.1 图标设计（2026-10-27 定稿）

**「热气球载着岛」** —— 取代了原先的 Tauri 默认图标。

原图标是 Tauri 框架自带的（青绿渐变圆角方块 + 白色钥匙孔）。它的问题不是难看，
而是**语义为零**：圆角方块 + 单色符号正是浏览器插件图标的通用语汇，
用户看到它只会觉得「这是个插件」，完全看不出这是一个密码库。

新图标讲的是产品的故事：
- **热气球**（黄 / 玫瑰红条纹）—— 轻盈、有辨识度、颜色跳
- **吊篮里的保险箱**（带发光的钥匙孔）—— 一眼说明「这是存密码的」
- **远处亮着灯的小岛**（青绿 + 暖黄窗）—— 「密岛」，也呼应产品名 KeyIsland

配色全部取自 App 自身的品牌语言，不是另起一套：
| 用途 | 色值 | 出处 |
| --- | --- | --- |
| 夜空背景 | `#1e3a8a` → `#16203a` → `#0b0b0d` | 灵动岛面板渐变（`Island.tsx`） |
| 暖黄灯光 / 锁芯 | `#fde68a` / `#fbbf24` | 锁定态 `amber-300` |
| 海面 / 岛 | `#0e7490` / `#5eead4` | 青绿点缀（`teal-300`） |
| 圆角底板 | `rx=224`（22%） | 对齐 Windows 11 图标观感 |

**SVG → PNG 的渲染链路**（`.iconwork/`）：
```
SVG 源图  ──Chrome headless──►  1024×1024 PNG  ──tauri icon──►  全套尺寸
```
- 用 Chrome 而不是 PIL：SVG 的渐变 / 路径 / 滤镜需要真正的渲染引擎，Chrome headless 就是现成的那个。
- **Chrome 只认原生 Windows 路径**，Git Bash 的 `/tmp` 不能直接用，会报 `net::ERR_FILE_NOT_FOUND`。
- 透明背景必须显式加 `--default-background-color=00000000`。
- 改完图标**必须在 16 / 32 / 48 px 各看一遍**：热气球方案第一版的棕榈树在 32px 下糊成了螺旋桨，
  换成「小屋 + 暖灯窗」才干净。**只在 1024px 下看是不够的**。
- PIL 默认字体不含中日韩字形，画中文会得到方块 —— 要显式 `ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc")`。

**★ 安装包自己的 EXE 图标是单独的字段，不跟着 `bundle.icon` 走。**

`bundle.windows.nsis` 里有两个独立配置项：

```json
"nsis": {
  "installMode": "currentUser",
  "languages": ["SimpChinese", "English"],
  "displayLanguageSelector": false,
  "installerIcon": "icons/icon.ico",
  "uninstallerIcon": "icons/icon.ico"
}
```

Tauri 的 NSIS 模板里是这么写的：

```nsis
; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
!endif
```

**`bundle.icon` 配得再对，`installerIcon` 留空时安装器自己的 EXE 图标也不会回退** ——
NSIS 会用它自己的默认图标。后果是：程序本体已经是新图标，但**用户双击安装包时看到的还是旧的**，
而且"旧的那个"恰好就是用户最嫌弃的那个（第一版出包实测，解出来正是 Tauri 徽记 + 橙色下载箭头）。
`uninstallerIcon` 同理，控制「控制面板 → 程序和功能」里那条卸载项的图标。

**怎么验证图标真的嵌进去了**（别只看文件大不大）：

1. 用 `npx tauri icon` 从 1024 PNG 重新生成全套；
2. **解析 PE 资源表**，把 `RT_ICON` 原始字节解码成 PNG 肉眼核对。

第 2 步的工具在 `.iconwork/decode_res_icons.py`（`extract_ico.py` 负责解析 PE）。
两个容易踩的点：

- **`GRPICONDIRENTRY` 的宽度在偏移 0**（`bWidth`），不是 2。读错的话所有档位都会显示成 256x256。
- **NSIS 安装器是 PE32（32 位）**，不是 PE32+。数据目录偏移 PE32 是 `opt + 96`、PE32+ 是 `opt + 112`，
  断言写死 64 位会直接报 `AssertionError`。安装器体积小不代表它就是 64 位。

PIL 重新编码过的 PNG 字节**不能**当指纹去比对（压缩参数不同），必须解码原始资源。

**DIB 图标的 AND 掩码也是自底向上存的。** 掩码行序写错**不会报错**，
只会让透明区域画反 —— 肉眼极难发现，回���时更不会有人注意到。
`decode_res_icons.py` 里 XOR 位图与掩码都用 `real_h - 1 - y` 取行。
`.iconwork/test_bpp4.py` 对 4 / 8 / 24 bpp 三个分支做「颜色 + 行序 + 掩码透明」三重断言：

```bash
python .iconwork/test_bpp4.py     # 期望：全部通过 ✓
```



**改完 CSP 一定要跑 `npm run e2e:smoke -- --csp`**：这条命令把 CSP 当响应头加到生产包上，跑同一套 17 条断言。CSP 写错在浏览器里毫无症状，只有它会红。
