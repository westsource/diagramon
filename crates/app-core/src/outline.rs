//! 大纲：由正文解析出可跳转的结构条目（侧栏「当前图大纲」）。
//!
//! 与 `lint` 一样是**行式扫描**：够用、可预测、不会因为某个语法变体整页空白。
//! 真正的 AST 解析留给后续（届时本模块的公开签名不变，换实现即可）。

use app_ipc::{FormatId, OutlineGroup, OutlineRow};

pub fn outline(format: FormatId, body: &str) -> Vec<OutlineGroup> {
    match format {
        FormatId::Mermaid => mermaid(body),
        FormatId::Dot => dot(body),
        FormatId::Drawio => xml(body),
        FormatId::Excalidraw => json(body),
    }
}

fn group(title: &str, rows: Vec<OutlineRow>) -> Option<OutlineGroup> {
    if rows.is_empty() {
        None
    } else {
        Some(OutlineGroup { title: title.to_string(), rows })
    }
}

fn row(name: impl Into<String>, kind: &str, line: u32) -> OutlineRow {
    OutlineRow { name: name.into(), kind: kind.to_string(), line }
}

/// 从 `A([开始])` / `B{判断}` 这类写法里抠出显示名。
fn mermaid_label(text: &str) -> String {
    for (open, close) in [("([", "])"), ("[(", ")]"), ("[[", "]]"), ("{{", "}}"), ("[", "]"), ("(", ")"), ("{", "}")] {
        if let Some(i) = text.find(open) {
            if let Some(j) = text[i + open.len()..].find(close) {
                let label = text[i + open.len()..i + open.len() + j].trim();
                if !label.is_empty() {
                    return label.to_string();
                }
            }
        }
    }
    // 没有标签就退回节点 id
    text.split_whitespace()
        .next()
        .unwrap_or_default()
        .trim_end_matches(&['[', '(', '{'][..])
        .to_string()
}

fn mermaid(body: &str) -> Vec<OutlineGroup> {
    let mut clusters = Vec::new();
    let mut nodes = Vec::new();
    let mut edges = Vec::new();

    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") {
            continue;
        }
        if let Some(rest) = text.strip_prefix("subgraph") {
            let name = rest.trim();
            clusters.push(row(if name.is_empty() { "(匿名)" } else { name }, "cluster", line));
            continue;
        }
        if text == "end" || text.starts_with("classDef") || text.starts_with("class ") || text.starts_with("style ") {
            continue;
        }
        if text.contains("-->") || text.contains("---") || text.contains("-.-") || text.contains("==>") {
            edges.push(row(text.split_whitespace().take(6).collect::<Vec<_>>().join(" "), "edge", line));
            continue;
        }
        // 形如 `A[标签]` / `B{判定}` 的声明行
        let head = text.split_whitespace().next().unwrap_or("");
        if head.contains('[') || head.contains('(') || head.contains('{') {
            nodes.push(row(mermaid_label(head), "node", line));
        }
    }

    [group("子图 subgraph", clusters), group("节点", nodes), group("边", edges)]
        .into_iter()
        .flatten()
        .collect()
}

fn dot(body: &str) -> Vec<OutlineGroup> {
    let mut clusters = Vec::new();
    let mut nodes = Vec::new();
    let mut edges = Vec::new();

    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("//") || text.starts_with('#') {
            continue;
        }
        if let Some(rest) = text.strip_prefix("subgraph") {
            let name = rest.trim().trim_end_matches('{').trim();
            clusters.push(row(if name.is_empty() { "(匿名)" } else { name }, "cluster", line));
            continue;
        }
        if text.contains("->") || text.contains("--") {
            edges.push(row(text.split_whitespace().take(6).collect::<Vec<_>>().join(" "), "edge", line));
            continue;
        }
        // `node [ … ]` 与 `a [label=…]` 都算节点声明，但属性默认值那行不算
        if let Some(name) = text.split('[').next().map(str::trim) {
            if text.contains('[') && !matches!(name, "node" | "edge" | "graph" | "digraph") && !name.contains(' ') {
                nodes.push(row(name, "node", line));
            }
        }
    }

    [group("子图 cluster", clusters), group("节点", nodes), group("边", edges)]
        .into_iter()
        .flatten()
        .collect()
}

fn xml(body: &str) -> Vec<OutlineGroup> {
    let mut rows = Vec::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if !text.starts_with("<mxCell") {
            continue;
        }
        // value="…" —— 取第一个 value 属性
        let name = match text.find("value=\"") {
            Some(i) => {
                let rest = &text[i + 7..];
                match rest.find('"') {
                    Some(j) => rest[..j].replace("&#10;", " ").replace("&quot;", "\""),
                    None => "(未命名)".into(),
                }
            }
            None => "(未命名)".into(),
        };
        rows.push(row(if name.is_empty() { "(空标签)" } else { &name }, "element", line));
    }
    group("图元 mxCell", rows).into_iter().collect()
}

