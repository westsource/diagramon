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
    events, AiAgentStep, AiChatRequest, AiContextFile, AiDelta, AiDone, AiFailed, AiModel, AiThinking,
    AppInfo, ConvMeta, Conversation, ConversationTurn, ConvertOutcome, ConvertRequest, DevFlags, Doc, FormatId,
    Issue, MemoryEntry, MemoryList, MemoryScope, MemoryState, OutlineGroup,
    Session as SessionPayload, Settings, ViewMode,
};
use base64::Engine as _;
use tauri::{AppHandle, Emitter, State};

use crate::state::{credential_key, now_ms, AppState};

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
        // 「以前用过 elk 吗」——前端据此决定要不要在启动后台预热那份 2.4MB 离线包
        warm_elk: state.render_opts().wants_elk_warmup(),
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

/// 显式退出（菜单「退出」/ Ctrl+Q / 托盘「退出」）：整个应用结束。
///
/// 不走 `ipc.win.close()` 是因为 CloseRequested 分不清来源 —— 那条路会被
/// `close_to_tray` 拦成"隐藏到托盘"，菜单里点退出却把窗口藏起来是错的。
/// sync 命令返回 `()` 没问题（见文件头返回值约定）。
#[tauri::command]
pub fn app_exit(app: AppHandle) {
    app.exit(0);
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

/// 打开文件后的统一收尾：恢复「按文件记着的渲染选项」+ 记一条「最近打开」。
///
/// 两条打开入口（`doc_open_paths` 与单实例/命令行 `open_cli_files`）共用这一份 ——
/// 各写一遍必然漂，而"命令行打开的文件不记得上次选的布局"这种漂法只在真机上才看得见。
pub(crate) fn after_open_file(state: &AppState, id: &str) {
    let (path, name, format) = {
        let s = state.session();
        let Some(d) = s.get(id) else { return };
        let Some(path) = d.path.clone() else { return };
        (path, d.name.clone(), d.format)
    };
    // 上次给这个文件选的显示样式 / 布局：打开即恢复（没记过就按默认）。
    // 过滤按**此刻的格式**做：文件改过扩展名时格式变了，旧值可能已经不合法。
    let remembered = state.render_opts().get(&path).map(|o| o.sanitized(format));
    if let Some(opts) = remembered {
        state.session().restore_render_opts(id, &opts);
    }
    state.remember_recent(&path, &name, format);
}

#[tauri::command]
pub fn doc_open_paths(state: State<'_, Arc<AppState>>, paths: Vec<String>) -> SessionPayload {
    let (opened, failed) = state.session().open_paths(&paths);
    for id in &opened {
        after_open_file(state.inner(), id);
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

/// 视图模式（源码 / 分屏 / 预览）。返回**文档**（契约：单文档变更 → Doc）——
/// 早先返回的是 Session，前端 `upsertDoc` 拿到的对象没有 `id`，于是要么被忽略、
/// 要么（旧版没有 id 守卫时）把整个 Session 塞进 `state.docs`。
/// 「关掉『记住每个标签页视图模式』时其它标签一起跟」是**前端**的事（`state.setViewMode`）。
#[tauri::command]
pub fn doc_set_view_mode(state: State<'_, Arc<AppState>>, id: String, mode: ViewMode) -> R<Doc> {
    let mut s = state.session();
    // 画布型没有分屏：**拒绝**而不是悄悄改成预览（静默改写会把前端多出来的控件藏起来）
    if !s.set_view_mode(&id, mode) {
        return Err(format!("这个格式没有分屏 / 源码视图，只有预览：{id}"));
    }
    s.get(&id).cloned().ok_or_else(|| format!("文档不存在：{id}"))
}

/// 改完渲染选项后的统一收尾：把当前选项**按路径**记下来（下次打开这个文件恢复它），
/// 再把文档回给前端。
///
/// 返回值是文档本身（契约：单文档变更 → Doc）。早先这两条命令返回 `bool`，而前端
/// `if (doc) upsertDoc(doc)` —— `true` 于是被当成文档塞进 `state.docs`（真机上会多出
/// 一个空标签页，探针看不见：mock 后端返回的是 Doc）。
fn commit_render_opt(state: &AppState, id: &str) -> R<Doc> {
    let (doc, format) = {
        let s = state.session();
        let d = s.get(id).ok_or_else(|| format!("文档不存在：{id}"))?;
        (d.clone(), d.format)
    };
    // 未落盘文档没有稳定身份（路径），没处可记 —— 保存时 `save_to` 会按新路径记上
    if let Some(path) = doc.path.clone() {
        let opts = app_core::render_opts::DocOpts { look: doc.look.clone(), layout: doc.layout.clone() };
        state.remember_render_opts(None, &path, opts.sanitized(format), format);
    }
    Ok(doc)
}

#[tauri::command]
pub fn doc_set_layout(state: State<'_, Arc<AppState>>, id: String, layout: String) -> R<Doc> {
    // 合法布局由注册表说了算（DOT 六个 / D2 三个 / Mermaid 两个）；不认的值明确报错，
    // 而不是悄悄忽略 —— 前端只提供注册表里的值，走到这里说明两侧契约漂了。
    if !state.session().set_layout(&id, layout.clone()) {
        return Err(format!("这个格式没有布局引擎「{layout}」"));
    }
    commit_render_opt(state.inner(), &id)
}

#[tauri::command]
pub fn doc_set_look(state: State<'_, Arc<AppState>>, id: String, look: String) -> R<Doc> {
    // 同上：外观模式（auto / classic / neo / handDrawn）只在 Mermaid 上存在
    if !state.session().set_look(&id, look.clone()) {
        return Err(format!("这个格式没有外观模式「{look}」"));
    }
    commit_render_opt(state.inner(), &id)
}

/// 把一个外部文件读成 AI 上下文（拖进对话框 / 手填全路径都走这条）。
///
/// 上限、二进制与编码判定都在 `app_core::context_file`（带单测）：这里只转发。
/// **不受"限制在工作区内"约束** —— 那个开关管的是写路径，读用户自己指名的参考文件
/// 不该被它拦住。
#[tauri::command]
pub fn file_read_text(path: String) -> R<AiContextFile> {
    app_core::context_file::read(Path::new(&path))
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
    // 旧会话身份要在 commit_saved **之前**抓：commit 之后 `path` 已经变了。
    // 未保存文档 → draft 键；已有路径的文档（另存为）→ 旧路径的文档键。
    let (old_key, old_path) = {
        let s = state.session();
        let d = s.get(id).ok_or_else(|| format!("文档不存在：{id}"))?;
        (app_core::conversations::key_for(d.path.as_deref(), id), d.path.clone())
    };
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
    // 会话跟着文件走：把旧键下的会话迁到新键。另存为也要迁，否则历史留在旧文件上、
    // 新文件打开是空的 —— 用户会认为"另存为把对话弄丢了"。迁移失败不影响保存本身。
    let path_text = path.to_string_lossy().to_string();
    let new_key = app_core::conversations::doc_key(&path_text);
    if let Err(e) =
        app_core::conversations::migrate(&state.paths.conversations_dir(), &old_key, &new_key, Some(&path_text))
    {
        eprintln!("diagramon|conv-migrate|{e}");
    }
    state.remember_recent(
        saved.path.as_deref().unwrap_or_default(),
        &saved.name,
        saved.format,
    );
    // 「按文件记着」的渲染选项也跟着文件走：另存为把旧路径的记录挪到新路径（旧路径不留在原地），
    // 首次保存的文档则把这次的选择记在新路径上 —— 否则"另存为之后外观/布局又回到默认"。
    let opts = state.session().render_opts(id); // 先取值再放手（不把会话锁带进落盘那段）
    if let Some(opts) = opts {
        state.remember_render_opts(
            old_path.as_deref(),
            saved.path.as_deref().unwrap_or_default(),
            opts.sanitized(saved.format),
            saved.format,
        );
    }
    Ok(saved)
}

/// 导出允许的扩展名（小写）。**白名单而非黑名单**：这条命令的路径来自前端，
/// 万一 webview 侧被注入脚本（审计 F-2 的前提），不能让它借这里往磁盘投
/// 可执行物（.exe/.bat/.ps1/.hta/…）。图片是用户导出；`.json` 是真机自检的
/// 报告落盘；`.mmd` 是自检造工作区用的演示文件（见 `ui/js/main.js`）。
const EXPORT_EXTS: &[&str] = &["png", "jpg", "jpeg", "svg", "webp", "json", "mmd", "md"];

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
        // 空闲上限按**这个模型**解析（留空 = 自动：ollama 300s / 其它 90s）——
        // 它决定 `ai_chat` 用哪个客户端实例（reqwest 的 read_timeout 只能建在客户端上）
        idle_timeout: ai::provider::idle_timeout_for(&model.provider, model.idle_timeout_s),
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
        &req.files,
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

        // 空闲档决定用哪个客户端实例（reqwest 的 read_timeout 只能在 ClientBuilder 上设）；
        // 云网关解析出的就是默认档，取回的是同一个默认池。
        let http = st.http_for_idle(resolved.idle_timeout);
        // messages 先 clone 进第一次调用：401 重试要用原来的再发一遍
        let mut result =
            ai::stream_chat(&http, &resolved, messages.clone(), &cancel, on_delta).await;

        // 网络类失败（请求没送达 / 一帧未到就断）**自动重试一次**。走到 `Network` 就
        // 意味着用户一个字都没收到 —— 收到正文后断流会原样交付（Ok），收到思考后断流
        // 是 `Interrupted`（上游已计费，重试是用户的决定）—— 都不会进到这里，所以
        // 这里重试不会让用户看到重复内容，上游大概率也还没产出，计费风险可接受。
        // （真机实录 2026-10-16：改图流中途连接静默断死，报 "error decoding response
        // body"，用户只能手动重发。）
        if matches!(result, Err(ai::ChatError::Network(_))) && !cancel.load(Ordering::Relaxed) {
            let on_delta_retry = delta_forwarder(app.clone(), request_id.clone());
            result =
                ai::stream_chat(&http, &resolved, messages.clone(), &cancel, on_delta_retry)
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
                            let http2 = st.http_for_idle(resolved2.idle_timeout);
                            result = ai::stream_chat(&http2, &resolved2, messages, &cancel, on_delta2).await;
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
                        // 流是怎么结束的：`length` = 被输出上限截断，`interrupted` = 中途断流。
                        // 前端据此把"半句话"说清楚（以前这两个状态在界面上看不见）。
                        finish: usage.finish.as_str().to_string(),
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
        &req.files,
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
        let http = st.http_for_idle(resolved.idle_timeout);
        let completer = ai::HttpCompleter { client: &http, resolved: &resolved };
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
                        // 工具循环是**非流式多步**，没有"流结束"这回事：终态留给上游解析，
                        // 这里如实报"这条路不给终态"（界面只对已知值动作，见 `AiDone.finish`）。
                        finish: String::new(),
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

/// 把文档解析成"会话身份"：`(key, path)`。
///
/// 身份有两种（3.8.0 起）：
///
/// * 文档有路径 → `doc_key(path)`（路径 SHA256）—— 路径才是跨会话稳定的东西；
/// * 文档还没保存 → `draft-<doc.id>` —— 未保存文档本来就在草稿仓（`recovery/`）里，
///   重启时 `adopt_draft` **保留原 id**，所以草稿会话重启后仍指得回同一份文档。
///   这是"从无到有生成图"的对话不再丢的关键：以前这类文档返回 `None`，
///   `conversation_save` 直接回 `false`，整段对话从未落盘。
///
/// 路径返回空串表示草稿（写进会话的 `path` 字段，仅供人工排查）。
fn conversation_key(state: &AppState, doc_id: &str) -> R<(String, String)> {
    let s = state.session();
    let d = s.get(doc_id).ok_or_else(|| format!("文档不存在：{doc_id}"))?;
    Ok((
        app_core::conversations::key_for(d.path.as_deref(), doc_id),
        d.path.clone().unwrap_or_default(),
    ))
}

/* ---------------- 对话历史（全部会话） ---------------- */

/// 「对话历史 → 全部」：读出全部会话的元数据（按更新时间倒序，最多 `MAX_LIST` 条）。
///
/// 只读 meta（`<key>.meta.json`），**不解析会话全文**（思考原文落盘后单份可能上百 KB）。
/// 旧会话没有 meta 时就地补写一次（见 `conversations::list`）。
#[tauri::command]
pub fn conversation_list(state: State<'_, Arc<AppState>>) -> R<Vec<ConvMeta>> {
    Ok(app_core::conversations::list(
        &state.paths.conversations_dir(),
        &state.recovery_dir,
    ))
}

/// 按**会话键**读回全文（列表的「导出 Markdown」用；`conversation_load` 是按文档 id 取）。
#[tauri::command]
pub fn conversation_read(state: State<'_, Arc<AppState>>, key: String) -> R<Conversation> {
    Ok(app_core::conversations::load(&state.paths.conversations_dir(), &key))
}

/// 删掉一段会话（含 meta）。只动本机这一份，**不动用户的文件**。
#[tauri::command]
pub fn conversation_delete(state: State<'_, Arc<AppState>>, key: String) -> R<bool> {
    app_core::conversations::clear(&state.paths.conversations_dir(), &key)?;
    Ok(true)
}

/// 打开 / 恢复一段会话对应的文档（「对话历史 → 全部」的主动作）。
///
/// 三种归属三种做法（《AI会话找回方案》§4.4）：
/// * **文档**（路径还在）→ 打开那个文件；已开着就切过去；
/// * **草稿**（还没保存、草稿仓里还活着）→ 就是那个未保存的标签页，激活它；
/// * **已失联**（文件没了 / 草稿也关了）→ **恢复成一张新标签页**：新建同格式文档，把会话
///   搬到新身份下。恢复只带对话与生成的代码 —— 原文件里的手工改动回不来，界面要讲清楚。
#[tauri::command]
pub fn conversation_open(state: State<'_, Arc<AppState>>, key: String) -> R<Doc> {
    let dir = state.paths.conversations_dir();
    let meta = app_core::conversations::list(&dir, &state.recovery_dir)
        .into_iter()
        .find(|m| m.key == key)
        .ok_or_else(|| format!("找不到这段会话：{key}"))?;

    // ① 文档：打开磁盘上的那份（与 `doc_open_paths` 共用收尾：恢复渲染选项 + 最近打开）
    if !meta.path.is_empty() && !meta.missing {
        let (opened, failed) = state.session().open_paths(&[meta.path.clone()]);
        let Some(id) = opened.first().cloned() else {
            return Err(failed
                .first()
                .map(|(_, e)| e.clone())
                .unwrap_or_else(|| "打开失败".to_string()));
        };
        after_open_file(state.inner(), &id);
        return state.session().get(&id).cloned().ok_or_else(|| format!("文档不存在：{id}"));
    }

    // ② 草稿还活着：那个未保存的标签页就是它
    if meta.live_draft {
        if let Some(id) = key.strip_prefix("draft-") {
            if state.session().activate(id) {
                return state.session().get(id).cloned().ok_or_else(|| format!("文档不存在：{id}"));
            }
        }
    }

    // ③ 已失联：新开一张同格式标签页，把会话搬过去，并**把最后生成的那张图放回正文**。
    //    只搬对话等于恢复出一个见面示例图 —— "会话在、图没了"，这个恢复就没意义。
    //    代码取自会话里最后一个匹配格式的 ``` 围栏；手工改动本来就不在会话里（界面文案已写明）。
    let conv = app_core::conversations::load(&dir, &key);
    let restored = app_core::conversations::last_generated_code(&conv.turns, &meta.format);
    let fmt = FormatId::from_str_opt(&meta.format)
        .or_else(|| restored.as_ref().map(|(f, _)| *f))
        .unwrap_or(FormatId::Mermaid);
    let doc = state.session().new_doc(fmt);
    if let Some((_, code)) = restored {
        state.session().set_body(&doc.id, code);
    }
    let to = app_core::conversations::key_for(None, &doc.id);
    app_core::conversations::migrate(&dir, &key, &to, None)?;
    state.session()
        .get(&doc.id)
        .cloned()
        .ok_or_else(|| format!("文档不存在：{}", doc.id))
}

/// 清理 N 天前的**已失联**会话（「对话历史 → 全部」顶栏那个动作）。
///
/// 只清孤儿：文件还在的文档会话、草稿仓里还活着的草稿会话**永远不动** ——
/// 会话删了就回不来，误删比留着更糟。返回清掉的条数。
#[tauri::command]
pub fn conversation_prune(state: State<'_, Arc<AppState>>, days: u32) -> R<u32> {
    let dir = state.paths.conversations_dir();
    let cutoff = now_ms() - (days.max(1) as i64) * 86_400_000;
    let mut n = 0u32;
    for m in app_core::conversations::list(&dir, &state.recovery_dir) {
        let orphan = (!m.path.is_empty() && m.missing) || (m.path.is_empty() && !m.live_draft);
        if orphan && m.updated_at < cutoff {
            app_core::conversations::clear(&dir, &m.key)?;
            n += 1;
        }
    }
    Ok(n)
}

/// 读该文档的会话。没存过 → 空会话。
#[tauri::command]
pub fn conversation_load(state: State<'_, Arc<AppState>>, id: String) -> R<Conversation> {
    let (key, _path) = conversation_key(&state, &id)?;
    Ok(app_core::conversations::load(&state.paths.conversations_dir(), &key))
}

/// 存该文档的会话。返回 `false` = **真写盘失败**（此时界面要提示一次）；
/// 未保存文档走草稿身份，照样落盘并返回 `true`。
#[tauri::command]
pub fn conversation_save(
    state: State<'_, Arc<AppState>>,
    id: String,
    turns: Vec<ConversationTurn>,
) -> R<bool> {
    let (key, path) = conversation_key(&state, &id)?;
    let (name, format) = {
        let s = state.session();
        let d = s.get(&id).ok_or_else(|| format!("文档不存在：{id}"))?;
        (d.name.clone(), d.format.as_str().to_string())
    };
    let conv = Conversation { doc_key: key, path, turns, updated_at: now_ms() };
    app_core::conversations::save_doc(
        &state.paths.conversations_dir(),
        &conv,
        &name,
        &format,
    )?;
    Ok(true)
}

/// 清该文档的会话（含 meta）。
#[tauri::command]
pub fn conversation_clear(state: State<'_, Arc<AppState>>, id: String) -> R<bool> {
    let (key, _path) = conversation_key(&state, &id)?;
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
    let Ok((text, _usage)) = ai::chat_once(&st.http_for_idle(resolved.idle_timeout), &resolved, messages).await else {
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
