//! 应用状态：会话、设置、凭据库、HTTP 客户端、AI 取消登记。
//!
//! 整体用 `Arc<AppState>` 交给 Tauri 管理：异步命令需要把状态搬进 `spawn` 的任务里，
//! `tauri::State<'_, T>` 活在调用栈上搬不走，所以命令里统一 `state.inner().clone()`。

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};

use app_core::Session;
use app_ipc::Settings;
use platform::{AppPaths, CredentialStore};

pub struct AppState {
    pub session: Mutex<Session>,
    pub settings: Mutex<Settings>,
    pub paths: AppPaths,
    pub creds: Arc<dyn CredentialStore>,
    pub http: reqwest::Client,
    /// 正在跑的 AI 请求：request_id → 取消标志
    pub cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AppState {
    pub fn new(paths: AppPaths, creds: Arc<dyn CredentialStore>) -> Self {
        let settings = app_core::settings::load(&paths.settings_file());
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .unwrap_or_default();
        Self {
            session: Mutex::new(Session::default()),
            settings: Mutex::new(settings),
            paths,
            creds,
            http,
            cancels: Mutex::new(HashMap::new()),
        }
    }

    pub fn session(&self) -> MutexGuard<'_, Session> {
        lock(&self.session)
    }

    pub fn settings(&self) -> MutexGuard<'_, Settings> {
        lock(&self.settings)
    }

    pub fn cancels(&self) -> MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        lock(&self.cancels)
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

    /// 记一条最近打开（去重、置顶、上限 10）。
    pub fn remember_recent(&self, path: &str, name: &str, format: app_ipc::FormatId) {
        let mut s = self.settings();
        s.recent.retain(|r| r.path != path);
        s.recent.insert(
            0,
            app_ipc::RecentEntry {
                path: path.to_string(),
                name: name.to_string(),
                format,
                opened_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0),
            },
        );
        s.recent.truncate(10);
        let snapshot = s.clone();
        drop(s);
        let _ = self.persist_settings(&snapshot);
    }
}

/// 一个模型对应一条凭据记录（键名固定，便于删除时清理）。
pub fn credential_key(model_id: &str) -> String {
    format!("ai-model:{model_id}")
}

/// 中毒的锁也要能用：设置/会话是纯数据，没有"写一半"的中间态。
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
