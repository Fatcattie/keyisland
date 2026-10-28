//! 桌面壳的窗口形态状态机：全形态 ↔ 岛形态 ↔ 仅托盘。
//!
//! ## 一句话方案
//!
//! **只有一个 `main` 窗口**，它在两种形态之间"变形"：关闭主面板 = 缩小 + 去装饰 +
//! 置顶 + 不占任务栏（岛形态），而不是再开第二个窗口。这样 `VaultClient` 实例与
//! 已解锁会话自始至终是同一份内存对象，**零跨窗口密钥传输**（安全不变式 S3）。
//!
//! ## 为什么"收进托盘"不是 `window.hide()`（最容易写错的一处）
//!
//! 前端 `SessionGate` 用 `visibilitychange → hidden` 实现 PRD FR-01「切后台 /
//! 系统锁屏即锁」。WebView2 在窗口被 `hide()` 之后会转成 `hidden` ——如果关闭
//! 主面板实现成 hide，用户**每关一次主面板就立刻被锁库**，"关掉主面板继续用岛"
//! 这个需求当场不成立，而且用户会以为"这软件一关就锁"。
//!
//! 所以岛形态用「缩小 + 去装饰 + `set_skip_taskbar`」表达，窗口始终 `visible`，
//! 不触发 `visibilitychange`。唯一保留 `hide()` 的路径是**未建库**——那时没有
//! 可泄露的资产，PRD 状态矩阵第 6 行也要求"岛不出现、托盘为唯一入口"。
//!
//! ## Rust 侧只做几何与事件
//!
//! 锁定永远由前端 `VaultClient` 执行。托盘的「锁定保险库」是一条 `emit` 请求，
//! 因为 Rust 不持会话、也不能自锁（安全不变式 S4）。同理，`shell_*` 命令的参数
//! 里只有 `expanded: bool` 与一个状态枚举字符串，**没有任何密钥或明文**（S2）。

pub mod autostart;
pub mod commands;
pub mod geometry;
pub mod state_file;
pub mod tray;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};

use geometry::{CloseAction, Size};

/// 唯一窗口的 label（`tauri.conf.json` 里定义）。
pub const MAIN_WINDOW: &str = "main";

/// 形态变更事件。载荷只有形态、展开与否、要不要弹首次提示——无密钥。
pub const EVENT_MODE: &str = "shell://mode";
/// 托盘「锁定保险库」→ 前端执行 `client.lock('manual')`。
pub const EVENT_LOCK_REQUESTED: &str = "shell://lock-requested";
/// 托盘「退出密岛」→ 前端 `dispose()` 后调 `shell_quit`。
pub const EVENT_QUIT_REQUESTED: &str = "shell://quit-requested";

/// 退出看门狗：发出退出请求后等前端收尾的宽限时间。
///
/// 前端 `dispose()` 要清剪贴板与计时器，所以不能直接 `exit`；但 webview 卡死时
/// "点了退出没反应"更糟，因此超时后强制退出。
const QUIT_WATCHDOG_MS: u64 = 1500;

/// 窗口形态。**真值源在 Rust**，前端只是镜像（`ui-store.appMode`）。
///
/// 序列化形式由 `serde` 的 `rename_all = "camelCase"` 决定（`full` / `island` /
/// `hidden`），前端按这三个字符串比对。刻意不再手写一份 `as_str`：两份字符串
/// 迟早会有一份被改漏，而 `serde` 那份才是真的会上线的。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AppMode {
    /// 全形态：1180×820、有装饰、占任务栏。
    Full,
    /// 岛形态：320×44 / 400×460、无装饰、置顶、不占任务栏。
    Island,
    /// 仅托盘（只在未建库时出现）。
    Hidden,
}

/// 会话状态的**镜像**：Rust 只拿它决定托盘项的置灰与文案。
///
/// 刻意只有三档：`cooling_down`（锁定冷却）在前端折叠成 `Locked`，
/// 因为冷却期同样没有可用资产，托盘不该出现第四种状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionMirror {
    /// 还没建库。
    Uninitialized,
    /// 已建库、当前锁定。
    Locked,
    /// 已建库、当前解锁。
    Unlocked,
}

