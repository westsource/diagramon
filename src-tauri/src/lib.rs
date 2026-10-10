//! Diagramon 装配层：插件、状态、命令、启动路径。
//!
//! 窗口是**自绘标题栏**（`decorations: false`）：拖动区与三个窗口按钮由前端调
//! `core:window:*` 权限完成，见 `capabilities/default.json`。

mod commands;
mod state;

use std::sync::Arc;

use platform::{AppPaths, CredentialStore};
use state::AppState;

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

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(app_state)
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
            commands::cred_set,
            commands::cred_delete,
            commands::ai_chat,
            commands::ai_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("Diagramon 启动失败");
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
