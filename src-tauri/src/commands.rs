//! 命令层：前端 `invoke` 的落点。
//!
//! 命名与载荷**逐字段对齐** `crates/app-ipc/src/lib.rs`（那里是唯一真源）。
//! 这里只做三件事：校验入参、动状态、必要时派任务；业务逻辑一律下沉到 `app-core` / `ai`。
//!
//! **返回值约定**：`async` 命令**一律返回有意义的值**（bool/String/结构体），
//! 不许返回 `Result<(), _>` —— `async` + 单元类型 `Ok(())` 的响应会被
//! WebView2/wry 静默丢弃，前端 `await` 永不结算且无任何报错（真机实测，
//! 曾让 AI 对话整条链路卡死）。`sync` 命令返回 `()` 没问题。
//!
//! **参数命名约定**：命令参数一律**单个词**（`id` / `path` / `name` / `req`）。
//! Tauri 会对命令参数做驼峰↔下划线转换，多词参数一旦两侧不一致就只在真机上炸
//! （报 "invalid args"，测试里看不见）。单词参数没有这个坑。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use app_ipc::{
    events, AiAgentStep, AiChatRequest, AiDelta, AiDone, AiFailed, AiModel, AiThinking, AppInfo,
    Conversation, ConversationTurn, ConvertOutcome, ConvertRequest, DevFlags, Doc, FormatId, Issue,
    MemoryEntry, MemoryList, MemoryScope, MemoryState, OutlineGroup, Session as SessionPayload,
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
        limits: app_core::guard::limits(),
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
///
/// 临时名用**追加后缀**而不是 `with_extension`：`with_extension` 会替换原扩展名
/// （`a.drawio` → `a.dgm-tmp`），同目录下 `foo.mmd` 与 `foo.drawio` 并存且同时
/// 保存时会互踩同一份临时文件。`a.mmd.dgm-tmp` 的扩展名是 `dgm-tmp`，
/// watcher 的 `is_open_ext` 过滤天然忽略它。
pub(crate) fn atomic_write(path: &Path, contents: &str) -> R<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败：{e}"))?;
    }
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| "路径没有文件名".to_string())?;
    let tmp = path.with_file_name(format!("{file_name}.dgm-tmp"));
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

/// 导出允许的扩展名（小写）。**白名单而非黑名单**：这条命令的路径来自前端，
/// 万一 webview 侧被注入脚本（审计 F-2 的前提），不能让它借这里往磁盘投
/// 可执行物（.exe/.bat/.ps1/.hta/…）。图片是用户导出；`.json` 是真机自检的
/// 报告落盘；`.mmd` 是自检造工作区用的演示文件（见 `ui/js/main.js`）。
const EXPORT_EXTS: &[&str] = &["png", "jpg", "jpeg", "svg", "webp", "json", "mmd"];

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
    // 扩展名白名单（审计 F-3）：另存为走系统对话框是用户本人的授权，不走这里；
    // 这条命令是前端可直接调的，必须自带边界。
    let ext_ok = p
        .extension()
        .map(|e| {
            let e = e.to_string_lossy().to_ascii_lowercase();
            EXPORT_EXTS.contains(&e.as_str())
        })
        .unwrap_or(false);
    if !ext_ok {
        return Err(format!(
            "导出只支持 {} 格式，不能写：{path}",
            EXPORT_EXTS.join(" / ")
        ));
    }
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

/// 写某个 BYOK 模型的密钥。
///
/// **键名的唯一真源在 Rust**（`state::credential_key`）—— 前端不许自己拼前缀。
/// 2026-10-14 的 bug 就是这么来的：设置对话框拿**原始 id** 去 `cred_set`，而读取端
/// （`hydrate_models` / `resolve_target`）查的是 `ai-model:{id}` —— 于是"填了密钥仍显示
/// 未配置、一调用就报缺少 API Key"（BYOK 整条路都不可用）。新模型也一样能写：
/// 这里只要 id，不必先落进 settings。
#[tauri::command]
pub fn ai_model_key_set(state: State<'_, Arc<AppState>>, model_id: String, secret: String) -> R<()> {
    state
        .creds
        .set(&credential_key(&model_id), secret.trim())
        .map_err(|e| e.to_string())
}

