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
//! 删一个不会漏。`list()` 只读 meta；**旧文件没有 meta 时就地补写一次**（幂等，见
//! `list()`），所以从这里升级上来的用户也能立刻在「对话历史 → 全部」里看到历史。

use std::path::{Path, PathBuf};

use app_ipc::{ConvMeta, Conversation, ConversationTurn, FormatId};
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
        // 归属标记由 `list()` 现算（落盘时还不知道文件/草稿之后在不在）
        missing: false,
        live_draft: false,
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

/// 列表上限。一条 meta <1KB，"全部"页面 500 段够用；更早的仍在磁盘上，只是不列出来。
pub const MAX_LIST: usize = 500;

/// 读出全部会话的**元数据**（`对话历史 → 全部` 的数据源）。
///
/// 四条约定：
/// * 只认实体 `<key>.json`（跳过 `.meta.json` / `.bak` / 目录）—— meta 是附属物，
///   实体没了就不该在列表里留一条指不回去的索引；
/// * 旧文件没有 meta 时就地**补写一次**（`build_meta` 需要文档名/格式，这里拿不到，
///   留空 —— 名字那一列会退化成 key 的形态，下次该文档再存一轮就补齐了）；
/// * `missing` / `live_draft` 是 **现算**的，不落盘（文件在不在、草稿还活着吗，只有此刻知道）；
/// * 按 `updated_at` 倒序，最多 [`MAX_LIST`] 条。
pub fn list(dir: &Path, recovery_dir: &Path) -> Vec<ConvMeta> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(16);
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !path.is_file() || !name.ends_with(".json") || name.ends_with(".meta.json") {
            continue;
        }
        let key = name.trim_end_matches(".json").to_string();
        if key.is_empty() || key.ends_with(".meta") {
            continue;
        }
        // 只认**我们自己**的会话文件：doc_key 必须与文件名一致。
        // 会话目录里可能躺着历史遗留物 —— 旧 C# 客户端的 `default.json`（PascalCase 的
        // Id/Messages）、以及原型期的 `{key, messages}`。它们解析不成 `Conversation`，
        // 既不该列出来（会变成一堆「已失联 · 0 轮」），也**不能被这里改名/补写 meta**
        // （列表是只读操作，动别人的文件更不行 —— 2026-10-19 实测本机就有 11 个这种文件）。
        let Some(conv) = read_entity(dir, &key) else {
            continue;
        };
        // 空会话（0 轮）没有可看的内容：不列。会话文件本身留着（删了也回不来，但它没用）
        if conv.turns.is_empty() {
            continue;
        }
        let mut meta = match read_meta(dir, &key) {
            Some(m) if m.key == key => m,
            _ => backfill_meta(dir, &key, &conv),
        };
        // 归属现算：文档 / 草稿（还活着）/ 已失联（见 ui 的三种徽章）
        meta.missing = !meta.path.is_empty() && !Path::new(&meta.path).exists();
        meta.live_draft = meta.path.is_empty()
            && crate::recovery::exists(recovery_dir, key.strip_prefix("draft-").unwrap_or(""));
        out.push(meta);
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.key.cmp(&b.key)));
    out.truncate(MAX_LIST);
    out
}

fn read_meta(dir: &Path, key: &str) -> Option<ConvMeta> {
    let text = std::fs::read_to_string(meta_file_for(dir, key)).ok()?;
    serde_json::from_str::<ConvMeta>(&text).ok()
}

/// **严格**读一份实体：必须能解析成 `Conversation`、且 `doc_key` 就是文件名。
/// 读不动/形状不对（外来文件）→ `None`。**不重命名、不写盘**（列表是只读操作）。
fn read_entity(dir: &Path, key: &str) -> Option<Conversation> {
    let text = std::fs::read_to_string(file_for(dir, key)).ok()?;
    let conv: Conversation = serde_json::from_str(&text).ok()?;
    (conv.doc_key == key).then_some(conv)
}

