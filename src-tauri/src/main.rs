// Windows 发布版不要弹出控制台窗口；调试版保留 stdout，便于看 `diagramon|…` 运行日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    diagramon_lib::run()
}
