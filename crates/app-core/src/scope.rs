//! 当前行所在作用域：Mermaid 的 `subgraph` / DOT 的 `cluster`。
//!
//! 这是面包屑被删掉之后**唯一不重复的一条信息**（文件路径在标题栏、层级在侧栏），
//! 因此挪到状态栏的行列号旁边显示（见 design/ui-proto/index.html §2）。

use app_ipc::FormatId;

/// 返回光标行所处的作用域名；不在任何 subgraph/cluster 里时返回空串。
///
/// 语义是「包含这一行的最内层作用域」，两条边界都对使用者有利：
/// * 光标停在 `subgraph` 那一行 ⇒ 已经算在该作用域内（不会刚写完就显示空）；
/// * 光标停在 `end` 那一行 ⇒ **仍算在内**（收尾行属于这个块），
///   否则从块内往下挪一行，状态栏的作用域会闪一下消失。
/// 也就是说：光标行上的 `end` 不参与弹栈。
pub fn current_scope(format: FormatId, body: &str, line: u32) -> String {
    if !matches!(format, FormatId::Mermaid | FormatId::Dot) {
        return String::new();
    }
    let upto = line.max(1) as usize;
    let mut stack: Vec<String> = Vec::new();

    for (idx, raw) in body.lines().take(upto).enumerate() {
        // 光标所在行上的 end 不弹栈（见上）
        let on_caret_line = idx + 1 == upto;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("//") || text.starts_with('#') || text.starts_with("%%") {
            continue;
        }
        match format {
            FormatId::Mermaid => {
                if let Some(rest) = text.strip_prefix("subgraph") {
                    let name = rest.trim();
                    stack.push(if name.is_empty() { "(匿名)".into() } else { name.to_string() });
                } else if text == "end" && !on_caret_line {
                    stack.pop();
                }
            }
            FormatId::Dot => {
                if let Some(rest) = text.strip_prefix("subgraph") {
                    // `subgraph cluster_x {` / `subgraph name` / `subgraph {`
                    let name = rest
                        .trim()
                        .trim_end_matches('{')
                        .trim()
                        .split_whitespace()
                        .next()
                        .unwrap_or("");
                    stack.push(if name.is_empty() { "(匿名)".into() } else { name.to_string() });
                } else if text == "}" && !on_caret_line {
                    stack.pop();
                }
            }
            _ => {}
        }
    }

    stack.pop().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MMD: &str = "flowchart TD\n    A --> B\n    subgraph 风控\n        L --> M\n        M --> N\n    end\n    C --> D\n";

    #[test]
    fn mermaid_scope_is_empty_outside_subgraph() {
        assert_eq!(current_scope(FormatId::Mermaid, MMD, 2), "");
        assert_eq!(current_scope(FormatId::Mermaid, MMD, 7), "", "end 之后应出作用域");
    }

    #[test]
    fn mermaid_scope_covers_subgraph_body_and_its_own_line() {
        for line in [3, 4, 5, 6] {
            assert_eq!(current_scope(FormatId::Mermaid, MMD, line), "风控", "第 {line} 行应在风控内");
        }
    }

    #[test]
    fn mermaid_nested_subgraphs_return_innermost() {
        let src = "flowchart TD\n subgraph 外\n  subgraph 内\n   A --> B\n  end\n end\n";
        assert_eq!(current_scope(FormatId::Mermaid, src, 4), "内");
        assert_eq!(current_scope(FormatId::Mermaid, src, 6), "外");
    }

    #[test]
    fn dot_cluster_scope_works_with_braces_on_the_same_line() {
        let src = "digraph G {\n  subgraph cluster_local {\n    a -> b;\n  }\n  c -> d;\n}\n";
        assert_eq!(current_scope(FormatId::Dot, src, 3), "cluster_local");
        assert_eq!(current_scope(FormatId::Dot, src, 5), "");
    }

    #[test]
    fn canvas_formats_never_report_scope() {
        assert_eq!(current_scope(FormatId::Drawio, "<mxfile/>", 1), "");
        assert_eq!(current_scope(FormatId::Excalidraw, "{}", 1), "");
    }

    #[test]
    fn line_beyond_end_of_file_does_not_panic() {
        assert_eq!(current_scope(FormatId::Mermaid, MMD, 999), "");
    }
}
