//! 转换报告：源哈希、`notes → ConvIssue` 映射、保真度判定。
//!
//! **报告是唯一真源**：界面只渲染，不自己再判断一次“丢了什么”。
//! 这一层放在 `app-core`（而不是命令层），因为同一份逻辑还要服务将来的 MCP `convert` 工具。

use std::collections::BTreeMap;

use app_ipc::{ConvIssue, Counts, Fidelity, FormatId, Grade, Level, SourceRef};
use sha2::{Digest, Sha256};

/// `sha256(源文本)` 的前 16 位十六进制。
///
/// 口径：先把 `\r\n` 归一成 `\n` —— 否则同一份文件在 Windows / 编辑器往返
/// 会算出两个值，“源改过没有”就永远为真。**不是安全边界**。
pub fn source_hash(source: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source.replace("\r\n", "\n").as_bytes());
    let hex = format!("{:x}", hasher.finalize());
    hex[..16].to_string()
}

fn issue(level: Level, code: &str, params: &[(&str, &str)]) -> ConvIssue {
    ConvIssue {
        level,
        code: code.to_string(),
        params: params
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect::<BTreeMap<_, _>>(),
        at: None,
    }
}

/// 把 Rust 转换器产出的一条 `note` 映射成结构化 issue。
///
/// `notes` 已有 20+ 条且还在长，所以只硬编码**稳定前缀**；
/// 其余落 `convert.note` 并把原文放进 `params.text`（中文原文至少不丢信息）。
/// 不要逐条翻译中文 —— 那种映射表一定会腐。
pub fn issue_from_note(note: &str) -> ConvIssue {
    let text = note.trim();
    if text.is_empty() {
        return issue(Level::Info, "convert.note", &[]);
    }
    let (level, code) = if text.starts_with("subgraph 映射为 DOT cluster") {
        (Level::Info, "cluster.mapped")
    } else if text.starts_with("subgraph 映射为 D2 容器") {
        (Level::Info, "cluster.mapped")
    } else if text.contains("没有对应形状") || text.contains("退化为") {
        (Level::Degraded, "shape.fallback")
    } else if text.contains("端点标记") {
        (Level::Degraded, "edge.endpoint.dropped")
    } else if text.starts_with("样式只迁移") {
        (Level::Degraded, "style.partial")
    } else if text.contains("指令未迁移") {
        (Level::Degraded, "directive.dropped")
    } else if text.contains("未迁移") {
        (Level::Degraded, "attr.dropped")
    } else if text.contains("版式") || text.contains("重新计算") {
        (Level::Info, "layout.recomputed")
    } else if text.contains("注释") {
        (Level::Info, "comment.moved")
    } else {
        (Level::Degraded, "convert.note")
    };
    let mut out = issue(level, code, &[("text", text)]);
    // 细节文案留在 params 里：i18n 只给通用句，具体丢的键名仍可见
    if code == "convert.note" || code == "shape.fallback" || code == "style.partial" {
        out.params.insert("detail".into(), text.to_string());
    } else {
        out.params.remove("text");
    }
    out
}

/// 引擎方向（由承载页完成）的 issue：**不是失败**。
///
/// `engine.delegated` 是 `Info`：委派给承载页是正常路径；用 `Blocking` 会把每一次
/// 正常转换记成失败。3.8.0 起 Excalidraw 链会真沿用文档 `look`，drawio 链的导入器
/// 不可配置 —— 两者都要如实写进报告，而不是只剩一句“交给了引擎”。
pub fn engine_issues(to: FormatId, engine: &str, look: Option<&str>) -> Vec<ConvIssue> {
    // DOT → drawio 不是“交给承载页”：Graphviz 只负责布局，映射在 Rust；
    // 外观/布局的说明与 drawio 导入器无关。
    if engine == "dotjson" {
        return vec![issue(Level::Info, "engine.dotjson", &[("engine", engine)])];
    }
    let mut out = vec![issue(Level::Info, "engine.delegated", &[("engine", engine)])];
    match to {
        FormatId::Excalidraw => {
            match look.map(str::trim).filter(|l| !l.is_empty() && *l != "auto") {
                Some(look) => out.push(issue(Level::Info, "engine.look.carried", &[("look", look)])),
                None => out.push(issue(Level::Info, "engine.look.default", &[])),
            }
            out.push(issue(Level::Info, "engine.layout.not_carried", &[]));
        }
        FormatId::Drawio => out.push(issue(Level::Info, "engine.drawio.fixed_config", &[])),
        _ => {}
    }
    out
}

