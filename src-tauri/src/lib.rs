//! Diagramon 装配层：插件、状态、命令、启动路径。
//!
//! 窗口是**自绘标题栏**（`decorations: false`）：拖动区与三个窗口按钮由前端调
//! `core:window:*` 权限完成，见 `capabilities/default.json`。
//!
//! 外壳与资产都由自定义协议 `dgm` 提供（不是只用它供资产），这样**外壳页与五个挂载点
//! 同源**：iframe 通信不受跨源限制，离线守卫只需管一个 origin。

mod cloud;
mod commands;
mod ai_tools;
mod state;
mod vision;
mod watcher;
mod workspace_cmds;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use app_ipc::events;
use assets::AssetRoots;
use platform::{AppPaths, CredentialStore};
use state::AppState;
use tauri::http::{header, Response};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder}; // Manager 提供 App::state()

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
    let mut app_state = AppState::new(paths, creds);

    // 自检的草稿写到**临时目录**，绝不碰真实草稿仓：
    // 自检会新建一堆未命名文档，autosave 把它们写进草稿仓；若写的是真仓，
    // 下一次自检又全部恢复回来 —— 草稿越滚越多（实测滚到 13 份），每次都在
    // 十几个未命名文档 + 两个画布引擎之上跑断言，负载不可控，表现为"非确定性卡死"。
    if selftest_on() {
        app_state.recovery_dir = std::env::temp_dir().join("diagramon-selftest-recovery");
        let _ = std::fs::remove_dir_all(&app_state.recovery_dir); // 只清自己的临时目录
    }

    let roots = Arc::new(AssetRoots::detect(ui_dir()));
    eprintln!(
        "diagramon|roots|ui={}|source={:?}|packaged={:?}",
        roots.ui.display(),
        roots.source_tree,
        roots.packaged
    );

    // 上次没保存完的（草稿仓里有）：先收进会话，再开命令行文件 —— 这样命令行那个
    // 文件拿到活动标签页，符合"我点它就是要看它"的直觉。
    // 自检时跳过：见上面"自检的草稿写到临时目录"的说明，同理 —— 自检要的是干净会话。
    if !selftest_on() {
        restore_drafts(&app_state);
    }
    open_cli_files(&app_state);

    tauri::Builder::default()
        // 单实例必须**第一个**注册：否则第二个进程会先把窗口建出来才被劝退
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths = diagram_files(&argv);
            // 开文档交给前端：那边才知道编辑器/预览/最近列表各自要做什么。
            // Rust 只负责"第二个进程想开这几个文件"这一件事。
            if !paths.is_empty() {
                let _ = app.emit(events::OPEN_PATHS, app_ipc::OpenPathsEvent { paths });
            }
            // 无论有没有带文件都要把主窗口唤起来：窗口可能正缩在托盘里
            // （close_to_tray），"再点一次图标 = 出窗口"是托盘应用的直觉。
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // 更新器与"装完自动重启"。"检查更新"从本地 toast 换成真实检查（第 7 步）。
        // 更新源在 tauri.conf.json 的 plugins.updater；产物要签名，
        // 签名密钥走 TAURI_SIGNING_PRIVATE_KEY 环境变量（见 docs/roadmap-dev3.0.md 第 7 步）。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
        .manage(Arc::new(app_state))
        // 关闭到托盘：CloseRequested 在这里拦（WebviewWindowBuilder 在 tauri 2.12
        // 上没有 on_window_event，只能挂在 Builder 级）。托盘菜单「退出」走
        // `app_exit` 直接 app.exit，不经此路，所以不需要额外的"真退出"标记。
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let to_tray = window
                    .app_handle()
                    .try_state::<Arc<AppState>>()
                    .map(|st| st.settings().close_to_tray)
                    .unwrap_or(false);
                if to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let paths = app.state::<Arc<AppState>>().paths.clone();
            build_main_window(app, &paths)?;
            if let Err(e) = build_tray(app.handle()) {
                // 托盘建不出来不挡启动：close_to_tray 开着也只是退化为"点了没反应"，
                // 用户关掉开关即可恢复，不该因小功能挂掉整个应用
                eprintln!("diagramon|warn|托盘创建失败：{e}");
            }
            eprintln!("diagramon|url|{}", window_url_label());
            spawn_autosave(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::app_exit,
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
            commands::doc_set_look,
            commands::doc_set_scheme,
            commands::palette_apply,
            commands::palette_clear,
            commands::palette_probe,
            commands::palette_scan,
            commands::palette_annotate,
            commands::doc_reload,
            commands::doc_issues,
            commands::file_read_text,
            commands::doc_outline,
            commands::doc_scope,
            commands::doc_save,
            commands::doc_save_as,
            commands::export_write,
            commands::convert_text,
            commands::format_text,
            commands::debug_note,
            commands::ai_provider_models,
            commands::ai_provider_key_set,
            commands::ai_provider_key_delete,
            commands::ai_chat,
            commands::ai_agent_run,
            commands::ai_resolve_intent,
            commands::ai_cancel,
            commands::conversation_list,
            commands::conversation_open,
            commands::conversation_read,
            commands::conversation_delete,
            commands::conversation_prune,
            commands::conversation_load,
            commands::conversation_save,
            commands::conversation_clear,
            commands::ai_memory_list,
            commands::ai_memory_save,
            commands::ai_memory_delete,
            commands::ai_memory_clear,
            commands::ai_memory_extract,
            workspace_cmds::workspace_open,
            workspace_cmds::workspace_get,
            workspace_cmds::workspace_close,
            workspace_cmds::workspace_new_file,
            workspace_cmds::workspace_rename,
            workspace_cmds::workspace_delete,
            workspace_cmds::search_run,
            workspace_cmds::search_cancel,
            workspace_cmds::search_once,
            vision::monitors_list,
            vision::vision_capture_start,
            vision::vision_frame,
            vision::vision_crop,
            vision::vision_cancel,
            vision::clip_write_image,
            vision::clip_read_image,
            cloud::cloud_login,
            cloud::cloud_logout,
            cloud::cloud_status,
            cloud::cloud_docs_list,
            cloud::cloud_folders,
            cloud::cloud_folder_create,
            cloud::cloud_doc_save,
            cloud::cloud_doc_open,
            cloud::cloud_doc_delete,
            cloud::ai_gateway_models,
        ])
        .run(tauri::generate_context!())
        .expect("Diagramon 启动失败");
}

