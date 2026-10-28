//! 系统托盘（Tauri 2 内置 `tauri::tray`，不引入任何托盘插件）。
//!
//! 托盘是"主面板关掉之后应用还在"的唯一可见凭据，所以它有三个不可退让的点：
//!
//! 1. **图标必须常驻**：`TrayIcon` 是引用计数的，最后一个实例被 drop 时图标就消失。
//!    因此 [`TrayController`] 必须交给 `app.manage(...)` 长期持有——只 `build` 不保存
//!    会得到一个"启动时闪一下就不见了"的托盘。
//! 2. **左键 = 打开主面板**：`show_menu_on_left_click(false)`，否则左键只会弹菜单，
//!    而用户对托盘图标的直觉是"点一下把窗口叫回来"。
//! 3. **Rust 不自锁**：「锁定保险库」只是 `emit` 一条请求，会话在 webview 内存里，
//!    Rust 侧既没有会话也没有密钥（安全不变式 S4）。

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use super::{SessionMirror, request_lock, request_quit, reveal_main};

/// 托盘图标 id。固定字符串，便于排查"是不是建了两个托盘"。
pub const TRAY_ID: &str = "main-tray";

/// 菜单项 id（与设计文档 §7.2 一致）。
pub const ITEM_OPEN: &str = "tray.open-main";
pub const ITEM_LOCK: &str = "tray.lock";
pub const ITEM_QUIT: &str = "tray.quit";

/// 托盘专用图标：32×32 裸 RGBA（4096 字节）。
///
/// 刻意**不用** `app.default_window_icon()`——那是 1024px 的整张插画，而 Windows 托盘
/// 实际只显示 16–32px，缩下去会糊成一团。设计源见 `assets/icon-src/tray-icon.svg`
/// （刻意简化：去掉星星/远岛/海浪/高光，只留暖黄气球 + 深色吊篮 + 锁光）。
const TRAY_ICON_SIZE: u32 = 32;
const TRAY_ICON_RGBA: &[u8] = include_bytes!("../../assets/tray-32.rgba");
/// 编译期保证尺寸自洽：对不上就编译失败，避免运行时 `Image::new` 读越界。
const _: () = assert!(TRAY_ICON_RGBA.len() == (TRAY_ICON_SIZE * TRAY_ICON_SIZE * 4) as usize);

/// 托盘句柄集合。
///
/// 持有 `TrayIcon` 是为了让它活着；持有两个 `MenuItem` 是为了在会话变化时
/// 改文案与置灰（CHG-09）。这些都是引用计数的轻量句柄，克隆代价可忽略。
pub struct TrayController {
    /// 托盘本体。字段本身不被读取，纯粹用于延长生命周期。
    _tray: TrayIcon,
    // `MenuItem` 在这个版本没有默认运行时的泛型参数，必须写全 `MenuItem<Wry>`
    // （应用只跑默认运行时 Wry，不需要为多运行时泛型化）。
    open_item: MenuItem<Wry>,
    lock_item: MenuItem<Wry>,
}

/// 创建托盘。任何一步失败都只返回 Err，由 `setup` 决定"记日志但继续"。
pub fn build(app: &AppHandle) -> tauri::Result<TrayController> {
    let open_item = MenuItem::with_id(app, ITEM_OPEN, "打开主面板", true, None::<&str>)?;
    // 初始按"未建库"渲染：此时没有可锁的会话，置灰才是诚实的。
    let lock_item = MenuItem::with_id(app, ITEM_LOCK, "锁定保险库", false, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, ITEM_QUIT, "退出密岛", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &lock_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("密岛 KeyIsland · 已锁定")
        // 左键留给"打开主面板"，菜单只从右键出。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            if id == ITEM_OPEN {
                reveal_main(app);
            } else if id == ITEM_LOCK {
                // 已锁定时菜单项本身是置灰的，这里再判一次：置灰只挡 UI，
                // 挡不住"菜单还开着时会话刚被自动锁定"这种竞态。
                if app.state::<super::ShellState>().session() == SessionMirror::Unlocked {
                    request_lock(app);
                }
            } else if id == ITEM_QUIT {
                request_quit(app);
            }
        })
        .on_tray_icon_event(|tray, event| {
            // 只认左键；`Click` 在按下与抬起时都会来一次，重复调用 reveal_main
            // 是幂等的（它只是把窗口还原 + 聚焦），所以不额外做去抖。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                reveal_main(tray.app_handle());
            }
        });

    // 用托盘专用的小尺寸图标（CHG-03：与安装包图标同一视觉语言）。裸 RGBA 直接嵌入，
    // 不依赖 `image-png` 特性，也没有运行时解码失败的可能。
    builder = builder.icon(tauri::image::Image::new(
        TRAY_ICON_RGBA,
        TRAY_ICON_SIZE,
        TRAY_ICON_SIZE,
    ));

    let tray = builder.build(app)?;
    Ok(TrayController {
        _tray: tray,
        open_item,
        lock_item,
    })
}

/// 会话状态 → 菜单可用性 / 文案 / tooltip（CHG-03、CHG-09）。
///
/// 全部操作"失败即忽略"：改个菜单文案失败不该让锁定流程中断。
pub fn sync_session(app: &AppHandle, session: SessionMirror) {
    let Some(controller) = app.try_state::<TrayController>() else {
        // 托盘没建起来（极少见）：静默跳过，别让会话同步跟着报错。
        return;
    };

    let open_text = match session {
        // 未建库时首项要能把用户带到建库流程，而不是打开一个空白主面板（CHG-03）。
        SessionMirror::Uninitialized => "开始建库…",
        _ => "打开主面板",
    };
    let tooltip = match session {
        SessionMirror::Uninitialized => "密岛 KeyIsland · 未建库",
        SessionMirror::Locked => "密岛 KeyIsland · 已锁定",
        SessionMirror::Unlocked => "密岛 KeyIsland · 已解锁",
    };

    let _ = controller.open_item.set_text(open_text);
    // 已锁定 / 未建库时置灰而不是隐藏：隐藏会让菜单项位置跳动，置灰更稳（PRD Q4）。
    let _ = controller
        .lock_item
        .set_enabled(matches!(session, SessionMirror::Unlocked));
    let _ = controller._tray.set_tooltip(Some(tooltip));
}