/// 旧会话没有 meta：用已经读出来的实体补一份，并**就地补写**（下次列表就不用再解析正文）。
/// 名字/格式拿不到（列表只有 meta 和实体），留空；该文档下次再存一轮就补齐了。
fn backfill_meta(dir: &Path, key: &str, conv: &Conversation) -> ConvMeta {
    let meta = build_meta(conv, "", "");
    if let Ok(text) = serde_json::to_string_pretty(&meta) {
        let _ = atomic_write(&meta_file_for(dir, key), &text, false);
    }
    meta
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

/// 从会话里找回**最后生成的那张图**（「对话历史 → 全部」恢复已失联会话时用）。
///
/// 只认 **assistant** 轮次里的 ``` 围栏（用户贴进来的代码不是产物）；同一格式有多个就往
/// 后找最后一个 —— 它才是用户最后看到 / 应用的那一版。`format` 为空（旧会话没有 meta）
/// 时不限格式，并**据围栏语言反推**，免得把 D2 的正文塞进一张 Mermaid 新标签页。
///
/// 返回值是 `(格式, 代码)`；没有可用围栏 → `None`（调用方保留新文档的默认正文）。
pub fn last_generated_code(
    turns: &[ConversationTurn],
    format: &str,
) -> Option<(FormatId, String)> {
    let want = FormatId::from_str_opt(format);
    for turn in turns.iter().rev().filter(|t| t.role == "assistant") {
        for (lang, code) in code_blocks(&turn.text).into_iter().rev() {
            if code.trim().is_empty() {
                continue;
            }
            let Some(fid) = format_of_lang(&lang) else { continue };
            if want.is_some_and(|w| w != fid) {
                continue;
            }
            return Some((fid, code));
        }
    }
    None
}

/// 拆出 ``` 围栏：返回 `(语言标签, 正文)`。围栏按**行**认（未闭合的那段直接丢掉 ——
/// 流式被截断的半截代码不是一份能用的图）。
fn code_blocks(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut cur: Option<(String, Vec<&str>)> = None;
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("```") {
            match cur.take() {
                None => cur = Some((rest.trim().to_string(), Vec::new())),
                Some((lang, body)) => out.push((lang, body.join("\n"))),
            }
            continue;
        }
        if let Some((_, body)) = cur.as_mut() {
            body.push(line);
        }
    }
    out
}

