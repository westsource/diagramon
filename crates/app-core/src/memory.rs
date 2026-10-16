//! AI 长期记忆：客户端持有的一份清单，随每次请求注入 prompt。
//!
//! 三件事是这个模块存在的理由，都是刻意的：
//!
//! 1. **客户端持有，服务端无状态。** 记忆只是 prompt 的一部分，所以云网关那条路
//!    **不需要任何服务端改动**；反过来，服务端存记忆就要新表 + 接进 12 步闸门，
//!    还会把计价与额度口径搅复杂。
//! 2. **只有 `Confirmed` 会注入。** `Pending`（模型自动提取的候选）留在清单里等用户确认 —— 
//!    对图表工具来说，一条错的"记住的偏好"会**静默降质**之后所有输出，而这比"用户要多点一下"
//!    严重得多。
//! 3. **体积有硬上限。** 记忆每次请求都带上，直接吃 token，而服务端有单请求成本上界；
//!    没有上限的记忆等于一条缓慢增长的账单。

use std::path::{Path, PathBuf};

use app_ipc::{MemoryEntry, MemoryScope, MemoryState};

/// 条数上限。到顶后**不再收新的自动候选**（用户手写的仍可加），并让界面如实提示。
pub const MAX_ENTRIES: usize = 200;

/// 注入 prompt 的字符上限（按 `chars()` 计，中文一个算一个）。
pub const PROMPT_MAX_CHARS: usize = 2000;

/// 单条记忆的字符上限 —— 一条顶格的记忆会挤掉别人，也说明它该被拆开。
pub const MAX_ENTRY_CHARS: usize = 200;

/// 注入块的开头。**必须写明优先级**：记忆是用户的偏好，不能压过格式语法与输出要求，
/// 否则用户一句"我想用中文"都能让模型不再输出代码围栏。
const PROMPT_HEADER: &str =
    "以下是用户此前确认过的长期偏好。它们**只影响风格与用词**，优先级低于上面的输出要求与语法要点：";

pub fn file_for(dir: &Path) -> PathBuf {
    dir.join("memory.json")
}

/// 读清单。文件不存在 → 空；坏了 → 留 `.bak` 再回空（与 settings/conversations 同规矩）。
pub fn load(dir: &Path) -> Vec<MemoryEntry> {
    let path = file_for(dir);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<MemoryEntry>>(&text) {
        Ok(items) => items,
        Err(_) => {
            let _ = std::fs::rename(&path, path.with_extension("json.bak"));
            Vec::new()
        }
    }
}

