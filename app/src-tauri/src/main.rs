// 发布版不弹控制台窗口；调试版保留，方便看 panic 与日志。
//
// 正因为发布版没有控制台，**这里的任何 panic 都是"双击图标一闪而过"**。
// 兜底在 `keyisland_lib`：启动失败不再走 panic（原因经 `startup_failure` 送到 UI），
// 真的崩溃了也有 panic hook 弹原生对话框。详见 `docs/DESKTOP-BUILD.md` §6.7。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    keyisland_lib::run()
}
