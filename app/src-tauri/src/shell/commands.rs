//! 桌面壳暴露给前端的 6 条命令。
//!
//! 命名与既有 `storage_*` / `startup_failure` / `open_external` 同一约定：前缀即归属。
//!
//! **参数里没有任何密钥、明文或资产**（安全不变式 S2）：只有 `expanded: bool`
//! 与一个会话状态枚举字符串。Rust 侧因此不需要（也不可能）持有 DEK / 主密码。

use serde::Serialize;
use tauri::{AppHandle, State};

use super::{AppMode, SessionMirror, ShellState};

/// `shell_mode` 的返回：前端据此初始化 `appMode`（真值仍以事件为准）。
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellModeDto {
    mode: AppMode,
    island_expanded: bool,
    session: SessionMirror,
}

/// 读当前形态。前端启动时读一次，之后靠 `shell://mode` 事件增量更新。
#[tauri::command]
pub fn shell_mode(state: State<'_, ShellState>) -> ShellModeDto {
    ShellModeDto {
        mode: state.mode(),
        island_expanded: state.island_expanded(),
        session: state.session(),
    }
}

/// 打开主面板（还原全形态 + 聚焦）。
///
/// 前端在"全形态"下调它也是安全的（幂等），因此调用点不必先判断形态。
#[tauri::command]
pub fn shell_show_main(app: AppHandle) -> Result<(), String> {
    super::show_main(&app)
}

/// 收进岛形态（工具栏"收进岛"、以及将来可能的快捷键）。
#[tauri::command]
pub fn shell_enter_island(app: AppHandle) -> Result<(), String> {
    super::enter_island(&app)
}

/// 上报岛面展开状态，由 Rust 落地窗口尺寸。
#[tauri::command]
pub fn shell_set_island_expanded(app: AppHandle, expanded: bool) -> Result<(), String> {
    super::apply_expanded(&app, expanded)
}

/// 上报会话状态（`uninitialized` / `locked` / `unlocked`）。
///
/// 非法值返回 Err 而不是 panic：这条命令由前端在每次会话变化时调用，
/// 一个拼错的状态字符串不该让整个进程崩掉。
#[tauri::command]
pub fn shell_set_session(app: AppHandle, status: String) -> Result<(), String> {
    let mirror =
        SessionMirror::parse(&status).ok_or_else(|| format!("未知的会话状态：{status}"))?;
    super::sync_session(&app, mirror);
    Ok(())
}

/// 真正退出进程。
///
/// 只在前端 `dispose()`（清剪贴板 + 计时器 + 会话）之后调用；
/// 托盘「退出密岛」走 `shell://quit-requested` → 前端收尾 → 这里，
/// 前端没回应时由 Rust 的 1500ms 看门狗兜底。
#[tauri::command]
pub fn shell_quit(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

/// 读开机自启状态（HKCU Run 值是否存在）。
#[tauri::command]
pub fn shell_get_autostart() -> Result<bool, String> {
    super::autostart::is_enabled()
}

/// 开 / 关开机自启，返回落地后的状态。
///
/// 返回 `bool` 而不是 `()`：前端据此更新菜单勾选，不靠自己猜。
#[tauri::command]
pub fn shell_set_autostart(enabled: bool) -> Result<bool, String> {
    super::autostart::set_enabled(enabled)
}
