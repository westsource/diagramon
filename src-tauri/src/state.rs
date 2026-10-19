//! 应用状态：会话、设置、凭据库、HTTP 客户端、AI 取消登记、工作区与 autosave 计时。
//!
//! 整体用 `Arc<AppState>` 交给 Tauri 管理：异步命令需要把状态搬进 `spawn` 的任务里，
//! `tauri::State<'_, T>` 活在调用栈上搬不走，所以命令里统一 `state.inner().clone()`。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use app_core::Session;
use app_ipc::{Settings, WorkspaceInfo};
use platform::{AppPaths, CredentialStore};

/// 现在（毫秒）。**毫秒是前后端唯一的单位**：前端 `Date.now()`、`RecentEntry.opened_at`
/// 的比较（`sidebar.recentWhen` / `dialogs.openedWhen` 都是 `Date.now() - ts`）、
/// 「按文件记着的渲染选项」的时刻，全用它。
///
/// `opened_at` 以前在 Rust 侧写的是 `as_secs()`，前端按毫秒读 —— 磁盘上那份"最近打开"
/// 于是显示成几万天前（自检看不见：它只验证返回值，不验证这个字段的语义）。
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 工作区：根目录 + 扫描结果 + 正在跑的监视器。
///
/// 三者绑在一起换（打开新目录 = 停旧的、换根、重扫），所以放同一个锁里，
/// 不会出现"根换了但监视的还是旧目录"这种中间态。
#[derive(Default)]
pub struct WorkspaceState {
    pub root: Option<PathBuf>,
    pub info: WorkspaceInfo,
    /// 换目录或关工作区时 drop 它 ⇒ 线程收到停止位退出
    pub watcher: Option<crate::watcher::WatchHandle>,
}

pub struct AppState {
    pub session: Mutex<Session>,
    pub settings: Mutex<Settings>,
    pub paths: AppPaths,
    pub creds: Arc<dyn CredentialStore>,
    pub http: reqwest::Client,
    /// 按"空闲多久算死"（秒）分档缓存的 AI 客户端。`read_timeout` 只能设在客户端上，
    /// 所以每个档位必须有自己的实例 —— 见 `http_for_idle`。
    http_idle: Mutex<HashMap<u64, reqwest::Client>>,
    /// 正在跑的 AI 请求：request_id → 取消标志
    pub cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// 正在跑的工作区搜索：request_id → 取消标志
    pub search_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub workspace: Mutex<WorkspaceState>,
    /// autosave：doc_id → 到期时刻（改正文时登记，后台线程到点落盘）
    pub autosave: Mutex<HashMap<String, Instant>>,
    /// 未落盘文档的草稿目录
    pub recovery_dir: PathBuf,
    /// 按文件记着的渲染选项（外观 / 布局）：打开文件时恢复，用户一改就落盘
    pub render_opts: Mutex<app_core::render_opts::Store>,
    /// 识图截屏的冻结帧（框选期间有效）
    pub vision: crate::vision::Frames,
}

impl AppState {
    pub fn new(paths: AppPaths, creds: Arc<dyn CredentialStore>) -> Self {
        let settings = app_core::settings::load(&paths.settings_file());
        // 默认池的空闲档 = BYOK 的默认档（90s，见 `ai::provider::idle_timeout_for`）：
        // 云网关、以及没填空闲超时的 openai / custom 模型都落到这一档。
        let http = http_client(ai::provider::idle_timeout_for("openai", None));
        let recovery_dir = app_core::recovery::dir_for(&paths.data_dir);
        let render_opts = app_core::render_opts::load(&paths.render_opts_file());
        Self {
            session: Mutex::new(Session::default()),
            settings: Mutex::new(settings),
            paths,
            creds,
            http,
            http_idle: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
            search_cancels: Mutex::new(HashMap::new()),
            workspace: Mutex::new(WorkspaceState::default()),
            autosave: Mutex::new(HashMap::new()),
            recovery_dir,
            render_opts: Mutex::new(render_opts),
            vision: crate::vision::Frames::new(),
        }
    }