fn json(body: &str) -> Vec<OutlineGroup> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(items) = v.get("elements").and_then(|e| e.as_array()) else {
        return Vec::new();
    };
    // 行号：按元素 id 在原文里找 `"id": "xxx"` 所在行；找不到就退化为 1
    let lines: Vec<&str> = body.lines().collect();
    let mut rows = Vec::new();
    for el in items {
        let kind = el.get("type").and_then(|t| t.as_str()).unwrap_or("unknown");
        let id = el.get("id").and_then(|t| t.as_str()).unwrap_or("");
        let text = el.get("text").and_then(|t| t.as_str()).unwrap_or("");
        let line = if id.is_empty() {
            1
        } else {
            let needle = format!("\"id\": \"{id}\"");
            let needle2 = format!("\"id\":\"{id}\"");
            lines
                .iter()
                .position(|l| l.contains(&needle) || l.contains(&needle2))
                .map(|i| i as u32 + 1)
                .unwrap_or(1)
        };
        let name = if text.is_empty() { format!("{kind} {id}") } else { text.to_string() };
        rows.push(row(name.trim(), "element", line));
    }
    group("场景元素", rows).into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mermaid_outline_groups_clusters_nodes_and_edges() {
        let src = "flowchart TD\n    A([开始]) --> B[打开登录页]\n    subgraph 风控\n        L --> M\n    end\n";
        let g = outline(FormatId::Mermaid, src);
        let titles: Vec<_> = g.iter().map(|x| x.title.as_str()).collect();
        assert_eq!(titles, vec!["子图 subgraph", "节点", "边"]);

        let clusters = &g[0];
        assert_eq!(clusters.rows[0].name, "风控");
        assert_eq!(clusters.rows[0].line, 3);

        let nodes = &g[1];
        assert_eq!(nodes.rows[0].name, "开始", "应取括号里的标签而不是 id");
        assert_eq!(nodes.rows[0].line, 2);
    }

    #[test]
    fn outline_omits_empty_groups() {
        let g = outline(FormatId::Mermaid, "flowchart TD\n    A --> B\n");
        assert_eq!(g.len(), 1, "没有 subgraph 与节点声明时只应剩「边」一组");
        assert_eq!(g[0].title, "边");
    }

    #[test]
    fn dot_outline_skips_default_attribute_lines() {
        let src = "digraph G {\n  node [shape=box];\n  a [label=\"甲\"];\n  a -> b;\n  subgraph cluster_x {\n    c;\n  }\n}\n";
        let g = outline(FormatId::Dot, src);
        let nodes = g.iter().find(|x| x.title == "节点").unwrap();
        assert_eq!(nodes.rows.len(), 1, "默认属性行 node [...] 不该被算成节点");
        assert_eq!(nodes.rows[0].name, "a");
        assert!(g.iter().any(|x| x.title == "子图 cluster" && x.rows[0].name == "cluster_x"));
    }

    #[test]
    fn drawio_outline_lists_cells_with_decoded_newlines() {
        let src = "<mxfile>\n  <mxCell id=\"a\" value=\"客户端&#10;Rust + WebView2\" vertex=\"1\"/>\n  <mxCell id=\"b\"/>\n</mxfile>\n";
        let g = outline(FormatId::Drawio, src);
        assert_eq!(g[0].rows[0].name, "客户端 Rust + WebView2");
        assert_eq!(g[0].rows[1].name, "(未命名)");
        assert_eq!(g[0].rows[1].line, 3);
    }

    #[test]
    fn excalidraw_outline_points_at_real_lines() {
        let src = "{\n  \"elements\": [\n    { \"id\": \"r1\", \"type\": \"rectangle\", \"text\": \"客户端\" },\n    { \"id\": \"a1\", \"type\": \"arrow\" }\n  ]\n}\n";
        let g = outline(FormatId::Excalidraw, src);
        assert_eq!(g[0].rows[0].name, "客户端");
        assert_eq!(g[0].rows[0].line, 3);
        assert_eq!(g[0].rows[1].name, "arrow a1");
        assert_eq!(g[0].rows[1].line, 4);
    }

    #[test]
    fn invalid_body_yields_empty_outline_instead_of_panicking() {
        assert!(outline(FormatId::Excalidraw, "{ not json").is_empty());
        assert!(outline(FormatId::Mermaid, "").is_empty());
    }
}
