//! Diagramon 装配层：插件、状态、命令、启动路径。
//!
//! 窗口是**自绘标题栏**（`decorations: false`）：拖动区与三个窗口按钮由前端调
//! `core:window:*` 权限完成，见 `capabilities/default.json`。
//!
//! 外壳与资产都由自定义协议 `dgm` 提供（不是只用它供资产），这样**外壳页与四个承载页
//! 同源**：iframe 通信不受跨源限制，离线守卫只需管一个 origin。

mod commands;
mod state;

use std::path::PathBuf;
use std::sync::Arc;

use assets::AssetRoots;
use platform::{AppPaths, CredentialStore};
use state::AppState;
use tauri::http::{header, Response};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder}; // Manager 提供 App::state()

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

/// 启动页面 URL。
///
/// 三平台差异只在这里：Windows 把自定义 scheme 暴露为 `http://<scheme>.localhost`，
/// 其它平台是 `<scheme>://localhost`（spike 实测：Linux 上用 `http://dgm.localhost/`
/// 页面根本不加载，必须走 `CustomProtocol`）。
#[cfg(target_os = "windows")]
fn webview_url() -> WebviewUrl {
    WebviewUrl::External("http://dgm.localhost/".parse().expect("恒为合法 URL"))
}

#[cfg(not(target_os = "windows"))]
fn webview_url() -> WebviewUrl {
    WebviewUrl::CustomProtocol("dgm://localhost/".parse().expect("恒为合法 URL"))
}

/// 页面 origin 的可读写法（诊断与文档用）。
fn window_url_label() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "http://dgm.localhost/"
    }
    #[cfg(not(target_os = "windows"))]
    {
        "dgm://localhost/"
    }
}

