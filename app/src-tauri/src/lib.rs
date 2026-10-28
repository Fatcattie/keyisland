//! Tauri 后端入口。
//!
//! 只做三件事：初始化存储、暴露 `storage_*` 命令、启动窗口。
//! 业务逻辑全部在前端 TS（`VaultClient`），这一层刻意保持薄——
//! Rust 侧多写一行，就多一处要和 TS 参考实现对齐的地方。
//!
//! ## 启动失败的处理原则：进程不许静默死掉
//!
//! 发布版是 `windows_subsystem = "windows"`，**没有控制台**。原来 `setup` 里
//! `Store::open` 失败会返回 Err，一路走到 `.expect("密岛启动失败")` 变成 panic——
//! 而在无控制台进程里，panic 的表现就是「双击图标，一闪而过，什么也没发生」。
//!
//! 尤其致命的是 Phase 11.7 的「密钥丢失拒绝启动」：它保护了数据不被覆盖，
//! 但用户看不到任何原因，只会以为程序坏了，然后可能去删 `vault.db` 重装。
//!
//! 所以现在的分工是：
//! 1. `setup` **永远返回 Ok**，失败原因挂到 [`AppState`] 上，窗口照常打开；
//! 2. 前端用 `startup_failure` 命令读原因，渲染一屏「无法启动 + 具体原因 + 出路」；
//! 3. `storage_*` 命令在失败时把同一句原因作为错误返回（防线，不该被走到）；
//! 4. 只有窗口/WebView 本身起不来时，才用原生 `MessageBoxW` 兜底。

mod shell;
mod storage;

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{Manager, State, WindowEvent};

use storage::{StartupError, Store};
// 逐条 import 而不是在 `generate_handler!` 里写全路径：`npm run desktop:doctor`
// 会静态比对「前端 invoke 的名字 ⊆ generate_handler! 里的名字 ⊆ 命令声明」，
// 而它按逗号切分后只认裸标识符。写全路径会让这条静态检查误报成"前端调了未注册的命令"。
// （注意：本段刻意不写出命令属性宏的字面量，doctor 的正则会把注释里的它当成真声明。）
use shell::commands::{
    shell_enter_island, shell_get_autostart, shell_mode, shell_quit, shell_set_autostart,
    shell_set_island_expanded, shell_set_session, shell_show_main,
};

/// 与前端 `VaultStorage` 端口一一对应：键名固定四个。
/// 前端传什么键都只落在这四行里，不接受任意键——避免把数据库当通用 KV 用。
const ALLOWED_KEYS: [&str; 4] = ["keyslots", "items", "meta", "recency"];

fn ensure_allowed(key: &str) -> Result<(), String> {
    if ALLOWED_KEYS.contains(&key) {
        Ok(())
    } else {
        Err(format!("未知的存储键：{key}"))
    }
}

/// 应用状态：要么是可用的 [`Store`]，要么是一条能读懂、能行动的启动失败原因。
///
/// 用 `Result` 而不是 `Option<Store>`：失败原因必须一路带到命令层。
/// 否则前端只能看到 `STORAGE_FAILED`，而它对用户意味着「重试」——
/// 密钥丢了这件事重试一万次也不会好。
pub struct AppState {
    inner: Result<Store, StartupError>,
    /// 数据文件路径。即使 `Store::open` 失败也尽量给出——
    /// 「打开数据文件夹」是用户在启动失败时唯一能自救的操作。
    db_path: Option<PathBuf>,
}

impl AppState {
    /// 取存储；启动失败时把具体原因当作命令错误返回。
    fn store(&self) -> Result<&Store, String> {
        self.inner
            .as_ref()
            .map_err(|error| error.detail().to_string())
    }
}

#[tauri::command]
fn storage_load(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    ensure_allowed(&key)?;
    state.store()?.get(&key)
}

#[tauri::command]
fn storage_save(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    ensure_allowed(&key)?;
    state.store()?.set(&key, &value)
}