impl SessionMirror {
    /// 把前端传来的状态字符串收窄成枚举；非法值返回 `None`（命令层转成 Err，不 panic）。
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "uninitialized" => Some(SessionMirror::Uninitialized),
            "locked" => Some(SessionMirror::Locked),
            "unlocked" => Some(SessionMirror::Unlocked),
            _ => None,
        }
    }
}

/// 锁中毒时的兜底：把内层数据捞出来继续用。
///
/// 一次 panic 不该让整个窗口壳变成"永远拿不到锁"的砖头——这里存的都是
/// 几个 `Copy` 的枚举与元组，不存在"半更新"的中间态。
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 壳状态。全部字段都是小值，读写不做任何 IO。
pub struct ShellState {
    mode: Mutex<AppMode>,
    session: Mutex<SessionMirror>,
    island_expanded: Mutex<bool>,
    /// 用户拖大过的全形态尺寸；`None` = 用默认 1180×820。
    full_size: Mutex<Option<(f64, f64)>>,
    /// 变形重入保护：最小化回弹路径会再次触发 `Resized`。
    morphing: AtomicBool,
}

impl ShellState {
    pub fn new() -> Self {
        Self {
            mode: Mutex::new(AppMode::Full),
            session: Mutex::new(SessionMirror::Uninitialized),
            island_expanded: Mutex::new(false),
            full_size: Mutex::new(None),
            morphing: AtomicBool::new(false),
        }
    }

    pub fn mode(&self) -> AppMode {
        *lock(&self.mode)
    }

    fn set_mode(&self, mode: AppMode) {
        *lock(&self.mode) = mode;
    }

    pub fn session(&self) -> SessionMirror {
        *lock(&self.session)
    }

    fn set_session(&self, session: SessionMirror) {
        *lock(&self.session) = session;
    }

    pub fn island_expanded(&self) -> bool {
        *lock(&self.island_expanded)
    }

    fn set_island_expanded(&self, expanded: bool) {
        *lock(&self.island_expanded) = expanded;
    }

    fn full_size(&self) -> Option<(f64, f64)> {
        *lock(&self.full_size)
    }

    fn remember_full_size(&self, size: (f64, f64)) {
        *lock(&self.full_size) = Some(size);
    }
}

impl Default for ShellState {
    fn default() -> Self {
        Self::new()
    }
}

/// `shell://mode` 的载荷。
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModeEvent {
    mode: AppMode,
    expanded: bool,
    /// 首次"关闭到托盘"提示（CHG-11）。由 Rust 决定，前端只负责弹。
    show_close_hint: bool,
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

fn emit_mode(app: &AppHandle, show_close_hint: bool) {
    let state = app.state::<ShellState>();
    let payload = ModeEvent {
        mode: state.mode(),
        expanded: state.island_expanded(),
        show_close_hint,
    };
    if let Err(error) = app.emit(EVENT_MODE, payload) {
        eprintln!("[shell] 形态事件发送失败：{error}");
    }
}

/// 屏幕工作区（逻辑像素），形如 `(x, y, w, h)`。
///
/// 用 `work_area()` 而不是 `size()`：后者含任务栏，把岛夹进去会被任务栏遮住一截。
fn work_area(window: &WebviewWindow, fallback_scale: f64) -> (f64, f64, f64, f64) {
    match window.current_monitor() {
        Ok(Some(monitor)) => {
            let area = monitor.work_area();
            // 显示器自己的缩放比窗口的缩放更准（跨屏拖动时两者可能不同）。
            let scale = if monitor.scale_factor() > 0.0 {
                monitor.scale_factor()
            } else {
                fallback_scale
            };
            (
                f64::from(area.position.x) / scale,
                f64::from(area.position.y) / scale,
                f64::from(area.size.width) / scale,
                f64::from(area.size.height) / scale,
            )
        }
        // 拿不到显示器信息时退化成"按默认全形态尺寸的一屏"，宁可夹得太紧也不要跑到屏幕外。
        _ => (0.0, 0.0, geometry::FULL_DEFAULT.w, geometry::FULL_DEFAULT.h),
    }
}

/// 以顶边中心为锚点把窗口放到 `next` 尺寸，并夹进工作区。返回落地后的位置。
fn place(
    window: &WebviewWindow,
    pos: (f64, f64),
    cur: Size,
    next: Size,
    scale: f64,
) -> Result<(f64, f64), String> {
    let (x, y) = geometry::anchored_top_center(pos, cur, next);
    let (x, y) = geometry::clamp_into_work_area((x, y), next, work_area(window, scale));
    window
        .set_size(LogicalSize::new(next.w, next.h))
        .map_err(|error| format!("设置窗口尺寸失败：{error}"))?;
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|error| format!("设置窗口位置失败：{error}"))?;
    Ok((x, y))
}