/// 删某个模型的密钥（模型被删掉时顺手清，别在凭据库里留孤儿）。
#[tauri::command]
pub fn ai_model_key_delete(state: State<'_, Arc<AppState>>, model_id: String) -> R<()> {
    state
        .creds
        .delete(&credential_key(&model_id))
        .map_err(|e| e.to_string())
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

/// 解析这次对话用哪个模型。**两条来源互不混用**，靠 id 前缀分流：
///   - `gw:<别名>` → 云网关（密钥 = 当前 access token，base_url 由服务地址推导）；
///   - 其它 → 本地 BYOK（`settings.ai.models`，密钥在凭据库）。
///
/// 分流**只有这一处**：下游（`build_body` / SSE 解析 / 取消 / usage）对两条来源完全一样，
/// 因为网关在客户端眼里就是一个 OpenAI 兼容 provider。
///
/// 网关那条**不在本地兜底取密钥**：没登录就直说没登录，不要拿一段过期字符串去撞 401。
async fn resolve_target(state: &AppState, model_id: &str) -> R<ai::Resolved> {
    if let Some(alias) = model_id.strip_prefix(app_ipc::GATEWAY_MODEL_PREFIX) {
        return crate::cloud::gateway_resolved(state, alias).await;
    }

    let model = resolve_model(state, model_id)?;
    let api_key = if model.provider == "ollama" {
        None
    } else {
        state
            .creds
            .get(&credential_key(&model.id))
            .map_err(|e| e.to_string())?
    };
    Ok(ai::Resolved {
        provider: model.provider.clone(),
        base_url: model.base_url.clone(),
        model: model.model.clone(),
        api_key,
        // BYOK 这两个值是用户自己配的，必须原样下发（网关那条相反：交给服务端钳）
        max_tokens: Some(model.max_tokens),
        temperature: Some(model.temperature),
    })
}

/// 会话过期类错误统一收尾：广播 `cloud://changed`，让侧栏**立刻**回到未登录 ——
/// 别再出现"侧栏登录着、AI 一调就报 token 过期"的假象（2026-10-16 用户反馈）。
/// 错误本身继续由调用方上抛。
fn note_session_error(app: &AppHandle, err: &str) {
    if err.contains(crate::cloud::ERR_SESSION_EXPIRED) {
        let _ = app.emit(events::CLOUD_CHANGED, ());
    }
}

/// 正文与思考走两条事件：界面在"还没有正文"时要能显示思考进度（见 Chunk 的说明）。
/// 收成一个函数：401 续期重试需要**第二个**转发闭包（FnMut 不可克隆）。
fn delta_forwarder(app: tauri::AppHandle, request_id: String) -> impl FnMut(ai::Chunk) {
    move |chunk: ai::Chunk| match chunk {
        ai::Chunk::Text(piece) => {
            let _ = app.emit(
                events::AI_DELTA,
                AiDelta { request_id: request_id.clone(), delta: piece },
            );
        }
        ai::Chunk::Reasoning(piece) => {
            let _ = app.emit(
                events::AI_THINKING,
                AiThinking { request_id: request_id.clone(), delta: piece },
            );
        }
    }
}

/// 发起一次流式对话：立刻返回，内容经 `ai://delta` / `ai://done` / `ai://failed` 推进来。
#[tauri::command]
pub async fn ai_chat(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    req: AiChatRequest,
) -> R<bool> {
    let st = state.inner().clone();
    let resolved = match resolve_target(&st, &req.model_id).await {
        Ok(r) => r,
        Err(e) => {
            note_session_error(&app, &e);
            return Err(e);
        }
    };

    let messages = ai::build_messages_with_history(
        req.format,
        req.intent,
        &req.prompt,
        req.context.as_deref(),
        req.image_data_url.as_deref(),
        &req.history,
    );
    // 长期记忆：作为**独立的 system 消息**注入（不改 `system_prompt` 本身）。
    // 关掉开关时这里拿到 `None`，请求体与没有记忆时**逐字节一致**。
    let messages = match memory_block(&st, &active_doc_key(&st)) {
        Some(block) => ai::inject_memory(messages, &block),
        None => messages,
    };

    let request_id = req.request_id.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    st.cancels().insert(request_id.clone(), cancel.clone());

    let used_model = resolved.model.clone();
    // 只有网关模型做 401 续期重试：BYOK 的 401 是用户自己的密钥坏了，重试没有意义
    let gateway = req.model_id.starts_with(app_ipc::GATEWAY_MODEL_PREFIX);
    let model_id = req.model_id.clone();
    tauri::async_runtime::spawn(async move {
        let on_delta = delta_forwarder(app.clone(), request_id.clone());

        // messages 先 clone 进第一次调用：401 重试要用原来的再发一遍
        let mut result =
            ai::stream_chat(&st.http, &resolved, messages.clone(), &cancel, on_delta).await;

        // 网络类失败（请求没送达 / 一帧未到就断）**自动重试一次**。走到 `Network` 就
        // 意味着用户一个字都没收到 —— 收到正文后断流会原样交付（Ok），收到思考后断流
        // 是 `Interrupted`（上游已计费，重试是用户的决定）—— 都不会进到这里，所以
        // 这里重试不会让用户看到重复内容，上游大概率也还没产出，计费风险可接受。
        // （真机实录 2026-10-16：改图流中途连接静默断死，报 "error decoding response
        // body"，用户只能手动重发。）
        if matches!(result, Err(ai::ChatError::Network(_))) && !cancel.load(Ordering::Relaxed) {
            let on_delta_retry = delta_forwarder(app.clone(), request_id.clone());
            result =
                ai::stream_chat(&st.http, &resolved, messages.clone(), &cancel, on_delta_retry)
                    .await;
        }

        // 网关 401 = access token 在服务端被拒（本地看还没过期/时钟不同步都可能）：
        // 续期一次再试一轮 —— 此时尚未向前端输出任何内容，重试是安全的。
        if gateway {
            if let Err(ai::ChatError::Http { status: 401, .. }) = &result {
                match crate::cloud::refresh_tokens(&st).await {
                    Ok(_) => {
                        if let Ok(resolved2) = resolve_target(&st, &model_id).await {
                            let on_delta2 = delta_forwarder(app.clone(), request_id.clone());
                            result = ai::stream_chat(&st.http, &resolved2, messages, &cancel, on_delta2).await;
                        }
                    }
                    Err(e) if !crate::cloud::is_network_failure(&e) => {
                        // 续期被服务端拒绝 = 会话真的死了：清凭据 + 广播，界面立刻回未登录
                        crate::cloud::clear_session(&st);
                        let _ = app.emit(events::CLOUD_CHANGED, ());
                        result = Err(ai::ChatError::Session(crate::cloud::ERR_SESSION_EXPIRED.into()));
                    }
                    Err(_) => {}
                }
            }
        }

        match result {
            Ok((text, _reasoning, usage)) => {
                let _ = app.emit(
                    events::AI_DONE,
                    AiDone {
                        request_id: request_id.clone(),
                        text,
                        model: used_model,
                        prompt_tokens: usage.prompt_tokens,
                        completion_tokens: usage.completion_tokens,
                        reasoning_tokens: usage.reasoning_tokens,
                        usage_source: if usage.reported() { "server" } else { "none" }.to_string(),
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

    // **不能返回 `Ok(())`**：`async` 命令返回 `Result<(), String>` 时，
    // 响应会被 WebView2/wry 静默丢掉，前端 `await` 永远不结算（真机实测）。
    // `sync` + `()` 没问题（doc_set_caret / cred_set），所以规矩是：
    // **async 命令一律返回有意义的值**。
    Ok(true)
}

/* ---------------- AI 受控工具循环 ---------------- */

/// 把工具结果截成"给界面看的一行"：换行折叠、超长截断。
/// 回给模型的**完整**结果已经在对话里，这里只是活动播报，别把整个工具输出又塞回前端。
fn step_summary(s: &str) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(160).collect();
    if flat.chars().count() > 160 {
        out.push('…');
    }
    out
}

/// 包装一层工具：每次执行都向界面播报 `ai://agent`。
///
/// 包在**工具**上而不是给循环加回调，是有意的 —— `ai::agent::run` 的签名保持不变
/// （方案红线：`crates/ai` 只做加法），而工具执行本来就是"活动发生"的确切时刻。
struct ReportingTool {
    inner: Box<dyn ai::Tool>,
    app: AppHandle,
    request_id: String,
    step: Arc<AtomicU32>,
}

impl ai::Tool for ReportingTool {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn schema(&self) -> serde_json::Value {
        self.inner.schema()
    }

    fn call(&self, args: &serde_json::Value) -> Result<String, String> {
        let n = self.step.fetch_add(1, Ordering::Relaxed) + 1;
        let result = self.inner.call(args);
        let (ok, summary) = match &result {
            Ok(text) => (true, step_summary(text)),
            Err(e) => (false, step_summary(e)),
        };
        let _ = self.app.emit(
            events::AI_AGENT,
            AiAgentStep {
                request_id: self.request_id.clone(),
                step: n,
                tool: self.inner.name().to_string(),
                summary,
                ok,
            },
        );
        result
    }
}

/// 受控工具循环：请求体与 `ai_chat` 完全相同（`AiChatRequest`），模型侧换成
/// **非流式多步**（`ai::agent::run`），每步工具活动经 `ai://agent` 播报，
/// 收尾与 `ai_chat` 一致（`ai://done` / `ai://failed`）。
///
/// 工具只作用于**当前活动文档**的内存模型（`ai_tools::build`）——
/// 与记忆的作用域同一来源（`session.active`），不新增请求字段。
#[tauri::command]
pub async fn ai_agent_run(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    req: AiChatRequest,
) -> R<bool> {
    let st = state.inner().clone();
    let resolved = match resolve_target(&st, &req.model_id).await {
        Ok(r) => r,
        Err(e) => {
            note_session_error(&app, &e);
            return Err(e);
        }
    };

    // 工具作用的对象是**当前活动文档**，与记忆的作用域同一来源（`session.payload().active`）
    let doc_id = st.session().payload().active.unwrap_or_default();
    let tools = crate::ai_tools::build(st.clone(), doc_id);

    let messages = ai::build_messages_with_history(
        req.format,
        req.intent,
        &req.prompt,
        req.context.as_deref(),
        req.image_data_url.as_deref(),
        &req.history,
    );
    // 长期记忆与 `ai_chat` 同一套注入（关掉时逐字节一致）
    let messages = match memory_block(&st, &active_doc_key(&st)) {
        Some(block) => ai::inject_memory(messages, &block),
        None => messages,
    };

    let request_id = req.request_id.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    st.cancels().insert(request_id.clone(), cancel.clone());

    let used_model = resolved.model.clone();
    tauri::async_runtime::spawn(async move {
        let completer = ai::HttpCompleter { client: &st.http, resolved: &resolved };
        let step = Arc::new(AtomicU32::new(0));
        let wrapped: Vec<Box<dyn ai::Tool>> = tools
            .into_iter()
            .map(|t| {
                Box::new(ReportingTool {
                    inner: t,
                    app: app.clone(),
                    request_id: request_id.clone(),
                    step: step.clone(),
                }) as Box<dyn ai::Tool>
            })
            .collect();

        let result = ai::run(&completer, messages, &wrapped, ai::DEFAULT_MAX_STEPS, &cancel).await;

        match result {
            Ok(outcome) => {
                let _ = app.emit(
                    events::AI_DONE,
                    AiDone {
                        request_id: request_id.clone(),
                        text: outcome.text,
                        model: used_model,
                        prompt_tokens: None,
                        completion_tokens: None,
                        reasoning_tokens: None,
                        usage_source: "none".to_string(),
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

    // 与 `ai_chat` 同一条真机教训：async 命令返回 `Result<(), _>` 会被 wry 静默吞掉
    Ok(true)
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

/* ---------------- AI 会话持久化 ---------------- */

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 把文档解析成"会话身份"：`(doc_key, 路径)`。
///
/// **只有存过盘的文档才有稳定身份。** 未保存文档返回 `None` —— 调用方据此如实告诉用户
/// "本文档尚未保存，对话只在本次运行内有效"，而不是伪造一份重启就丢的"持久化"。
///
/// 身份用**路径的 SHA256**（`app-core::conversations::doc_key`），不用文档 id：
/// 文档 id 是本次运行内的临时标识，拿它当文件名等于永远读不回来。
fn conversation_key(state: &AppState, doc_id: &str) -> R<Option<(String, String)>> {
    let s = state.session();
    let d = s.get(doc_id).ok_or_else(|| format!("文档不存在：{doc_id}"))?;
    Ok(d.path
        .as_deref()
        .map(|p| (app_core::conversations::doc_key(p), p.to_string())))
}

/// 读该文档的会话。没有稳定身份（未保存）或没存过 → 空会话。
#[tauri::command]
pub fn conversation_load(state: State<'_, Arc<AppState>>, id: String) -> R<Conversation> {
    let Some((key, _path)) = conversation_key(&state, &id)? else {
        return Ok(Conversation::default());
    };
    Ok(app_core::conversations::load(&state.paths.conversations_dir(), &key))
}

/// 存该文档的会话。返回 `false` = **没落盘**（未保存文档，界面要如实标注）。
#[tauri::command]
pub fn conversation_save(
    state: State<'_, Arc<AppState>>,
    id: String,
    turns: Vec<ConversationTurn>,
) -> R<bool> {
    let Some((key, path)) = conversation_key(&state, &id)? else {
        return Ok(false);
    };
    let conv = Conversation { doc_key: key, path, turns, updated_at: now_ms() };
    app_core::conversations::save(&state.paths.conversations_dir(), &conv)?;
    Ok(true)
}

/// 清该文档的会话。返回 `false` = 没有可清的东西（未保存文档）。
#[tauri::command]
pub fn conversation_clear(state: State<'_, Arc<AppState>>, id: String) -> R<bool> {
    let Some((key, _path)) = conversation_key(&state, &id)? else {
        return Ok(false);
    };
    app_core::conversations::clear(&state.paths.conversations_dir(), &key)?;
    Ok(true)
}

/* ---------------- AI 长期记忆 ---------------- */

/// 某个文档的稳定身份（不存在 / 未保存 ⇒ 空串）。
fn doc_key_of(state: &AppState, doc_id: &str) -> String {
    if doc_id.is_empty() {
        return String::new();
    }
    let s = state.session();
    s.get(doc_id)
        .and_then(|d| d.path.clone())
        .map(|p| app_core::conversations::doc_key(&p))
        .unwrap_or_default()
}

/// **当前活动文档**的稳定身份。记忆的作用域判定要用它 ——
/// AI 面板永远是"针对当前这份文档"的，请求体里也就没有必要再带一次 doc id。
///
/// 走 `payload().active` 而不是读 `Session` 的字段：`active` 是私有的，
/// 且 `payload()` 本来就是"对外可读的那一份"（契约在 `app-ipc`）。
fn active_doc_key(state: &AppState) -> String {
    let s = state.session();
    let payload = s.payload();
    payload
        .active
        .as_deref()
        .and_then(|id| s.get(id))
        .and_then(|d| d.path.clone())
        .map(|p| app_core::conversations::doc_key(&p))
        .unwrap_or_default()
}

/// 组装要注入的记忆块。**开关关掉 ⇒ `None`**，请求体于是与没有记忆时完全一致。
fn memory_block(state: &AppState, doc_key: &str) -> Option<String> {
    if !state.settings().ai.memory_enabled {
        return None;
    }
    let items = app_core::memory::load(&state.paths.memory_dir());
    let block = app_core::memory::prompt_block(&items, doc_key, app_core::memory::PROMPT_MAX_CHARS);
    if block.trim().is_empty() {
        None
    } else {
        Some(block)
    }
}

fn memory_list(state: &AppState, doc_id: &str) -> MemoryList {
    MemoryList {
        items: app_core::memory::load(&state.paths.memory_dir()),
        doc: doc_key_of(state, doc_id),
    }
}

#[tauri::command]
pub fn ai_memory_list(state: State<'_, Arc<AppState>>, id: String) -> R<MemoryList> {
    Ok(memory_list(&state, &id))
}

/// 新增或更新一条（同 id 即更新）。**内容为空 / 已达条数上限** ⇒ 明确报错，不静默吞掉。
#[tauri::command]
pub fn ai_memory_save(
    state: State<'_, Arc<AppState>>,
    id: String,
    entry: MemoryEntry,
) -> R<MemoryList> {
    let dir = state.paths.memory_dir();
    let mut items = app_core::memory::load(&dir);
    if !app_core::memory::upsert(&mut items, entry) {
        return Err("这条记忆是空的，或已经达到条数上限".into());
    }
    app_core::memory::save(&dir, &items)?;
    Ok(memory_list(&state, &id))
}

#[tauri::command]
pub fn ai_memory_delete(
    state: State<'_, Arc<AppState>>,
    id: String,
    entry: String,
) -> R<MemoryList> {
    let dir = state.paths.memory_dir();
    let mut items = app_core::memory::load(&dir);
    items.retain(|e| e.id != entry);
    app_core::memory::save(&dir, &items)?;
    Ok(memory_list(&state, &id))
}

/// 清空。`kind == "pending"` 只清"待确认"的候选（用户想扔掉模型猜的那些但保留自己写的）。
#[tauri::command]
pub fn ai_memory_clear(state: State<'_, Arc<AppState>>, id: String, kind: String) -> R<MemoryList> {
    let dir = state.paths.memory_dir();
    let mut items = app_core::memory::load(&dir);
    if kind == "pending" {
        items.retain(|e| e.state != MemoryState::Pending);
    } else {
        items.clear();
    }
    app_core::memory::save(&dir, &items)?;
    Ok(memory_list(&state, &id))
}

/// 一轮对话结束后让模型总结候选记忆，写成 `Pending`（**不注入**，等用户确认）。
///
/// 这是**额外一次真实调用**，所以两道开关都要放行才发：`memory_enabled` ∧ `memory_auto`。
/// 拿不到候选、解析失败、上游报错 —— 一律**静默返回当前清单**：记忆是锦上添花，
/// 它失败了不该在界面上报一次错（那会让用户以为对话本身出了问题）。
#[tauri::command]
pub async fn ai_memory_extract(
    state: State<'_, Arc<AppState>>,
    id: String,
    model_id: String,
    prompt: String,
    reply: String,
) -> R<MemoryList> {
    let st = state.inner().clone();
    let (enabled, auto) = {
        let s = st.settings();
        (s.ai.memory_enabled, s.ai.memory_auto)
    };
    if !enabled || !auto || prompt.trim().is_empty() || reply.trim().is_empty() {
        return Ok(memory_list(&st, &id));
    }

    let dir = st.paths.memory_dir();
    let mut items = app_core::memory::load(&dir);
    if items.len() >= app_core::memory::MAX_ENTRIES {
        return Ok(memory_list(&st, &id));
    }

    let resolved = resolve_target(&st, &model_id).await?;
    let messages = vec![
        serde_json::json!({ "role": "system", "content": ai::MEMORY_EXTRACT_SYSTEM }),
        serde_json::json!({ "role": "user", "content": ai::memory_extract_user(&prompt, &reply) }),
    ];
    let Ok((text, _usage)) = ai::chat_once(&st.http, &resolved, messages).await else {
        return Ok(memory_list(&st, &id));
    };

    let now = now_ms();
    let mut added = false;
    for (i, text) in ai::parse_memory_candidates(&text).into_iter().enumerate() {
        // 清单里已有的（不论状态）不再重复收 —— 否则同一句偏好会一轮攒一条
        if items.iter().any(|e| e.text.trim().eq_ignore_ascii_case(text.trim())) {
            continue;
        }
        let entry = MemoryEntry {
            id: format!("mem-{now}-{i}"),
            text,
            // 自动候选默认**全局**：偏好多半跨文档成立；用户确认时可以改成"本文档"
            scope: MemoryScope::Global,
            doc: String::new(),
            state: MemoryState::Pending,
            source: "auto".into(),
            enabled: true,
            at: now + i as i64,
        };
        if app_core::memory::upsert(&mut items, entry) {
            added = true;
        }
    }
    if added {
        let _ = app_core::memory::save(&dir, &items);
    }
    Ok(memory_list(&st, &id))
}
