//! 格式注册表 —— **单一真源**。
//!
//! 前端不维护第二份清单：`app_info` 命令把这里的内容整体发给 UI，
//! 于是"能不能分屏""能不能 AI 直出""能转成什么"全部由这一处决定。

use app_ipc::{FormatId, FormatInfo, Surface, ViewMode};

/// DOT 的六种布局引擎。切换走增量更新，不重载 WASM。
pub const DOT_LAYOUTS: [&str; 6] = ["dot", "neato", "fdp", "sfdp", "twopi", "circo"];

const MERMAID_BODY: &str = "flowchart TD\n    A([开始]) --> B[第一步]\n    B --> C{判断}\n    C -- 是 --> D([结束])\n    C -- 否 --> B\n";

const DOT_BODY: &str = "digraph G {\n    rankdir=LR;\n    node [shape=box, style=\"rounded,filled\"];\n    A -> B -> C;\n}\n";

const DRAWIO_BODY: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<mxfile host=\"Diagramon\">\n  <diagram name=\"Page-1\" id=\"p1\">\n    <mxGraphModel dx=\"800\" dy=\"600\" grid=\"1\" page=\"1\">\n      <root>\n        <mxCell id=\"0\" />\n        <mxCell id=\"1\" parent=\"0\" />\n      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n";

const EXCALIDRAW_BODY: &str = "{\n  \"type\": \"excalidraw\",\n  \"version\": 2,\n  \"source\": \"https://diagramon.app\",\n  \"elements\": [],\n  \"appState\": { \"viewBackgroundColor\": \"#ffffff\" }\n}\n";

/// 四种格式的能力位。顺序即 UI 里新建对话框的顺序。
pub fn registry() -> Vec<FormatInfo> {
    vec![
        FormatInfo {
            id: FormatId::Mermaid,
            name: "Mermaid".into(),
            short: "Mmd".into(),
            exts: vec![".mmd".into(), ".mermaid".into()],
            surface: Surface::Text,
            split_view: true,
            ai: true,
            // 转换的唯一源格式：另外三种都是它的目标
            convert_to: vec![FormatId::Drawio, FormatId::Excalidraw, FormatId::Dot],
            layouts: vec![],
            note: "文本图表，支持源码 / 分屏 / 预览三态".into(),
            default_body: MERMAID_BODY.into(),
        },
        FormatInfo {
            id: FormatId::Dot,
            name: "Graphviz DOT".into(),
            short: "DOT".into(),
            exts: vec![".dot".into(), ".gv".into()],
            surface: Surface::Text,
            split_view: true,
            ai: true,
            // DOT → Mermaid 只在 flowchart 子集内可行，列为实验方向（转换中心会标出来）
            convert_to: vec![FormatId::Mermaid],
            layouts: DOT_LAYOUTS.iter().map(|s| (*s).to_string()).collect(),
            note: "文本图表，支持源码 / 分屏 / 预览三态，六种布局引擎".into(),
            default_body: DOT_BODY.into(),
        },
        FormatInfo {
            id: FormatId::Drawio,
            name: "drawio".into(),
            short: "Drw".into(),
            exts: vec![".drawio".into()],
            surface: Surface::Canvas,
            split_view: false,
            ai: false,
            convert_to: vec![],
            layouts: vec![],
            note: "画布即编辑器；文件仍是可 diff 的 mxfile XML".into(),
            default_body: DRAWIO_BODY.into(),
        },
        FormatInfo {
            id: FormatId::Excalidraw,
            name: "Excalidraw".into(),
            short: "Exc".into(),
            exts: vec![".excalidraw".into()],
            surface: Surface::Canvas,
            split_view: false,
            ai: false,
            convert_to: vec![],
            layouts: vec![],
            note: "手绘风画布；文件是场景 JSON".into(),
            default_body: EXCALIDRAW_BODY.into(),
        },
    ]
}

/// 取某个格式的能力位。
pub fn info(id: FormatId) -> FormatInfo {
    registry()
        .into_iter()
        .find(|f| f.id == id)
        .expect("registry() 覆盖全部四种格式")
}

/// 新建文档时的默认正文。
pub fn default_body(id: FormatId) -> String {
    info(id).default_body
}

/// 该格式打开时用的默认视图模式：画布型恒为「仅预览」（画布即编辑器）。
pub fn default_view_mode(id: FormatId) -> ViewMode {
    if info(id).split_view {
        ViewMode::Split
    } else {
        ViewMode::Preview
    }
}

/// 该格式可以转换到的目标（不可用方向由前端转换中心列出并给理由）。
pub fn convert_targets(id: FormatId) -> Vec<FormatId> {
    info(id).convert_to
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_covers_every_format_exactly_once() {
        let r = registry();
        assert_eq!(r.len(), 4);
        for id in [FormatId::Mermaid, FormatId::Dot, FormatId::Drawio, FormatId::Excalidraw] {
            assert_eq!(r.iter().filter(|f| f.id == id).count(), 1, "{id:?} 出现次数不为 1");
        }
    }

    #[test]
    fn canvas_formats_have_no_split_view_and_no_direct_ai() {
        for id in [FormatId::Drawio, FormatId::Excalidraw] {
            let f = info(id);
            assert!(!f.split_view, "{id:?} 是画布型，不应有分屏");
            assert!(!f.ai, "{id:?} 的 AI 产出应经 Mermaid 转换，不应声称 AI 直出");
            assert_eq!(default_view_mode(id), ViewMode::Preview);
        }
    }

    #[test]
    fn only_mermaid_is_a_conversion_source() {
        assert_eq!(convert_targets(FormatId::Mermaid).len(), 3);
        for id in [FormatId::Drawio, FormatId::Excalidraw] {
            assert!(convert_targets(id).is_empty(), "{id:?} 不应作为转换源");
        }
    }

    #[test]
    fn dot_exposes_six_layouts_and_others_do_not() {
        assert_eq!(info(FormatId::Dot).layouts.len(), 6);
        assert!(info(FormatId::Mermaid).layouts.is_empty());
    }

    #[test]
    fn extension_routing_matches_registry() {
        for f in registry() {
            for ext in &f.exts {
                assert_eq!(FormatId::from_ext(ext), f.id, "{ext} 应路由到 {:?}", f.id);
            }
        }
        // 未知扩展名回退 Mermaid（不报错）
        assert_eq!(FormatId::from_ext(".nope"), FormatId::Mermaid);
        assert_eq!(FormatId::from_ext(""), FormatId::Mermaid);
    }
}
