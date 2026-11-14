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

use app_ipc::{events, DocKind};
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

/// 外壳页（`ui/**`）的内容安全策略。
///
/// **为什么挂在协议响应头上、而不是 `tauri.conf.json` 的 `app.security.csp`**（审计 2026-11-03 H-6）：
/// 那个配置只作用于 Tauri 自己的资产协议，**管不到自定义协议处理器的响应** ——
/// 而外壳页与五个承载页全部由 `dgm` 提供。原先只有 `ui/index.html` 里一条 `<meta>`，
/// 于是 drawio / Excalidraw 承载页、上游 drawio 的 `index.html`、`capture.html`
/// **一条 CSP 都没有**，而它们处理的正是本应用最主要的不可信输入
/// （第三方 `.drawio`/`.excalidraw`、渲染引擎产出的 SVG），又与外壳**同源**、
/// 同样被注入 `window.__TAURI__`（wry 在 Windows 上把初始化脚本注进**所有帧**，
/// 见 `wry-0.57.0/src/lib.rs:1029`）。响应头是唯一能覆盖到上游产物那一份的办法。
///
/// ⚠️ 与 `ui/index.html` 里的 `<meta>` **逐字一致**（那边保留一份做兜底：
/// 万一这里的挂载点判断出错，外壳页至少还有一道）。改一处必须改两处。
const CSP_SHELL: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; \
worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
connect-src 'self' data: blob: http://ipc.localhost https://ipc.localhost; \
font-src 'self' data:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'";

/// 承载页（`/drawio/`、`/excalidraw/`、`/graphviz/`、`/mermaid/`、`/d2/`、`/mermaid-elk/`）的策略。
///
/// 与外壳页只差两处，都是被第三方引擎逼出来的：
/// * `script-src` 多 `'unsafe-inline' 'unsafe-eval'` —— 我们自己写的两份承载页有内联脚本，
///   上游 drawio 的构建产物同样有，而它**不是我们的文件、没法改成外链**；mxGraph 系还要 eval。
///   这不是理想状态，但承载页本来就要跑第三方 JS，CSP 在这里的价值主要是
///   **切断外带通道**（`connect-src`/`default-src` 只留同源），而不是禁脚本。
/// * `object-src` 放宽到 `'self'`（外壳页是 `'none'`）：drawio 的导出/打印路径可能用到，
///   收紧到 `'none'` 的收益不足以抵掉弄坏上游功能的风险。
const CSP_CANVAS: &str = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; \
worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
connect-src 'self' data: blob: http://ipc.localhost https://ipc.localhost; \
font-src 'self' data:; frame-src 'self' blob:; object-src 'self'; base-uri 'none'";

