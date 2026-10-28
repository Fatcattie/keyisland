//! 窗口几何的持久化：`%APPDATA%/com.keyisland.desktop/shell.json`。
//!
//! **只存几何与一个"首次关闭提示已看过"的布尔值**，绝不存任何密钥、资产、
//! 会话信息（安全不变式 S1）。这也是不引入 `tauri-plugin-window-state` 的原因：
//! 我们只需要四个数字加一个布尔，而任何"自动持久化窗口状态"的插件都会顺带
//! 把窗口标题、URL 之类的东西一起写盘，那是多出来的攻击面。
//!
//! 读写全程**失败即静默**：几何是体验优化，读不到就用默认值；
//! 让它成为启动失败的新来源是本末倒置。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 落盘内容。字段全部 `Option` / 有默认值：旧版本文件少字段也能读。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ShellStateFile {
    /// 岛形态的窗口位置（逻辑像素）。
    #[serde(default)]
    pub island_pos: Option<(f64, f64)>,
    /// 用户拖大过的全形态尺寸（逻辑像素）。
    #[serde(default)]
    pub full_size: Option<(f64, f64)>,
    /// 首次"关闭到托盘"的轻提示是否已经展示过（CHG-11）。
    #[serde(default)]
    pub close_hint_seen: bool,
}

/// 状态文件路径。定位不到应用数据目录时返回 `None`（调用方静默跳过）。
fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("shell.json"))
}

/// 读状态文件。文件不存在 / 内容损坏 / 目录定位失败一律返回默认值。
pub fn load(app: &AppHandle) -> ShellStateFile {
    let Some(file) = path(app) else {
        return ShellStateFile::default();
    };
    let Ok(raw) = std::fs::read_to_string(&file) else {
        return ShellStateFile::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// 写状态文件（覆盖）。失败只打日志，不冒泡——几何写不进去不该阻断任何操作。
pub fn save(app: &AppHandle, state: &ShellStateFile) {
    let Some(file) = path(app) else {
        return;
    };
    if let Some(dir) = file.parent() {
        if let Err(error) = std::fs::create_dir_all(dir) {
            eprintln!("[shell] 创建状态目录失败：{error}");
            return;
        }
    }
    match serde_json::to_string(state) {
        Ok(raw) => {
            if let Err(error) = std::fs::write(&file, raw) {
                eprintln!("[shell] 写入窗口状态失败：{error}");
            }
        }
        Err(error) => eprintln!("[shell] 序列化窗口状态失败：{error}"),
    }
}

/// 记住全形态尺寸（用户可能拖到 1400×900，还原时不该回到 1180×820）。
pub fn save_full_size(app: &AppHandle, size: (f64, f64)) {
    let mut state = load(app);
    state.full_size = Some(size);
    save(app, &state);
}

/// 记住岛的位置（CHG-10：拖到哪、下次还在哪）。
pub fn save_island_pos(app: &AppHandle, pos: (f64, f64)) {
    let mut state = load(app);
    state.island_pos = Some(pos);
    save(app, &state);
}

/// 取出"是否要展示首次关闭提示"，并把标记翻成已看过。
///
/// 放在这里而不是前端：前端为"提示是否已看过"再开一条命令、再存一份状态，
/// 就多了一处会和 Rust 不一致的真相。Rust 在发 `shell://mode` 时顺带告诉
/// 前端"这次要不要提示"，前端只负责弹 toast。
pub fn take_close_hint(app: &AppHandle) -> bool {
    let mut state = load(app);
    let (show, _) = take_close_hint_logic(state.close_hint_seen);
    state.close_hint_seen = true;
    save(app, &state);
    show
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 项⑥：首次关闭提示必须弹一次。没看过 → 弹，并翻成已看过。
    #[test]
    fn close_hint_shows_only_on_first_time() {
        assert_eq!(take_close_hint_logic(false), (true, true));
        // 之后任何一次都不再弹，但标记始终维持"已看过"。
        assert_eq!(take_close_hint_logic(true), (false, true));
        assert_eq!(take_close_hint_logic(true), (false, true));
    }
}

/// 纯函数版本的"首次提示"判定，抽出以便在没有 GUI / AppHandle 的环境下单测。
///
/// - 没看过 → 这次要提示，并标记成已看过；
/// - 看过 → 这次不提示，标记保持已看过。
///
/// 返回 `(should_show, new_seen)`。项⑥「关闭提示只弹一次」的保证完全落在这一行。
pub fn take_close_hint_logic(seen: bool) -> (bool, bool) {
    if seen {
        (false, true)
    } else {
        (true, true)
    }
}
