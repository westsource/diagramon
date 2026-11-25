//! macOS 凭据存储：系统 **Keychain**（Security.framework 的 generic password）。
//!
//! 与 Windows 的 DPAPI、Linux 的 Secret Service 同一层语义：密钥只存在 Rust 进程内，
//! 前端只拿掩码。**不可用时如实报错，绝不降级到明文** —— 旧的非 Windows 兜底
//! `PlaintextStore` 只在显式设置 `DGM_ALLOW_PLAINTEXT_CREDS` 时启用（入口在
//! `src-tauri/src/lib.rs`），仅限开发/受限环境。
//!
//! Keychain 的访问控制由系统决定：登录钥匙串解锁时读写通常不弹窗；如果用户把
//! 钥匙串锁上，读写会返回错误，界面应如实提示"Keychain 不可用"，而不是假装没存过。
#![cfg(target_os = "macos")]

use platform::{CredentialStore, Error};

/// Keychain 里的 service 名。用产品名而不是包名：钥匙串访问界面里用户看到的就是它。
const SERVICE: &str = "Diagramon";

pub struct KeychainStore {
    service: String,
}

impl Default for KeychainStore {
    fn default() -> Self {
        Self::new()
    }
}

impl KeychainStore {
    pub fn new() -> Self {
        Self { service: SERVICE.to_string() }
    }

    fn entry(&self, key: &str) -> Result<keyring::Entry, Error> {
        keyring::Entry::new(&self.service, key)
            .map_err(|e| Error::CredentialUnavailable(format!("Keychain 不可用：{e}")))
    }
}

impl CredentialStore for KeychainStore {
    fn get(&self, key: &str) -> Result<Option<String>, Error> {
        match self.entry(key)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            // 没存过不是错误：上层用它表示"还没登录 / 还没填密钥"
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::CredentialIo(format!("读取 Keychain 失败：{e}"))),
        }
    }

    fn set(&self, key: &str, secret: &str) -> Result<(), Error> {
        self.entry(key)?
            .set_password(secret)
            .map_err(|e| Error::CredentialIo(format!("写入 Keychain 失败：{e}")))
    }

    fn delete(&self, key: &str) -> Result<(), Error> {
        match self.entry(key)?.delete_credential() {
            // 不存在也算成功（接口语义）
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::CredentialIo(format!("删除 Keychain 项失败：{e}"))),
        }
    }
}