/// 按 URL 路径选 CSP：落在挂载点前缀下的走承载页那一档，其余（外壳与前端产物）走严格那一档。
fn csp_for(url_path: &str) -> &'static str {
    let first = url_path
        .trim_start_matches('/')
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    if assets::MOUNTS.contains(&first) {
        CSP_CANVAS
    } else {
        CSP_SHELL
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
                            // 每个同源响应都要带 CSP（审计 2026-11-03 H-6）：外壳页与承载页
                            // 同源，而承载页跑的是渲染不可信图表的第三方引擎 —— 只有响应头
                            // 能覆盖到上游产物那一份（见 csp_for 的注释）。
                            .header(header::CONTENT_SECURITY_POLICY, csp_for(&path))
                            // 不缓存：开发期改了 ui/ 下的文件刷新即可见；
                            // 98MB 资产的重复读盘代价可接受，换来"不会看到旧版本"。
                            .header(header::CACHE_CONTROL, "no-store")
                            .body(bytes)
                            .expect("响应构造"),
                        Err(e) => {
                            // 错误原文只进日志，不回给页面（审计 2026-11-03 L-1）：
                            // io::Error 的 Display 会带 Windows 错误文案、有时含完整路径，
                            // 而这个响应的读者包含承载页里的第三方内容。404 分支早就只回
                            // "not found"，这里以前不一致。
                            eprintln!("diagramon|asset-readerr|{path}|{e}");
                            Response::builder()
                                .status(500)
                                .header(header::CONTENT_TYPE, "text/plain")
                                .body(b"read error".to_vec())
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
                let app = window.app_handle();
                let to_tray = app
                    .try_state::<Arc<AppState>>()
                    .map(|st| st.settings().close_to_tray)
                    .unwrap_or(false);
                if to_tray {
                    // 进程还活着：autosave 若开着就继续落盘；真退出走托盘菜单
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    // 先让前端跑 quit()：它知道 350ms 去抖里还没送到后端的正文，
                    // 只看后端 dirty_count 会漏掉刚敲下的最后几个字
                    api.prevent_close();
                    request_quit(app);
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
            commands::drafts_flush,
            commands::drafts_discard,
            commands::drafts_probe,
            commands::doc_mark_cloud,
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

/// autosave：每 1 秒醒一次，把到期的脏文档按 `DocKind` 落盘。
///
/// **为什么归 Rust 而不是前端计时器**：WebView2 对后台窗口把 `setTimeout`
/// 节流到约 1 次/秒，窗口不聚焦时界面侧的计时器根本不准。这件事必须由不睡觉的一侧做。
///
/// 排表规则见 `doc_set_body`：草稿总是排；本地文件只在 `editor.autosave` 开启时排。
/// 云端文档与 `hold` 改动不排。
fn spawn_autosave(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(1000));
        let st = app.state::<Arc<AppState>>().inner().clone();
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

/// 落一份后台持久化：按 `DocKind` 决定写哪里。
///
/// * `Draft` → 草稿仓（**和 `editor.autosave` 无关**；这是"打开软件能恢复"的基础）；
/// * `File` + `editor.autosave` 开启 → 写回原文件并清脏标；
/// * `Cloud` / `File` 且开关关闭 → 什么都不写。
///
/// `hold`（AI 应用/转换产物本身）在排表时已被排除；这里再挡一次，防止历史计时器迟到。
fn autosave_one(app: &tauri::AppHandle, st: &AppState, id: &str) -> Result<(), String> {
    let (path, kind, name, format, body, dirty, held) = {
        let s = st.session();
        let d = s.get(id).ok_or_else(|| "文档不存在".to_string())?;
        (
            d.path.clone(),
            d.kind,
            d.name.clone(),
            d.format,
            d.body.clone(),
            d.dirty,
            s.is_held(id),
        )
    };
    if !dirty || held {
        return Ok(()); // 期间用户自己存了/改回去了，或这次改动只进内存
    }
    let autosave_on = st.settings().editor.autosave;
    match kind {
        DocKind::Draft => {
            let draft = app_core::recovery::Draft {
                id: id.to_string(),
                name,
                format,
                body,
            };
            app_core::recovery::save(&st.recovery_dir, &draft).map_err(|e| e.to_string())?;
        }
        DocKind::File if autosave_on => {
            let p = path.ok_or_else(|| "本地文件缺少路径".to_string())?;
            let p = PathBuf::from(p);
            // 受限模式下不许写出去 —— 直接不写，留给用户手动保存
            st.check_writable(&p)?;
            commands::atomic_write(&p, &body)?;
            let doc = st
                .session()
                .commit_saved(id, None)
                .ok_or_else(|| "文档不存在".to_string())?;
            let _ = app.emit(events::DOC_AUTOSAVED, doc);
        }
        _ => {}
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
            "quit" => request_quit(app),
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

/// 请求前端走一遍未保存确认后再退出。
///
/// 托盘「退出」与 Alt+F4 / 系统关窗都走这里。**不先看后端 `dirty_count`**：编辑器有
/// 350ms 去抖，刚敲下的字在 `pendingBody` 里，后端还是干净的；直接 `app.exit` 会把
/// 它们静默丢掉。前端 `quit()` 用 `state.docs[].dirty` 判，包含这些待发送改动。
/// 前端不可用（事件发不出去）时退回 `app.exit`，避免窗口关不掉。
fn request_quit(app: &tauri::AppHandle) {
    show_main_window(app);
    if app.emit(events::APP_QUIT_REQUESTED, ()).is_err() {
        app.exit(0);
    }
}

/// `DIAGRAMON_SELFTEST=1` 是否开着（自检要干净会话与临时草稿目录）。
pub(crate) fn selftest_on() -> bool {
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

/// 是不是**开发/验收**构建（审计 2026-11-03 L-8）。
///
/// 三个调试开关原来在 release 里同样生效：
/// * `DIAGRAMON_DEBUG_PORT` 打开的是**无鉴权**的 CDP 端点 —— 拿到它就等于拿到
///   webview 里的任意 JS 执行权（进而全部 IPC 命令）；
/// * `DGM_BROWSER_EXTRA_ARGS` 的典型值是 `--no-sandbox`；
/// * `app_info.dev.debug_port` 还会把这个端口主动告诉页面。
///
/// 它们只该活在开发与验收里。`DGM_BROWSER_EXTRA_ARGS` 额外放行"自检开着"的情况：
/// 验收流水线跑的是 debug 构建，但受限会话里有人用 release 构建自查时也得能起来 ——
/// 而那个变量本身要用户自己设进程环境变量，前提已经接近"已有本机代码执行"。
#[cfg(debug_assertions)]
pub(crate) const fn dev_build() -> bool {
    true
}
#[cfg(not(debug_assertions))]
pub(crate) const fn dev_build() -> bool {
    false
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
    // 无鉴权 CDP 端点只给开发构建（审计 L-8）
    let port = if dev_build() {
        std::env::var(app_ipc::ENV_DEBUG_PORT)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    } else {
        None
    };
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
    // 发布构建只在自检开着时认它（审计 L-8），平时一律忽略。
    if dev_build() || selftest {
        if let Ok(extra) = std::env::var("DGM_BROWSER_EXTRA_ARGS") {
            let extra = extra.trim();
            if !extra.is_empty() {
                args.push(' ');
                args.push_str(extra);
            }
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
