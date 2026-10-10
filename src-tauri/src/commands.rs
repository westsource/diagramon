//! 命令层：前端 `invoke` 的落点。
//!
//! 命名与载荷**逐字段对齐** `crates/app-ipc/src/lib.rs`（那里是唯一真源）。
//! 这里只做三件事：校验入参、动状态、必要时派任务；业务逻辑一律下沉到 `app-core` / `ai`。
//!
//! **参数命名约定**：命令参数一律**单个词**（`id` / `path` / `name` / `req`）。
//! Tauri 会对命令参数做驼峰↔下划线转换，多词参数一旦两侧不一致就只在真机上炸
//! （报 "invalid args"，测试里看不见）。单词参数没有这个坑。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use app_ipc::{
    events, AiChatRequest, AiDelta, AiDone, AiFailed, AiModel, AppInfo, ConvertOutcome,
    ConvertRequest, DevFlags, Doc, FormatId, Issue, OutlineGroup, Session as SessionPayload,
    Settings, ViewMode,
};
use base64::Engine as _;
use tauri::{AppHandle, Emitter, State};

use crate::state::{credential_key, AppState};

type R<T> = Result<T, String>;

/* ---------------- 应用信息与设置 ---------------- */

#[tauri::command]
pub fn app_info(state: State<'_, Arc<AppState>>) -> AppInfo {
    // 前端起来的第一件事就是拉 app_info —— 这行日志等于"前端活着的证据"
    #[cfg(debug_assertions)]
    eprintln!("diagramon|app_info|called");
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        formats: app_core::format::registry(),
        dev: dev_flags(&state.paths),
    }
}

/// 开发开关：按环境变量如实声明（见 `crate::selftest_report` 与 `debug_browser_args`）。
fn dev_flags(paths: &platform::AppPaths) -> DevFlags {
    DevFlags {
        selftest_report: crate::selftest_report(paths),
        debug_port: std::env::var(app_ipc::ENV_DEBUG_PORT)
            .ok()
            .and_then(|v| v.trim().parse::<u16>().ok()),
        mock: false,
    }
}

#[tauri::command]
pub fn settings_get(state: State<'_, Arc<AppState>>) -> Settings {
    let mut s = state.settings().clone();
    state.hydrate_models(&mut s);
    s
}

/// 局部更新：前端只发它改动的字段，其余原样保留（见 app-core::settings::apply_patch）。
#[tauri::command]
pub fn settings_patch(state: State<'_, Arc<AppState>>, patch: serde_json::Value) -> R<Settings> {
    let mut s = state.settings().clone();
    app_core::settings::apply_patch(&mut s, patch)?;
    state.persist_settings(&s)?;
    *state.settings() = s.clone();
    state.hydrate_models(&mut s);
    Ok(s)
}

/* ---------------- 会话与文档 ---------------- */

#[tauri::command]
pub fn session_get(state: State<'_, Arc<AppState>>) -> SessionPayload {
    state.session().payload()
}

#[tauri::command]
pub fn doc_new(state: State<'_, Arc<AppState>>, format: FormatId) -> Doc {
    state.session().new_doc(format)
}

#[tauri::command]
pub fn doc_open_paths(state: State<'_, Arc<AppState>>, paths: Vec<String>) -> SessionPayload {
    let (opened, failed) = state.session().open_paths(&paths);
    for id in &opened {
        let s = state.session();
        if let Some(d) = s.get(id) {
            if let Some(p) = d.path.clone() {
                let (name, fmt) = (d.name.clone(), d.format);
                drop(s);
                state.remember_recent(&p, &name, fmt);
            }
        }
    }
    if !failed.is_empty() {
        // 打开失败要出声：静默吞掉会让用户以为"点了没反应"
        let detail = failed
            .iter()
            .map(|(p, e)| format!("{p}（{e}）"))
            .collect::<Vec<_>>()
            .join("；");
        eprintln!("diagramon|open-failed|{detail}");
    }
    state.session().payload()
}

#[tauri::command]
pub fn doc_activate(state: State<'_, Arc<AppState>>, id: String) -> R<SessionPayload> {
    if !state.session().activate(&id) {
        return Err(format!("文档不存在：{id}"));
    }
    Ok(state.session().payload())
}

#[tauri::command]
pub fn doc_close(state: State<'_, Arc<AppState>>, id: String) -> R<SessionPayload> {
    if !state.session().close(&id) {
        return Err(format!("文档不存在：{id}"));
    }
    // 用户明确关掉了这个文档 ⇒ 它的草稿也该消失（"不保存"是一种表达）
    state.cancel_autosave(&id);
    app_core::recovery::remove(&state.recovery_dir, &id);
    Ok(state.session().payload())
}