/// 命令行参数里属于本应用的文件（第二个实例转交、以及"双击文件打开"都走这里）。
///
/// 只认注册表里的扩展名：把 `--flag`、可执行文件路径之类筛掉，
/// 免得第二个进程一启就把工作目录里的乱七八糟东西全塞进来。
fn diagram_files(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip(1) // argv[0] 是 exe 自己
        .filter(|a| !a.starts_with('-'))
        .filter(|a| {
            Path::new(a)
                .extension()
                .map(|e| app_core::workspace::is_open_ext(&e.to_string_lossy()))
                .unwrap_or(false)
        })
        .cloned()
        .collect()
}

/// 把草稿仓里的未落盘文档收进会话（上次退出时没保存完的东西）。
fn restore_drafts(state: &AppState) {
    let drafts = app_core::recovery::load_all(&state.recovery_dir);
    if drafts.is_empty() {
        return;
    }
    let n = drafts.len();
    let mut s = state.session();
    for d in drafts {
        s.adopt_draft(d.id, d.name, d.format, d.body);
    }
    eprintln!("diagramon|recovered|{n}");
}

/// autosave：每 1 秒醒一次，把到期的脏文档落盘。
///
/// **为什么归 Rust 而不是前端计时器**：WebView2 对后台窗口把 `setTimeout`
/// 节流到约 1 次/秒，窗口不聚焦时界面侧的计时器根本不准。这件事必须由不睡觉的一侧做。
fn spawn_autosave(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(1000));
        let st = app.state::<Arc<AppState>>().inner().clone();
        if !st.settings().editor.autosave {
            st.autosave().clear();
            continue;
        }
        let now = std::time::Instant::now();
        let due: Vec<String> = {
            let map = st.autosave();
            map.iter().filter(|(_, t)| **t <= now).map(|(k, _)| k.clone()).collect()
        };
        for id in due {
            st.autosave().remove(&id);
            if let Err(e) = autosave_one(&app, &st, &id) {
                eprintln!("diagramon|autosave-failed|{id}|{e}");
            }
        }
    });
}

