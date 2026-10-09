//! 前端可调用的命令（`invoke` 目标）。每个命令只负责：把参数交给 `app-core`，
//! 用平台适配层完成 IO/对话框，再把结果转成契约类型。

use std::path::PathBuf;

use app_core::{specs, Surface};
use app_ipc::{
    codes, ApiError, AppInfo, CredentialRecord, DocFormat, FormatInfo, LayoutOptionDto,
    OpenedDocument, TabState,
};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

type Res<T> = Result<T, ApiError>;

fn io_err(context: &str, e: impl std::fmt::Display) -> ApiError {
    ApiError::new(codes::IO, format!("{context}: {e}"))
}

/// 应用与运行时信息。
#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        name: "Diagramon".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        platform: state.platform().os().to_string(),
        origin: crate::window_url_label().to_string(),
    }
}

/// 全部标签页状态。
#[tauri::command]
pub fn list_tabs(state: State<'_, AppState>) -> Vec<TabState> {
    state.with_session(|s| s.tab_states())
}

/// 格式注册表快照（前端据此建菜单与分支，不再维护第二份格式清单）。
#[tauri::command]
pub fn formats() -> Vec<FormatInfo> {
    specs()
        .iter()
        .map(|s| FormatInfo {
            id: s.format.id().to_string(),
            default_extension: s.format.default_extension().to_string(),
            extensions: s.format.extensions().iter().map(|e| (*e).to_string()).collect(),
            surface: match s.surface {
                Surface::TextWithPreview => "textWithPreview",
                Surface::EmbeddedApp => "embeddedApp",
            }
            .to_string(),
            supports_ai_assistant: s.supports_ai_assistant,
            supports_graph_import: s.supports_graph_import,
            layout_options: s
                .layout_options
                .iter()
                .map(|l| LayoutOptionDto {
                    id: l.id.to_string(),
                    label: l.label.to_string(),
                    is_default: l.is_default,
                })
                .collect(),
        })
        .collect()
}

/// 当前活动标签页 id。
#[tauri::command]
pub fn active_tab(state: State<'_, AppState>) -> Option<String> {
    state.with_session(|s| s.active_id().map(str::to_string))
}

/// 新建一个未落盘标签页并激活，连同默认正文一并返回。
#[tauri::command]
pub fn new_tab(state: State<'_, AppState>, format: DocFormat) -> Res<OpenedDocument> {
    state.with_session(|s| {
        let id = s.add_untitled(format);
        let doc = s.get(&id).expect("刚插入的文档");
        Ok(OpenedDocument {
            tab: doc.tab_state(),
            body: doc.body().to_string(),
        })
    })
}

/// 打开文件对话框并载入所选文件。
#[tauri::command]
pub async fn open_dialog(app: AppHandle, state: State<'_, AppState>) -> Res<Vec<OpenedDocument>> {
    let builder = app
        .dialog()
        .file()
        .set_title("打开图表文件")
        .add_filter(
            "图表文件",
            &["mmd", "mermaid", "dot", "gv", "drawio", "excalidraw"],
        )
        .add_filter("所有文件", &["*"]);

    let picked = tauri::async_runtime::spawn_blocking(move || builder.blocking_pick_files())
        .await
        .map_err(|e| io_err("打开对话框失败", e))?;

    let Some(files) = picked else {
        return Ok(Vec::new());
    };
    let paths: Vec<PathBuf> = files.into_iter().filter_map(|f| f.into_path().ok()).collect();
    open_paths(&state, paths)
}

/// 载入给定路径（命令行参数 / 最近文件 / 拖放复用此入口）。
#[tauri::command]
pub fn open_paths_cmd(state: State<'_, AppState>, paths: Vec<String>) -> Res<Vec<OpenedDocument>> {
    open_paths(&state, paths.into_iter().map(PathBuf::from).collect())
}

/// 读取标签页正文（大文件按需拉取，不随标签状态全量推送）。
#[tauri::command]
pub fn read_document(state: State<'_, AppState>, id: String) -> Res<String> {
    state.with_session(|s| {
        s.get(&id)
            .map(|d| d.body().to_string())
            .ok_or_else(|| ApiError::new(codes::INVALID_TAB, format!("未知标签页: {id}")))
    })
}

/// 替换标签页正文（脏标记按内容比对）。
#[tauri::command]
pub fn set_body(state: State<'_, AppState>, id: String, body: String) -> Res<TabState> {
    state.with_session(|s| {
        let doc = s
            .get_mut(&id)
            .ok_or_else(|| ApiError::new(codes::INVALID_TAB, format!("未知标签页: {id}")))?;
        doc.set_body(body);
        Ok(doc.tab_state())
    })
}

