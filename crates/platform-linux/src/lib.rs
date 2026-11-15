//! Linux 凭据存储：freedesktop **Secret Service**（GNOME Keyring / KWallet / KeePassXC
//! 等提供同一套 D-Bus 接口），作用域是当前用户会话。
//!
//! 为什么不用"文件 + 固定密钥"自制加密：那只是把明文换成半明文 —— 密钥就在同一台机器、
//! 同一个用户可读的位置，任何能读到配置目录的进程都能解开。系统的密钥环是唯一有意义的
//! 边界（解锁由登录会话/密钥环口令决定）。
//!
//! **密钥环不可用时不降级到明文**：`set/get` 都返回 `CredentialUnavailable`，由界面如实
//! 报错（"请安装/启动密钥环服务"）。正式发布里绝不允许令牌落成明文 —— 旧的非 Windows
//! 兜底 `PlaintextStore` 只用于开发，入口在 `src-tauri/src/lib.rs`（需显式环境变量）。
//!
//! 落盘形态由 Secret Service 决定（通常是 `~/.local/share/keyrings/*.keyring`，加密存储），
//! 本模块不碰文件。
#![cfg(target_os = "linux")]

use platform::{CredentialStore, Error};

/// Secret Service 里的 service 名（`Entry::new(service, user)` 的第一个参数）。
/// 用产品名而不是包名：密钥环的图形界面里用户看到的就是它。
const SERVICE: &str = "Diagramon";

pub struct SecretServiceStore {
    service: String,
}

impl Default for SecretServiceStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretServiceStore {
    pub fn new() -> Self {
        Self { service: SERVICE.to_string() }
    }

    fn entry(&self, key: &str) -> Result<keyring::Entry, Error> {
        keyring::Entry::new(&self.service, key)
            .map_err(|e| Error::CredentialUnavailable(format!("密钥环不可用：{e}")))
    }
}

impl CredentialStore for SecretServiceStore {
    fn get(&self, key: &str) -> Result<Option<String>, Error> {
        match self.entry(key)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            // 没存过不是错误：上层用它表示"还没登录 / 还没填密钥"
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::CredentialIo(format!("读取密钥失败：{e}"))),
        }
    }

    fn set(&self, key: &str, secret: &str) -> Result<(), Error> {
        self.entry(key)?
            .set_password(secret)
            .map_err(|e| Error::CredentialIo(format!("写入密钥失败：{e}")))
    }

    fn delete(&self, key: &str) -> Result<(), Error> {
        match self.entry(key)?.delete_credential() {
            // 不存在也算成功（接口语义）
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::CredentialIo(format!("删除密钥失败：{e}"))),
        }
    }
}