/// 落一份 autosave：有路径的写回原文件，没有的进草稿仓。
fn autosave_one(app: &tauri::AppHandle, st: &AppState, id: &str) -> Result<(), String> {
    let (path, name, format, body, dirty) = {
        let s = st.session();
        let d = s.get(id).ok_or_else(|| "文档不存在".to_string())?;
        (d.path.clone(), d.name.clone(), d.format, d.body.clone(), d.dirty)
    };
    if !dirty {
        return Ok(()); // 期间用户自己存了/改回去了
    }
    match path {
        Some(p) => {
            let p = PathBuf::from(p);
            // 受限模式下不许写出去 —— 直接不写，留给用户手动保存（别把草稿也弄丢）
            st.check_writable(&p)?;
            commands::atomic_write(&p, &body)?;
            let doc = st
                .session()
                .commit_saved(id, None)
                .ok_or_else(|| "文档不存在".to_string())?;
            let _ = app.emit(events::DOC_AUTOSAVED, doc);
        }
        None => {
            let draft = app_core::recovery::Draft {
                id: id.to_string(),
                name,
                format,
                body,
            };
            app_core::recovery::save(&st.recovery_dir, &draft).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
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
            // 页面加载日志只在 debug 构建里有；release 下 payload 没人用，
            // 用 drop 压掉"未使用变量"警告（release 编译曾因此刷警告）。
            #[cfg(debug_assertions)]
            match payload.event() {
                tauri::webview::PageLoadEvent::Started => eprintln!("diagramon|page|start {}", payload.url()),
                tauri::webview::PageLoadEvent::Finished => eprintln!("diagramon|page|finish {}", payload.url()),
            }
            #[cfg(not(debug_assertions))]
            drop(payload);
        })
        .title("Diagramon")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1000.0, 640.0)
        .decorations(false) // 自绘标题栏（拖动区 + 三个窗口按钮在前端）
        // 自检时置顶：WebView2 会挂起"被遮挡"的窗口 —— 定时器全停、
        // invoke 响应（走 ExecuteScript 投递）被丢，自检就变成非确定性的静默卡死。
        // 从脚本里拉起来的窗口几乎必然被终端/IDE 盖住，所以自检要置顶，
        // 让遮挡判定永远判"可见"。反节流开关（debug_browser_args）同此目的，双保险。
        .always_on_top(crate::selftest_on())
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

