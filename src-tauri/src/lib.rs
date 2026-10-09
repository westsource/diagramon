//! Diagramon Tauri 主进程装配（三平台同一入口）。
//!
//! 与既有 Avalonia 客户端的关键差异：
//! * 资产不再走进程内 loopback HTTP 服务，而是由 Tauri 的**自定义协议** `dgm://` 提供；
//! * 三平台的差异只在两处：协议 origin 的写法（Windows `http://<scheme>.localhost`，
//!   其它平台 `<scheme>://localhost`）与平台适配层实现（`cfg` 选择）。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod state;

use std::path::PathBuf;
use std::sync::Arc;

use assets::AssetRoots;
use platform::{AppPaths, Platform, StandardPaths};
use tauri::http::{header, Response};
use tauri::{WebviewUrl, WebviewWindowBuilder};

use state::AppState;

/// 前端产物目录。
///
/// 解析顺序：`DIAGRAMON_UI_DIR` → 可执行文件同级的 `ui/`（发布/便携形态）
/// → 源码树里的 `ui/`（开发形态）。
fn ui_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("DIAGRAMON_UI_DIR") {
        return PathBuf::from(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let cand = dir.join("ui");
            if cand.join("index.html").is_file() {
                return cand;
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ui")
}

/// 自定义协议页面 URL（诊断与 `AppInfo.origin` 使用）。
#[cfg(target_os = "windows")]
pub fn window_url_label() -> &'static str {
    "http://dgm.localhost/"
}

#[cfg(not(target_os = "windows"))]
pub fn window_url_label() -> &'static str {
    "dgm://localhost/"
}

/// 构造协议 URL；Windows 与其它平台的写法不同（spike 实测：
/// Linux 上用 `http://dgm.localhost/` 页面根本不加载，必须用 `<scheme>://localhost/`）。
fn webview_url() -> WebviewUrl {
    #[cfg(target_os = "windows")]
    {
        WebviewUrl::External(
            "http://dgm.localhost/".parse().expect("恒为合法 URL"),
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        WebviewUrl::CustomProtocol("dgm://localhost/".parse().expect("恒为合法 URL"))
    }
}

/// 构造平台适配层实现。
#[cfg(windows)]
fn create_platform() -> Result<Box<dyn Platform>, platform::PlatformError> {
    let paths = StandardPaths::new("Diagramon");
    let credentials_dir = paths.config_dir().join("credentials");
    Ok(Box::new(platform_windows::WindowsPlatform::new(
        credentials_dir,
    )?))
}

#[cfg(not(windows))]
compile_error!(
    "macOS/Linux 平台适配层尚未实现：请先补 platform-macos / platform-linux（阶段 1 待办）"
);

/// 启动应用。
pub fn run() {
    let roots = Arc::new(AssetRoots::detect(ui_dir()));
    println!(
        "dgm|roots|ui={}|legacy={:?}|packaged={:?}",
        roots.ui.display(),
        roots.legacy_client,
        roots.packaged
    );

    let platform = create_platform().expect("平台适配层初始化失败");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .register_asynchronous_uri_scheme_protocol("dgm", move |_ctx, request, responder| {
            let roots = roots.clone();
            let path = request.uri().path().to_string();
            std::thread::spawn(move || {
                let response = match assets::resolve(&roots, &path) {
                    Some(file) => match std::fs::read(&file) {
                        Ok(bytes) => {
                            println!("dgm|serve|{path}|{}", bytes.len());
                            Response::builder()
                                .status(200)
                                .header(header::CONTENT_TYPE, assets::mime_for(&file))
                                .header(header::CACHE_CONTROL, "no-store")
                                .body(bytes)
                                .expect("响应构造")
                        }
                        Err(e) => {
                            println!("dgm|readerr|{path}|{e}");
                            Response::builder()
                                .status(500)
                                .body(format!("read error: {e}").into_bytes())
                                .expect("响应构造")
                        }
                    },
                    None => {
                        println!("dgm|404|{path}");
                        Response::builder()
                            .status(404)
                            .header(header::CONTENT_TYPE, "text/plain")
                            .body(b"not found".to_vec())
                            .expect("响应构造")
                    }
                };
                responder.respond(response);
            });
        })
        .manage(AppState::new(platform))
        .setup(|app| {
            let win = WebviewWindowBuilder::new(app, "main", webview_url())
                .title("Diagramon")
                .inner_size(1280.0, 860.0)
                .visible(true)
                .build()?;
            let _ = win;
            println!("dgm|url|{}", window_url_label());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::list_tabs,
            commands::formats,
            commands::active_tab,
            commands::new_tab,
            commands::open_dialog,
            commands::open_paths_cmd,
            commands::read_document,
            commands::set_body,
            commands::save,
            commands::save_as,
            commands::save_image,
            commands::close_tab,
            commands::activate_tab,
            commands::credential_get,
            commands::credential_set,
            commands::credential_delete,
            commands::quit,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用运行失败");
}
