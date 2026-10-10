//! AI 对话持久化：按文档稳定身份（路径的 SHA256）存成一个个 JSON 文件。
//!
//! 与既有客户端一致：对话历史按**文件的稳定身份**寻址，而不是按窗口/标签页 ——
//! 同一个文件无论何时打开都接上同一段对话。

use std::io;
use std::path::{Path, PathBuf};

use app_ipc::AiChatMessage;
use serde::{Deserialize, Serialize};

/// 对话文件的内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    key: String,
    messages: Vec<AiChatMessage>,
}

/// 稳定身份键：路径规范化后取 SHA256（十六进制）。
///
/// 规范化只做分隔符统一与去尾斜杠；大小写不折叠（Windows 上少见但合法的大小写差异
/// 会在不同会话里各自保留）。
pub fn identity_key(path: &str) -> String {
    use sha2::{Digest, Sha256};
    let normalized = path.trim().replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    let digest = Sha256::digest(normalized.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// 对话存储目录。
#[derive(Debug, Clone)]
pub struct ConversationStore {
    dir: PathBuf,
}

impl ConversationStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn file_for(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.json"))
    }

    /// 读取对话；不存在或损坏时返回空（历史读不出来不该阻断使用）。
    pub fn load(&self, key: &str) -> Vec<AiChatMessage> {
        std::fs::read_to_string(self.file_for(key))
            .ok()
            .and_then(|t| serde_json::from_str::<Stored>(&t).ok())
            .map(|s| s.messages)
            .unwrap_or_default()
    }

    pub fn save(&self, key: &str, messages: &[AiChatMessage]) -> io::Result<PathBuf> {
        std::fs::create_dir_all(&self.dir)?;
        let path = self.file_for(key);
        let stored = Stored { key: key.to_string(), messages: messages.to_vec() };
        let text = serde_json::to_string_pretty(&stored).unwrap_or_else(|_| "{}".into());
        std::fs::write(&path, text)?;
        Ok(path)
    }

    /// 清空某文档的对话；不存在视为成功。
    pub fn clear(&self, key: &str) -> io::Result<()> {
        match std::fs::remove_file(self.file_for(key)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str) -> (PathBuf, ConversationStore) {
        let dir = std::env::temp_dir().join(format!("dgm-conv-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (dir.clone(), ConversationStore::new(dir))
    }

    #[test]
    fn identity_key_is_stable_and_path_normalized() {
        let a = identity_key("C:/a/x.mmd");
        let b = identity_key(r"C:\a\x.mmd");
        assert_eq!(a, b, "分隔符差异应归一到同一个键");
        assert_eq!(a, identity_key("C:/a/x.mmd/"), "尾随斜杠不影响");
        assert_ne!(a, identity_key("C:/a/y.mmd"));
        assert_eq!(a.len(), 64, "sha256 十六进制");
    }

    #[test]
    fn conversation_roundtrip_and_clear() {
        let (dir, store) = temp_store("rt");
        let key = identity_key("C:/a/x.mmd");
        assert!(store.load(&key).is_empty(), "初始为空");

        let msgs = vec![
            AiChatMessage::user("画个流程图"),
            AiChatMessage::assistant("graph TD\n  A-->B"),
        ];
        let path = store.save(&key, &msgs).unwrap();
        assert!(path.ends_with(format!("{key}.json")));

        assert_eq!(store.load(&key), msgs);

        store.clear(&key).unwrap();
        assert!(store.load(&key).is_empty());
        store.clear(&key).unwrap(); // 幂等

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupted_conversation_reads_as_empty() {
        let (dir, store) = temp_store("bad");
        let key = identity_key("C:/a/x.mmd");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(store.file_for(&key), "{ not json").unwrap();
        assert!(store.load(&key).is_empty(), "损坏的历史不该让调用失败");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