/// 窗口当前尺寸与位置（逻辑像素）。
fn read_geometry(window: &WebviewWindow) -> Result<(Size, (f64, f64), f64), String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let inner = window
        .inner_size()
        .map_err(|error| format!("读取窗口尺寸失败：{error}"))?;
    let position = window
        .outer_position()
        .map_err(|error| format!("读取窗口位置失败：{error}"))?;
    Ok((
        Size {
            w: f64::from(inner.width) / scale,
            h: f64::from(inner.height) / scale,
        },
        (
            f64::from(position.x) / scale,
            f64::from(position.y) / scale,
        ),
        scale,
    ))
}

/// 关闭请求的统一入口（`CloseRequested` 与工具栏"收进岛"都走这里）。
///
/// 前端**不**参与决策：一旦 `prevent_close` 生效而前端因为卡顿/未挂载没人收尾，
/// 用户看到的就是"点 × 毫无反应"——比没有动画严重得多。变形在 Rust 内同步完成，
/// 前端只做 CSS 淡入淡出。
pub fn on_close_requested(app: &AppHandle) {
    if let Err(error) = enter_island(app) {
        eprintln!("[shell] 关闭请求处理失败：{error}");
        // 兜底：至少别让窗口留在屏幕上装作没关。此时没有会话可泄露（处理失败
        // 说明几何操作出了问题，不代表已解锁），隐藏是安全的一侧。
        if let Some(window) = main_window(app) {
            let _ = window.hide();
        }
    }
}

/// 最小化（`—`）也进岛形态：主理人决策「关闭与最小化等价」。
///
/// 不做这件事的话，最小化后窗口躺在任务栏里、岛不可见，"常驻"就不成立。
pub fn on_minimized(app: &AppHandle) {
    let state = app.state::<ShellState>();
    if state.mode() == AppMode::Island {
        return;
    }
    // 防重入：`unminimize()` 会再触发一次 `Resized`，没有这道闸会自激。
    if state.morphing.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(window) = main_window(app) {
        // 必须先取消最小化：最小化状态下 `set_size` / `set_position` 不落地。
        let _ = window.unminimize();
    }
    if let Err(error) = enter_island(app) {
        eprintln!("[shell] 最小化转岛形态失败：{error}");
    }
    state.morphing.store(false, Ordering::SeqCst);
}

/// 进入岛形态（已建库）或收进托盘（未建库）。
///
/// 幂等：已经在岛形态时直接返回，不重复 emit（避免前端收到一串同值事件）。
pub fn enter_island(app: &AppHandle) -> Result<(), String> {
    let window = main_window(app).ok_or_else(|| "主窗口不存在".to_string())?;
    let state = app.state::<ShellState>();
    if state.mode() == AppMode::Island {
        return Ok(());
    }
    match geometry::decide_close_action(state.session()) {
        CloseAction::HideToTray => {
            window
                .hide()
                .map_err(|error| format!("隐藏主窗口失败：{error}"))?;
            state.set_mode(AppMode::Hidden);
            state.set_island_expanded(false);
            emit_mode(app, false);
            Ok(())
        }
        CloseAction::MorphToIsland => {
            morph_into_island(app, &window, &state)?;
            state.set_mode(AppMode::Island);
            state.set_island_expanded(false);
            emit_mode(app, state_file::take_close_hint(app));
            Ok(())
        }
    }
}

