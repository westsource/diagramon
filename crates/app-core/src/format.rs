//! 格式注册表 —— **单一真源**。
//!
//! 前端不维护第二份清单：`app_info` 命令把这里的内容整体发给 UI，
//! 于是"能不能分屏""能不能 AI 直出""能转成什么"全部由这一处决定。

use app_ipc::{FormatId, FormatInfo, Surface, ViewMode};

/// DOT 的六种布局引擎。切换走增量更新，不重载 WASM。
pub const DOT_LAYOUTS: [&str; 6] = ["dot", "neato", "fdp", "sfdp", "twopi", "circo"];

/// D2 的三种布局引擎。都跑在 D2 自己的 wasm 里；`tala` 实测首次编译约 5.6s（如实在 UI 里标注）。
pub const D2_LAYOUTS: [&str; 3] = ["dagre", "elk", "tala"];

/// Mermaid 的两种布局引擎：`dagre` 内建；`elk` 走随包离线 bundle
/// （@mermaid-js/layout-elk，前端经 `mermaid.registerLayoutLoaders` 注册后才可用）。
///
/// **顺序即默认**（`document::default_layout` 取第一个）：3.11.3 起 Mermaid 默认用
/// `elk` —— 分层布局的走线更整齐，用户报的"默认图太乱"就是这个。dagre 仍可随时切回；
/// 显式选过的文件按 `render-opts.json` 记住的选择走。
pub const MERMAID_LAYOUTS: [&str; 2] = ["elk", "dagre"];

/// Mermaid 的外观模式（mermaid 12 的 `look` 配置）。`auto` = 不干预
/// （Mermaid 内建默认：流程图为 neo + redux-color 主题）。
pub const MERMAID_LOOKS: [&str; 4] = ["auto", "classic", "neo", "handDrawn"];

const MERMAID_BODY: &str = "flowchart TD\n    A([开始]) --> B[第一步]\n    B --> C{判断}\n    C -- 是 --> D([结束])\n    C -- 否 --> B\n";

const DOT_BODY: &str = "digraph G {\n    rankdir=LR;\n    node [shape=box, style=\"rounded,filled\"];\n    A -> B -> C;\n}\n";

/// D2 的默认正文：**已实测能被渲染器接受的**中文示例（别自创语法 —— D2 的语法很挑）。
const D2_BODY: &str = "direction: right\n前端应用 -> 网关: HTTPS 请求\n网关 -> 用户服务: 令牌校验\n用户服务 -> 数据库: SELECT users\n";

const DRAWIO_BODY: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<mxfile host=\"Diagramon\">\n  <diagram name=\"Page-1\" id=\"p1\">\n    <mxGraphModel dx=\"800\" dy=\"600\" grid=\"1\" page=\"1\">\n      <root>\n        <mxCell id=\"0\" />\n        <mxCell id=\"1\" parent=\"0\" />\n      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n";

const EXCALIDRAW_BODY: &str = "{\n  \"type\": \"excalidraw\",\n  \"version\": 2,\n  \"source\": \"https://diagramon.app\",\n  \"elements\": [],\n  \"appState\": { \"viewBackgroundColor\": \"#ffffff\" }\n}\n";

/// 五种格式的能力位。顺序即 UI 显示顺序：drawio、Mermaid、Excalidraw、DOT、D2 ——
/// 「新建」对话框、标签条「转换」下拉、「转换能力一览」（方向清单与矩阵）、命令面板
/// 都直接吃这一份顺序，**别在前端再排第二次**。
pub fn registry() -> Vec<FormatInfo> {
    vec![
        FormatInfo {
            id: FormatId::Drawio,
            name: "drawio".into(),
            short: "Drw".into(),
            exts: vec![".drawio".into()],
            surface: Surface::Canvas,
            split_view: false,
            ai: false,
            // D2 / Excalidraw 都不作为转换源：D2 的出口是 drawio（见 D2 那条），
            // 画布型则要先把内容导回文本或 Mermaid
            convert_to: vec![],
            layouts: vec![],
            looks: vec![],
            note: "画布即编辑器；文件仍是可 diff 的 mxfile XML".into(),
            default_body: DRAWIO_BODY.into(),
        },
        FormatInfo {
            id: FormatId::Mermaid,
            name: "Mermaid".into(),
            short: "Mmd".into(),
            exts: vec![".mmd".into(), ".mermaid".into()],
            surface: Surface::Text,
            split_view: true,
            ai: true,
            // 转换的唯一通用源格式：其余四种都是它的目标
            convert_to: vec![
                FormatId::Drawio,
                FormatId::Excalidraw,
                FormatId::Dot,
                // Mermaid flowchart → D2 由 Rust 侧的 Mermaid 解析器完成（flowchart 子集）
                FormatId::D2,
            ],
            layouts: MERMAID_LAYOUTS.iter().map(|s| (*s).to_string()).collect(),
            looks: MERMAID_LOOKS.iter().map(|s| (*s).to_string()).collect(),
            note: "文本图表，支持源码 / 分屏 / 预览三态".into(),
            default_body: MERMAID_BODY.into(),
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
            looks: vec![],
            note: "手绘风画布；文件是场景 JSON".into(),
            default_body: EXCALIDRAW_BODY.into(),
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
            looks: vec![],
            note: "文本图表，支持源码 / 分屏 / 预览三态，六种布局引擎".into(),
            default_body: DOT_BODY.into(),
        },
        FormatInfo {
            id: FormatId::D2,
            name: "D2".into(),
            short: "D2".into(),
            exts: vec![".d2".into()],
            surface: Surface::Text,
            split_view: true,
            ai: true,
            // 唯一出口是 drawio（compile() 给的是绝对几何，转 mxGraph 能保几何、可继续手改）。
            // D2 → Mermaid / DOT 明确不做：D2 是那两者的超集，反向压缩每个特性都要单独决定丢什么。
            convert_to: vec![FormatId::Drawio],
            layouts: D2_LAYOUTS.iter().map(|s| (*s).to_string()).collect(),
            looks: vec![],
            note: "文本图表，支持源码 / 分屏 / 预览三态；三种布局引擎（tala 较慢）".into(),
            default_body: D2_BODY.into(),
        },
    ]
}

