//! 会话：打开的文档集合与当前活动文档。
//!
//! 脏标记**不靠标志位传递**：每个条目记一份 `saved`（最后一次落盘的正文），
//! `dirty` 永远是 `doc.body != saved` 算出来的 —— 这样"改了又改回去"会正确地变回干净，
//! 不会像布尔标志那样一路脏下去。

use std::path::Path;

use app_ipc::{Doc, FormatId, Session as SessionPayload, ViewMode};

use crate::document;

pub struct Entry {
    pub doc: Doc,
    /// 最后一次落盘（或"出生时"）的正文，用于算 dirty
    saved: String,
}

impl Entry {
    fn new(doc: Doc) -> Self {
        let saved = doc.body.clone();
        Self { doc, saved }
    }

    pub fn is_dirty(&self) -> bool {
        self.doc.body != self.saved
    }

    /// 保存成功后收口：把当前正文记为已落盘。
    pub fn mark_saved(&mut self) {
        self.saved = self.doc.body.clone();
        self.doc.dirty = false;
    }

    /// 新建文档"出生即脏"：`saved` 记成空串，于是 body（默认正文）≠ saved 恒成立。
    fn born_dirty(doc: Doc) -> Self {
        Self { doc, saved: String::new() }
    }
}

#[derive(Default)]
pub struct Session {
    entries: Vec<Entry>,
    active: Option<String>,
    untitled_seq: u32,
}

impl Session {
    /// 新建一个未落盘文档并激活。
    pub fn new_doc(&mut self, format: FormatId) -> Doc {
        self.untitled_seq += 1;
        let id = format!("untitled-{}", self.untitled_seq);
        let doc = document::untitled(id, format, self.untitled_seq);
        let id = doc.id.clone();
        self.entries.push(Entry::born_dirty(doc));
        self.active = Some(id.clone());
        self.get(&id).cloned().expect("刚插入")
    }

    /// 打开一组路径。已打开的（同 path）不重复开，只激活。
    /// 返回 (成功打开的 id 列表, 失败的 (路径, 原因) 列表)。
    pub fn open_paths(&mut self, paths: &[String]) -> (Vec<String>, Vec<(String, String)>) {
        let mut opened = Vec::new();
        let mut failed = Vec::new();
        for raw in paths {
            let p = Path::new(raw);
            let normalized = raw.replace('\\', "/");
            if let Some(e) = self.entries.iter_mut().find(|e| e.doc.path.as_deref() == Some(normalized.as_str())) {
                self.active = Some(e.doc.id.clone());
                opened.push(e.doc.id.clone());
                continue;
            }
            self.untitled_seq += 1;
            let id = format!("doc-{}", self.untitled_seq);
            match document::from_path(id, p) {
                Ok(doc) => {
                    let id = doc.id.clone();
                    self.entries.push(Entry::new(doc));
                    self.active = Some(id.clone());
                    opened.push(id);
                }
                Err(err) => failed.push((raw.clone(), err.to_string())),
            }
        }
        (opened, failed)
    }

    pub fn close(&mut self, id: &str) -> bool {
        let Some(idx) = self.entries.iter().position(|e| e.doc.id == id) else {
            return false;
        };
        self.entries.remove(idx);
        if self.active.as_deref() == Some(id) {
            // 关掉活动页后落到"原位置或其前一个"，与旧客户端一致
            self.active = self
                .entries
                .get(idx.saturating_sub(1).min(self.entries.len().saturating_sub(1)))
                .map(|e| e.doc.id.clone());
            if self.entries.is_empty() {
                self.active = None;
            }
        }
        true
    }

    pub fn activate(&mut self, id: &str) -> bool {
        if self.entries.iter().any(|e| e.doc.id == id) {
            self.active = Some(id.to_string());
            true
        } else {
            false
        }
    }

    pub fn get(&self, id: &str) -> Option<&Doc> {
        self.entries.iter().find(|e| e.doc.id == id).map(|e| &e.doc)
    }

    pub fn entry_mut(&mut self, id: &str) -> Option<&mut Entry> {
        self.entries.iter_mut().find(|e| e.doc.id == id)
    }

    /// 改正文：`\r\n` 统一成 `\n`，脏标记由 `saved` 比对自然得出。
    pub fn set_body(&mut self, id: &str, body: String) -> bool {
        match self.entry_mut(id) {
            Some(e) => {
                e.doc.body = document::normalize_newlines(body);
                e.doc.dirty = e.is_dirty();
                true
            }
            None => false,
        }
    }

    pub fn set_caret(&mut self, id: &str, line: u32, col: u32) -> bool {
        match self.entry_mut(id) {
            Some(e) => {
                e.doc.caret_line = line.max(1);
                e.doc.caret_col = col.max(1);
                true
            }
            None => false,
        }
    }

    pub fn set_view_mode(&mut self, id: &str, mode: ViewMode) -> bool {
        match self.entry_mut(id) {
            Some(e) => {
                // 文本型才允许三态；画布型一律预览（前端也按能力位显示控件）
                e.doc.view_mode = if crate::format::info(e.doc.format).split_view {
                    mode
                } else {
                    ViewMode::Preview
                };
                true
            }
            None => false,
        }
    }