#[tauri::command]
fn storage_clear(state: State<'_, AppState>) -> Result<(), String> {
    state.store()?.clear()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageLocationDto {
    kind: &'static str,
    display_path: Option<String>,
    can_reveal: bool,
}

#[tauri::command]
fn storage_describe(state: State<'_, AppState>) -> Result<StorageLocationDto, String> {
    // 刻意不经过 `Store`：启动失败时"数据到底在哪"比平时更需要知道。
    // 这条命令因此不会失败，设置页也就不会因为启动问题连路径都显示不出来。
    Ok(StorageLocationDto {
        kind: "file",
        display_path: state
            .db_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        can_reveal: state.db_path.is_some(),
    })
}

/// 在资源管理器里定位数据文件（设置页「打开所在文件夹」）。
#[tauri::command]
fn storage_reveal(state: State<'_, AppState>) -> Result<(), String> {
    let path = state.db_path.clone().ok_or_else(|| {
        "无法确定数据目录（定位应用数据目录就失败了），请手动查看 %APPDATA%".to_string()
    })?;
    reveal_in_file_manager(&path)
}

/// 启动失败的原因，供前端首屏使用；正常启动返回 `null`。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupFailureDto {
    /// 与 [`StartupError::code`] 一一对应，前端据此选文案。
    code: &'static str,
    /// 具体原因，直接展示给用户。
    detail: String,
    /// 数据文件路径，可能为 null（连数据目录都定位不到时）。
    db_path: Option<String>,
}

#[tauri::command]
fn startup_failure(state: State<'_, AppState>) -> Option<StartupFailureDto> {
    state.inner.as_ref().err().map(|error| StartupFailureDto {
        code: error.code(),
        detail: error.detail().to_string(),
        db_path: state
            .db_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
    })
}

/// 在文件管理器里打开数据文件所在目录。
///
/// 两个细节都是从「点了没反应」换来的：
/// 1. 目录不存在时先建出来——启动就失败在"建目录"这一步时，目录压根没有，
///    不补建的话无论 `/select` 还是直接打开都会静默失败；
/// 2. 文件不存在时不要 `/select`——`explorer /select,<不存在的文件>` 会落到
///    「文档」目录，用户以为自己点错了按钮。
fn reveal_in_file_manager(db_path: &Path) -> Result<(), String> {
    let dir = db_path.parent().unwrap_or(db_path);
    std::fs::create_dir_all(dir).map_err(|error| format!("创建数据目录失败：{error}"))?;
    reveal_path(db_path, dir, db_path.exists())
}

#[cfg(windows)]
fn reveal_path(db_path: &Path, dir: &Path, exists: bool) -> Result<(), String> {
    let mut command = std::process::Command::new("explorer");
    if exists {
        command.arg("/select,").arg(db_path);
    } else {
        command.arg(dir);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开文件夹失败：{error}"))
}

#[cfg(target_os = "macos")]
fn reveal_path(db_path: &Path, dir: &Path, exists: bool) -> Result<(), String> {
    let mut command = std::process::Command::new("open");
    if exists {
        command.arg("-R").arg(db_path);
    } else {
        command.arg(dir);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开文件夹失败：{error}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal_path(_db_path: &Path, dir: &Path, _exists: bool) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开文件夹失败：{error}"))
}

/// 用系统默认浏览器打开链接。
///
/// 为什么不让前端用 `window.open`：Tauri 会拦截它（默认不允许创建新窗口），
/// 结果是"点了没反应，而且不报错"。这里走系统 shell，行为等同双击链接。
///
/// 只接受 http/https + 拒绝控制字符：`explorer.exe` 不经过 shell 解析参数，
/// 但协议白名单仍是必要的一道闸——不能让前端传什么就执行什么。
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    let lowered = trimmed.to_ascii_lowercase();
    if !(lowered.starts_with("http://") || lowered.starts_with("https://")) {
        return Err("只允许打开 http / https 链接".to_string());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("链接包含非法字符".to_string());
    }
    open_with_system(trimmed)
}

#[cfg(windows)]
fn open_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开链接失败：{error}"))
}

#[cfg(target_os = "macos")]
fn open_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开链接失败：{error}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开链接失败：{error}"))
}

/// 原生错误对话框。**只在窗口都起不来时用**——那是前端唯一没有机会说话的时刻。
///
/// 手写 FFI 而不是引入 `windows-sys`：这里只需要一个函数，而多一个依赖就多一处
/// 版本兼容风险（这个仓库当前没有 Rust 工具链，加依赖无法当场验证能否编译）。
/// `MessageBoxW` 的签名在 Win32 里二十年没变过，手写反而更稳。
#[cfg(windows)]
mod fatal {
    use std::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: *mut c_void, text: *const u16, caption: *const u16, flags: u32) -> i32;
    }

    const MB_OK: u32 = 0x0000_0000;
    const MB_ICONERROR: u32 = 0x0000_0010;
    const MB_SETFOREGROUND: u32 = 0x0001_0000;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn show(caption: &str, message: &str) {
        let caption = wide(caption);
        let message = wide(message);
        // SAFETY: 两个缓冲区都以 NUL 结尾，且在调用期间一直存活；
        // 传空 HWND 表示无父窗口，不依赖任何其它应用状态（此时也确实没有窗口）。
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                message.as_ptr(),
                caption.as_ptr(),
                MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
            );
        }
    }
}

