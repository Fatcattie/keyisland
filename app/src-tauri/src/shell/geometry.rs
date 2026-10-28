//! 窗口几何：**纯函数**，不碰任何窗口对象，因此可以在没有 GUI 的环境里单测。
//!
//! 为什么单独拆一个文件：窗口尺寸的算术（锚点、夹取）是"看起来对、跑起来错"
//! 的重灾区，而它一旦错，用户看到的是"岛跑到屏幕外了"这种没法自证的现象。
//! 把它们抽成纯函数，`cargo test --lib shell::geometry` 就能把结论钉住。
//!
//! 尺寸常量的真值在这里，前端 `src/lib/window-geometry.ts` 有一份**同值镜像**
//! （只用于测试与 `phase → expanded` 判断）。改尺寸必须两侧同改，否则会出现
//! "前端以为展开了、窗口没变"。

use super::SessionMirror;

/// 逻辑像素尺寸（宽 × 高）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Size {
    pub w: f64,
    pub h: f64,
}

/// 岛形态 · 收起（只有一条窄条）。
pub const ISLAND_COLLAPSED: Size = Size { w: 320.0, h: 44.0 };
/// 岛形态 · 展开（完整岛面：搜索 + 最近使用 + 快捷新建）。
pub const ISLAND_EXPANDED: Size = Size { w: 400.0, h: 460.0 };
/// 全形态默认尺寸（与 `tauri.conf.json` 的 main 窗口一致）。
pub const FULL_DEFAULT: Size = Size { w: 1180.0, h: 820.0 };
/// 全形态最小尺寸。**进入岛形态前必须先清掉它**，否则窗口缩不到 320×44。
pub const FULL_MIN: Size = Size { w: 960.0, h: 640.0 };

/// 岛形态尺寸：展开与收起只差一个布尔，避免调用方各写一份 `if`。
pub fn island_size(expanded: bool) -> Size {
    if expanded {
        ISLAND_EXPANDED
    } else {
        ISLAND_COLLAPSED
    }
}

/// 以「顶边中心」为锚点计算新位置。
///
/// 岛是从窗口上边缘往下长出来的，所以缩小/放大时**顶边不动、水平居中不变**，
/// 视觉上才不会"跳一下"。不变式：`x + w / 2` 与 `y` 在变形前后保持一致。
pub fn anchored_top_center(pos: (f64, f64), cur: Size, next: Size) -> (f64, f64) {
    let x = pos.0 + (cur.w - next.w) / 2.0;
    (x, pos.1)
}

/// 把位置夹进工作区（CHG-10：多显示器 / 缩放变化后岛不能跑到屏幕外）。
///
/// `area` 是 `(x, y, w, h)` 的工作区矩形。窗口比工作区还大时无法完全容纳，
/// 此时贴住左上角（而不是把窗口推到负坐标去），否则用户会连标题都点不到。
pub fn clamp_into_work_area(pos: (f64, f64), size: Size, area: (f64, f64, f64, f64)) -> (f64, f64) {
    let max_x = area.0 + (area.2 - size.w).max(0.0);
    let max_y = area.1 + (area.3 - size.h).max(0.0);
    (pos.0.min(max_x).max(area.0), pos.1.min(max_y).max(area.1))
}

/// 关闭请求的裁决结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseAction {
    /// 已建库：缩小为岛形态（**不** hide，hide 会触发 `visibilitychange` 误锁）。
    MorphToIsland,
    /// 未建库：没有可泄露的资产，可以真的收进托盘（PRD 状态矩阵第 6 行）。
    HideToTray,
}