pub fn run() {
    let paths = match AppPaths::resolve() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("diagramon|fatal|{e}");
            std::process::exit(1);
        }
    };
    if let Err(e) = paths.ensure() {
        // 建不出配置目录也要能启动：设置退回内存默认值，下次再说
        eprintln!("diagramon|warn|配置目录不可用：{e}");
    }

    let creds = credential_store(&paths);
    let app_state = Arc::new(AppState::new(paths, creds));

    // 命令行/文件关联传进来的文件：先开着，前端一起来就能看到
    open_cli_files(&app_state);

    let roots = Arc::new(AssetRoots::detect(ui_dir()));
    eprintln!(
        "diagramon|roots|ui={}|source={:?}|packaged={:?}",
        roots.ui.display(),
        roots.source_tree,
        roots.packaged
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .register_asynchronous_uri_scheme_protocol("dgm", move |_ctx, request, responder| {
            let roots = roots.clone();
            let path = request.uri().path().to_string();
            // 文件 I/O 挪到独立线程：回调本身占着 UI 线程，
            // drawio 首屏会并发拉几百个资源，同步读会明显卡首帧。
            std::thread::spawn(move || {
                let response = match assets::resolve(&roots, &path) {
                    Some(file) => match std::fs::read(&file) {
                        Ok(bytes) => Response::builder()
                            .status(200)
                            .header(header::CONTENT_TYPE, assets::mime_for(&file))
                            // 不缓存：开发期改了 ui/ 下的文件刷新即可见；
                            // 98MB 资产的重复读盘代价可接受，换来"不会看到旧版本"。
                            .header(header::CACHE_CONTROL, "no-store")
                            .body(bytes)
                            .expect("响应构造"),
                        Err(e) => {
                            eprintln!("diagramon|asset-readerr|{path}|{e}");
                            Response::builder()
                                .status(500)
                                .body(format!("read error: {e}").into_bytes())
                                .expect("响应构造")
                        }
                    },
                    None => {
                        eprintln!("diagramon|asset-404|{path}");
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
        .manage(app_state)
        .setup(|app| {
            let paths = app.state::<Arc<AppState>>().paths.clone();
            build_main_window(app, &paths)?;
            eprintln!("diagramon|url|{}", window_url_label());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::settings_get,
            commands::settings_patch,
            commands::session_get,
            commands::doc_new,
            commands::doc_open_paths,
            commands::doc_activate,
            commands::doc_close,
            commands::doc_set_body,
            commands::doc_set_caret,
            commands::doc_set_view_mode,
            commands::doc_set_layout,
            commands::doc_issues,
            commands::doc_outline,
            commands::doc_scope,
            commands::doc_save,
            commands::doc_save_as,
            commands::export_write,
            commands::debug_note,
            commands::cred_set,
            commands::cred_delete,
            commands::ai_chat,
            commands::ai_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("Diagramon 启动失败");
}

/// 主窗口。**运行时创建**而不是写在 tauri.conf.json 里，为的是能按环境变量决定
/// 是否挂 WebView2 的远程调试端口 —— 自动化验收（`tools/dev/cdp-probe.py`）要用它。
///
/// 注意：wry 默认会传 `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`，
/// 宿主一旦显式传参，WebView2 就**不再读** `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
/// 这个环境变量（实测：进程起了、21 个 msedgewebview2 子进程都在，但 9333 端口不监听）。
/// 所以要开调试端口必须走 `additional_browser_args`，这也是它被搬到运行时的原因。
fn build_main_window(app: &mut tauri::App, paths: &AppPaths) -> Result<(), Box<dyn std::error::Error>> {
    let mut builder = WebviewWindowBuilder::new(app, "main", webview_url())
        // 页面加载事件：真机排查"白窗口"时，第一件要知道的就是页面有没有起来
        .on_page_load(|_window, payload| {
            #[cfg(debug_assertions)]
            match payload.event() {
                tauri::webview::PageLoadEvent::Started => eprintln!("diagramon|page|start {}", payload.url()),
                tauri::webview::PageLoadEvent::Finished => eprintln!("diagramon|page|finish {}", payload.url()),
            }
        })
        .title("Diagramon")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1000.0, 640.0)
        .decorations(false) // 自绘标题栏（拖动区 + 三个窗口按钮在前端）
        .center();

    if let Some(args) = debug_browser_args() {
        eprintln!("diagramon|debug-port|{args}");
        builder = builder.additional_browser_args(&args);
    }

    let window = builder.build()?;

    // 自检报告路径**不注入**：eval 发生在页面导航之前，注到空文档上会随导航丢掉。
    // 改由前端调 `app_info` 主动拉（见 commands::dev_flags），时序上不会错。
    if let Some(report) = selftest_report(paths) {
        eprintln!("diagramon|selftest|{report}");
    }
    let _ = &window;
    Ok(())
}

/// 自检开关。`DIAGRAMON_SELFTEST=1` ⇒ 后端把自己的开关交代出来（`app_info.dev`），
/// 前端据此跑一遍**真实 IPC** 断言，并用 `export_write` 把报告写到指定路径。
///
/// 为什么不走 URL query：窗口 URL 是 `dgm://localhost/`（自定义协议），
/// 拼接的 query 不保证落到 `location.search`（实测报告一直不落地）。
/// 由后端如实声明、前端主动拉，时序上不会错。
///
/// 为什么不用 CDP：本机 WebView2 不认 `--remote-debugging-port`
/// （wry 默认会传 `--disable-features=…`；宿主一旦显式传参，WebView2 就不再读
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`）。自检由页面自己跑，且不依赖桌面输入注入。
/// `tools/dev/cdp-probe.py` 留给能开调试端口的机器。
pub(crate) fn selftest_report(paths: &AppPaths) -> Option<String> {
    let on = std::env::var(app_ipc::ENV_SELFTEST)
        .map(|v| !v.trim().is_empty() && v.trim() != "0")
        .unwrap_or(false);
    if !on {
        return None;
    }
    Some(std::env::var(app_ipc::ENV_SELFTEST_REPORT).unwrap_or_else(|_| {
        paths
            .data_dir
            .join("selftest-report.json")
            .to_string_lossy()
            .into_owned()
    }))
}

/// `DIAGRAMON_DEBUG_PORT=9333` ⇒ 打开 CDP 端口，供 `tools/dev/cdp-probe.py` 连入。
fn debug_browser_args() -> Option<String> {
    let port = std::env::var(app_ipc::ENV_DEBUG_PORT).ok()?;
    let port = port.trim();
    if port.is_empty() {
        return None;
    }
    Some(format!(
        "--remote-debugging-port={port} --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"
    ))
}

/// Windows 用 DPAPI；其它平台暂时用明文兜底（仅够开发，正式适配层补齐后删除）。
fn credential_store(paths: &AppPaths) -> Arc<dyn CredentialStore> {
    #[cfg(windows)]
    let store: Arc<dyn CredentialStore> = Arc::new(platform_windows::store_in(&paths.config_dir));
    #[cfg(not(windows))]
    let store: Arc<dyn CredentialStore> =
        Arc::new(platform::PlaintextStore::new(paths.credentials_dir()));
    store
}

fn open_cli_files(state: &AppState) {
    let files: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .collect();
    if files.is_empty() {
        return;
    }
    let (opened, failed) = state.session().open_paths(&files);
    for id in opened {
        let entry = {
            let s = state.session();
            s.get(&id).and_then(|d| {
                d.path
                    .clone()
                    .map(|p| (p, d.name.clone(), d.format))
            })
        };
        if let Some((path, name, format)) = entry {
            state.remember_recent(&path, &name, format);
        }
    }
    for (path, err) in failed {
        eprintln!("diagramon|open-failed|{path}|{err}");
    }
}