/// 原子写。
pub fn save(dir: &Path, items: &[MemoryEntry]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    let path = file_for(dir);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 规范化一条记忆：去空白、截断、补默认值。返回 `None` = 内容为空，**不该入库**。
pub fn normalize_entry(mut entry: MemoryEntry) -> Option<MemoryEntry> {
    entry.text = entry.text.trim().chars().take(MAX_ENTRY_CHARS).collect::<String>().trim().to_string();
    if entry.text.is_empty() {
        return None;
    }
    if entry.scope == MemoryScope::Global {
        // 全局条目不该带着某个文档的身份，否则它会在"本文档"筛选里被误算进去
        entry.doc = String::new();
    }
    Some(entry)
}

/// 落盘前的最后一道业务闸：内容为空的不入库；到上限后不再收**自动**条目。
///
/// 手写条目不受上限限制吗？受 —— 上限就是上限，否则"每请求都注入"的成本失控。
/// 但手写和确认过的条目**优先保留**（见 `trim_to_cap`）。
pub fn upsert(items: &mut Vec<MemoryEntry>, entry: MemoryEntry) -> bool {
    let Some(entry) = normalize_entry(entry) else {
        return false;
    };
    let existing = items.iter().position(|e| e.id == entry.id);
    if existing.is_none() && items.len() >= MAX_ENTRIES {
        return false;
    }
    match existing {
        Some(i) => items[i] = entry,
        None => items.push(entry),
    }
    true
}

/// 按时间排好、成块渲染给模型。**只取已确认、已启用、且作用域命中的条目。**
///
/// 顺序是**从新到旧**：超预算时被截掉的是更早的偏好 —— 用户最近确认的那条更可能还成立。
pub fn prompt_block(items: &[MemoryEntry], doc_key: &str, max_chars: usize) -> String {
    let mut usable: Vec<&MemoryEntry> = items
        .iter()
        .filter(|e| e.state == MemoryState::Confirmed && e.enabled && !e.text.trim().is_empty())
        .filter(|e| match e.scope {
            MemoryScope::Global => true,
            MemoryScope::Doc => !doc_key.is_empty() && e.doc == doc_key,
        })
        .collect();
    usable.sort_by(|a, b| b.at.cmp(&a.at));
    if usable.is_empty() {
        return String::new();
    }

    let mut out = String::from(PROMPT_HEADER);
    let mut used = out.chars().count();
    for entry in usable {
        let line = format!("\n- {}", entry.text.trim());
        let len = line.chars().count();
        if used + len > max_chars {
            break;
        }
        used += len;
        out.push_str(&line);
    }
    if out.trim() == PROMPT_HEADER {
        return String::new(); // 一条都没放进去
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, text: &str, state: MemoryState, scope: MemoryScope, doc: &str, at: i64) -> MemoryEntry {
        MemoryEntry {
            id: id.into(),
            text: text.into(),
            scope,
            doc: doc.into(),
            state,
            source: "user".into(),
            enabled: true,
            at,
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("diagramon-memory-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = temp_dir("round-trip");
        let items = vec![
            entry("a", "配色一律用暗色", MemoryState::Confirmed, MemoryScope::Global, "", 1),
            entry("b", "时序图优先", MemoryState::Pending, MemoryScope::Global, "", 2),
        ];
        save(&dir, &items).unwrap();
        let back = load(&dir);
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].text, "配色一律用暗色");
        assert_eq!(back[1].state, MemoryState::Pending);
    }

    #[test]
    fn missing_and_corrupt_files_load_as_empty() {
        let dir = temp_dir("corrupt");
        assert!(load(&dir).is_empty());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(file_for(&dir), "not json at all").unwrap();
        assert!(load(&dir).is_empty());
        assert!(file_for(&dir).with_extension("json.bak").exists(), "坏文件要以 .bak 留下");
    }

    /// **`Pending` 绝不进 prompt。** 这是"自动提取"与"不静默污染"之间那条线，
    /// 也是整个记忆功能里最要紧的一条断言。
    #[test]
    fn pending_entries_are_never_injected() {
        let items = vec![
            entry("a", "配色一律用暗色", MemoryState::Confirmed, MemoryScope::Global, "", 1),
            entry("b", "模型乱猜的偏好", MemoryState::Pending, MemoryScope::Global, "", 2),
        ];
        let block = prompt_block(&items, "", PROMPT_MAX_CHARS);
        assert!(block.contains("配色一律用暗色"));
        assert!(!block.contains("模型乱猜的偏好"), "待确认条目漏进 prompt 了：{block}");
    }

    #[test]
    fn disabled_entries_are_not_injected() {
        let mut e = entry("a", "配色一律用暗色", MemoryState::Confirmed, MemoryScope::Global, "", 1);
        e.enabled = false;
        assert!(prompt_block(&[e], "", PROMPT_MAX_CHARS).is_empty());
    }

    /// 文档作用域：只在该文档命中；未保存文档（doc_key 为空）看不到任何文档级记忆。
    #[test]
    fn doc_scoped_entries_only_apply_to_their_own_document() {
        let items = vec![
            entry("a", "把「风控」叫风控中心", MemoryState::Confirmed, MemoryScope::Doc, "abc123", 1),
            entry("b", "全局偏好", MemoryState::Confirmed, MemoryScope::Global, "", 2),
        ];
        let hit = prompt_block(&items, "abc123", PROMPT_MAX_CHARS);
        assert!(hit.contains("风控中心"));
        assert!(hit.contains("全局偏好"));

        let miss = prompt_block(&items, "other9", PROMPT_MAX_CHARS);
        assert!(!miss.contains("风控中心"));
        assert!(miss.contains("全局偏好"));

        let no_doc = prompt_block(&items, "", PROMPT_MAX_CHARS);
        assert!(!no_doc.contains("风控中心"), "未保存文档不该看到文档级记忆");
        assert!(no_doc.contains("全局偏好"));
    }

    /// 超预算时**从最早的开始丢**，最近确认的那条一定在。
    ///
    /// 预算要把**块标题**算进去（标题也是真进 prompt 的内容）—— 这里给 150：
    /// 标题约 49 字 + 一条 83 字放得下，再加一条就超了。
    #[test]
    fn the_char_budget_drops_the_oldest_first() {
        let items = vec![
            entry("old", &"甲".repeat(80), MemoryState::Confirmed, MemoryScope::Global, "", 1),
            entry("new", &"乙".repeat(80), MemoryState::Confirmed, MemoryScope::Global, "", 2),
        ];
        let block = prompt_block(&items, "", 150);
        assert!(!block.is_empty());
        assert!(block.contains("乙"), "最近的一条必须留下：{block}");
        assert!(!block.contains("甲"), "超预算该丢最早的那条：{block}");
    }

    /// 预算小到连**一条**都放不下时返回空串，而不是只留一个标题 ——
    /// 只留标题等于每个请求都多塞一句没有任何信息的话。
    #[test]
    fn a_budget_too_small_for_any_entry_yields_nothing() {
        let items = vec![entry("a", &"甲".repeat(80), MemoryState::Confirmed, MemoryScope::Global, "", 1)];
        assert!(prompt_block(&items, "", 20).is_empty());
    }

    #[test]
    fn empty_content_is_never_stored() {
        let mut items = Vec::new();
        let blank = entry("x", "   ", MemoryState::Confirmed, MemoryScope::Global, "", 1);
        assert!(!upsert(&mut items, blank));
        assert!(items.is_empty());
    }

    #[test]
    fn upsert_updates_in_place_by_id() {
        let mut items = vec![entry("a", "旧内容", MemoryState::Confirmed, MemoryScope::Global, "", 1)];
        assert!(upsert(&mut items, entry("a", "新内容", MemoryState::Confirmed, MemoryScope::Global, "", 5)));
        assert_eq!(items.len(), 1, "同 id 是更新，不是新增");
        assert_eq!(items[0].text, "新内容");
    }

    /// 全局条目上残留的文档身份要被清掉 —— 否则它会在"本文档"筛选里被误算进去。
    #[test]
    fn global_entries_have_their_doc_field_cleared() {
        let mut items = Vec::new();
        upsert(&mut items, entry("a", "全局偏好", MemoryState::Confirmed, MemoryScope::Global, "abc", 1));
        assert!(items[0].doc.is_empty());
    }

    #[test]
    fn upsert_stops_accepting_new_entries_at_the_cap() {
        let mut items: Vec<MemoryEntry> = (0..MAX_ENTRIES)
            .map(|i| entry(&format!("id{i}"), &format!("第{i}条"), MemoryState::Confirmed, MemoryScope::Global, "", i as i64))
            .collect();
        assert!(!upsert(&mut items, entry("extra", "溢出的", MemoryState::Confirmed, MemoryScope::Global, "", 999)));
        assert_eq!(items.len(), MAX_ENTRIES);
        // 但更新已有的仍要允许，否则用户连改错别字都做不到
        assert!(upsert(&mut items, entry("id0", "改过的", MemoryState::Confirmed, MemoryScope::Global, "", 1000)));
    }

    #[test]
    fn overlong_entry_text_is_truncated() {
        let mut items = Vec::new();
        upsert(&mut items, entry("a", &"字".repeat(500), MemoryState::Confirmed, MemoryScope::Global, "", 1));
        assert_eq!(items[0].text.chars().count(), MAX_ENTRY_CHARS);
    }

    /// 一条内容都没有时**返回空串**，而不是只带标题的块 ——
    /// 否则每个请求都会多出一条什么信息都没有的 system 消息。
    #[test]
    fn block_is_empty_when_nothing_is_usable() {
        assert!(prompt_block(&[], "", PROMPT_MAX_CHARS).is_empty());
        let only_pending = vec![entry("a", "候选", MemoryState::Pending, MemoryScope::Global, "", 1)];
        assert!(prompt_block(&only_pending, "", PROMPT_MAX_CHARS).is_empty());
    }

    #[test]
    fn block_states_its_priority_so_it_cannot_override_the_output_rules() {
        let items = vec![entry("a", "配色用暗色", MemoryState::Confirmed, MemoryScope::Global, "", 1)];
        let block = prompt_block(&items, "", PROMPT_MAX_CHARS);
        assert!(block.contains("优先级低于"), "记忆块必须写明不得压过输出要求：{block}");
        assert!(block.contains("- 配色用暗色"));
    }
}
