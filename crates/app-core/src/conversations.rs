//! 会话持久化：按**文档稳定身份**存该文档的 AI 对话轮次。
//!
//! 身份有两种（3.8.0 起），对应会话的两种归属：
//!
//! 1. **doc**：文档有路径 → 身份 = 路径的 SHA256（`doc_key`）。路径才是跨会话稳定的东西。
//! 2. **draft**：文档还没有路径（新建、AI 生成落进去的新标签页）→ 身份 = `draft-<doc.id>`。
//!    未保存文档本来就进草稿仓（`recovery/`），重启时 `adopt_draft` **保留原 id** 并推进
//!    `untitled_seq` 防撞 —— 所以草稿身份跨重启仍然指得回同一份文档。这是"从无到有生成图"
//!    的对话不再丢的关键：以前这类文档根本没有身份，`save` 直接拒绝，整段对话从不落盘。
//!
//! 其余三条同样是刻意的：
//!
//! * **只落文本。** 图片（dataURL）永不落盘：客户端对外承诺"图片只在内存、不落盘"，
//!   会话持久化不该把这句话变成谎话。
//! * **坏文件留 `.bak` 再回默认**（与 `settings::load` 同规矩），不静默丢用户内容。
//! * **原子写**（先 `.tmp` 再 rename），避免崩溃留下半截 JSON。
//!
//! 另有 `<key>.meta.json`：列表用的轻量元数据（轮数/时间/首问），与实体同目录同前缀，
//! 删一个不会漏。批次一先"写"，`list()` 在批次二实现。

use std::path::{Path, PathBuf};

use app_ipc::Conversation;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 文档身份：路径规范化 → SHA256 → 前 16 位十六进制。
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

/// 会话键：有路径走文档身份，没有走草稿身份。
///
/// 两套前缀**不可能冲突**：`doc_key` 只含 `[0-9a-f]`（16 位），`draft-` 含别的字符。
pub fn key_for(path: Option<&str>, doc_id: &str) -> String {
    match path {
        Some(p) if !p.trim().is_empty() => doc_key(p),
        _ => draft_key(doc_id),
    }
}

/// 草稿会话键。`doc.id` 来自 `untitled-<seq>`，只含白名单字符；这里再过一遍兜底，
/// 保证键一定能当文件名（Windows 禁 `:` 等字符，白名单顺带防路径穿越）。
pub fn draft_key(doc_id: &str) -> String {
    let safe: String = doc_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    format!("draft-{safe}")
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

fn meta_file_for(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{key}.meta.json"))
}

/// 列表用的轻量元数据（批次二 `list()` 的数据源；批次一先随 save 写出）。
///
/// 故意与 `Conversation` 分离：列表不该解析几百份几十 KB 的全文（思考原文落盘之后
/// 单份并不小）。meta 与实体同目录同前缀，手动删掉实体不会留下指不回去的索引。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvMeta {
    pub key: String,
    /// 空 = 草稿（文档还没保存）
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub format: String,
    pub turns: u32,
    pub updated_at: i64,
    /// 首条用户提问的前 120 字（列表摘要用；不存全文，也不拿来检索正文）
    #[serde(default)]
    pub first_prompt: String,
    #[serde(default)]
    pub last_model: String,
}

/// 从会话推导 meta。`name` / `format` 由调用方（命令层）从文档补上 —— 纯函数层
/// 不该反过来依赖会话状态。
fn build_meta(conv: &Conversation, name: &str, format: &str) -> ConvMeta {
    let first_prompt = conv
        .turns
        .iter()
        .find(|t| t.role == "user")
        .map(|t| {
            let mut s: String = t.text.trim().chars().take(120).collect();
            if t.text.trim().chars().count() > 120 {
                s.push('…');
            }
            s
        })
        .unwrap_or_default();
    let last_model = conv
        .turns
        .iter()
        .rev()
        .find(|t| t.role == "assistant")
        .map(|t| t.model.clone())
        .unwrap_or_default();
    ConvMeta {
        key: conv.doc_key.clone(),
        path: conv.path.clone(),
        name: name.to_string(),
        format: format.to_string(),
        turns: conv.turns.len() as u32,
        updated_at: conv.updated_at,
        first_prompt,
        last_model,
    }
}

