//! 应用状态：会话（标签页）与平台适配层。

use std::sync::Mutex;

use app_core::Session;
use platform::Platform;

/// Tauri 托管的应用状态。
pub struct AppState {
    session: Mutex<Session>,
    platform: Box<dyn Platform>,
}

impl AppState {
    pub fn new(platform: Box<dyn Platform>) -> Self {
        Self {
            session: Mutex::new(Session::new()),
            platform,
        }
    }

    /// 以锁访问会话；锁中毒时恢复内层数据（业务状态本身仍然有效）。
    pub fn with_session<T>(&self, f: impl FnOnce(&mut Session) -> T) -> T {
        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut guard)
    }

    pub fn platform(&self) -> &dyn Platform {
        self.platform.as_ref()
    }
}