/// 取某个格式的能力位。
pub fn info(id: FormatId) -> FormatInfo {
    registry()
        .into_iter()
        .find(|f| f.id == id)
        .expect("registry() 覆盖全部五种格式")
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
        assert_eq!(r.len(), 5);
        for id in [FormatId::Mermaid, FormatId::Dot, FormatId::D2, FormatId::Drawio, FormatId::Excalidraw] {
            assert_eq!(r.iter().filter(|f| f.id == id).count(), 1, "{id:?} 出现次数不为 1");
        }
    }

    /// 显示顺序是产品决定的：drawio、Mermaid、Excalidraw、DOT、D2。
    /// 「新建」对话框、「转换」下拉、「转换能力一览」的方向清单与矩阵都吃这个顺序 ——
    /// 前端不再排第二次，所以这里一旦被改动，四处会一起变（这是有意的）。
    #[test]
    fn registry_order_is_the_ui_order() {
        let order: Vec<FormatId> = registry().iter().map(|f| f.id).collect();
        assert_eq!(
            order,
            vec![FormatId::Drawio, FormatId::Mermaid, FormatId::Excalidraw, FormatId::Dot, FormatId::D2]
        );
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

    /// 转换源只有两个：Mermaid（通用源，四个出口）与 D2（唯一出口是 drawio，保几何）。
    #[test]
    fn only_mermaid_and_d2_are_conversion_sources() {
        assert_eq!(convert_targets(FormatId::Mermaid).len(), 4);
        assert_eq!(convert_targets(FormatId::D2), vec![FormatId::Drawio]);
        for id in [FormatId::Drawio, FormatId::Excalidraw] {
            assert!(convert_targets(id).is_empty(), "{id:?} 不应作为转换源");
        }
        // 反向（D2 → Mermaid / DOT）明确不做：D2 是那两者的超集
        assert!(!convert_targets(FormatId::D2).contains(&FormatId::Mermaid));
    }

    #[test]
    fn dot_exposes_six_layouts_and_others_do_not() {
        assert_eq!(info(FormatId::Dot).layouts.len(), 6);
        let d2 = info(FormatId::D2);
        assert_eq!(d2.layouts, vec!["dagre", "elk", "tala"], "D2 的布局清单要如实照抄实测");
        assert_eq!(d2.layouts[0], "dagre", "默认布局必须是快的那个（tala 实测 5.6s）");
        // Mermaid：elk（离线 bundle）+ dagre 内建，**默认 elk**；外观模式四档，其余格式没有
        assert_eq!(info(FormatId::Mermaid).layouts, vec!["elk", "dagre"]);
        assert_eq!(info(FormatId::Mermaid).layouts[0], "elk", "3.11.3 起 Mermaid 默认 ELK 布局");
        assert_eq!(
            info(FormatId::Mermaid).looks,
            vec!["auto", "classic", "neo", "handDrawn"]
        );
        for id in [FormatId::Dot, FormatId::D2, FormatId::Drawio, FormatId::Excalidraw] {
            assert!(info(id).looks.is_empty(), "{id:?} 不应有外观模式");
        }
    }

    /// 文本型的三种格式都要有可渲染的默认正文（新建出来不能是空预览 + 报错面板）。
    #[test]
    fn text_formats_ship_a_default_body() {
        for id in [FormatId::Mermaid, FormatId::Dot, FormatId::D2] {
            let f = info(id);
            assert_eq!(f.surface, Surface::Text);
            assert!(f.split_view && f.ai, "{id:?} 是文本型，应有分屏与 AI 直出");
            assert!(!f.default_body.trim().is_empty(), "{id:?} 缺默认正文");
        }
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