/// 关闭主面板时该做什么。
///
/// 判据只有一条：**有没有建过库**。未建库时岛上没有任何东西可展示，把窗口
/// 缩成一条空岛只会让用户困惑（PRD 要求"托盘为唯一入口"）；已建库时缩成岛，
/// 因为用户关掉主面板的意图是"我待会儿还要用"，不是"退出"。
pub fn decide_close_action(session: SessionMirror) -> CloseAction {
    match session {
        SessionMirror::Uninitialized => CloseAction::HideToTray,
        SessionMirror::Locked | SessionMirror::Unlocked => CloseAction::MorphToIsland,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 锚点不变式：顶边不动，水平中心不动。
    #[test]
    fn anchor_keeps_top_edge_and_horizontal_center() {
        let pos = (100.0, 60.0);
        let cur = FULL_DEFAULT;
        let next = ISLAND_COLLAPSED;
        let (x, y) = anchored_top_center(pos, cur, next);

        assert_eq!(y, pos.1, "顶边必须保持不动");
        let center_before = pos.0 + cur.w / 2.0;
        let center_after = x + next.w / 2.0;
        assert!((center_before - center_after).abs() < 1e-9, "水平中心必须保持不变");
    }

    /// 展开时同样以顶边中心为锚点（320×44 → 400×460）。
    #[test]
    fn anchor_works_when_expanding() {
        let pos = (500.0, 20.0);
        let (x, y) = anchored_top_center(pos, ISLAND_COLLAPSED, ISLAND_EXPANDED);
        assert_eq!(y, 20.0);
        assert!((x + ISLAND_EXPANDED.w / 2.0 - (pos.0 + ISLAND_COLLAPSED.w / 2.0)).abs() < 1e-9);
    }

    /// 越界左 / 右：贴边而不是穿出屏幕。
    #[test]
    fn clamp_pulls_back_from_horizontal_overflow() {
        let area = (0.0, 0.0, 1920.0, 1080.0);
        let size = ISLAND_COLLAPSED;

        assert_eq!(clamp_into_work_area((-200.0, 40.0), size, area), (0.0, 40.0));
        assert_eq!(
            clamp_into_work_area((1900.0, 40.0), size, area),
            (1920.0 - size.w, 40.0)
        );
    }

    /// 越界上 / 下：y 同样夹取（负 y 会让窗口被任务栏或标题栏吃掉）。
    #[test]
    fn clamp_pulls_back_from_vertical_overflow() {
        let area = (0.0, 40.0, 1920.0, 1000.0);
        let size = ISLAND_EXPANDED;

        assert_eq!(clamp_into_work_area((300.0, -30.0), size, area), (300.0, 40.0));
        assert_eq!(
            clamp_into_work_area((300.0, 5000.0), size, area),
            (300.0, 40.0 + 1000.0 - size.h)
        );
    }

    /// 窗口比工作区还大：贴住左上角，不产生负坐标。
    #[test]
    fn clamp_pins_top_left_when_window_is_larger_than_area() {
        let area = (100.0, 100.0, 300.0, 200.0);
        let size = FULL_DEFAULT;
        assert_eq!(clamp_into_work_area((0.0, 0.0), size, area), (100.0, 100.0));
    }

    /// 尺寸映射：收起 / 展开两个常量必须真的被用到。
    #[test]
    fn island_size_maps_expanded_flag() {
        assert_eq!(island_size(false), ISLAND_COLLAPSED);
        assert_eq!(island_size(true), ISLAND_EXPANDED);
        // 展开态宽度不得小于 360（否则岛内搜索框与列表会挤成一列，见设计 §7.1）。
        assert!(ISLAND_EXPANDED.w >= 360.0);
    }

    /// 关闭裁决的两个分支。
    #[test]
    fn close_action_depends_on_whether_vault_exists() {
        assert_eq!(
            decide_close_action(SessionMirror::Uninitialized),
            CloseAction::HideToTray
        );
        assert_eq!(
            decide_close_action(SessionMirror::Locked),
            CloseAction::MorphToIsland
        );
        assert_eq!(
            decide_close_action(SessionMirror::Unlocked),
            CloseAction::MorphToIsland
        );
    }
}
