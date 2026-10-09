//! 会话：打开的标签页集合 + 当前活动页。
//!
//! 纯内存模型，不做 IO（读写文件由 Tauri 命令层用平台适配层完成后再灌进来）。

use std::path::PathBuf;

use app_ipc::{ApiError, DocFormat, TabState};

use crate::document::Document;

/// 一组打开的文档（应用会话）。
#[derive(Debug, Default)]
pub struct Session {
    docs: Vec<Document>,
    active: Option<String>,
    next_id: u64,
}

impl Session {
    pub fn new() -> Self {
        Self::default()
    }

    fn alloc_id(&mut self) -> String {
        self.next_id += 1;
        format!("doc-{}", self.next_id)
    }

    /// 当前活动文档 id。
    pub fn active_id(&self) -> Option<&str> {
        self.active.as_deref()
    }

    pub fn active(&self) -> Option<&Document> {
        self.active.as_deref().and_then(|id| self.get(id))
    }

    pub fn documents(&self) -> &[Document] {
        &self.docs
    }

    pub fn is_empty(&self) -> bool {
        self.docs.is_empty()
    }

    pub fn len(&self) -> usize {
        self.docs.len()
    }

    pub fn get(&self, id: &str) -> Option<&Document> {
        self.docs.iter().find(|d| d.id() == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Document> {
        self.docs.iter_mut().find(|d| d.id() == id)
    }

    fn index_of(&self, id: &str) -> Option<usize> {
        self.docs.iter().position(|d| d.id() == id)
    }

    /// 新建未落盘文档并激活，返回其 id。
    pub fn add_untitled(&mut self, format: DocFormat) -> String {
        let id = self.alloc_id();
        self.docs.push(Document::untitled(id.clone(), format));
        self.active = Some(id.clone());
        id
    }

    /// 打开磁盘文档；若同一路径已在会话中，则激活既有页并返回 `false`。
    pub fn add_opened(
        &mut self,
        path: PathBuf,
        format: DocFormat,
        body: String,
    ) -> (String, bool) {
        let canonical = normalize_canonical(path);
        if let Some(existing) = self
            .docs
            .iter()
            .find(|d| d.path() == Some(canonical.as_path()))
        {
            let id = existing.id().to_string();
            self.active = Some(id.clone());
            return (id, false);
        }
        let id = self.alloc_id();
        self.docs
            .push(Document::from_file(id.clone(), canonical, format, body));
        self.active = Some(id.clone());
        (id, true)
    }

    /// 关闭标签页；活动页关闭后优先落到右邻居，其次左邻居。
    pub fn close(&mut self, id: &str) -> Result<(), ApiError> {
        let idx = self
            .index_of(id)
            .ok_or_else(|| ApiError::new(app_ipc::codes::INVALID_TAB, format!("未知标签页: {id}")))?;
        self.docs.remove(idx);
        if self.active.as_deref() == Some(id) {
            self.active = self
                .docs
                .get(idx)
                .or_else(|| self.docs.get(idx.saturating_sub(1)))
                .map(|d| d.id().to_string());
        }
        Ok(())
    }

    /// 激活标签页。
    pub fn activate(&mut self, id: &str) -> Result<(), ApiError> {
        if self.index_of(id).is_none() {
            return Err(ApiError::new(app_ipc::codes::INVALID_TAB, format!("未知标签页: {id}")));
        }
        self.active = Some(id.to_string());
        Ok(())
    }

    /// 全部标签页的状态快照。
    pub fn tab_states(&self) -> Vec<TabState> {
        self.docs.iter().map(Document::tab_state).collect()
    }
}

/// 规范化磁盘路径：先 `canonicalize`（解析符号链接/`..`/大小写），再去掉 Windows 的
/// verbatim 前缀（`\\?\` / `\\?\UNC\`）。
///
/// 去掉前缀是**面向用户**的决定：带前缀的路径会出现在标签页标题、最近文件与设置里
/// （`\\?\C:\…`），既不好看也会被用户复制去别处用。去前缀后仍是绝对路径，系统调用照常可用。
fn normalize_canonical(path: PathBuf) -> PathBuf {
    let canonical = path.canonicalize().unwrap_or(path);
    let text = canonical.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        canonical
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::spec;

    #[test]
    fn new_document_uses_format_default_and_is_clean() {
        let mut s = Session::new();
        let id = s.add_untitled(DocFormat::Mermaid);
        let doc = s.get(&id).unwrap();
        assert_eq!(doc.body(), spec(DocFormat::Mermaid).default_content);
        assert!(!doc.is_dirty());
        assert!(doc.path().is_none());
        assert_eq!(doc.title(), "");
        assert_eq!(s.active_id(), Some(id.as_str()));
    }

    #[test]
    fn dirty_tracks_content_not_edits() {
        let mut s = Session::new();
        let id = s.add_untitled(DocFormat::Dot);
        let original = s.get(&id).unwrap().body().to_string();

        s.get_mut(&id).unwrap().set_body(original.clone());
        assert!(!s.get(&id).unwrap().is_dirty(), "改成同内容不算脏");

        s.get_mut(&id).unwrap().set_body(format!("{original}// note\n"));
        assert!(s.get(&id).unwrap().is_dirty());

        s.get_mut(&id).unwrap().set_body(original);
        assert!(!s.get(&id).unwrap().is_dirty(), "改回来应恢复干净");
    }

    #[test]
    fn reopening_same_path_activates_existing_tab() {
        let mut s = Session::new();
        let a = s.add_untitled(DocFormat::Mermaid);
        let b = s.add_untitled(DocFormat::Mermaid);
        assert_eq!(s.active_id(), Some(b.as_str()));

        let path = PathBuf::from("E:/tmp/does-not-need-to-exist.mmd");
        let (id1, created1) = s.add_opened(path.clone(), DocFormat::Mermaid, "graph TD\n".into());
        assert!(created1);
        s.activate(&a).unwrap();

        let (id2, created2) = s.add_opened(path, DocFormat::Mermaid, "ignored".into());
        assert!(!created2, "同一路径第二次打开不新建标签页");
        assert_eq!(id1, id2);
        assert_eq!(s.active_id(), Some(id1.as_str()), "激活既有页");
        assert_eq!(s.len(), 3);
    }

    #[test]
    fn closing_active_tab_falls_to_neighbor() {
        let mut s = Session::new();
        let a = s.add_untitled(DocFormat::Mermaid);
        let b = s.add_untitled(DocFormat::Mermaid);
        let c = s.add_untitled(DocFormat::Mermaid);

        // 关中间的：活动页落到右邻居 c
        s.activate(&b).unwrap();
        s.close(&b).unwrap();
        assert_eq!(s.active_id(), Some(c.as_str()));

        // 关末尾的：落到左邻居 a
        s.close(&c).unwrap();
        assert_eq!(s.active_id(), Some(a.as_str()));

        // 关最后一个：无活动页
        s.close(&a).unwrap();
        assert!(s.is_empty());
        assert_eq!(s.active_id(), None);
    }

    #[test]
    fn close_unknown_tab_errors() {
        let mut s = Session::new();
        let err = s.close("nope").unwrap_err();
        assert_eq!(err.code, app_ipc::codes::INVALID_TAB);
    }

    #[test]
    fn canonical_paths_drop_verbatim_prefix() {
        // 不存在的路径会原样返回（canonicalize 失败），正好用来测前缀剥离这条纯逻辑
        let win = normalize_canonical(PathBuf::from(r"\\?\C:\some\dir\file.mmd"));
        assert_eq!(win, PathBuf::from(r"C:\some\dir\file.mmd"));

        let unc = normalize_canonical(PathBuf::from(r"\\?\UNC\server\share\a.mmd"));
        assert_eq!(unc, PathBuf::from(r"\\server\share\a.mmd"));

        let plain = normalize_canonical(PathBuf::from("relative/path.mmd"));
        assert_eq!(plain, PathBuf::from("relative/path.mmd"));
    }
}
