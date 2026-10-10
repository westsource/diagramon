//! 工作区与全库搜索的命令层。
//!
//! 契约见 `crates/app-ipc/src/lib.rs`（那里是唯一真源）。
//!
//! **参数命名约定**：命令参数一律**单个词**（`id` / `path` / `name`）。
//! Tauri 对命令参数做驼峰/下划线转换，多词参数一旦两侧不一致就报
//! "invalid args"，而这类错在真机上很难看见。单词参数没有这个问题。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use app_ipc::{events, FormatId, SearchDone, SearchHit, SearchRequest, WorkspaceInfo};
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;

type R<T> = Result<T, String>;

fn root_of(state: &AppState) -> R<PathBuf> {
    state
        .workspace()
        .root
        .clone()
        .ok_or_else(|| "还没打开工作区：先在资源管理器里「打开文件夹」".to_string())
}

/// 打开（或切换）工作区。返回扫好的树。
#[tauri::command]
pub fn workspace_open(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    path: String,
) -> R<WorkspaceInfo> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("不是一个目录：{path}"));
    }
    let info = app_core::workspace::scan(&root);

    let watcher = crate::watcher::start(app, state.inner().clone(), root.clone())?;

    let mut ws = state.workspace();
    ws.watcher = Some(watcher);
    ws.root = Some(root);
    ws.info = info.clone();
    Ok(info)
}

/// 当前工作区。**每次都重新扫盘**，不是回放缓存 ——
/// 外部改动（watcher 只报"有变化"）之后，树必须反映磁盘此刻的样子。
#[tauri::command]
pub fn workspace_get(state: State<'_, Arc<AppState>>) -> WorkspaceInfo {
    let root = state.workspace().root.clone();
    match root {
        Some(root) => {
            let info = app_core::workspace::scan(&root);
            state.workspace().info = info.clone();
            info
        }
        None => WorkspaceInfo::default(),
    }
}

/// 关掉工作区。监视器随状态一起被丢掉。
#[tauri::command]
pub fn workspace_close(state: State<'_, Arc<AppState>>) -> WorkspaceInfo {
    let mut ws = state.workspace();
    ws.watcher = None;
    ws.root = None;
    ws.info = WorkspaceInfo::default();
    ws.info.clone()
}

/// 在工作区里新建一个图表文件。返回它的绝对路径。
///
/// 这是 fs scope 的实际落点：名字经 `resolve_in_root`，**出不去工作区**。
#[tauri::command]
pub fn workspace_new_file(
    state: State<'_, Arc<AppState>>,
    dir: String,
    name: String,
    format: FormatId,
) -> R<String> {
    let root = root_of(state.inner())?;
    let dirp = PathBuf::from(&dir);
    if !app_core::workspace::inside(&root, &dirp) {
        return Err("目标目录不在工作区内".into());
    }
    if !dirp.is_dir() {
        return Err(format!("目录不存在：{dir}"));
    }
    let name = ensure_ext(name.trim(), format);
    let target = app_core::workspace::resolve_in_root(&dirp, &name)?;
    if !app_core::workspace::inside(&root, &target) {
        return Err("目标路径跑出工作区".into());
    }
    if target.exists() {
        return Err(format!("已经有一个同名的了：{}", app_core::workspace::slash(&target)));
    }
    std::fs::write(&target, app_core::format::default_body(format))
        .map_err(|e| format!("写入失败：{e}"))?;
    Ok(app_core::workspace::slash(&target))
}

