//! 应用状态：会话（标签页）、平台适配层、设置。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use app_core::{Session, Settings};
use platform::Platform;

/// Tauri 托管的应用状态。
pub struct AppState {
    session: Mutex<Session>,
    platform: Box<dyn Platform>,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    /// 复用连接池的 HTTP 客户端（AI 调用）。
    pub http: ai::HttpClient,
}

impl AppState {
    /// 从配置目录装载设置（读取时顺带剔除已失效的最近文件）。
    pub fn new(platform: Box<dyn Platform>) -> Self {
        let settings_path = platform.paths().config_dir().join("settings.json");

        let mut settings = Settings::load(&settings_path);
        settings.prune_recent();

        Self {
            session: Mutex::new(Session::new()),
            platform,
            settings: Mutex::new(settings),
            settings_path,
            http: ai::new_client(),
        }
    }

    /// 以锁访问会话；锁中毒时恢复内层数据（业务状态本身仍然有效）。
    pub fn with_session<T>(&self, f: impl FnOnce(&mut Session) -> T) -> T {
        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut guard)
    }

    /// 以锁访问设置。
    pub fn with_settings<T>(&self, f: impl FnOnce(&mut Settings) -> T) -> T {
        let mut guard = self.settings.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut guard)
    }

    pub fn settings_path(&self) -> &Path {
        &self.settings_path
    }

    /// 立刻落盘；失败只记录，不让命令失败（设置写不进去不该阻断用户操作）。
    pub fn persist_settings(&self) {
        let guard = self.settings.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = guard.save(&self.settings_path) {
            eprintln!("dgm|settings|save_failed|{e}");
        }
    }

    pub fn platform(&self) -> &dyn Platform {
        self.platform.as_ref()
    }
}
