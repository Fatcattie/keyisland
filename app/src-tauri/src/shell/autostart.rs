//! 开机自启（仅 Windows）。
//!
//! 直接读写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，**不**引入
//! `tauri-plugin-autostart`：那个插件做的事就是写同一个注册表值，却要多一个
//! crate + 插件注册。而 `winreg` 本来就在依赖树里（tauri 的传递依赖），
//! 声明为直接依赖零成本。
//!
//! 只写 **HKCU**（当前用户），不碰 HKLM：安装器是 `currentUser` 模式，应用也
//! 没有提权，写 HKLM 要么失败要么弹 UAC——开机自启不该弹权限框。
//!
//! 值的名字固定为 `KeyIsland`，内容是带引号的 exe 绝对路径（路径可能含空格）。

use std::io::ErrorKind;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "KeyIsland";

/// 当前是否已登记开机自启。
///
/// 只判"值是否存在"，不比对路径：应用被移动到新目录后旧值仍算"已启用"，
/// 用户再点一次开关就会用新路径覆盖（幂等）。比对路径反而会让"已勾选"在
/// 用户换了安装目录后突然变成未勾选，看起来像 bug。
#[cfg(windows)]
pub fn is_enabled() -> Result<bool, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = match hkcu.open_subkey(RUN_KEY) {
        Ok(key) => key,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("读取开机自启配置失败：{error}")),
    };
    match key.get_value::<String, _>(VALUE_NAME) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("读取开机自启配置失败：{error}")),
    }
}

/// 打开 / 关闭开机自启。返回落地后的状态。
#[cfg(windows)]
pub fn set_enabled(enabled: bool) -> Result<bool, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(RUN_KEY)
        .map_err(|error| format!("打开开机自启注册表项失败：{error}"))?;

    if enabled {
        let exe = std::env::current_exe().map_err(|error| format!("取程序路径失败：{error}"))?;
        let value = format!("\"{}\"", exe.display());
        key.set_value(VALUE_NAME, &value)
            .map_err(|error| format!("写入开机自启失败：{error}"))?;
    } else {
        match key.delete_value(VALUE_NAME) {
            Ok(()) => {}
            // 本来就没有：关掉一个没开的东西不算失败。
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(format!("关闭开机自启失败：{error}")),
        }
    }
    Ok(enabled)
}

#[cfg(not(windows))]
pub fn is_enabled() -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(windows))]
pub fn set_enabled(_enabled: bool) -> Result<bool, String> {
    Err("开机自启仅支持 Windows".to_string())
}