/// 真正的"变形"动作：几何 + 装饰 + 置顶 + 任务栏 + 记住全形态尺寸。
fn morph_into_island(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &ShellState,
) -> Result<(), String> {
    let (current, position, scale) = read_geometry(window)?;
    // 记住用户拖大过的尺寸。小于最小尺寸的读数不可信（最小化刚恢复、DPI 抖动），
    // 退回默认值——还原成 200px 宽的主面板比回到默认尺寸糟糕得多。
    let full = if current.w >= geometry::FULL_MIN.w && current.h >= geometry::FULL_MIN.h {
        current
    } else {
        geometry::FULL_DEFAULT
    };
    state.remember_full_size((full.w, full.h));
    state_file::save_full_size(app, (full.w, full.h));

    // 顺序有讲究：先清 min_size，否则 960×640 的下限会让 320×44 缩不下去。
    window
        .set_min_size(None::<LogicalSize<f64>>)
        .map_err(|error| format!("清除最小尺寸失败：{error}"))?;
    window
        .set_decorations(false)
        .map_err(|error| format!("去掉窗口装饰失败：{error}"))?;
    // 无装饰窗口在 Windows 上留着阴影会出现一条黑边。
    let _ = window.set_shadow(false);
    window
        .set_resizable(false)
        .map_err(|error| format!("锁定窗口缩放失败：{error}"))?;
    window
        .set_always_on_top(true)
        .map_err(|error| format!("设置置顶失败：{error}"))?;
    window
        .set_skip_taskbar(true)
        .map_err(|error| format!("设置不占任务栏失败：{error}"))?;

    let next = geometry::island_size(false);
    // CHG-10：用户拖过的岛位置要"贴回原处"。已记忆过就从记忆取该顶左边作为锚点，
    // 并把 cur 当成岛尺寸（→ `anchored_top_center` 不动），否则从全窗口顶边居中收起。
    // 之前这里只写不读，导致拖动的岛位置从不真正恢复（跨重开/二次进入都回弹到全窗口居中）。
    let saved = state_file::load(app).island_pos;
    let (anchor_pos, anchor_cur) = match saved {
        Some(pos) => (pos, next),
        None => (position, current),
    };
    let (x, y) = place(window, anchor_pos, anchor_cur, next, scale)?;
    state_file::save_island_pos(app, (x, y));
    Ok(())
}