/// 代码围栏的语言标签 → 格式。与 `ui/js/ai.js::langToFormat` 同一张表（空标签 = Mermaid，
/// 与 AI 产物落进文档时的判定一致）；认不出来 → `None`，**不猜**。
fn format_of_lang(lang: &str) -> Option<FormatId> {
    match lang.trim().to_ascii_lowercase().as_str() {
        "" | "mermaid" => Some(FormatId::Mermaid),
        "dot" | "graphviz" => Some(FormatId::Dot),
        "d2" => Some(FormatId::D2),
        "xml" | "drawio" => Some(FormatId::Drawio),
        "json" | "excalidraw" => Some(FormatId::Excalidraw),
        _ => None,
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

    fn turn(role: &str, text: &str, at: i64) -> ConversationTurn {
        ConversationTurn {
            role: role.into(),
            text: text.into(),
            at,
            model: if role == "assistant" { "GLM-5.2".into() } else { String::new() },
            tokens: 0,
            intent: "chat".into(),
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
                    intent: "chat".into(),
                    thinking: String::new(),
                },
                ConversationTurn {
                    role: "assistant".into(),
                    text: "flowchart TD\n A --> B".into(),
                    at: 2,
                    model: "GLM-5.2".into(),
                    tokens: 822,
                    intent: "chat".into(),
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
        // 旧文件的 tab 必须落进 intent；否则升级后所有轮次都归到「生图」。
        assert_eq!(back.turns[0].intent, "chat");
    }

    /// 新文件只写 `intent`，不写 `tab`；旧文件靠 serde alias 读进来。
    /// 这是“不再考虑回滚 3.10.7”后的单向迁移：读旧、写新。
    #[test]
    fn writes_intent_only_and_migrates_legacy_tab() {
        let dir = temp_dir("intent-only");
        std::fs::create_dir_all(&dir).unwrap();
        let key = doc_key("E:/x/intent.mmd");
        std::fs::write(
            file_for(&dir, &key),
            format!(
                r#"{{"doc_key":"{key}","path":"E:/x/intent.mmd","updated_at":2,"turns":[
                    {{"role":"user","text":"问","at":1,"tab":"review"}}]}}"#
            ),
        )
        .unwrap();

        let mut back = load(&dir, &key);
        assert_eq!(back.turns[0].intent, "review");
        save(&dir, &back).unwrap();
        let raw = std::fs::read_to_string(file_for(&dir, &key)).unwrap();
        assert!(raw.contains(r#""intent": "review""#));
        assert!(!raw.contains(r#""tab""#), "新文件不应再写 tab：{raw}");
        back = load(&dir, &key);
        assert_eq!(back.turns[0].intent, "review");
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
    /* ---------------- 列表（对话历史 → 全部） ---------------- */

    #[test]
    fn list_returns_every_conversation_newest_first() {
        let dir = temp_dir("list-order");
        let rec = temp_dir("list-order-recovery");
        for (path, at) in [("E:/x/old.mmd", 1), ("E:/x/new.mmd", 9), ("E:/x/mid.dot", 5)] {
            let key = doc_key(path);
            let conv = Conversation {
                doc_key: key,
                path: path.into(),
                turns: vec![turn("user", "画一张图", at)],
                updated_at: at,
            };
            save_doc(&dir, &conv, "n", "mermaid").unwrap();
        }
        let got: Vec<i64> = list(&dir, &rec).iter().map(|m| m.updated_at).collect();
        assert_eq!(got, vec![9, 5, 1], "按更新时间倒序");
    }

    #[test]
    fn list_skips_meta_files_and_backfills_missing_meta() {
        let dir = temp_dir("list-backfill");
        let rec = temp_dir("list-backfill-recovery");
        let key = doc_key("E:/x/legacy.mmd");
        let conv = Conversation {
            doc_key: key.clone(),
            path: "E:/x/legacy.mmd".into(),
            turns: vec![turn("user", "老会话里有这句", 7), turn("assistant", "好", 8)],
            updated_at: 8,
        };
        // 模拟"批次一之前"的落盘：只有实体、没有 meta
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(file_for(&dir, &key), serde_json::to_string(&conv).unwrap()).unwrap();
        assert!(!meta_file_for(&dir, &key).exists());

        let got = list(&dir, &rec);
        assert_eq!(got.len(), 1, "只列实体，不把 meta.json 当成第二条：{got:?}");
        assert_eq!(got[0].turns, 2);
        assert_eq!(got[0].first_prompt, "老会话里有这句");
        assert!(meta_file_for(&dir, &key).exists(), "旧文件要就地补写一次 meta");
    }

    #[test]
    fn list_computes_missing_and_live_draft_without_persisting_them() {
        let dir = temp_dir("list-kinds");
        let rec = temp_dir("list-kinds-recovery");
        std::fs::create_dir_all(&rec).unwrap();
        // ① 文档还在（真建一个文件）；② 文档已不在；③ 草稿仓里的草稿还活着
        std::fs::create_dir_all(&dir).unwrap();
        let alive_path = dir.join("alive.mmd");
        std::fs::write(&alive_path, "flowchart TD\n").unwrap();
        let alive = alive_path.to_string_lossy().replace('\\', "/");
        let gone = dir.join("nope").join("gone-9f3.mmd").to_string_lossy().replace('\\', "/");
        let dkey = draft_key("untitled-42");
        std::fs::write(rec.join("untitled-42.dgm.json"), "{}").ok();
        for (key, path, at) in [
            (doc_key(&alive), alive.clone(), 3),
            (doc_key(&gone), gone.clone(), 2),
            (dkey.clone(), String::new(), 1),
        ] {
            let conv = Conversation {
                doc_key: key,
                path: path.into(),
                turns: vec![turn("user", "问一句", at)],
                updated_at: at,
            };
            save_doc(&dir, &conv, "n", "mermaid").unwrap();
        }

        let got = list(&dir, &rec);
        assert_eq!(got.len(), 3);
        let by_key = |k: &str| got.iter().find(|m| m.key == k).cloned().unwrap();
        assert!(!by_key(&doc_key(&alive)).missing && !by_key(&doc_key(&alive)).live_draft);
        assert!(by_key(&doc_key(&gone)).missing, "路径没了 → missing");
        assert!(by_key(&dkey).live_draft, "草稿仓里还在 → live_draft");
        assert!(!by_key(&dkey).missing, "草稿不该算已失联");

        // 现算的标记**不落盘**：磁盘上的 meta 里不该出现它们
        let text = std::fs::read_to_string(meta_file_for(&dir, &dkey)).unwrap();
        assert!(!text.contains("\"live_draft\": true"), "{text}");
    }

    /// 会话目录里可能躺着**不是我们的** JSON（旧 C# 客户端的 `default.json`、原型期的
    /// `{key, messages}`）。它们不能被列出来，更不能被列表改名或补写 meta（列表是只读操作）。
    #[test]
    fn list_ignores_foreign_files_and_never_mutates_them() {
        let dir = temp_dir("list-foreign");
        let rec = temp_dir("list-foreign-recovery");
        std::fs::create_dir_all(&dir).unwrap();
        // ① 旧 C# 客户端：PascalCase
        let legacy = dir.join("default.json");
        std::fs::write(&legacy, r#"{"Id":"x","FilePath":null,"Messages":[{"Role":0,"Content":"hi"}]}"#).unwrap();
        // ② 原型期：{key, messages}
        let proto = dir.join("1111111111111111.json");
        std::fs::write(&proto, r#"{"key":"1111111111111111","messages":[{"role":"user","text":"hi"}]}"#).unwrap();
        // ③ 一份**合法但 0 轮**的会话（空对话没有可看的内容，不列）
        let empty_key = doc_key("E:/x/empty.mmd");
        let empty = Conversation { doc_key: empty_key.clone(), path: "E:/x/empty.mmd".into(), turns: vec![], updated_at: 5 };
        save_doc(&dir, &empty, "空.mmd", "mermaid").unwrap();
        // ④ 一份正常会话
        let ok_key = doc_key("E:/x/ok.mmd");
        let ok = Conversation {
            doc_key: ok_key.clone(),
            path: "E:/x/ok.mmd".into(),
            turns: vec![turn("user", "问一句", 9)],
            updated_at: 9,
        };
        save_doc(&dir, &ok, "ok.mmd", "mermaid").unwrap();

        let got = list(&dir, &rec);
        assert_eq!(got.len(), 1, "只该列出那份正常会话：{got:?}");
        assert_eq!(got[0].key, ok_key);
        // 外来文件原样保留，且没有被补写 meta
        assert!(legacy.exists());
        assert!(!dir.join("default.meta.json").exists(), "不该给外来的 default.json 写 meta");
        assert!(proto.exists());
        assert!(!dir.join("1111111111111111.meta.json").exists());
    }

    #[test]
    fn list_of_missing_dir_is_empty_not_panic() {
        let dir = temp_dir("list-missing");
        assert!(list(&dir, &temp_dir("list-missing-recovery")).is_empty());
    }

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

    /// 已失联恢复要带回"最后生成的那张图"：同一格式取最后一版，用户轮次里的围栏不算产物。
    #[test]
    fn last_generated_code_picks_the_latest_matching_fence() {
        let turns = vec![
            turn("user", "```mermaid\ngraph TD\n  U --> X\n```", 1),
            turn("assistant", "先给一版：\n```mermaid\ngraph TD\n  A --> B\n```", 2),
            turn("assistant", "改好了：\n```mermaid\ngraph TD\n  A --> C\n```", 3),
        ];
        let (fmt, code) = last_generated_code(&turns, "mermaid").expect("应找回最后一版");
        assert_eq!(fmt, FormatId::Mermaid);
        assert_eq!(code, "graph TD\n  A --> C");
    }

    /// 格式不匹配时**绝不**把别的格式塞进文档：只有 D2 围栏要 Mermaid → None。
    #[test]
    fn last_generated_code_never_crosses_formats() {
        let turns = vec![turn("assistant", "```d2\na -> b\n```", 1)];
        assert_eq!(last_generated_code(&turns, "mermaid"), None);
        let (fmt, code) = last_generated_code(&turns, "d2").unwrap();
        assert_eq!(fmt, FormatId::D2);
        assert_eq!(code, "a -> b");
    }

    /// 旧会话没有 meta（format 空）→ 据围栏语言反推格式，别把 D2 装进 Mermaid 标签页。
    #[test]
    fn last_generated_code_infers_the_format_of_legacy_sessions() {
        let turns = vec![turn("assistant", "```graphviz\ndigraph { A -> B }\n```", 1)];
        let (fmt, code) = last_generated_code(&turns, "").unwrap();
        assert_eq!(fmt, FormatId::Dot);
        assert_eq!(code, "digraph { A -> B }");
    }

    /// 没有围栏（未成围栏的旧格式 / 纯文本回答）→ None，保留新文档默认正文。
    #[test]
    fn last_generated_code_is_none_without_a_fence() {
        let turns = vec![turn("assistant", "graph TD\n  A --> B", 1)];
        assert_eq!(last_generated_code(&turns, "mermaid"), None);
        // 未闭合的围栏（流式被截断）也丢掉
        assert_eq!(last_generated_code(&[turn("assistant", "```mermaid\ngraph TD", 1)], "mermaid"), None);
    }
}