    pub fn session(&self) -> MutexGuard<'_, Session> {
        lock(&self.session)
    }

    pub fn settings(&self) -> MutexGuard<'_, Settings> {
        lock(&self.settings)
    }

    /// 取一个"空闲上限 = `idle`"的 AI HTTP 客户端。
    ///
    /// 为什么要有"每个空闲档一个实例"这回事：reqwest 的 `read_timeout` **只能在
    /// `ClientBuilder` 上设**（不能按请求覆盖），所以"多久收不到字节算死"是**客户端实例**
    /// 的属性 —— 每个模型的空闲上限不同，就只能落到不同实例上。
    ///
    /// 缓存是必须的，不是优化：不缓存就是每轮对话新建一个连接池（TLS 会话、socket 全作废）。
    /// 默认档（90s：云网关 + 没填空闲超时的 BYOK 模型）直接复用 `http`，不另建池。
    pub fn http_for_idle(&self, idle: std::time::Duration) -> reqwest::Client {
        if idle == ai::provider::idle_timeout_for("openai", None) {
            return self.http.clone(); // `Client` 内部是 Arc，clone 很便宜
        }
        lock(&self.http_idle)
            .entry(idle.as_secs())
            .or_insert_with(|| http_client(idle))
            .clone()
    }

    pub fn cancels(&self) -> MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        lock(&self.cancels)
    }

    pub fn search_cancels(&self) -> MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        lock(&self.search_cancels)
    }

    pub fn workspace(&self) -> MutexGuard<'_, WorkspaceState> {
        lock(&self.workspace)
    }

    pub fn render_opts(&self) -> MutexGuard<'_, app_core::render_opts::Store> {
        lock(&self.render_opts)
    }

    pub fn autosave(&self) -> MutexGuard<'_, HashMap<String, Instant>> {
        lock(&self.autosave)
    }

    pub fn persist_settings(&self, s: &Settings) -> Result<(), String> {
        app_core::settings::save(&self.paths.settings_file(), s)
    }

    /// 交给前端之前，把密钥状态**现算**一遍：
    /// 磁盘上的 `has_key` 可能是别的机器留下的，只有凭据库说了算。
    pub fn hydrate_models(&self, s: &mut Settings) {
        for m in &mut s.ai.models {
            match self.creds.get(&credential_key(&m.id)) {
                Ok(Some(secret)) => {
                    m.has_key = true;
                    m.key_hint = platform::mask(&secret);
                }
                _ => {
                    m.has_key = false;
                    m.key_hint = String::new();
                }
            }
        }
    }

    /// 记一条最近打开（去重、置顶、上限 50）。
    ///
    /// 上限从 10 提到 50：界面上的短名单（欢迎页 5 条、菜单 6 条、侧栏 8 条）之外
    /// 还有「文件打开历史」窗口要看更早的 —— 只留 10 条的话那个窗口没有意义。
    /// 50 条 × 一条几十字节，settings.json 的体积可以忽略。
    pub fn remember_recent(&self, path: &str, name: &str, format: app_ipc::FormatId) {
        let mut s = self.settings();
        s.recent.retain(|r| r.path != path);
        s.recent.insert(
            0,
            app_ipc::RecentEntry {
                path: path.to_string(),
                name: name.to_string(),
                format,
                opened_at: now_ms(),
            },
        );
        s.recent.truncate(50);
        let snapshot = s.clone();
        drop(s);
        let _ = self.persist_settings(&snapshot);
    }

    /// 记下某个文件的渲染选项（外观 / 布局）并落盘 —— 下次打开这个文件就恢复它。
    ///
    /// `from` 是"这份文档原来的路径"（另存为 / 首次保存时给）：记录跟着文件走，
    /// 否则旧文件的记录会永远留着、新文件打开还是默认。
    ///
    /// `format` 决定"布局用过 elk 吗"这个启动预热信号（只有 Mermaid + elk 算，见
    /// `render_opts::Store::note_layout`）。
    ///
    /// 与 `remember_recent` 一样**吞掉写失败**：这只是一份"记住上次选择"的缓存，
    /// 磁盘写不进去不该让用户的一次下拉选择报错。
    pub fn remember_render_opts(
        &self,
        from: Option<&str>,
        to: &str,
        opts: app_core::render_opts::DocOpts,
        format: app_ipc::FormatId,
    ) {
        let mut store = self.render_opts();
        if let Some(old) = from {
            if old != to {
                store.forget(old);
            }
        }
        store.note_layout(format, opts.layout.as_deref());
        store.set(to, opts, now_ms());
        let snapshot = store.clone();
        drop(store);
        let _ = app_core::render_opts::save(&self.paths.render_opts_file(), &snapshot);
    }

    /* ---------------- autosave 计时 ---------------- */

    /// 正文改动后登记到期时刻（毫秒阈值来自设置）。
    pub fn mark_autosave(&self, doc_id: &str) {
        let ms = self.settings().editor.autosave_ms.max(500);
        self.autosave()
            .insert(doc_id.to_string(), Instant::now() + std::time::Duration::from_millis(ms as u64));
    }

    pub fn cancel_autosave(&self, doc_id: &str) {
        self.autosave().remove(doc_id);
    }

    /* ---------------- 写路径守卫（fs scope） ---------------- */

    /// 写文件前的守门。
    ///
    /// 规则只有一条：**打开着工作区、且设置里开了"限制在工作区内"时**，
    /// 目标必须落在工作区根内（或本来就是已打开文档所在的那个文件）。
    ///
    /// 默认不开这条：自由「另存为」到桌面是常见需求，开成默认只会莫名挡住人。
    /// 但工作区界面自己的写操作（新建/重命名/删除）**永远**经
    /// `workspace::resolve_in_root`，那条路不受这个开关影响 —— 它本来就出不去。
    pub fn check_writable(&self, path: &Path) -> Result<(), String> {
        let restrict = self.settings().editor.restrict_to_workspace;
        if !restrict {
            return Ok(());
        }
        let root = self.workspace().root.clone();
        let Some(root) = root else {
            return Ok(()); // 没有边界可对照
        };
        if app_core::workspace::inside(&root, path) {
            return Ok(());
        }
        // 例外：这个文件本来就是会话里开着的（用户只是把它存回原处）
        let s = self.session();
        if s.id_by_path(&path.to_string_lossy()).is_some() {
            return Ok(());
        }
        Err(format!(
            "「限制在工作区内」已开启，不能写到工作区外：{}（可在 设置 → 编辑器 里关掉）",
            path.display()
        ))
    }
}

