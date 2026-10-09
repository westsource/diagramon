//! 平台适配层接口（《迁移方案 v1.2》§7.2）。
//!
//! 约定：**三平台的差异只允许出现在本层的实现里**。上层（app-core / 命令层 / 前端）
//! 一律只依赖这里定义的 trait，从而三平台共享同一套业务代码。
//!
//! 本 crate 只放接口与**跨平台通用**的实现（标准路径由 `dirs` 给出各平台规范位置）。
//! 真正按平台分叉的能力（凭据加密、单实例、自启、托盘、文件关联）由
//! `platform-windows` / `platform-macos` / `platform-linux` 各自实现。

use std::path::PathBuf;

/// 平台适配层统一错误。
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct PlatformError(pub String);

impl PlatformError {
    pub fn new(msg: impl Into<String>) -> Self {
        Self(msg.into())
    }
}

/// 凭据存储（AI 供应商 API Key 等敏感值）。
///
/// 实现必须保证**密文落盘**：Windows `DPAPI`、macOS Keychain、Linux Secret Service。
/// 迁移期还要求能读回旧客户端写下的 `secure.config`（见 §7.2 备注）。
pub trait CredentialStore: Send + Sync {
    /// 读一条凭据；不存在返回 `Ok(None)`。
    fn get(&self, key: &str) -> Result<Option<String>, PlatformError>;
    /// 写入/覆盖一条凭据。
    fn set(&self, key: &str, value: &str) -> Result<(), PlatformError>;
    /// 删除一条凭据；不存在视为成功。
    fn delete(&self, key: &str) -> Result<(), PlatformError>;
}

/// 应用目录（配置 / 数据 / 缓存）。
pub trait AppPaths: Send + Sync {
    /// 配置目录（`settings.json`、`secure.config` 所在处）。
    fn config_dir(&self) -> PathBuf;
    /// 数据目录（会话、对话历史）。
    fn data_dir(&self) -> PathBuf;
    /// 缓存目录（崩溃日志、预览临时文件）。
    fn cache_dir(&self) -> PathBuf;
}

/// 当前平台。
pub trait Platform: Send + Sync {
    /// 稳定的平台 id：`windows` / `macos` / `linux`。
    fn os(&self) -> &'static str;
    fn paths(&self) -> &dyn AppPaths;
    fn credentials(&self) -> &dyn CredentialStore;
}

/// 基于 `dirs` 的标准路径实现：遵循各平台规范
/// （Windows `%APPDATA%`/`%LOCALAPPDATA%`、macOS `~/Library/Application Support`、Linux `~/.config`/`~/.local/share`）。
#[derive(Debug, Clone)]
pub struct StandardPaths {
    app_dir: String,
}

impl StandardPaths {
    pub fn new(app_dir: impl Into<String>) -> Self {
        Self {
            app_dir: app_dir.into(),
        }
    }
}

impl AppPaths for StandardPaths {
    fn config_dir(&self) -> PathBuf {
        base(dirs::config_dir(), "config").join(&self.app_dir)
    }

    fn data_dir(&self) -> PathBuf {
        base(dirs::data_dir(), "data").join(&self.app_dir)
    }

    fn cache_dir(&self) -> PathBuf {
        base(dirs::cache_dir(), "cache").join(&self.app_dir)
    }
}

/// 取平台目录；个别平台可能返回 `None`，退回当前工作目录以免 panic。
fn base(dir: Option<PathBuf>, which: &str) -> PathBuf {
    dir.unwrap_or_else(|| {
        debug_assert!(false, "系统未提供 {which} 目录");
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    })
}
