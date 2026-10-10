//! 工作区文件监视：`notify` → 去抖 → `fs://changed`。
//!
//! 三件必须在 Rust 侧做的事：
//!   1. **去抖**：一次保存会触发好几个事件（临时文件、改名、父目录 mtime），
//!      原样推给前端就是刷屏。攒 350ms 再发。
//!   2. **回声抑制**：我们自己保存也会触发事件。判据不是"猜"，而是**比对内容** ——
//!      磁盘内容与已打开文档的正文一致，就是自己写出去的回声，整条丢掉。
//!      这比记"最近写过哪些路径"可靠：时间窗怎么定都会漏。
//!   3. **冲突判定**：开着、且本地有未保存改动 ⇒ `conflicts`，界面必须问用户；
//!      开着但干净 ⇒ 直接让界面重新载入。
//!
//! 只关心本应用能打开的文件（`.mmd/.mermaid/.dot/.gv/.drawio/.excalidraw`），
//! 目录只报创建/删除（Windows 上目录的 modified 事件极其频繁，推了就是噪音）。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use app_ipc::{events, FsChange};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::state::AppState;

/// 攒多久再发。太小会刷屏，太大会让人以为"没反应"。
const DEBOUNCE: Duration = Duration::from_millis(350);
/// 主循环醒来检查停止位的间隔。
const TICK: Duration = Duration::from_millis(150);

/// 监视器句柄。**drop 即停** —— 换工作区时旧监视器随旧状态一起被丢掉。
pub struct WatchHandle {
    stop: Arc<AtomicBool>,
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// 开始监视 `root`（递归）。返回时监视器**已经挂上**，失败会如实返回错误。
pub fn start(app: AppHandle, state: Arc<AppState>, root: PathBuf) -> Result<WatchHandle, String> {
    let (tx, rx) = channel::<notify::Result<Event>>();
    let (ready_tx, ready_rx) = channel::<Result<(), String>>();
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();

    std::thread::spawn(move || {
        let mut watcher = match notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) {
            Ok(w) => w,
            Err(e) => {
                let _ = ready_tx.send(Err(format!("监视器创建失败：{e}")));
                return;
            }
        };
        if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
            let _ = ready_tx.send(Err(format!("挂载监视失败：{e}")));
            return;
        }
        let _ = ready_tx.send(Ok(()));

        let mut pending: BTreeMap<String, String> = BTreeMap::new();
        let mut last = Instant::now();
        while !thread_stop.load(Ordering::Relaxed) {
            match rx.recv_timeout(TICK) {
                Ok(Ok(ev)) => {
                    let Some(kind) = kind_of(&ev.kind) else { continue };
                    for p in ev.paths {
                        let s = app_core::workspace::slash(&p);
                        let merged = app_core::workspace::merge_kind(
                            pending.get(&s).map(String::as_str),
                            kind,
                        );
                        pending.insert(s, merged.to_string());
                    }
                    last = Instant::now();
                }
                Ok(Err(_)) => {}
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if !pending.is_empty() && last.elapsed() >= DEBOUNCE {
                let batch = std::mem::take(&mut pending);
                last = Instant::now();
                let changes = classify(&state, batch);
                if !changes.is_empty() {
                    let _ = app.emit(events::FS_CHANGED, changes);
                }
            }
        }
        // watcher 在函数结束时才 drop —— 整段循环期间它都活着
        drop(watcher);
    });

    match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(())) => Ok(WatchHandle { stop }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("监视器启动超时".into()),
    }
}

/// notify 的事件类型 → 契约里的语义串。映射只有这几行，
/// 判定规则（去抖合并、回声抑制、冲突）都在 `app-core::workspace` 与 `classify`。
fn kind_of(k: &EventKind) -> Option<&'static str> {
    use app_core::workspace::RawKind;
    match k {
        EventKind::Create(_) => Some(RawKind::Created.as_str()),
        EventKind::Remove(_) => Some(RawKind::Removed.as_str()),
        EventKind::Modify(_) => Some(RawKind::Modified.as_str()),
        // Access（读文件也算）跟"内容变了"无关，丢掉
        EventKind::Access(_) => None,
        EventKind::Any | EventKind::Other => Some(RawKind::Other.as_str()),
    }
}

/// 把一批原始事件变成"值得告诉界面"的变更。
fn classify(state: &AppState, batch: BTreeMap<String, String>) -> Vec<FsChange> {
    let mut out = Vec::new();
    for (path, kind) in batch {
        let p = PathBuf::from(&path);
        if p.is_dir() {
            if kind == "created" || kind == "removed" {
                out.push(FsChange { path, kind: "dir".into(), doc_id: None, conflicts: false });
            }
            continue;
        }
        let is_diagram = p
            .extension()
            .map(|e| app_core::workspace::is_open_ext(&e.to_string_lossy()))
            .unwrap_or(false);
        if !is_diagram {
            continue; // 与我们无关的文件（含我们自己写的 .dgm-tmp 临时文件）
        }

        let (doc_id, conflicts, echo) = {
            let s = state.session();
            let doc_id = s.id_by_path(&path);
            match doc_id.as_deref().and_then(|id| s.get(id)) {
                Some(d) => {
                    let disk = std::fs::read_to_string(&p).ok();
                    let echo = kind != "removed"
                        && disk.as_deref().map(|t| t == d.body.as_str()).unwrap_or(false);
                    (doc_id, d.dirty, echo)
                }
                None => (doc_id, false, false),
            }
        };
        if echo {
            continue; // 自己写出去的回声，整条丢掉
        }
        out.push(FsChange { path, kind, doc_id, conflicts });
    }
    out
}