/// 还原全形态并聚焦。托盘左键、托盘菜单、右键岛菜单、二次启动都只调这一个函数，
/// 保证"不会出现第二个岛、第二个托盘图标"（CHG-08）。
pub fn show_main(app: &AppHandle) -> Result<(), String> {
    let window = main_window(app).ok_or_else(|| "主窗口不存在".to_string())?;
    let state = app.state::<ShellState>();
    let (w, h) = state
        .full_size()
        .unwrap_or((geometry::FULL_DEFAULT.w, geometry::FULL_DEFAULT.h));

    // 与进入岛形态相反：先把"大窗口"的属性装回去，再改尺寸。
    window
        .set_resizable(true)
        .map_err(|error| format!("恢复窗口缩放失败：{error}"))?;
    window
        .set_skip_taskbar(false)
        .map_err(|error| format!("恢复任务栏占位失败：{error}"))?;
    window
        .set_always_on_top(false)
        .map_err(|error| format!("取消置顶失败：{error}"))?;
    window
        .set_decorations(true)
        .map_err(|error| format!("恢复窗口装饰失败：{error}"))?;
    let _ = window.set_shadow(true);
    // 必须恢复 min_size，否则窗口能被拖到 200px 宽，主面板布局会塌。
    window
        .set_min_size(Some(LogicalSize::new(geometry::FULL_MIN.w, geometry::FULL_MIN.h)))
        .map_err(|error| format!("恢复最小尺寸失败：{error}"))?;
    window
        .set_size(LogicalSize::new(w, h))
        .map_err(|error| format!("恢复窗口尺寸失败：{error}"))?;

    // 岛形态时窗口贴在屏幕顶部，直接放大可能越界（任务栏在下方时尤其明显）。
    if let Ok(position) = window.outer_position() {
        let scale = window.scale_factor().unwrap_or(1.0);
        let area = work_area(&window, scale);
        let (x, y) = geometry::clamp_into_work_area(
            (f64::from(position.x) / scale, f64::from(position.y) / scale),
            Size { w, h },
            area,
        );
        let _ = window.set_position(LogicalPosition::new(x, y));
    }

    let _ = window.unminimize();
    window
        .show()
        .map_err(|error| format!("显示主窗口失败：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("聚焦主窗口失败：{error}"))?;

    state.set_mode(AppMode::Full);
    state.set_island_expanded(false);
    emit_mode(app, false);
    Ok(())
}

/// 二次启动 / 托盘左键的入口：先还原全形态（**不是**岛形态），再聚焦。
pub fn reveal_main(app: &AppHandle) {
    if let Err(error) = show_main(app) {
        eprintln!("[shell] 打开主面板失败：{error}");
    }
    if let Some(window) = main_window(app) {
        // `show_main` 已含 unminimize/show/focus，这里再兜一次：托盘左键点击时
        // 窗口可能处于"最小化但未变形"的瞬间状态。
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 前端上报"岛面展开了没有"，由 Rust 落地窗口尺寸。
///
/// 前端只上报 `expanded = (phase !== 'collapsed')`：`closing`（收起动画进行中）
/// 仍算展开，否则退出动画会被缩小的窗口裁掉一半。
pub fn apply_expanded(app: &AppHandle, expanded: bool) -> Result<(), String> {
    let state = app.state::<ShellState>();
    if state.mode() != AppMode::Island {
        // 全形态下不缩窗（前端也会跳过，这里是第二道闸）。
        state.set_island_expanded(expanded);
        return Ok(());
    }
    if state.island_expanded() == expanded {
        return Ok(());
    }
    state.set_island_expanded(expanded);

    let window = main_window(app).ok_or_else(|| "主窗口不存在".to_string())?;
    let (current, position, scale) = read_geometry(&window)?;
    let next = geometry::island_size(expanded);
    let (x, y) = place(&window, position, current, next, scale)?;
    state_file::save_island_pos(app, (x, y));
    // 展开时必须把键盘焦点交给窗口：岛是置顶小窗，用户多半是"鼠标移过来"而不是
    // 点过它，窗口没焦点时 Enter / Shift+Enter / Ctrl+Enter 根本到不了 webview
    // （线上反馈"快捷键不能用"的根因）。
    if expanded {
        let _ = window.set_focus();
    }
    Ok(())
}

/// DPI / 分辨率变化后重新夹取（CHG-10）。
///
/// 不改变展开状态，只把窗口拉回工作区：150% 缩放下原本合法的位置可能一半在屏幕外。
pub fn on_scale_changed(app: &AppHandle) {
    let state = app.state::<ShellState>();
    if state.mode() != AppMode::Island {
        return;
    }
    let Some(window) = main_window(app) else {
        return;
    };
    let Ok((current, position, scale)) = read_geometry(&window) else {
        return;
    };
    let next = geometry::island_size(state.island_expanded());
    // 尺寸本身由前端驱动，这里只做"位置夹取"，所以忽略返回值。
    let _ = place(&window, position, current, next, scale);
}

/// 会话镜像同步：前端是唯一写入者，Rust 只镜像并据此更新托盘（CHG-09）。
///
/// 刻意**不做"同值跳过"**：初值 `Uninitialized` 只是"还没上报"的占位，而托盘
/// 建出来时也按未建库渲染。如果同值就跳过，前端挂载后第一次上报 `uninitialized`
/// 会被吞掉——本身没影响，但只要初值与真实状态巧合相同（比如刚建完库就被自动
/// 锁定到 `locked`），跳过就会让托盘一直停在旧文案上。重复写几次菜单文案的代价
/// 可以忽略，去重交给前端按值做（它才知道"上次推的是什么"）。
pub fn sync_session(app: &AppHandle, session: SessionMirror) {
    let state = app.state::<ShellState>();
    state.set_session(session);
    tray::sync_session(app, session);
}

/// 请求锁定：**只是发一条请求**，真正锁定由前端 `VaultClient` 执行。
pub fn request_lock(app: &AppHandle) {
    if let Err(error) = app.emit(EVENT_LOCK_REQUESTED, ()) {
        eprintln!("[shell] 锁定请求发送失败：{error}");
    }
}

/// 请求退出：先让前端 `dispose()`（清剪贴板 + 计时器），1500ms 没等到就强制退。
pub fn request_quit(app: &AppHandle) {
    if let Err(error) = app.emit(EVENT_QUIT_REQUESTED, ()) {
        eprintln!("[shell] 退出请求发送失败：{error}");
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(QUIT_WATCHDOG_MS));
        // 走到这里说明前端没来得及调 `shell_quit`（webview 卡死 / 未挂载）。
        // 继续等下去就是"点了退出没反应"，比剪贴板没清更糟。
        handle.exit(0);
    });
}