/// 系统托盘：图标常驻（不随 close_to_tray 开关走），菜单给"恢复窗口"与"真退出"。
///
/// 为什么常驻：窗口可能已经在托盘里用户才关掉开关，没有图标就永远找不回窗口了。
/// close_to_tray 只决定 CloseRequested 的处置，与图标本身无关。
/// 菜单文案按启动时的 settings.locale 定，之后改语言不重刷（托盘属系统侧，影响可忽略）。
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let zh = app
        .try_state::<Arc<AppState>>()
        .map(|st| st.settings().locale != "en-US")
        .unwrap_or(true);
    let (show_label, quit_label) =
        if zh { ("显示主窗口", "退出") } else { ("Show window", "Quit") };
    let show = MenuItem::with_id(app, "show", show_label, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .expect("bundle.icon 已配置，default_window_icon 必有");
    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("Diagramon")
        .menu(&menu)
        // 左键不弹菜单（留给双击唤窗），右键才出菜单 —— Windows 惯例
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick { .. } = event {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 从托盘唤回主窗口（托盘菜单「显示主窗口」、双击图标、第二实例启动共用）。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// `DIAGRAMON_SELFTEST=1` 是否开着（自检要干净会话与临时草稿目录）。
fn selftest_on() -> bool {
    std::env::var(app_ipc::ENV_SELFTEST)
        .map(|v| !v.trim().is_empty() && v.trim() != "0")
        .unwrap_or(false)
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
    if !selftest_on() {
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

/// 自检 / CDP 调试时给 WebView2 加**反节流**开关。
///
/// 为什么必须有：WebView2 对"被遮挡的后台窗口"不只是把 `setTimeout` 节流到 ~1 次/秒，
/// 它会**整体挂起渲染进程** —— 定时器全停、`ExecuteScript`（也就是 invoke 响应的
/// 投递通道）被丢弃。表现为：Rust 侧命令明明执行完了，前端的 `await` 却永远不结算，
/// 无报错、无 pagehide、每次卡的位置还不一样。曾经因此把一个不存在的 bug 查了五轮。
///
/// 这四个开关是 Chromium/WebView2 通用的反后台节流组合：
/// 关遮挡判定 + 关定时器节流 + 关"被遮挡即降级" + 关渲染进程后台降级。
fn debug_browser_args() -> Option<String> {
    let selftest = std::env::var(app_ipc::ENV_SELFTEST)
        .map(|v| !v.trim().is_empty() && v.trim() != "0")
        .unwrap_or(false);
    let port = std::env::var(app_ipc::ENV_DEBUG_PORT)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    if !selftest && port.is_none() {
        return None;
    }
    let mut args = String::new();
    if let Some(p) = port {
        args.push_str(&format!("--remote-debugging-port={p} "));
    }
    args.push_str(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion \
         --disable-background-timer-throttling --disable-backgrounding-occluded-windows \
         --disable-renderer-backgrounding",
    );
    // **自检必须直连**：Tauri 2 的 invoke 在 Windows 上走 `http://ipc.localhost`，
    // 系统代理（clash 之类）若没把它排除，请求/响应就会被间歇性吞掉 ——
    // 表现正是"Rust 执行完了、前端 await 永不结算、卡点每次还不一样"。
    // 自检不需要任何外网，直接把代理整个关掉。
    args.push_str(" --no-proxy-server --proxy-bypass-list=<-loopback>;");
    // 运行时追加开关（如 `DGM_BROWSER_EXTRA_ARGS=--no-sandbox`）：受限会话/作业对象里
    // WebView2 的浏览器子进程会**启动即崩**（Crashpad 每 launch 一个 ~7MB dmp、窗口纯白），
    // 自动化验收从这类环境拉起应用时需要它。**仅环境变量显式给出时生效**，
    // 绝不写进任何默认/发布路径 —— 沙箱只允许被验收环境自己关掉。
    if let Ok(extra) = std::env::var("DGM_BROWSER_EXTRA_ARGS") {
        let extra = extra.trim();
        if !extra.is_empty() {
            args.push(' ');
            args.push_str(extra);
        }
    }
    Some(args)
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
    // 与单实例路径（diagram_files）同一套过滤：只认注册的扩展名，挡掉
    // `--flag` 与 exe 路径之类的杂参（审计 F-5：两条入口曾不一致）。
    let argv: Vec<String> = std::env::args().collect();
    let files = diagram_files(&argv);
    if files.is_empty() {
        return;
    }
    let (opened, failed) = state.session().open_paths(&files);
    for id in opened {
        // 恢复「按文件记着的渲染选项」+ 记最近打开：与 `doc_open_paths` 共用同一份收尾，
        // 否则命令行打开的这份又会"不记得上次选的布局"。
        crate::commands::after_open_file(state, &id);
    }
    for (path, err) in failed {
        eprintln!("diagramon|open-failed|{path}|{err}");
    }
}