/// 保存到既有路径；无路径时弹另存为对话框。返回 `None` 表示用户在对话框取消。
#[tauri::command]
pub async fn save(app: AppHandle, state: State<'_, AppState>, id: String) -> Res<Option<TabState>> {
    let existing = state.with_session(|s| s.get(&id).and_then(|d| d.path().map(PathBuf::from)));
    match existing {
        Some(path) => write_document(&state, &id, path).map(Some),
        None => save_as(app, state, id).await,
    }
}

/// 另存为（始终弹对话框）。返回 `None` 表示取消。
#[tauri::command]
pub async fn save_as(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Res<Option<TabState>> {
    let (default_name, filters) = state.with_session(|s| {
        let doc = s
            .get(&id)
            .ok_or_else(|| ApiError::new(codes::INVALID_TAB, format!("未知标签页: {id}")))?;
        let format = doc.format();
        let name = doc.path().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()));
        let name = name.unwrap_or_else(|| format!("Untitled.{}", format.default_extension()));
        Ok((name, filter_for(format)))
    })?;

    let builder = app
        .dialog()
        .file()
        .set_title("另存为")
        .set_file_name(default_name)
        .add_filter(filters.0, filters.1);
    let picked = tauri::async_runtime::spawn_blocking(move || builder.blocking_save_file())
        .await
        .map_err(|e| io_err("另存为对话框失败", e))?;

    let Some(file) = picked else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|e| io_err("无效的保存路径", e))?;
    write_document(&state, &id, path).map(Some)
}

/// 保存前端生成的位图（`data:` URL）到磁盘。
///
/// 前端把预览内容栅格化为 PNG data URL（`data:` 路，见 §7.3 的跨引擎结论），
/// 这里只负责解码与写盘；返回写入的绝对路径，用户在对话框取消则返回 `None`。
#[tauri::command]
pub async fn save_image(
    app: AppHandle,
    data_url: String,
    file_name: String,
) -> Res<Option<String>> {
    let (mime, bytes) = app_core::decode_data_url(&data_url)?;

    let ext = app_core::extension_for_mime(&mime);
    let filter_name = if ext == "jpg" { "JPEG 图片" } else { "PNG 图片" };
    let mut suggested = file_name;
    if !suggested.to_ascii_lowercase().ends_with(&format!(".{ext}")) {
        suggested = format!("{}.{ext}", suggested.trim_end_matches('.'));
    }

    let builder = app
        .dialog()
        .file()
        .set_title("保存图片")
        .set_file_name(suggested)
        .add_filter(filter_name, &[ext]);
    let picked = tauri::async_runtime::spawn_blocking(move || builder.blocking_save_file())
        .await
        .map_err(|e| io_err("保存图片对话框失败", e))?;

    let Some(file) = picked else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|e| io_err("无效的保存路径", e))?;
    std::fs::write(&path, bytes).map_err(|e| io_err(&format!("写入 {}", path.display()), e))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// 读设置。
#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> app_core::Settings {
    state.with_settings(|s| s.clone())
}

/// 覆盖写设置（前端持有的就是全量对象），随即落盘。
#[tauri::command]
pub fn settings_save(state: State<'_, AppState>, settings: app_core::Settings) -> app_core::Settings {
    state.with_settings(|s| *s = settings);
    state.persist_settings();
    state.with_settings(|s| s.clone())
}

/// 最近文件列表（最新在前）。
#[tauri::command]
pub fn recent_list(state: State<'_, AppState>) -> Vec<app_core::RecentFile> {
    state.with_settings(|s| s.recent_files.clone())
}

/// 记一条最近文件并落盘，返回更新后的列表。
#[tauri::command]
pub fn recent_add(state: State<'_, AppState>, path: String, title: String) -> Vec<app_core::RecentFile> {
    let now = now_ms();
    state.with_settings(|s| s.touch_recent(&path, &title, now));
    state.persist_settings();
    state.with_settings(|s| s.recent_files.clone())
}

/// 清空最近文件。
#[tauri::command]
pub fn recent_clear(state: State<'_, AppState>) -> Vec<app_core::RecentFile> {
    state.with_settings(|s| s.recent_files.clear());
    state.persist_settings();
    Vec::new()
}

/// 剔除已失效的最近文件，返回更新后的列表。
#[tauri::command]
pub fn recent_prune(state: State<'_, AppState>) -> Vec<app_core::RecentFile> {
    state.with_settings(|s| s.prune_recent());
    state.persist_settings();
    state.with_settings(|s| s.recent_files.clone())
}

/// 命令行里给出的、确实存在的文件路径（启动时由前端取走并打开）。
#[tauri::command]
pub fn cli_paths() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter(|a| std::path::Path::new(a).is_file())
        .collect()
}

