//! 格式注册表：把「按格式分派」收敛为数据，避免散落的 `if format == ...` 链。
//!
//! 逐条对齐既有 C# 实现 `Services/Documents/Formats/*.cs`：默认正文、扩展名、
//! 承载方式与能力位在此是**唯一真源**，Rust 侧与前端都从这里取。

use app_ipc::DocFormat;

/// 标签页的承载方式，决定界面显隐。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Surface {
    /// 文本编辑器 + 预览（Mermaid / DOT）
    TextWithPreview,
    /// 内嵌图形应用占满（drawio / Excalidraw）
    EmbeddedApp,
}

/// 一个可选的布局引擎（目前仅 DOT 使用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutOption {
    pub id: &'static str,
    /// 显示名即是引擎名（专有名词，不翻译）。
    pub label: &'static str,
    pub is_default: bool,
}

/// 一个文档格式的静态元数据。
#[derive(Debug, Clone, Copy)]
pub struct FormatSpec {
    pub format: DocFormat,
    /// 新建标签页的默认文件名（不含扩展名；前端按语言本地化"未命名"）。
    pub default_stem: &'static str,
    /// 新建标签页的初始正文（与既有客户端逐字符一致）。
    pub default_content: &'static str,
    pub surface: Surface,
    pub supports_ai_assistant: bool,
    pub supports_graph_import: bool,
    pub uses_mermaid_cli_export: bool,
    pub layout_options: &'static [LayoutOption],
}

const DOT_LAYOUTS: &[LayoutOption] = &[
    LayoutOption { id: "dot", label: "dot", is_default: true },
    LayoutOption { id: "neato", label: "neato", is_default: false },
    LayoutOption { id: "fdp", label: "fdp", is_default: false },
    LayoutOption { id: "sfdp", label: "sfdp", is_default: false },
    LayoutOption { id: "twopi", label: "twopi", is_default: false },
    LayoutOption { id: "circo", label: "circo", is_default: false },
];

/// Mermaid 新建正文（`MainViewModel.SetInitialContent` 的原字面量）。
const MERMAID_DEFAULT: &str = "graph TD\n    A[开始] --> B{判断}\n    B -->|是| C[处理A]\n    B -->|否| D[处理B]\n    C --> E[结束]\n    D --> E\n";

/// DOT 新建正文。
const DOT_DEFAULT: &str = "digraph G {\n    A -> B;\n}\n";

/// drawio 空文档：一个空的单页 mxfile。
const DRAWIO_DEFAULT: &str = r#"<mxfile host="Diagramon" version="24.0.0"><diagram id="page-1" name="Page-1"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>"#;

/// Excalidraw 空场景。
const EXCALIDRAW_DEFAULT: &str = r##"{"type":"excalidraw","version":2,"source":"Diagramon","elements":[],"appState":{"gridSize":null,"viewBackgroundColor":"#ffffff"},"files":{}}"##;

const SPECS: [FormatSpec; 4] = [
    FormatSpec {
        format: DocFormat::Mermaid,
        default_stem: "Untitled",
        default_content: MERMAID_DEFAULT,
        surface: Surface::TextWithPreview,
        supports_ai_assistant: true,
        supports_graph_import: true,
        uses_mermaid_cli_export: false, // dev2.0 去 mmdc：改页内 `data:` 路栅格化
        layout_options: &[],
    },
    FormatSpec {
        format: DocFormat::Dot,
        default_stem: "Untitled",
        default_content: DOT_DEFAULT,
        surface: Surface::TextWithPreview,
        supports_ai_assistant: true,
        supports_graph_import: false,
        uses_mermaid_cli_export: false,
        layout_options: DOT_LAYOUTS,
    },
    FormatSpec {
        format: DocFormat::Drawio,
        default_stem: "Untitled",
        default_content: DRAWIO_DEFAULT,
        surface: Surface::EmbeddedApp,
        supports_ai_assistant: false,
        supports_graph_import: false,
        uses_mermaid_cli_export: false,
        layout_options: &[],
    },
    FormatSpec {
        format: DocFormat::Excalidraw,
        default_stem: "Untitled",
        default_content: EXCALIDRAW_DEFAULT,
        surface: Surface::EmbeddedApp,
        supports_ai_assistant: false,
        supports_graph_import: false,
        uses_mermaid_cli_export: false,
        layout_options: &[],
    },
];

/// 全部格式条目。
pub fn specs() -> &'static [FormatSpec] {
    &SPECS
}

/// 按格式取元数据（注册表里必然存在）。
pub fn spec(format: DocFormat) -> &'static FormatSpec {
    SPECS
        .iter()
        .find(|s| s.format == format)
        .expect("格式注册表缺失条目")
}

/// 按格式 id 取元数据。
pub fn spec_by_id(id: &str) -> Option<&'static FormatSpec> {
    SPECS.iter().find(|s| s.format.id() == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_covers_all_formats() {
        for f in DocFormat::ALL {
            let s = spec(f);
            assert_eq!(s.format, f);
            assert!(!s.default_content.is_empty(), "{f} 默认正文不应为空");
        }
    }

    #[test]
    fn extensions_are_unique_across_formats() {
        let mut seen = std::collections::HashSet::new();
        for s in specs() {
            for e in s.format.extensions() {
                assert!(seen.insert(*e), "扩展名 {e} 被多个格式认领");
            }
        }
    }

    #[test]
    fn unknown_extension_falls_back_to_mermaid() {
        assert_eq!(
            DocFormat::from_path(std::path::Path::new("a.unknown")),
            DocFormat::Mermaid
        );
        assert_eq!(
            DocFormat::from_path(std::path::Path::new("a.dot")),
            DocFormat::Dot
        );
    }

    #[test]
    fn only_mermaid_supports_graph_import() {
        let importers: Vec<_> = specs()
            .iter()
            .filter(|s| s.supports_graph_import)
            .map(|s| s.format)
            .collect();
        assert_eq!(importers, vec![DocFormat::Mermaid]);
    }

    #[test]
    fn only_dot_has_layout_options() {
        for s in specs() {
            assert_eq!(
                !s.layout_options.is_empty(),
                s.format == DocFormat::Dot,
                "{} 的布局选项与预期不符",
                s.format
            );
        }
        assert_eq!(spec(DocFormat::Dot).layout_options.len(), 6);
    }
}
