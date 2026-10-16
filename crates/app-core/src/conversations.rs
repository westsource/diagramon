//! 会话持久化：按**文档稳定身份**（路径的 SHA256）存该文档的 AI 对话轮次。
//!
//! 三件事值得先说清，它们都是刻意的：
//!
//! 1. **身份用路径哈希，不用文档 id。** 文档 id 是本次运行内的临时标识，重启就换一份
//!    （`Session::new_doc` 每次生成新的）—— 拿它当文件名等于"永远读不回来"。
//!    路径才是跨会话稳定的东西，而 `dlg.history.note` 一直宣称的就是这个口径。
//! 2. **只落文本。** 图片（dataURL）永不落盘：客户端对外承诺"图片只在内存、不落盘"，
//!    会话持久化不该把这句话变成谎话。
//! 3. **坏文件留 `.bak` 再回默认**（与 `settings::load` 同规矩），不静默丢用户内容。
//!
//! 读写是**原子写**（先 `.tmp` 再 rename），避免崩溃留下半截 JSON。

use std::path::{Path, PathBuf};

use app_ipc::Conversation;
use sha2::{Digest, Sha256};

/// 稳定身份：路径规范化 → SHA256 → 前 16 位十六进制。
pub fn doc_key(path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalize(path).as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 路径规范化：反斜杠统一成正斜杠、去尾部斜杠、**转小写**。
///
/// 转小写是因为 Windows 路径大小写不敏感（`A.mmd` 与 `a.mmd` 是同一个文件）——
/// 不统一的话同一份文档会因为大小写差异拿到两个身份，会话看起来就"丢"了。
fn normalize(path: &str) -> String {
    let unified = path.trim().replace('\\', "/");
    unified.trim_end_matches('/').to_lowercase()
}

pub fn file_for(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{key}.json"))
}

/// 读一份会话。文件不存在 → 空会话；文件坏了 → 留 `.bak` 再回空会话。
pub fn load(dir: &Path, key: &str) -> Conversation {
    let path = file_for(dir, key);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Conversation::default();
    };
    match serde_json::from_str::<Conversation>(&text) {
        Ok(c) => c,
        Err(_) => {
            let _ = std::fs::rename(&path, path.with_extension("json.bak"));
            Conversation::default()
        }
    }
}

/// 原子写。`doc_key` 为空说明这份会话没有稳定身份 —— **拒绝落盘**，
/// 否则会在目录里堆一堆无名的会话文件。
pub fn save(dir: &Path, conv: &Conversation) -> Result<(), String> {
    if conv.doc_key.is_empty() {
        return Err("会话缺少文档身份，拒绝落盘".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(conv).map_err(|e| e.to_string())?;
    let path = file_for(dir, &conv.doc_key);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 删掉一份会话；不存在也算成功（幂等）。
pub fn clear(dir: &Path, key: &str) -> Result<(), String> {
    match std::fs::remove_file(file_for(dir, key)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use app_ipc::ConversationTurn;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("diagramon-conv-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// 同一个文件的不同写法必须落到**同一个**身份上：Windows 大小写不敏感、路径分隔符
    /// 两种写法都合法、尾斜杠可有可无。任一条不成立，用户就会看到"会话丢了"。
    #[test]
    fn doc_key_is_stable_across_equivalent_paths() {
        let a = doc_key("E:/OpenCode/docs/Flow.mmd");
        assert_eq!(a, doc_key("e:\\opencode\\docs\\flow.mmd"));
        assert_eq!(a, doc_key("E:/OpenCode/docs/Flow.mmd/"));
        assert_eq!(a, doc_key("  E:/OpenCode/docs/Flow.mmd  "));
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn different_documents_get_different_keys() {
        assert_ne!(doc_key("E:/a/one.mmd"), doc_key("E:/a/two.mmd"));
        assert_ne!(doc_key("E:/a/one.mmd"), doc_key("E:/b/one.mmd"));
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = temp_dir("round-trip");
        let key = doc_key("E:/x/diagram.mmd");
        let conv = Conversation {
            doc_key: key.clone(),
            path: "E:/x/diagram.mmd".into(),
            turns: vec![
                ConversationTurn {
                    role: "user".into(),
                    text: "画一张登录流程".into(),
                    at: 1,
                    model: String::new(),
                    tokens: 0,
                    tab: "chat".into(),
                },
                ConversationTurn {
                    role: "assistant".into(),
                    text: "flowchart TD\n A --> B".into(),
                    at: 2,
                    model: "GLM-5.2".into(),
                    tokens: 822,
                    tab: "chat".into(),
                },
            ],
            updated_at: 2,
        };
        save(&dir, &conv).unwrap();

        let back = load(&dir, &key);
        assert_eq!(back.doc_key, key);
        assert_eq!(back.turns.len(), 2);
        assert_eq!(back.turns[1].role, "assistant");
        assert_eq!(back.turns[1].tokens, 822);
        assert_eq!(back.turns[1].model, "GLM-5.2");
    }

    /// 目录还不存在时 `save` 要自己建（首次运行不该要求目录先被建好）。
    #[test]
    fn save_creates_the_directory() {
        let dir = temp_dir("mkdir").join("nested");
        let key = doc_key("E:/x/a.mmd");
        save(&dir, &Conversation { doc_key: key.clone(), ..Default::default() }).unwrap();
        assert!(file_for(&dir, &key).exists());
    }

    /// 没有稳定身份的会话拒绝落盘 —— 否则目录里会堆一堆无名文件。
    #[test]
    fn save_refuses_a_conversation_without_identity() {
        let dir = temp_dir("no-key");
        assert!(save(&dir, &Conversation::default()).is_err());
    }

    #[test]
    fn missing_file_loads_as_empty_and_clear_is_idempotent() {
        let dir = temp_dir("clear");
        let key = doc_key("E:/x/missing.mmd");
        let empty = load(&dir, &key);
        assert!(empty.turns.is_empty());
        clear(&dir, &key).unwrap(); // 不存在也不该报错
        clear(&dir, &key).unwrap();
    }

    /// 坏文件留 `.bak`（不静默丢用户内容），并且能继续正常工作。
    #[test]
    fn corrupt_file_is_preserved_as_bak_and_loads_empty() {
        let dir = temp_dir("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        let key = doc_key("E:/x/broken.mmd");
        std::fs::write(file_for(&dir, &key), "{ 这不是 JSON").unwrap();

        let got = load(&dir, &key);
        assert!(got.turns.is_empty());
        assert!(file_for(&dir, &key).with_extension("json.bak").exists(), "坏文件要以 .bak 留下");
    }
}
