//! 平台适配层：**只定义接口**，实现放在 platform-windows / platform-macos / platform-linux。
//!
//! 密钥是这里的头等大事：`CredentialStore` 的取值**只在 Rust 进程内流转**，
//! Tauri 命令层只把掩码（`sk-…1234`）与 `has_key` 交给前端 —— 见 §9.1 的安全边界。

use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("找不到可用的配置目录")]
    NoConfigDir,
    #[error("凭据存储不可用：{0}")]
    CredentialUnavailable(String),
    #[error("凭据读写失败：{0}")]
    CredentialIo(String),
    #[error("密钥解密失败（可能换了 Windows 账户，或密文被其它机器复制过来）")]
    DecryptFailed,
}

/// 凭据存储（Windows 上是 DPAPI；其它平台待补）。
pub trait CredentialStore: Send + Sync {
    /// 取明文密钥。`Ok(None)` = 没存过。
    fn get(&self, key: &str) -> Result<Option<String>, Error>;
    /// 写入（覆盖）。
    fn set(&self, key: &str, secret: &str) -> Result<(), Error>;
    /// 删除；不存在也算成功。
    fn delete(&self, key: &str) -> Result<(), Error>;
}

/// 标准路径。三平台都从 `dirs` 推导，不硬编码盘符。
#[derive(Debug, Clone)]
pub struct AppPaths {
    /// 设置、凭据
    pub config_dir: PathBuf,
    /// 对话历史、渲染临时文件
    pub data_dir: PathBuf,
}

impl AppPaths {
    pub fn resolve() -> Result<Self, Error> {
        let config_dir = dirs::config_dir().ok_or(Error::NoConfigDir)?.join("Diagramon");
        let data_dir = dirs::data_dir().ok_or(Error::NoConfigDir)?.join("Diagramon");
        Ok(Self { config_dir, data_dir })
    }

    pub fn settings_file(&self) -> PathBuf {
        self.config_dir.join("settings.json")
    }

    pub fn credentials_dir(&self) -> PathBuf {
        self.config_dir.join("credentials")
    }

    pub fn conversations_dir(&self) -> PathBuf {
        self.data_dir.join("conversations")
    }

    /// AI 长期记忆（`memory.json`）。
    ///
    /// **与凭据目录分开**：`credentials_dir()` 只放密钥（DPAPI 密文），
    /// 记忆是用户内容，混进去会让"凭据库里都有什么"这件事变得说不清。
    pub fn memory_dir(&self) -> PathBuf {
        self.data_dir.join("memory")
    }

    /// 按文件记着的渲染选项（外观 / 布局）：`render-opts.json`。
    ///
    /// 放 `data_dir` 而不是 `settings.json`：那是"每个文件上次选的什么"，与用户偏好
    /// 是两回事，条数还会随打开过的文件增长（有上限，见 `app_core::render_opts::MAX_DOCS`）。
    pub fn render_opts_file(&self) -> PathBuf {
        self.data_dir.join("render-opts.json")
    }

    /// 首次运行要建目录；已存在不算错。
    pub fn ensure(&self) -> Result<(), Error> {
        for d in [&self.config_dir, &self.data_dir, &self.conversations_dir(), &self.memory_dir()] {
            std::fs::create_dir_all(d).map_err(|e| Error::CredentialIo(e.to_string()))?;
        }
        Ok(())
    }
}

/// 掩码：`sk-abcdef1234` → `sk-…1234`。前端只能看到这个。
pub fn mask(secret: &str) -> String {
    let s = secret.trim();
    if s.is_empty() {
        return String::new();
    }
    let tail: String = s.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    let head: String = s.chars().take(3).collect();
    if s.chars().count() <= 7 {
        format!("…{tail}")
    } else {
        format!("{head}…{tail}")
    }
}

/// 非 Windows 的临时实现：**明文落盘**并在文件名上打标记。
/// 存在的意义只是让 macOS/Linux 上能跑起来开发；正式平台适配层补上后应删掉。
pub struct PlaintextStore {
    dir: PathBuf,
}

impl PlaintextStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn path_for(&self, key: &str) -> PathBuf {
        let safe: String = key
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        self.dir.join(format!("{safe}.plain-secret"))
    }
}

impl CredentialStore for PlaintextStore {
    fn get(&self, key: &str) -> Result<Option<String>, Error> {
        match std::fs::read_to_string(self.path_for(key)) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Error::CredentialIo(e.to_string())),
        }
    }

    fn set(&self, key: &str, secret: &str) -> Result<(), Error> {
        std::fs::create_dir_all(&self.dir).map_err(|e| Error::CredentialIo(e.to_string()))?;
        std::fs::write(self.path_for(key), secret).map_err(|e| Error::CredentialIo(e.to_string()))
    }

    fn delete(&self, key: &str) -> Result<(), Error> {
        match std::fs::remove_file(self.path_for(key)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Error::CredentialIo(e.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_keeps_head_and_tail_only() {
        assert_eq!(mask("sk-abcdef1234"), "sk-…1234");
        assert_eq!(mask("short"), "…hort");
        assert_eq!(mask(""), "");
        assert_eq!(mask("   "), "");
    }

    #[test]
    fn mask_never_leaks_the_middle_of_the_secret() {
        let secret = "sk-live-SUPERSECRET-9876";
        let m = mask(secret);
        assert!(!m.contains("SUPERSECRET"), "掩码不能包含中间片段：{m}");
        assert!(m.ends_with("9876"));
    }

    #[test]
    fn plaintext_store_round_trips_and_deletes() {
        let dir = std::env::temp_dir().join("diagramon-platform-test");
        let _ = std::fs::remove_dir_all(&dir);
        let store = PlaintextStore::new(dir.clone());
        assert_eq!(store.get("a/b").unwrap(), None);
        store.set("a/b", "secret").unwrap();
        assert_eq!(store.get("a/b").unwrap().as_deref(), Some("secret"));
        store.delete("a/b").unwrap();
        assert_eq!(store.get("a/b").unwrap(), None);
        store.delete("a/b").unwrap(); // 再删一次也不报错
    }

    #[test]
    fn key_with_path_separators_cannot_escape_the_directory() {
        let dir = std::env::temp_dir().join("diagramon-platform-test2");
        let _ = std::fs::remove_dir_all(&dir);
        let store = PlaintextStore::new(dir.clone());
        store.set("../../escape", "x").unwrap();
        let written: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(written.len(), 1, "不该写到目录外");
    }

    #[test]
    fn app_paths_are_under_the_os_config_root() {
        let p = AppPaths::resolve().unwrap();
        assert!(p.settings_file().to_string_lossy().ends_with("settings.json"));
        assert!(p.config_dir.to_string_lossy().contains("Diagramon"));
    }
}