/// 按"空闲多久算死"造一个 HTTP 客户端。
///
/// `idle` 落在 `read_timeout` 上：**每次读单独计时、读到就重置** —— 连接卡死（收不到任何字节）
/// 到这个上限即报错，而"慢但活着"的流不受影响。它与下面的总 deadline 互补。
fn http_client(idle: std::time::Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        // 总超时（整请求一刀切）：普通请求的兜底。
        // **流式 AI 请求不能吃这个值** —— 思考型模型一条流跑 5 分钟+很正常，
        // 撞上它就是"网络请求失败：error decoding response body"（真机实录
        // 2026-10-16：改图流恰好在 300s 整被掐死，ai_usage 记 299.9s cancelled，
        // 连续两天两笔）。stream_chat 里已按请求把总超时放宽到 30 分钟。
        .timeout(std::time::Duration::from_secs(300))
        .read_timeout(idle)
        .build()
        .unwrap_or_default()
}

/// 一个模型对应一条凭据记录（键名固定，便于删除时清理）。
pub fn credential_key(model_id: &str) -> String {
    format!("ai-model:{model_id}")
}

/// 云网关令牌在凭据库里的键名。**令牌永不回前端**（cloud.rs 的头注释）。
pub const CLOUD_ACCESS_KEY: &str = "cloud:access-token";
pub const CLOUD_REFRESH_KEY: &str = "cloud:refresh-token";

/// 中毒的锁也要能用：设置/会话是纯数据，没有"写一半"的中间态。
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
