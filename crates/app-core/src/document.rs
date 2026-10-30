//! 文档模型：从磁盘路径构造文档、正文变更与脏标记。

use std::path::Path;

use app_ipc::{Doc, FormatId};

use crate::format;

/// 从路径推断格式与显示名。
///
/// 未知扩展名**回退 Mermaid** 且不报错 —— 与旧客户端行为一致：
/// 用户拿 .txt 里塞的 mermaid 来打开，也应该能看到图。
pub fn from_path(id: String, path: &Path) -> std::io::Result<Doc> {
    let body = std::fs::read_to_string(path)?;
    let format = path
        .extension()
        .and_then(|e| e.to_str())
        .map(FormatId::from_ext)
        .unwrap_or(FormatId::Mermaid);
    Ok(Doc {
        id,
        path: Some(path.to_string_lossy().replace('\\', "/")),
        name: file_name(path),
        format,
        body,
        dirty: false,
        view_mode: format::default_view_mode(format),
        caret_line: 1,
        caret_col: 1,
        layout: default_layout(format),
        look: None,
    })
}

/// 未落盘的文档。
pub fn untitled(id: String, format: FormatId, seq: u32) -> Doc {
    let ext = &format::info(format).exts[0];
    let name = format!("未命名-{seq}{ext}");
    Doc {
        id,
        path: None,
        name,
        format,
        body: format::default_body(format),
        dirty: true, // 新文档一出生就算「未保存」
        view_mode: format::default_view_mode(format),
        caret_line: 1,
        caret_col: 1,
        layout: default_layout(format),
        look: None,
    }
}

/// 新文档的初始布局引擎：**取注册表里的第一个**（DOT → `dot`，D2 → `dagre`，
/// Mermaid → `elk`）；没有布局的格式（画布型）为 `None`。
///
/// 这里以前写死 `format == FormatId::Dot`，加第五种格式时就成了"漏一处、D2 静默没有布局"。
/// 布局清单本来就是注册表的一部分，按它取是唯一不会再漂的第二份。
pub fn default_layout(format: FormatId) -> Option<String> {
    format::info(format).layouts.first().cloned()
}

pub fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// 另存为后更新路径与名字（dirty 由 Session 依据 `saved` 重算）。
pub fn retarget(doc: &mut Doc, path: &Path) {
    doc.path = Some(path.to_string_lossy().replace('\\', "/"));
    doc.name = file_name(path);
}

/// 把正文里的换行统一成 `\n`：Windows 上写出去的是 CRLF，读回来会污染
/// 行号计算与 diff（`\r` 会让差分每行都变）。统一在这里收口。
pub fn normalize_newlines(body: String) -> String {
    if body.contains('\r') {
        body.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        body
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_file(name: &str, content: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("diagramon-core-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        p
    }

    #[test]
    fn reads_body_and_infers_format_from_extension() {
        let p = temp_file("a.dot", "digraph G { A -> B }\n");
        let d = from_path("d1".into(), &p).unwrap();
        assert_eq!(d.format, FormatId::Dot);
        assert_eq!(d.name, "a.dot");
        assert!(!d.dirty, "刚从磁盘读出来的文档不算脏");
        assert_eq!(d.view_mode, crate::format::default_view_mode(FormatId::Dot));
        assert!(d.path.unwrap().ends_with("a.dot"));
    }

    #[test]
    fn unknown_extension_falls_back_to_mermaid_without_error() {
        let p = temp_file("weird.txt", "flowchart TD\n A-->B\n");
        let d = from_path("d2".into(), &p).unwrap();
        assert_eq!(d.format, FormatId::Mermaid);
    }

    #[test]
    fn d2_documents_get_their_default_layout_from_the_registry() {
        let p = temp_file("c.d2", "a -> b\n");
        let d = from_path("d4".into(), &p).unwrap();
        assert_eq!(d.format, FormatId::D2);
        assert_eq!(d.view_mode, crate::format::default_view_mode(FormatId::D2), "文本型默认分屏");
        assert_eq!(d.layout.as_deref(), Some("dagre"), "新文档的布局取注册表里的第一个（快的那个）");
    }

    #[test]
    fn mermaid_documents_default_to_elk_layout() {
        let p = temp_file("e.mmd", "flowchart TD\n A-->B\n");
        let d = from_path("d5".into(), &p).unwrap();
        assert_eq!(d.format, FormatId::Mermaid);
        assert_eq!(d.layout.as_deref(), Some("elk"), "3.11.3 起 Mermaid 默认 ELK 布局（注册表第一个）");
        assert_eq!(untitled("e3".into(), FormatId::Mermaid, 3).layout.as_deref(), Some("elk"), "新建的也一样");
    }

    #[test]
    fn canvas_format_opens_in_preview_only() {
        let p = temp_file("b.drawio", "<mxfile/>");
        let d = from_path("d3".into(), &p).unwrap();
        assert_eq!(d.format, FormatId::Drawio);
        assert_eq!(d.view_mode, app_ipc::ViewMode::Preview, "画布型没有分屏");
    }

    #[test]
    fn untitled_names_are_unique_by_sequence() {
        let a = untitled("e1".into(), FormatId::Mermaid, 1);
        let b = untitled("e2".into(), FormatId::Mermaid, 2);
        assert_eq!(a.name, "未命名-1.mmd");
        assert_eq!(b.name, "未命名-2.mmd");
        assert!(a.path.is_none());
        assert!(a.dirty, "新文档应显示未保存标记");
    }

    #[test]
    fn newline_normalisation_strips_carriage_returns() {
        assert_eq!(normalize_newlines("a\r\nb\rc\n".into()), "a\nb\nc\n");
        assert_eq!(normalize_newlines("a\nb".into()), "a\nb");
    }

    #[test]
    fn retarget_updates_name_and_path() {
        let mut d = untitled("e3".into(), FormatId::Mermaid, 3);
        retarget(&mut d, std::path::Path::new("E:/tmp/x/计划.mmd"));
        assert_eq!(d.name, "计划.mmd");
        assert_eq!(d.path.as_deref(), Some("E:/tmp/x/计划.mmd"));
    }
}
