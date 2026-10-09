// Windows 发布构建不附带控制台窗口；调试构建保留控制台以便查看 `dgm|` 诊断日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    diagramon_lib::run()
}