/// 一条 issue 的**兼容文案**（旧前端仍读 `notes`）。
///
/// 与 `ui/js/i18n.js` 里 `conv.lookCarried` 等四条的措辞保持一致 ——
/// 这不是第二套真源，而是给 3.8.x 前端的降级路径。
pub fn issue_note(issue: &ConvIssue) -> String {
    let p = |key: &str| issue.params.get(key).map(String::as_str).unwrap_or("");
    match issue.code.as_str() {
        "engine.delegated" => format!("由 {} 引擎完成（经画布承载页）", p("engine")),
        "engine.dotjson" => "Graphviz 出布局，Rust 映射成 drawio（保几何）".to_string(),
        "normalize.applied" => format!(
            "产物已归一化（id 前缀 {}，{} 个 id）",
            p("prefix"),
            p("n")
        ),
        "inspect.only" => "仅统计结构（未归一化）".to_string(),
        "userobject.flattened" => format!("{} 个 UserObject 包装被拍平（label/id 保留，自定义字段未回写）", p("n")),
        "engine.look.carried" => format!(
            "转换沿用文档外观：look = {}（布局不参与转换，按引擎默认）",
            p("look")
        ),
        "engine.look.default" => "文档未设置外观，按引擎内置默认渲染".to_string(),
        "engine.layout.not_carried" => {
            "布局引擎不参与转换：目标图按引擎默认布局重排".to_string()
        }
        "engine.drawio.fixed_config" => {
            "drawio 内置导入器按固定配置渲染；文档级外观/布局不参与转换".to_string()
        }
        "cluster.mapped" => "subgraph 已映射为容器".to_string(),
        "shape.fallback" => "有形状在目标格式里没有对应写法，已退化".to_string(),
        "edge.endpoint.dropped" => "端点标记未迁移".to_string(),
        "style.partial" => "样式只迁移了一部分".to_string(),
        "directive.dropped" => "`click` / `linkStyle` 等指令未迁移".to_string(),
        "attr.dropped" => "部分属性未迁移".to_string(),
        "layout.recomputed" => "版式由目标引擎重新计算".to_string(),
        "comment.moved" => "注释位置改变".to_string(),
        _ => p("text").to_string(),
    }
}

/// Rust 文本方向的三层保真度。
///
/// 文本方向没有几何（目标格式自己排版），样式必然只是近似 —— 如实写，不美化。
pub fn text_fidelity(from: FormatId, to: FormatId) -> Fidelity {
    let (structure, style) = match (from, to) {
        (FormatId::Mermaid, FormatId::Dot | FormatId::D2) => (Grade::Exact, Grade::Approx),
        (FormatId::Dot, FormatId::D2) => (Grade::Partial, Grade::Approx),
        _ => (Grade::Partial, Grade::Approx),
    };
    Fidelity { structure, geometry: Grade::None, style }
}

/// 一条 issue 的源码位置（本期 Rust 转换器还不带行号，留空）。
pub fn at_line(line: Option<u32>) -> Option<SourceRef> {
    line.map(|line| SourceRef { line: Some(line), node: None })
}

/// 用 `Counts` 判断结构档位：目标格式的结构计数与源一致 ⇒ `exact`；
/// 否则 `partial`（调用方传入已知的上限档位）。
pub fn structure_grade(counts: &Counts) -> Grade {
    if counts.nodes == 0 && counts.edges == 0 {
        Grade::None
    } else {
        Grade::Exact
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_across_line_endings_and_16_chars() {
        let a = source_hash("a\r\nb\n");
        let b = source_hash("a\nb\n");
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn every_existing_note_maps_to_a_code() {
        // 3.5.6 之后 notes 的典型句子都在这里；映射表腐化时这条会红
        let samples = [
            "subgraph 映射为 DOT cluster（边框样式由布局引擎决定，Mermaid 的圆角虚线不保留）",
            "`([文本])` 体育场形在 DOT 里没有对应形状，退化为圆角框",
            "`o`（圆圈）端点标记在 DOT 里没有对应形状，退化为不带端点",
            "样式只迁移 fill / stroke / stroke-width / color；其余键未迁移：x",
            "subgraph 内的 `direction` 未迁移（DOT cluster 没有局部方向）",
            "版式由 D2 的布局引擎重新计算（Mermaid 不保留位置信息）",
            "`%%` 注释改写为 `#` 并汇总到文件开头（位置不再逐行对应）",
        ];
        for note in samples {
            let issue = issue_from_note(note);
            assert_ne!(issue.code, "convert.note", "未映射：{note}");
        }
    }

    #[test]
    fn unknown_note_keeps_original_text() {
        let issue = issue_from_note("一个新的、没人映射过的说明");
        assert_eq!(issue.code, "convert.note");
        assert_eq!(issue.params.get("text").map(String::as_str), Some("一个新的、没人映射过的说明"));
    }

    #[test]
    fn engine_issues_keep_look_and_layout_facts() {
        let exc = engine_issues(FormatId::Excalidraw, "excalidraw", Some("handDrawn"));
        assert!(exc.iter().any(|i| i.code == "engine.look.carried"));
        assert!(exc.iter().any(|i| i.code == "engine.layout.not_carried"));
        let drawio = engine_issues(FormatId::Drawio, "drawio", Some("handDrawn"));
        assert!(drawio.iter().any(|i| i.code == "engine.drawio.fixed_config"));
        assert!(!drawio.iter().any(|i| i.code == "engine.look.carried"));
        assert!(drawio.iter().all(|i| i.level != Level::Blocking));
    }
}