/// 原子写一个文件（`.tmp` → rename）。`create` = 需要时先建目录。
fn atomic_write(file: &Path, text: &str, create: bool) -> Result<(), String> {
    if create {
        std::fs::create_dir_all(file.parent().unwrap_or(Path::new(".")))
            .map_err(|e| e.to_string())?;
    }
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())
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

/// 原子写会话 + 同步写 meta（文档名/格式未知时传空串，批次二补）。
///
/// `doc_key` 为空说明这份会话没有稳定身份 —— **拒绝落盘**，否则目录里会堆无名文件。
pub fn save(dir: &Path, conv: &Conversation) -> Result<(), String> {
    save_doc(dir, conv, "", "")
}

/// 同 `save`，但把文档名与格式一并写进 meta（列表显示用）。
pub fn save_doc(dir: &Path, conv: &Conversation, name: &str, format: &str) -> Result<(), String> {
    if conv.doc_key.is_empty() {
        return Err("会话缺少文档身份，拒绝落盘".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(conv).map_err(|e| e.to_string())?;
    let path = file_for(dir, &conv.doc_key);
    atomic_write(&path, &text, false)?;
    let meta = build_meta(conv, name, format);
    let mtext = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    atomic_write(&meta_file_for(dir, &conv.doc_key), &mtext, false)
}

/// 删掉一份会话（含 meta）；不存在也算成功（幂等）。
pub fn clear(dir: &Path, key: &str) -> Result<(), String> {
    for f in [file_for(dir, key), meta_file_for(dir, key)] {
        match std::fs::remove_file(&f) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

/// 迁移会话键（文档保存 / 另存为时调用）：`from` → `to`。
///
/// * `from` 不存在 → no-op（`Ok(false)`）。
/// * 目标已存在 → **合并**：两份轮次按 `at` 排序，`role+text+at` 完全相同的去重。
///   "另存为"不该把历史留在旧文件上，也不能覆盖目标已有的对话。
/// * `new_path` 会写进会话与 meta 的 `path` 字段（人工排查用，不参与身份计算）。
/// * 失败返回 `Err` —— **调用方不得因此让保存文档失败**，迁移是尽力而为。
pub fn migrate(dir: &Path, from: &str, to: &str, new_path: Option<&str>) -> Result<bool, String> {
    if from == to || from.is_empty() || to.is_empty() {
        return Ok(false);
    }
    let src_file = file_for(dir, from);
    if !src_file.exists() {
        return Ok(false);
    }
    let mut conv = load(dir, from);
    conv.doc_key = to.to_string();
    if let Some(p) = new_path {
        conv.path = p.to_string();
    }
    let dst_file = file_for(dir, to);
    if dst_file.exists() {
        let mut dst = load(dir, to);
        dst.turns.extend(conv.turns.drain(..));
        dst.turns.sort_by_key(|t| t.at);
        dst.turns.dedup_by(|a, b| a.role == b.role && a.text == b.text && a.at == b.at);
        dst.updated_at = dst.updated_at.max(conv.updated_at);
        if new_path.is_some() {
            dst.path = conv.path.clone();
        }
        save(dir, &dst)?;
    } else {
        save(dir, &conv)?;
    }
    // 源头清掉（json 与 meta；load 把坏文件改成 .bak 的场景也一并清）
    let _ = std::fs::remove_file(&src_file);
    let _ = std::fs::remove_file(src_file.with_extension("json.bak"));
    let _ = std::fs::remove_file(meta_file_for(dir, from));
    Ok(true)
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

    fn turn(role: &str, text: &str, at: i64) -> ConversationTurn {
        ConversationTurn {
            role: role.into(),
            text: text.into(),
            at,
            model: if role == "assistant" { "GLM-5.2".into() } else { String::new() },
            tokens: 0,
            tab: "chat".into(),
            thinking: String::new(),
        }
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

    /// 两套键前缀不可能相等：文档键只有十六进制字符，`draft-` 含别的。
    /// 真撞上的话，草稿会话会覆盖某个文件的会话 —— 这条测试就是防它的。
    #[test]
    fn draft_keys_never_collide_with_doc_keys() {
        let d = draft_key("untitled-3");
        assert!(d.starts_with("draft-"));
        assert_ne!(d, doc_key(&d));
        assert_eq!(draft_key("untitled-3"), draft_key("untitled-3"));
        assert_ne!(draft_key("untitled-3"), draft_key("untitled-4"));
        // 非白名单字符被替换，键仍能当文件名
        assert_eq!(draft_key("a/b:c"), "draft-a_b_c");
    }

    /// 有路径走文档身份；没路径走草稿身份 —— 后者是"从无到有生成"的对话能落盘的前提。
    #[test]
    fn key_for_picks_draft_when_there_is_no_path() {
        assert_eq!(key_for(Some("E:/x/a.mmd"), "untitled-1"), doc_key("E:/x/a.mmd"));
        assert_eq!(key_for(None, "untitled-1"), draft_key("untitled-1"));
        assert_eq!(key_for(Some(""), "untitled-1"), draft_key("untitled-1"));
        assert_eq!(key_for(Some("  "), "untitled-1"), draft_key("untitled-1"));
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
                    thinking: String::new(),
                },
                ConversationTurn {
                    role: "assistant".into(),
                    text: "flowchart TD\n A --> B".into(),
                    at: 2,
                    model: "GLM-5.2".into(),
                    tokens: 822,
                    tab: "chat".into(),
                    thinking: "先读一遍这张图，把节点与边理清楚……".into(),
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
        // 思考原文必须跟着回得来：界面上"点开重读推理"全靠它（2026-10-18 前它只活在内存里）
        assert_eq!(back.turns[1].thinking, "先读一遍这张图，把节点与边理清楚……");
        assert!(back.turns[0].thinking.is_empty(), "用户轮不该带思考");
    }

    /// 旧版本写的会话文件里没有 `thinking` 字段 —— 升级后必须照样读得出来（空串），
    /// 否则用户一升级就"历史会话全空了"。
    #[test]
    fn legacy_turn_without_thinking_field_still_loads() {
        let dir = temp_dir("legacy");
        std::fs::create_dir_all(&dir).unwrap();
        let key = doc_key("E:/x/legacy.mmd");
        std::fs::write(
            file_for(&dir, &key),
            format!(
                r#"{{"doc_key":"{key}","path":"E:/x/legacy.mmd","updated_at":2,"turns":[
                    {{"role":"user","text":"问","at":1,"model":"","tokens":0,"tab":"chat"}},
                    {{"role":"assistant","text":"答","at":2,"model":"GLM-5.2","tokens":10,"tab":"chat"}}]}}"#
            ),
        )
        .unwrap();

        let back = load(&dir, &key);
        assert_eq!(back.turns.len(), 2);
        assert!(back.turns[1].thinking.is_empty());
        assert_eq!(back.turns[1].text, "答");
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

    /// save 要同步写 meta，clear 要连 meta 一起删 —— 批次二的列表只读 meta，
    /// 这两条不成立的话列表要么缺项要么指向已删除的会话。
    #[test]
    fn save_writes_meta_and_clear_removes_it() {
        let dir = temp_dir("meta");
        let key = doc_key("E:/x/meta.mmd");
        let conv = Conversation {
            doc_key: key.clone(),
            path: "E:/x/meta.mmd".into(),
            turns: vec![turn("user", "画一张时序图", 1), turn("assistant", "sequenceDiagram…", 2)],
            updated_at: 2,
        };
        save_doc(&dir, &conv, "支付时序.d2", "d2").unwrap();

        let mpath = dir.join(format!("{key}.meta.json"));
        let text = std::fs::read_to_string(&mpath).unwrap();
        let meta: ConvMeta = serde_json::from_str(&text).unwrap();
        assert_eq!(meta.key, key);
        assert_eq!(meta.name, "支付时序.d2");
        assert_eq!(meta.format, "d2");
        assert_eq!(meta.turns, 2);
        assert_eq!(meta.first_prompt, "画一张时序图");
        assert_eq!(meta.last_model, "GLM-5.2");

        clear(&dir, &key).unwrap();
        assert!(!mpath.exists());
        assert!(!file_for(&dir, &key).exists());
    }

    /// 保存文档时的键迁移：草稿 → 文档键。源文件与源 meta 都要清掉，
    /// 否则同一段对话会在两处各留一份，列表里出现"同一个会话两条"。
    #[test]
    fn migrate_moves_a_draft_conversation_to_the_doc_key() {
        let dir = temp_dir("migrate-move");
        let draft = draft_key("untitled-2");
        let conv = Conversation {
            doc_key: draft.clone(),
            path: String::new(),
            turns: vec![turn("user", "画一张流程图", 1)],
            updated_at: 1,
        };
        save(&dir, &conv).unwrap();

        let doc = doc_key("E:/x/flow.mmd");
        migrate(&dir, &draft, &doc, Some("E:/x/flow.mmd")).unwrap();

        assert!(!file_for(&dir, &draft).exists(), "源会话要删掉");
        assert!(!dir.join(format!("{draft}.meta.json")).exists(), "源 meta 要删掉");
        let back = load(&dir, &doc);
        assert_eq!(back.doc_key, doc);
        assert_eq!(back.path, "E:/x/flow.mmd");
        assert_eq!(back.turns.len(), 1);
        assert!(dir.join(format!("{doc}.meta.json")).exists());
    }

    /// 另存为到"已有会话的文件"：合并而不是覆盖 —— 按 at 排序、完全相同的轮去重。
    #[test]
    fn migrate_merges_when_the_target_already_exists() {
        let dir = temp_dir("migrate-merge");
        let from = draft_key("untitled-1");
        let to = doc_key("E:/x/shared.mmd");
        save(
            &dir,
            &Conversation {
                doc_key: from.clone(),
                path: String::new(),
                turns: vec![turn("user", "共同的提问", 5), turn("assistant", "只在草稿里的回答", 6)],
                updated_at: 6,
            },
        )
        .unwrap();
        save(
            &dir,
            &Conversation {
                doc_key: to.clone(),
                path: "E:/x/shared.mmd".into(),
                turns: vec![turn("user", "共同的提问", 5)],
                updated_at: 5,
            },
        )
        .unwrap();

        migrate(&dir, &from, &to, Some("E:/x/shared.mmd")).unwrap();

        let merged = load(&dir, &to);
        assert_eq!(merged.turns.len(), 2, "重复的那轮要去掉");
        assert_eq!(merged.turns[0].text, "共同的提问");
        assert_eq!(merged.turns[1].text, "只在草稿里的回答");
        assert!(merged.turns.iter().all(|t| t.at <= merged.turns.last().unwrap().at));
        assert!(!file_for(&dir, &from).exists());
    }

    /// 源不存在 → no-op；from == to → no-op。保存一个已有路径的文档时走的就是后者。
    #[test]
    fn migrate_is_a_noop_without_a_source_or_for_the_same_key() {
        let dir = temp_dir("migrate-noop");
        assert!(!migrate(&dir, &draft_key("untitled-9"), &doc_key("E:/x/a.mmd"), None).unwrap());
        let key = doc_key("E:/x/a.mmd");
        save(&dir, &Conversation { doc_key: key.clone(), ..Default::default() }).unwrap();
        assert!(!migrate(&dir, &key, &key, None).unwrap());
        assert!(file_for(&dir, &key).exists());
    }
}
