//! 未落盘文档的草稿仓（"关掉窗口再开，没保存的东西还在"）。
//!
//! 有路径的文档由 autosave 直接写回原文件；**没有路径的**（新建后还没另存为）
//! 才落到这里，一个文档一个 JSON。文档真正落盘（或用户明确放弃）时把草稿删掉。
//!
//! 为什么不是一个 sqlite 或一个大 JSON：草稿是**可丢的**，一个文件坏了不该带走别的。
//! 一个文档一个小文件，坏了就跳过那一个。

use std::fs;
use std::path::{Path, PathBuf};

use app_ipc::FormatId;
use serde::{Deserialize, Serialize};

/// 一份未落盘文档的快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Draft {
    pub id: String,
    pub name: String,
    pub format: FormatId,
    pub body: String,
}

/// 草稿目录（挂在应用数据目录下）。
pub fn dir_for(data_dir: &Path) -> PathBuf {
    data_dir.join("recovery")
}

/// 文件名：id 过一遍白名单，避免路径穿越或非法字符。
fn file_for(dir: &Path, id: &str) -> PathBuf {
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    dir.join(format!("{safe}.dgm.json"))
}

pub fn save(dir: &Path, draft: &Draft) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let text = serde_json::to_string_pretty(draft).map_err(std::io::Error::other)?;
    fs::write(file_for(dir, &draft.id), text)
}

pub fn remove(dir: &Path, id: &str) {
    let _ = fs::remove_file(file_for(dir, id));
}

/// 读出全部草稿。坏掉的单个文件跳过（并保持其他草稿可用）。
pub fn load_all(dir: &Path) -> Vec<Draft> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&p) else { continue };
        if let Ok(d) = serde_json::from_str::<Draft>(&text) {
            out.push(d);
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("diagramon-recovery-{tag}"));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn draft(id: &str, body: &str) -> Draft {
        Draft { id: id.into(), name: format!("{id}.mmd"), format: FormatId::Mermaid, body: body.into() }
    }

    #[test]
    fn round_trip_keeps_body_and_format() {
        let dir = tmp("rt");
        save(&dir, &draft("untitled-1", "flowchart TD\n")).unwrap();
        let all = load_all(&dir);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].body, "flowchart TD\n");
        assert_eq!(all[0].format, FormatId::Mermaid);
        assert_eq!(all[0].name, "untitled-1.mmd");
    }

    #[test]
    fn saving_again_overwrites_not_duplicates() {
        let dir = tmp("ow");
        save(&dir, &draft("untitled-1", "a")).unwrap();
        save(&dir, &draft("untitled-1", "b")).unwrap();
        let all = load_all(&dir);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].body, "b");
    }

    #[test]
    fn remove_drops_only_that_draft() {
        let dir = tmp("rm");
        save(&dir, &draft("untitled-1", "a")).unwrap();
        save(&dir, &draft("untitled-2", "b")).unwrap();
        remove(&dir, "untitled-1");
        let all = load_all(&dir);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "untitled-2");
    }

    #[test]
    fn a_corrupt_draft_does_not_take_down_the_others() {
        let dir = tmp("bad");
        save(&dir, &draft("untitled-1", "a")).unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("broken.dgm.json"), "{ not json").unwrap();
        let all = load_all(&dir);
        assert_eq!(all.len(), 1, "坏的那个跳过，好的照读");
        assert_eq!(all[0].id, "untitled-1");
    }

    #[test]
    fn missing_dir_reads_as_empty() {
        assert!(load_all(Path::new("E:/definitely/not/here")).is_empty());
    }

    #[test]
    fn id_is_sanitised_before_hitting_the_filesystem() {
        let dir = tmp("san");
        save(&dir, &draft("../escape", "x")).unwrap();
        // 不能跑到上一级去
        assert!(!dir.join("..").join("escape.dgm.json").exists());
        assert_eq!(load_all(&dir).len(), 1);
    }
}