/// 改正文。返回"现在是否脏"，前端据此显示/清除标签页上的脏标。
#[tauri::command]
pub fn doc_set_body(state: State<'_, Arc<AppState>>, id: String, body: String) -> R<bool> {
    let mut s = state.session();
    if !s.set_body(&id, body) {
        return Err(format!("文档不存在：{id}"));
    }
    let dirty = s.get(&id).map(|d| d.dirty).unwrap_or(false);
    drop(s);
    // autosave 计时归 Rust：正文一改就重新起表
    if state.settings().editor.autosave {
        state.mark_autosave(&id);
    }
    Ok(dirty)
}

/// 从磁盘重读（watcher 报"外部改过了"且本地没未保存改动时走这条）。
#[tauri::command]
pub fn doc_reload(state: State<'_, Arc<AppState>>, id: String) -> R<Doc> {
    state
        .session()
        .reload(&id)
        .ok_or_else(|| format!("读不到磁盘内容（文件被删了或读不动）：{id}"))
}

#[tauri::command]
pub fn doc_set_caret(state: State<'_, Arc<AppState>>, id: String, line: u32, col: u32) -> R<()> {
    if !state.session().set_caret(&id, line, col) {
        return Err(format!("文档不存在：{id}"));
    }
    Ok(())
}

#[tauri::command]
pub fn doc_set_view_mode(state: State<'_, Arc<AppState>>, id: String, mode: ViewMode) -> R<SessionPayload> {
    let mut s = state.session();
    if !s.set_view_mode(&id, mode) {
        return Err(format!("文档不存在：{id}"));
    }
    Ok(s.payload())
}

#[tauri::command]
pub fn doc_set_layout(state: State<'_, Arc<AppState>>, id: String, layout: String) -> R<bool> {
    Ok(state.session().set_layout(&id, layout))
}

#[tauri::command]
pub fn doc_issues(state: State<'_, Arc<AppState>>, id: String) -> R<Vec<Issue>> {
    let s = state.session();
    let d = s.get(&id).ok_or_else(|| format!("文档不存在：{id}"))?;
    if !FORMAT_LINT_ENABLED {
        return Ok(Vec::new());
    }
    Ok(app_core::lint::issues(d.format, &d.body))
}

/// 设置里关掉校验时，前端拿到的就是空列表（开关在 UI 上，判定在这里）。
const FORMAT_LINT_ENABLED: bool = true;

#[tauri::command]
pub fn doc_outline(state: State<'_, Arc<AppState>>, id: String) -> R<Vec<OutlineGroup>> {
    let s = state.session();
    let d = s.get(&id).ok_or_else(|| format!("文档不存在：{id}"))?;
    Ok(app_core::outline::outline(d.format, &d.body))
}

#[tauri::command]
pub fn doc_scope(state: State<'_, Arc<AppState>>, id: String) -> R<String> {
    let s = state.session();
    let d = s.get(&id).ok_or_else(|| format!("文档不存在：{id}"))?;
    Ok(app_core::scope::current_scope(d.format, &d.body, d.caret_line))
}

/// 原子写：先写临时文件再 rename —— 写一半断电也不会留下半个文件。
pub(crate) fn atomic_write(path: &Path, contents: &str) -> R<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败：{e}"))?;
    }
    let tmp = path.with_extension("dgm-tmp");
    std::fs::write(&tmp, contents).map_err(|e| format!("写入失败：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("落盘失败：{e}"))
}

#[tauri::command]
pub fn doc_save(state: State<'_, Arc<AppState>>, id: String) -> R<Doc> {
    let path = {
        let s = state.session();
        let d = s.get(&id).ok_or_else(|| format!("文档不存在：{id}"))?;
        d.path.clone()
    };
    let path = path.ok_or_else(|| "这个文档还没有保存位置，请先「另存为」".to_string())?;
    save_to(state.inner(), &id, Path::new(&path))
}

#[tauri::command]
pub fn doc_save_as(state: State<'_, Arc<AppState>>, id: String, path: String) -> R<Doc> {
    save_to(state.inner(), &id, Path::new(&path))
}

fn save_to(state: &AppState, id: &str, path: &Path) -> R<Doc> {
    // fs scope：开了"限制在工作区内"时，这里是唯一的守门点
    state.check_writable(path)?;
    let body = {
        let s = state.session();
        s.get(id).ok_or_else(|| format!("文档不存在：{id}"))?.body.clone()
    };
    atomic_write(path, &body)?;
    let saved = state
        .session()
        .commit_saved(id, Some(path))
        .ok_or_else(|| format!("文档不存在：{id}"))?;
    // 落了盘：autosave 的倒计时取消，草稿仓里那份也没用了
    state.cancel_autosave(id);
    app_core::recovery::remove(&state.recovery_dir, id);
    state.remember_recent(
        saved.path.as_deref().unwrap_or_default(),
        &saved.name,
        saved.format,
    );
    Ok(saved)
}

/// 导出：把前端渲染好的图片（base64）落到用户选的路径。
#[tauri::command]
pub fn export_write(
    state: State<'_, Arc<AppState>>,
    path: String,
    base64: String,
) -> R<String> {
    let payload = match base64.split_once(",") {
        // 容忍 data URL 前缀
        Some((head, tail)) if head.starts_with("data:") => tail.to_string(),
        _ => base64,
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("图片数据不是合法 base64：{e}"))?;
    let p = PathBuf::from(&path);
    state.check_writable(&p)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败：{e}"))?;
    }
    std::fs::write(&p, bytes).map_err(|e| format!("写入失败：{e}"))?;
    Ok(path)
}

