//! Windows 平台适配层。
//!
//! 当前提供：
//! * `DpapiCredentialStore` —— 用 `CryptProtectData` / `CryptUnprotectData`（当前用户域）
//!   加密凭据后落盘，与既有客户端「API Key 走 DPAPI、绝不明文入 settings.json」的约定一致。
//!
//! 本 crate 仅在 `cfg(windows)` 下有实体；其它平台编译为空 crate（由 `src-tauri` 的
//! 目标依赖按平台选择实现），因此可安全地留在工作区成员里。
#![cfg(windows)]

mod dpapi;

pub use dpapi::DpapiCredentialStore;

use platform::{AppPaths, CredentialStore, Platform, PlatformError, StandardPaths};

/// Windows 平台实现。
pub struct WindowsPlatform {
    paths: StandardPaths,
    credentials: DpapiCredentialStore,
}

impl WindowsPlatform {
    pub fn new(credentials_dir: std::path::PathBuf) -> Result<Self, PlatformError> {
        Ok(Self {
            paths: StandardPaths::new("Diagramon"),
            credentials: DpapiCredentialStore::new(credentials_dir)?,
        })
    }
}

impl Platform for WindowsPlatform {
    fn os(&self) -> &'static str {
        "windows"
    }

    fn paths(&self) -> &dyn AppPaths {
        &self.paths
    }

    fn credentials(&self) -> &dyn CredentialStore {
        &self.credentials
    }
}