/// 重命名。`name` 可以不带扩展名（沿用原来的）。
#[tauri::command]
pub fn workspace_rename(
    state: State<'_, Arc<AppState>>,
    path: String,
    name: String,
) -> R<String> {
    let root = root_of(state.inner())?;
    let src = PathBuf::from(&path);
    if !app_core::workspace::inside(&root, &src) {
        return Err("目标不在工作区内".into());
    }
    if !src.exists() {
        return Err(format!("找不到：{path}"));
    }
    let parent = src.parent().ok_or_else(|| "没有上级目录".to_string())?;
    let mut next = name.trim().to_string();
    if next.is_empty() {
        return Err("名称为空".into());
    }
    if Path::new(&next).extension().is_none() {
        if let Some(ext) = src.extension() {
            next = format!("{next}.{}", ext.to_string_lossy());
        }
    }
    let dst = app_core::workspace::resolve_in_root(parent, &next)?;
    if !app_core::workspace::inside(&root, &dst) {
        return Err("目标路径跑出工作区".into());
    }
    if dst.exists() && dst != src {
        return Err(format!("已经有一个同名的了：{}", app_core::workspace::slash(&dst)));
    }
    std::fs::rename(&src, &dst).map_err(|e| format!("重命名失败：{e}"))?;
    Ok(app_core::workspace::slash(&dst))
}

/// 删除。**只删文件与空目录** —— 递归删除不可逆，本客户端不做这件事。
///
/// 返回 `true`（不是 `()`）：见 commands.rs 的返回值约定。
#[tauri::command]
pub fn workspace_delete(state: State<'_, Arc<AppState>>, path: String) -> R<bool> {
    let root = root_of(state.inner())?;
    let p = PathBuf::from(&path);
    if !app_core::workspace::inside(&root, &p) {
        return Err("目标不在工作区内".into());
    }
    if !p.exists() {
        return Err(format!("找不到：{path}"));
    }
    if p.is_dir() {
        let non_empty = std::fs::read_dir(&p)
            .map_err(|e| format!("读目录失败：{e}"))?
            .next()
            .is_some();
        if non_empty {
            return Err("目录里还有东西 —— 本客户端只删空目录（递归删除不可逆，不提供）".into());
        }
        std::fs::remove_dir(&p).map(|_| true).map_err(|e| format!("删除失败：{e}"))
    } else {
        let r = std::fs::remove_file(&p).map(|_| true).map_err(|e| format!("删除失败：{e}"));
        r
    }
}

/// 名字没带扩展名时补一个（按格式注册表的第一个扩展名）。
fn ensure_ext(name: &str, format: FormatId) -> String {
    if name.is_empty() {
        return name.to_string();
    }
    if Path::new(name).extension().is_some() {
        return name.to_string();
    }
    let ext = &app_core::format::info(format).exts[0];
    format!("{name}{ext}")
}

/* ------------------------------------------------------------------ 全库搜索 */

/// 起一次全库搜索：立刻返回，命中经 `search://hit` 逐条推进来，收尾 `search://done`。
#[tauri::command]
pub fn search_run(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    req: SearchRequest,
) -> R<()> {
    let root = root_of(state.inner())?;
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .search_cancels()
        .insert(req.request_id.clone(), cancel.clone());

    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let hit_app = app.clone();
        let done = app_core::workspace::search(&root, &req, move |hit: SearchHit| {
            if cancel.load(Ordering::Relaxed) {
                return false;
            }
            let _ = hit_app.emit(events::SEARCH_HIT, hit);
            true
        });
        let _ = app.emit(events::SEARCH_DONE, done);
        st.search_cancels().remove(&req.request_id);
    });
    Ok(())
}

/// 取消一次搜索（结果留在界面上的那部分不回滚）。
#[tauri::command]
pub fn search_cancel(state: State<'_, Arc<AppState>>, id: String) -> R<()> {
    match state.search_cancels().get(&id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Ok(())
        }
        None => Err("这次搜索已经结束了".into()),
    }
}

/// 供 selftest / 诊断用：把一次搜索的结果**同步**拿回来（不等事件）。
///
/// 为什么单独开一条：自检里不能靠"等事件"（后台窗口的定时器被节流），
/// 而搜索的结果形状（行号/列号/是否截断）正是最该被钉住的东西。
#[tauri::command]
pub fn search_once(state: State<'_, Arc<AppState>>, req: SearchRequest) -> R<(Vec<SearchHit>, SearchDone)> {
    let root = root_of(state.inner())?;
    let mut hits = Vec::new();
    let done = app_core::workspace::search(&root, &req, |h| {
        hits.push(h);
        true
    });
    Ok((hits, done))
}