/// 调试通道：前端把"我走到哪一步"打到 stdout。
///
/// 为什么需要它：WebView 里的 `console.log` 在真机上没人看得见（本机还不能开 CDP），
/// 而"卡在哪一步"是排查白窗/卡死的第一件事。自检与故障排查都靠它。
#[tauri::command]
pub fn debug_note(text: String) {
    eprintln!("diagramon|note|{text}");
}

/* ---------------- 格式转换 ---------------- */

/// 格式转换。
///
/// 先问 `plan()`：**Rust 能算的就直接算**；引擎型的两个方向回一个带 `engine` 的空结果
/// （附原因），由前端把源码交给承载页 —— 不把「不是 Rust 的活」当成错误。
#[tauri::command]
pub fn convert_text(req: ConvertRequest) -> Result<ConvertOutcome, String> {
    let plan = app_core::convert::plan(req.from, req.to)?;
    if matches!(plan.engine, app_core::convert::Engine::Rust) {
        let c = app_core::convert::convert(req.from, req.to, &req.source)?;
        return Ok(ConvertOutcome {
            engine: plan.engine.id().to_string(),
            body: c.body,
            notes: c.notes,
        });
    }
    Ok(ConvertOutcome {
        engine: plan.engine.id().to_string(),
        body: String::new(),
        notes: vec![plan.reason],
    })
}

/* ---------------- 凭据（密钥永不回传前端） ---------------- */

#[tauri::command]
pub fn cred_set(state: State<'_, Arc<AppState>>, key: String, secret: String) -> R<()> {
    state
        .creds
        .set(&key, secret.trim())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cred_delete(state: State<'_, Arc<AppState>>, key: String) -> R<()> {
    state.creds.delete(&key).map_err(|e| e.to_string())
}

/* ---------------- AI ---------------- */

fn resolve_model(state: &AppState, model_id: &str) -> R<AiModel> {
    let s = state.settings();
    s.ai
        .models
        .iter()
        .find(|m| m.id == model_id)
        .cloned()
        .ok_or_else(|| format!("模型不存在：{model_id}（先在「AI 设置」里新增一个）"))
}

/// 发起一次流式对话：立刻返回，内容经 `ai://delta` / `ai://done` / `ai://failed` 推进来。
#[tauri::command]
pub async fn ai_chat(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    req: AiChatRequest,
) -> R<()> {
    let st = state.inner().clone();
    let model = resolve_model(&st, &req.model_id)?;

    let api_key = if model.provider == "ollama" {
        None
    } else {
        st.creds
            .get(&credential_key(&model.id))
            .map_err(|e| e.to_string())?
    };

    let resolved = ai::Resolved {
        provider: model.provider.clone(),
        base_url: model.base_url.clone(),
        model: model.model.clone(),
        api_key,
        max_tokens: model.max_tokens,
        temperature: model.temperature,
    };

    let messages = ai::build_messages(
        req.format,
        req.intent,
        &req.prompt,
        req.context.as_deref(),
        req.image_data_url.as_deref(),
    );

    let request_id = req.request_id.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    st.cancels().insert(request_id.clone(), cancel.clone());

    let used_model = resolved.model.clone();
    tauri::async_runtime::spawn(async move {
        let delta_app = app.clone();
        let delta_rid = request_id.clone();
        let on_delta = move |piece: &str| {
            let _ = delta_app.emit(
                events::AI_DELTA,
                AiDelta { request_id: delta_rid.clone(), delta: piece.to_string() },
            );
        };

        let result = ai::stream_chat(&st.http, &resolved, messages, &cancel, on_delta).await;

        match result {
            Ok((text, usage)) => {
                let _ = app.emit(
                    events::AI_DONE,
                    AiDone {
                        request_id: request_id.clone(),
                        text,
                        model: used_model,
                        prompt_tokens: usage.prompt_tokens,
                        completion_tokens: usage.completion_tokens,
                    },
                );
            }
            Err(ai::ChatError::Cancelled) => {
                let _ = app.emit(
                    events::AI_FAILED,
                    AiFailed { request_id: request_id.clone(), message: "已取消".into() },
                );
            }
            Err(e) => {
                let _ = app.emit(
                    events::AI_FAILED,
                    AiFailed { request_id: request_id.clone(), message: e.to_string() },
                );
            }
        }
        st.cancels().remove(&request_id);
    });

    Ok(())
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, Arc<AppState>>, id: String) -> R<()> {
    match state.cancels().get(&id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Ok(())
        }
        None => Err("这个请求已经结束了".into()),
    }
}