#[cfg(not(windows))]
mod fatal {
    pub fn show(caption: &str, message: &str) {
        eprintln!("{caption}：{message}");
    }
}

/// 发布版里任何 panic 都会变成「一闪而过」。装个 hook，至少把原因弹出来。
///
/// 这是最后一道兜底，不是主要错误通道：启动失败的正常路径走 `AppState` → UI。
/// 调试版有控制台、且开发时弹框只会打断人，所以直接跳过。
fn install_panic_dialog() {
    if cfg!(debug_assertions) {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        previous(info);
        fatal::show(
            "密岛发生内部错误",
            &format!("{info}\n\n如果反复出现，请先到数据文件夹备份 vault.db，再重新安装。"),
        );
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_dialog();

    let result = tauri::Builder::default()
        // 单实例必须在最前面注册：第二次启动时它负责把已有窗口拉到前台然后退出，
        // 不会走到 setup（也就不会再开一个数据库连接）。
        //
        // 岛形态常驻后，这里必须走 `reveal_main` 而不是"unminimize + focus"：
        // 窗口可能正处于「320×44 无边框置顶」的岛形态，只 focus 会让用户看到
        // 一条小窄条。`reveal_main` 会先还原全形态（尺寸/装饰/任务栏/min_size），
        // 再聚焦——同时保证不会冒出第二个岛、第二个托盘图标（CHG-08）。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            shell::reveal_main(app);
        }))
        .setup(|app| {
            // **这里永远返回 Ok**。失败也要把窗口开起来，让前端有地方说明原因。
            // 一旦返回 Err，`run()` 会 panic，而无控制台的发布版里 panic 等于静默退出。
            let (db_path, inner) = match app.path().app_data_dir() {
                Ok(dir) => {
                    let path = dir.join("vault.db");
                    let inner = Store::open(path.clone());
                    (Some(path), inner)
                }
                Err(error) => (
                    None,
                    Err(StartupError::DataDir(format!("定位数据目录失败：{error}"))),
                ),
            };
            app.manage(AppState { inner, db_path });

            // 窗口形态状态机。必须先于托盘注册：托盘菜单事件会读它判断"能不能锁"。
            // 初始 session 是 Uninitialized —— 与真实情况一致（建库与否由前端上报）。
            app.manage(shell::ShellState::new());

            // 系统托盘。失败只记日志、不阻断启动：没有托盘只是少了「退出密岛」入口，
            // 主面板与岛仍然可用，比"因为建不出托盘就起不来"好得多。
            let handle = app.handle().clone();
            match shell::tray::build(&handle) {
                Ok(controller) => {
                    app.manage(controller);
                }
                Err(error) => eprintln!("[shell] 创建系统托盘失败：{error}"),
            }
            Ok(())
        })
        // 关闭 / 最小化的拦截点。全部在 Rust 内同步裁决，前端不参与决策
        // （`prevent_close` 已生效而前端卡住时，用户会看到"点 × 毫无反应"）。
        .on_window_event(|window, event| {
            if window.label() != shell::MAIN_WINDOW {
                return;
            }
            let app = window.app_handle();
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    // 关窗口 ≠ 退出：已建库时变形为岛形态（**不** hide，见 shell 模块注释），
                    // 未建库时才真的收进托盘。
                    api.prevent_close();
                    shell::on_close_requested(app);
                }
                WindowEvent::Resized(_) => {
                    // 「最小化 —」也进岛形态（主理人决策：关闭与最小化等价），
                    // 否则最小化后岛不可见，"常驻"就不成立。
                    if window.is_minimized().unwrap_or(false) {
                        shell::on_minimized(app);
                    }
                }
                WindowEvent::ScaleFactorChanged { .. } => {
                    // 100% ↔ 150% 缩放变化后岛可能一半在屏幕外（CHG-10）。
                    shell::on_scale_changed(app);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            storage_load,
            storage_save,
            storage_clear,
            storage_describe,
            storage_reveal,
            startup_failure,
            open_external,
            shell_mode,
            shell_show_main,
            shell_enter_island,
            shell_set_island_expanded,
            shell_set_session,
            shell_quit,
            shell_get_autostart,
            shell_set_autostart
        ])
        .run(tauri::generate_context!());

    if let Err(error) = result {
        // 走到这里说明窗口 / WebView 本身没起来，前端没有任何机会显示错误。
        fatal::show("密岛启动失败", &format!("无法创建应用窗口：{error}"));
    }
}