/// 应用目录（关于/诊断用）。
#[tauri::command]
pub fn app_dirs(state: State<'_, AppState>) -> std::collections::BTreeMap<String, String> {
    let paths = state.platform().paths();
    let mut out = std::collections::BTreeMap::new();
    out.insert("config".into(), paths.config_dir().to_string_lossy().into_owned());
    out.insert("data".into(), paths.data_dir().to_string_lossy().into_owned());
    out.insert("cache".into(), paths.cache_dir().to_string_lossy().into_owned());
    out.insert(
        "settings".into(),
        state.settings_path().to_string_lossy().into_owned(),
    );
    out
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 关闭标签页，返回剩余标签与新的活动页。
#[tauri::command]
pub fn close_tab(state: State<'_, AppState>, id: String) -> Res<CloseResult> {
    state.with_session(|s| {
        s.close(&id)?;
        Ok(CloseResult {
            tabs: s.tab_states(),
            active: s.active_id().map(str::to_string),
        })
    })
}

/// 激活标签页。
#[tauri::command]
pub fn activate_tab(state: State<'_, AppState>, id: String) -> Res<()> {
    state.with_session(|s| s.activate(&id))
}

/// 读凭据（存在才返回）。
#[tauri::command]
pub fn credential_get(state: State<'_, AppState>, key: String) -> Res<Option<String>> {
    state
        .platform()
        .credentials()
        .get(&key)
        .map_err(|e| ApiError::new(codes::CREDENTIAL, e.to_string()))
}

/// 写凭据。
#[tauri::command]
pub fn credential_set(state: State<'_, AppState>, record: CredentialRecord) -> Res<()> {
    state
        .platform()
        .credentials()
        .set(&record.key, &record.value)
        .map_err(|e| ApiError::new(codes::CREDENTIAL, e.to_string()))
}

/// 删凭据。
#[tauri::command]
pub fn credential_delete(state: State<'_, AppState>, key: String) -> Res<()> {
    state
        .platform()
        .credentials()
        .delete(&key)
        .map_err(|e| ApiError::new(codes::CREDENTIAL, e.to_string()))
}

/// 退出应用。
#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}

/// `close_tab` 的结果。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseResult {
    pub tabs: Vec<TabState>,
    pub active: Option<String>,
}

/// 打开一组路径，返回成功载入的文档。
fn open_paths(state: &State<'_, AppState>, paths: Vec<PathBuf>) -> Res<Vec<OpenedDocument>> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let bytes = std::fs::read(&path).map_err(|e| io_err(&format!("读取 {}", path.display()), e))?;
        let body = String::from_utf8(bytes)
            .map_err(|_| ApiError::new(codes::ENCODING, format!("{} 不是 UTF-8 文本", path.display())))?;
        let format = DocFormat::from_path(&path);
        let opened = state.with_session(|s| {
            let (id, _created) = s.add_opened(path, format, body);
            let doc = s.get(&id).expect("刚打开/激活的文档");
            OpenedDocument {
                tab: doc.tab_state(),
                body: doc.body().to_string(),
            }
        });
        record_recent(state, opened.tab.path.as_deref(), &opened.tab.title);
        out.push(opened);
    }
    Ok(out)
}

/// 把标签正文写到磁盘并把该页标记为已保存。
fn write_document(state: &State<'_, AppState>, id: &str, path: PathBuf) -> Res<TabState> {
    let updated = state.with_session(|s| {
        let doc = s
            .get(id)
            .ok_or_else(|| ApiError::new(codes::INVALID_TAB, format!("未知标签页: {id}")))?;
        std::fs::write(&path, doc.body())
            .map_err(|e| io_err(&format!("写入 {}", path.display()), e))?;
        let doc = s.get_mut(id).expect("上一步已确认存在");
        doc.mark_saved(path);
        Ok(doc.tab_state())
    })?;
    record_recent(state, updated.path.as_deref(), &updated.title);
    Ok(updated)
}

/// 记一条最近文件（打开/首次保存成功后调用）。
fn record_recent(state: &State<'_, AppState>, path: Option<&str>, title: &str) {
    let Some(path) = path else { return };
    let now = now_ms();
    state.with_settings(|s| s.touch_recent(path, title, now));
    state.persist_settings();
}

/// 某格式的对话框过滤器（名称, 扩展名）。
fn filter_for(format: DocFormat) -> (String, &'static [&'static str]) {
    let label = match format {
        DocFormat::Mermaid => "Mermaid",
        DocFormat::Dot => "Graphviz DOT",
        DocFormat::Drawio => "drawio",
        DocFormat::Excalidraw => "Excalidraw",
    };
    (format!("{label} 文件"), format.extensions())
}