    pub fn set_layout(&mut self, id: &str, layout: String) -> bool {
        match self.entry_mut(id) {
            Some(e) if e.doc.format == FormatId::Dot => {
                if crate::format::DOT_LAYOUTS.contains(&layout.as_str()) {
                    e.doc.layout = Some(layout);
                    true
                } else {
                    false
                }
            }
            _ => false,
        }
    }

    /// 落盘成功后的收口（路径重定向 + 脏标记清除）。
    pub fn commit_saved(&mut self, id: &str, path: Option<&Path>) -> Option<Doc> {
        let e = self.entry_mut(id)?;
        if let Some(p) = path {
            document::retarget(&mut e.doc, p);
        }
        e.mark_saved();
        Some(e.doc.clone())
    }

    pub fn payload(&self) -> SessionPayload {
        SessionPayload {
            docs: self.entries.iter().map(|e| e.doc.clone()).collect(),
            active: self.active.clone(),
        }
    }

    /// 未保存文档数：退出前确认用。
    pub fn dirty_count(&self) -> usize {
        self.entries.iter().filter(|e| e.is_dirty()).count()
    }

    pub fn dirty_ids(&self) -> Vec<String> {
        self.entries.iter().filter(|e| e.is_dirty()).map(|e| e.doc.id.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_doc_is_dirty_and_active() {
        let mut s = Session::default();
        let d = s.new_doc(FormatId::Mermaid);
        assert_eq!(s.payload().active.as_deref(), Some(d.id.as_str()));
        assert_eq!(s.dirty_count(), 1, "新文档未落盘，应算脏");
    }

    #[test]
    fn dirty_flag_clears_when_body_returns_to_saved_text() {
        let mut s = Session::default();
        let d = s.new_doc(FormatId::Mermaid);
        s.commit_saved(&d.id, None);
        assert_eq!(s.dirty_count(), 0);

        s.set_body(&d.id, "flowchart TD\n".into());
        assert_eq!(s.dirty_count(), 1, "改过就是脏");

        // 改回去 —— 布尔标志做不到这一点
        let original = s.get(&d.id).unwrap().body.clone();
        s.set_body(&d.id, original);
        assert_eq!(s.dirty_count(), 0, "正文与已保存一致时应恢复干净");
    }

    #[test]
    fn body_normalises_crlf_so_line_numbers_stay_aligned() {
        let mut s = Session::default();
        let d = s.new_doc(FormatId::Mermaid);
        s.set_body(&d.id, "a\r\nb\r\n".into());
        assert_eq!(s.get(&d.id).unwrap().body, "a\nb\n");
    }

    #[test]
    fn close_falls_back_to_previous_tab_and_clears_when_last() {
        let mut s = Session::default();
        let a = s.new_doc(FormatId::Mermaid);
        let b = s.new_doc(FormatId::Dot);
        let c = s.new_doc(FormatId::Dot);
        assert!(s.close(&c.id));
        assert_eq!(s.payload().active.as_deref(), Some(b.id.as_str()), "关活动页落到前一个");
        assert!(s.close(&b.id));
        assert_eq!(s.payload().active.as_deref(), Some(a.id.as_str()));
        assert!(s.close(&a.id));
        assert!(s.payload().active.is_none(), "关掉最后一个后没有活动页");
    }

    #[test]
    fn view_mode_is_clamped_for_canvas_formats() {
        let mut s = Session::default();
        let d = s.new_doc(FormatId::Drawio);
        assert!(!s.set_view_mode(&d.id, ViewMode::Split), "画布型不接受分屏");
        assert_eq!(s.get(&d.id).unwrap().view_mode, ViewMode::Preview);
    }

    #[test]
    fn layout_only_applies_to_dot_and_must_be_known() {
        let mut s = Session::default();
        let dot = s.new_doc(FormatId::Dot);
        let mmd = s.new_doc(FormatId::Mermaid);
        assert!(s.set_layout(&dot.id, "neato".into()));
        assert_eq!(s.get(&dot.id).unwrap().layout.as_deref(), Some("neato"));
        assert!(!s.set_layout(&dot.id, "nope".into()), "未知布局应拒绝");
        assert!(!s.set_layout(&mmd.id, "dot".into()), "非 DOT 文档不接布局");
    }

    #[test]
    fn opening_same_path_twice_activates_instead_of_duplicating() {
        let dir = std::env::temp_dir().join("diagramon-session-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("dup.mmd");
        std::fs::write(&p, "flowchart TD\n").unwrap();
        let path = p.to_string_lossy().to_string();

        let mut s = Session::default();
        let (opened, failed) = s.open_paths(&[path.clone()]);
        assert_eq!(opened.len(), 1);
        assert!(failed.is_empty());
        let (again, _) = s.open_paths(&[path]);
        assert_eq!(again, opened, "第二次打开应复用同一个文档 id");
        assert_eq!(s.payload().docs.len(), 1);
    }

    #[test]
    fn unreadable_path_reports_failure_without_panicking() {
        let mut s = Session::default();
        let (opened, failed) = s.open_paths(&["E:/definitely/not/here.mmd".into()]);
        assert!(opened.is_empty());
        assert_eq!(failed.len(), 1);
    }
}
