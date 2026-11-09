//! 大纲：由正文解析出可跳转的结构条目（侧栏「当前图大纲」）。
//!
//! 与 `lint` 一样是**行式扫描**：够用、可预测、不会因为某个语法变体整页空白。
//! 真正的 AST 解析留给后续（届时本模块的公开签名不变，换实现即可）。

use app_ipc::{FormatId, OutlineGroup, OutlineRow};
use std::collections::HashSet;

pub fn outline(format: FormatId, body: &str) -> Vec<OutlineGroup> {
    match format {
        FormatId::Mermaid => mermaid(body),
        FormatId::Dot => dot(body),
        FormatId::D2 => d2(body),
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

/// 扫出一行里所有「id + 标签」的节点声明。
///
/// **边行也要扫**：`A([开始]) --> B[打开登录页]` 里 A、B 都是节点，
/// 只认"纯声明行"的话，实际文档（几乎全是边行）在侧栏大纲里会一个节点都没有。
/// 顺带支持 `A([开始])` 这种括号套括号的圆角节点。
fn mermaid_nodes_in(text: &str) -> Vec<(String, String)> {
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<(String, String)> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let open = chars[i];
        if matches!(open, '[' | '(' | '{') {
            // 往回找紧邻的标识符
            let mut j = i;
            while j > 0 {
                let c = chars[j - 1];
                if c.is_alphanumeric() || c == '_' || c == '-' {
                    j -= 1;
                } else {
                    break;
                }
            }
            let id: String = chars[j..i].iter().collect();
            if !id.is_empty() {
                let close = match open {
                    '[' => ']',
                    '(' => ')',
                    _ => '}',
                };
                let mut depth = 0usize;
                let mut k = i;
                let mut end = None;
                while k < chars.len() {
                    if chars[k] == open {
                        depth += 1;
                    } else if chars[k] == close {
                        depth -= 1;
                        if depth == 0 {
                            end = Some(k);
                            break;
                        }
                    }
                    k += 1;
                }
                if let Some(e) = end {
                    let raw: String = chars[i + 1..e].iter().collect();
                    let label = raw
                        .trim_matches(|c| matches!(c, '(' | ')' | '[' | ']' | '{' | '}'))
                        .trim();
                    out.push((id.clone(), if label.is_empty() { id } else { label.to_string() }));
                    i = e; // 跳到闭合处，内层不再重复扫
                }
            }
        }
        i += 1;
    }
    out
}

/// 关键词必须独立成词：`service db…` 算，`servicex` / `service:` 不算。
fn strip_kw<'a>(text: &'a str, kw: &str) -> Option<&'a str> {
    let rest = text.strip_prefix(kw)?;
    match rest.chars().next() {
        None => Some(rest),
        Some(c) if c.is_whitespace() => Some(rest.trim_start()),
        _ => None,
    }
}

/// `id(icon)[label]` → (id, label)。图标名**不是**标签 —— 大纲里绝不能拿它当节点名。
fn architecture_decl(rest: &str) -> Option<(String, Option<String>)> {
    let rest = rest.trim();
    if rest.is_empty() {
        return None;
    }
    let open = rest.find('(');
    let (id, label) = match open {
        // 没有图标位的声明（junction 由调用方另走一条；这里只对宽松输入兜底）
        None => (rest.split_whitespace().next()?, None),
        Some(i) => {
            let id = rest[..i].trim();
            if id.is_empty() {
                return None;
            }
            let after = &rest[i..];
            let close = after.find(')')?;
            let tail = after[close + 1..].trim_start();
            let label = tail
                .strip_prefix('[')
                .and_then(|inner| inner.find(']').map(|j| inner[..j].trim().to_string()))
                .filter(|s| !s.is_empty());
            (id, label)
        }
    };
    Some((id.to_string(), label))
}

/// 架构图的边：`id{group}?:PORT <]?--[>? PORT:id{group}?`。
/// 只做行式识别（方向/箭头可以贴在 `--` 两侧），解析失败就当普通文本忽略。
fn architecture_edge(text: &str) -> Option<String> {
    let (left, right) = text.split_once("--")?;
    let (left, right) = (left.trim(), right.trim());
    if !left.contains(':') || !right.contains(':') {
        return None;
    }
    let left_port = left.rsplit(':').next()?.trim_end_matches('<').trim();
    let right_port = right.split(':').next()?.trim_start_matches('>').trim();
    let ok = |s: &str| matches!(s.chars().next(), Some('T' | 'B' | 'L' | 'R'));
    if !ok(left_port) || !ok(right_port) {
        return None;
    }
    Some(text.to_string())
}

/// 架构图（`architecture-beta`）的大纲：`group` → 分组，`service`/`junction` → 节点，
/// 端口连线 → 边。**标签优先**：`service db(database)[Database]` 显示 `Database`，
/// 不是图标名 `database`（旧实现会把 cloud / database / server 当成节点名）。
fn mermaid_architecture(body: &str) -> Vec<OutlineGroup> {
    let mut clusters = Vec::new();
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut seen_groups: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut seen_nodes: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text == "architecture-beta" {
            continue;
        }
        if text.starts_with("align ") || text.starts_with("---") {
            continue;
        }
        if let Some(rest) = strip_kw(text, "group") {
            if let Some((id, label)) = architecture_decl(rest) {
                if seen_groups.insert(id.clone()) {
                    clusters.push(row(label.unwrap_or(id), "cluster", line));
                }
            }
            continue;
        }
        if let Some(rest) = strip_kw(text, "service") {
            if let Some((id, label)) = architecture_decl(rest) {
                if seen_nodes.insert(id.clone()) {
                    nodes.push(row(label.unwrap_or(id), "node", line));
                }
            }
            continue;
        }
        if let Some(rest) = strip_kw(text, "junction") {
            let id = rest.split_whitespace().next().unwrap_or("");
            if !id.is_empty() && id != "in" && seen_nodes.insert(id.to_string()) {
                nodes.push(row(id.to_string(), "node", line));
            }
            continue;
        }
        if let Some(edge) = architecture_edge(text) {
            edges.push(row(edge, "edge", line));
        }
    }

    [group("分组 group", clusters), group("节点", nodes), group("边", edges)]
        .into_iter()
        .flatten()
        .collect()
}

/* ---------------- Mermaid：按图种分派 ----------------
 *
 * 以前只有 flowchart 一套行式解析器，所有 Mermaid 文档都往里走：C4 的
 * `Person(alias, "…")` 会被当成节点、脑图的图标名会被当成标签，侧栏因此显示
 * 一堆跟图无关的东西。现在先认头部，再交给对应图种的解析器；没有专门解析器的
 * 图种返回空大纲 —— **空比错好**。
 */
fn mermaid(body: &str) -> Vec<OutlineGroup> {
    match crate::format::mermaid_header_keyword(body).as_deref() {
        Some("flowchart" | "graph" | "swimlane-beta") => mermaid_flowchart(body),
        Some("architecture-beta") => mermaid_architecture(body),
        Some("mindmap") => mermaid_mindmap(body),
        Some("sequencediagram") => mermaid_sequence(body),
        Some("classdiagram") => mermaid_class(body),
        Some("statediagram" | "statediagram-v2") => mermaid_state(body),
        Some("erdiagram") => mermaid_er(body),
        Some("gantt") => mermaid_gantt(body),
        Some("pie") => mermaid_pie(body),
        Some("journey") => mermaid_journey(body),
        Some("gitgraph") => mermaid_gitgraph(body),
        Some("timeline") => mermaid_timeline(body),
        Some("quadrantchart") => mermaid_quadrant(body),
        Some("xychart-beta") => mermaid_xychart(body),
        Some("block-beta") => mermaid_block(body),
        Some("c4context" | "c4container" | "c4component" | "c4dynamic" | "c4deployment") => mermaid_c4(body),
        Some("requirementdiagram") => mermaid_requirement(body),
        Some("kanban") => mermaid_kanban(body),
        Some("sankey-beta") => mermaid_sankey(body),
        Some("packet-beta") => mermaid_packet(body),
        Some("radar-beta") => mermaid_radar(body),
        Some("treeview-beta") => mermaid_treeview(body),
        Some("treemap-beta") => mermaid_treemap(body),
        Some("venn-beta") => mermaid_venn(body),
        Some("cynefin-beta") => mermaid_cynefin(body),
        Some("wardley-beta") => mermaid_wardley(body),
        // usecase / ishikawa / eventmodeling / agentflow / railroad / info：
        // 没有稳定的行式结构可提取，返回空大纲（不猜、不误报）。
        _ => Vec::new(),
    }
}

fn unquote(s: &str) -> &str {
    s.trim().trim_matches('"').trim()
}

fn push_node(nodes: &mut Vec<OutlineRow>, seen: &mut HashSet<String>, id: &str, label: &str, line: u32) {
    let id = id.trim();
    if id.is_empty() || !seen.insert(id.to_string()) {
        return;
    }
    let label = unquote(label);
    nodes.push(row(if label.is_empty() { id } else { label }, "node", line));
}

fn push_cluster(clusters: &mut Vec<OutlineRow>, seen: &mut HashSet<String>, id: &str, label: &str, line: u32) {
    let id = id.trim();
    if id.is_empty() || !seen.insert(id.to_string()) {
        return;
    }
    let label = unquote(label);
    clusters.push(row(if label.is_empty() { id } else { label }, "cluster", line));
}

/// 一行里最早出现的箭头（同一位置时按 `ops` 的顺序优先，所以长箭头排在前面）。
fn first_arrow<'a>(text: &str, ops: &[&'a str]) -> Option<(usize, &'a str)> {
    ops.iter()
        .filter_map(|op| text.find(op).map(|p| (p, *op)))
        .min_by_key(|(p, _)| *p)
}

/// `id["label"]` / `id[label]` → (id, label)。kanban / venn 这类声明共用的形状。
fn bracket_decl(text: &str) -> Option<(&str, &str)> {
    let open = text.find('[')?;
    let close = text[open + 1..].find(']')? + open + 1;
    let id = text[..open].trim();
    let label = text[open + 1..close].trim();
    if id.is_empty() {
        return None;
    }
    Some((id, if label.is_empty() { id } else { label }))
}

/// 按顶层逗号拆参数（C4 的 `Rel(a, b, "label")`）：引号内与括号内的逗号不算。
fn split_args(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut in_quote = false;
    let mut depth = 0usize;
    for (i, c) in s.char_indices() {
        match c {
            '"' => in_quote = !in_quote,
            '(' | '[' if !in_quote => depth += 1,
            ')' | ']' if !in_quote => depth = depth.saturating_sub(1),
            ',' if !in_quote && depth == 0 => {
                out.push(s[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(s[start..].trim());
    out
}

fn mermaid_mindmap(body: &str) -> Vec<OutlineGroup> {
    let mut nodes = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text == "mindmap" || text.starts_with("::") {
            continue;
        }
        let label = mindmap_label(text);
        if !label.is_empty() && seen.insert(label.clone()) {
            nodes.push(row(label, "node", line));
        }
    }
    group("节点", nodes).into_iter().collect()
}

fn mindmap_label(text: &str) -> String {
    // 形状：`id((label))` / `id{{label}}` / `id[label]` / `id(label)` /
    // `id))label((` / `id)label(`；没有形状的纯文本行本身就是标签。
    for (open, close) in [("((", "))"), ("{{", "}}"), ("[", "]"), ("(", ")")] {
        if let Some(i) = text.find(open) {
            let after = &text[i + open.len()..];
            if let Some(j) = after.find(close) {
                let label = after[..j].trim();
                if !label.is_empty() {
                    return unquote(label).to_string();
                }
            }
        }
    }
    for (open, close) in [("))", "(("), (")", "(")] {
        if let Some(i) = text.find(open) {
            let after = &text[i + open.len()..];
            if let Some(j) = after.find(close) {
                let label = after[..j].trim();
                if !label.is_empty() {
                    return unquote(label).to_string();
                }
            }
        }
    }
    text.split(":::").next().unwrap_or(text).trim().to_string()
}

fn mermaid_sequence(body: &str) -> Vec<OutlineGroup> {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty()
            || text.starts_with("%%")
            || text == "sequenceDiagram"
            || text.starts_with("title")
            || text.starts_with("accTitle")
            || text.starts_with("accDescr")
            || text == "autonumber"
            || text.starts_with("activate ")
            || text.starts_with("deactivate ")
        {
            continue;
        }
        if let Some(rest) = strip_kw(text, "participant").or_else(|| strip_kw(text, "actor")) {
            let (id, label) = rest
                .split_once(" as ")
                .map(|(a, b)| (a.trim(), b.trim()))
                .unwrap_or((rest.trim(), rest.trim()));
            push_node(&mut nodes, &mut seen, id, label, line);
            continue;
        }
        if let Some((pos, op)) = first_arrow(
            text,
            &["-->>", "->>", "-->", "->", "--x", "-x", "--)", "-)"],
        ) {
            let left = text[..pos].trim();
            let right = text[pos + op.len()..].split(':').next().unwrap_or("").trim();
            if !left.is_empty() && !right.is_empty() && left.split_whitespace().count() == 1 {
                push_node(&mut nodes, &mut seen, left, left, line);
                push_node(&mut nodes, &mut seen, right, right, line);
                edges.push(row(text, "edge", line));
            }
        }
    }
    [group("参与者", nodes), group("消息", edges)].into_iter().flatten().collect()
}

fn mermaid_class(body: &str) -> Vec<OutlineGroup> {
    const RELS: &[&str] = &["<|--", "--|>", "<|..", "..|>", "*--", "--*", "o--", "--o", "-->", "<--", "..>", "<..", "--", ".."];
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty()
            || text.starts_with("%%")
            || text == "classDiagram"
            || text.starts_with("classDef")
            || text.starts_with("style ")
            || text.starts_with("cssClass")
            || text.starts_with("click ")
            || text.starts_with("link ")
            || text.starts_with("direction ")
            || text.starts_with("note")
            || text == "end"
            || text == "}"
            || matches!(text.chars().next(), Some('+' | '-' | '#' | '~'))
        {
            continue;
        }
        if let Some(rest) = strip_kw(text, "class") {
            let rest = rest.trim();
            let first = rest.split(|c: char| c.is_whitespace() || c == '{').next().unwrap_or("");
            let (id, label) = match rest.split_once(" as ") {
                Some((label, id)) => (id.trim(), label.trim()),
                None => (first, first),
            };
            push_node(&mut nodes, &mut seen, id, label, line);
            continue;
        }
        if let Some((pos, op)) = first_arrow(text, RELS) {
            let left = text[..pos].trim().split_whitespace().last().unwrap_or("");
            let right = text[pos + op.len()..]
                .split(':')
                .next()
                .unwrap_or("")
                .trim()
                .split_whitespace()
                .next()
                .unwrap_or("");
            if !left.is_empty() && !right.is_empty() {
                push_node(&mut nodes, &mut seen, left, left, line);
                push_node(&mut nodes, &mut seen, right, right, line);
                edges.push(row(text, "edge", line));
            }
        }
    }
    [group("类", nodes), group("关系", edges)].into_iter().flatten().collect()
}

fn mermaid_state(body: &str) -> Vec<OutlineGroup> {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty()
            || text.starts_with("%%")
            || text.starts_with("stateDiagram")
            || text == "direction LR"
            || text == "direction RL"
            || text == "direction TB"
            || text == "direction BT"
            || text.starts_with("classDef")
            || text.starts_with("class ")
            || text.starts_with("style ")
            || text.starts_with("note")
            || text == "end"
            || text == "}"
        {
            continue;
        }
        if let Some(rest) = strip_kw(text, "state") {
            let rest = rest.trim();
            let first = rest.split(|c: char| c.is_whitespace() || c == '{').next().unwrap_or("");
            let (id, label) = match rest.split_once(" as ") {
                Some((label, id)) => (id.trim(), label.trim()),
                None => (first, first),
            };
            push_node(&mut nodes, &mut seen, id, label, line);
            continue;
        }
        if let Some((pos, _)) = first_arrow(text, &["-->"]) {
            let left = text[..pos].trim();
            let right = text[pos + 3..].split(':').next().unwrap_or("").trim();
            if left != "[*]" && !left.is_empty() {
                push_node(&mut nodes, &mut seen, left, left, line);
            }
            if right != "[*]" && !right.is_empty() {
                push_node(&mut nodes, &mut seen, right, right, line);
            }
            edges.push(row(text, "edge", line));
        }
    }
    [group("状态", nodes), group("转移", edges)].into_iter().flatten().collect()
}

fn mermaid_er(body: &str) -> Vec<OutlineGroup> {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty()
            || text.starts_with("%%")
            || text == "erDiagram"
            || text.starts_with("direction ")
            || text.starts_with("style ")
            || text.starts_with("classDef")
            || text == "}"
        {
            continue;
        }
        if let Some((pos, _)) = text.find("--").map(|p| (p, "--")) {
            let left = text[..pos]
                .trim_end_matches(|c| matches!(c, '|' | 'o' | '{' | '}'))
                .trim();
            let right = text[pos + 2..]
                .trim_start_matches(|c| matches!(c, '|' | 'o' | '{' | '}'))
                .trim()
                .split(':')
                .next()
                .unwrap_or("")
                .trim();
            if !left.is_empty() && !right.is_empty() {
                push_node(&mut nodes, &mut seen, left, left, line);
                push_node(&mut nodes, &mut seen, right, right, line);
                edges.push(row(text, "edge", line));
            }
        } else if text.ends_with('{') {
            let entity = text.trim_end_matches('{').trim();
            push_node(&mut nodes, &mut seen, entity, entity, line);
        }
    }
    [group("实体", nodes), group("关系", edges)].into_iter().flatten().collect()
}

fn mermaid_gantt(body: &str) -> Vec<OutlineGroup> {
    let mut clusters = Vec::new();
    let mut nodes = Vec::new();
    let mut seen = HashSet::new();
    let skip = [
        "title", "dateFormat", "axisFormat", "excludes", "includes", "todayMarker", "tickInterval",
        "weekday", "weekend", "inclusiveEndDates", "topAxis", "displayMode", "accTitle", "accDescr",
    ];
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text == "gantt" {
            continue;
        }
        if let Some(rest) = strip_kw(text, "section") {
            push_cluster(&mut clusters, &mut seen, rest.trim(), rest.trim(), line);
            continue;
        }
        if skip.iter().any(|k| text.starts_with(k)) {
            continue;
        }
        if let Some((label, _)) = text.split_once(':') {
            let label = label.trim();
            if !label.is_empty() {
                nodes.push(row(label, "node", line));
            }
        }
    }
    [group("分组", clusters), group("任务", nodes)].into_iter().flatten().collect()
}

fn mermaid_pie(body: &str) -> Vec<OutlineGroup> {
    let mut nodes = Vec::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text.starts_with("pie") || text.starts_with("title") || text.starts_with("showData") {
            continue;
        }
        if let Some((label, _)) = text.split_once(':') {
            let label = unquote(label);
            if !label.is_empty() {
                nodes.push(row(label, "node", line));
            }
        }
    }
    group("分片", nodes).into_iter().collect()
}

fn mermaid_journey(body: &str) -> Vec<OutlineGroup> {
    let mut clusters = Vec::new();
    let mut nodes = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text == "journey" || text.starts_with("title") {
            continue;
        }
        if let Some(rest) = strip_kw(text, "section") {
            push_cluster(&mut clusters, &mut seen, rest.trim(), rest.trim(), line);
            continue;
        }
        if let Some((label, _)) = text.split_once(':') {
            let label = label.trim();
            if !label.is_empty() {
                nodes.push(row(label, "node", line));
            }
        }
    }
    [group("阶段", clusters), group("任务", nodes)].into_iter().flatten().collect()
}

fn mermaid_gitgraph(body: &str) -> Vec<OutlineGroup> {
    let mut branches = Vec::new();
    let mut commits = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text == "gitGraph" {
            continue;
        }
        if let Some(rest) = strip_kw(text, "branch") {
            let name = rest.split_whitespace().next().unwrap_or("");
            push_node(&mut branches, &mut seen, name, name, line);
        } else if text == "commit" || text.starts_with("commit ") {
            let label = text.strip_prefix("commit").unwrap_or("").trim();
            commits.push(row(if label.is_empty() { "commit" } else { label }, "node", line));
        } else if let Some(rest) = strip_kw(text, "merge") {
            commits.push(row(format!("merge {}", rest.trim()), "node", line));
        } else if text.starts_with("cherry-pick") {
            commits.push(row(text, "node", line));
        }
    }
    [group("分支", branches), group("提交", commits)].into_iter().flatten().collect()
}

fn mermaid_timeline(body: &str) -> Vec<OutlineGroup> {
    let mut clusters = Vec::new();
    let mut nodes = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text == "timeline" || text.starts_with("title") {
            continue;
        }
        if let Some(rest) = strip_kw(text, "section") {
            push_cluster(&mut clusters, &mut seen, rest.trim(), rest.trim(), line);
            continue;
        }
        if let Some((time, event)) = text.split_once(':') {
            let time = time.trim();
            let event = event.trim();
            let label = if event.is_empty() { time } else if time.is_empty() { event } else { text };
            if !label.is_empty() {
                nodes.push(row(label, "node", line));
            }
        }
    }
    [group("分组", clusters), group("事件", nodes)].into_iter().flatten().collect()
}

fn mermaid_quadrant(body: &str) -> Vec<OutlineGroup> {
    let mut clusters = Vec::new();
    let mut nodes = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text == "quadrantChart" || text.starts_with("title") || text.starts_with("x-axis") || text.starts_with("y-axis") {
            continue;
        }
        if let Some(rest) = ["quadrant-1", "quadrant-2", "quadrant-3", "quadrant-4"]
            .iter()
            .find_map(|k| strip_kw(text, k))
        {
            push_cluster(&mut clusters, &mut seen, rest.trim(), rest.trim(), line);
            continue;
        }
        if let Some((name, _)) = text.split_once(':') {
            let name = name.trim();
            if !name.is_empty() && !name.contains(' ') {
                push_node(&mut nodes, &mut seen, name, name, line);
            }
        }
    }
    [group("象限", clusters), group("数据点", nodes)].into_iter().flatten().collect()
}

fn mermaid_xychart(body: &str) -> Vec<OutlineGroup> {
    let mut nodes = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text == "xychart-beta" || text.starts_with("title") || text.starts_with("x-axis") || text.starts_with("y-axis") {
            continue;
        }
        if let Some(kind) = ["bar", "line", "area"].iter().find(|k| strip_kw(text, k).is_some()) {
            push_node(&mut nodes, &mut seen, kind, kind, line);
        }
    }
    group("系列", nodes).into_iter().collect()
}

fn mermaid_block(body: &str) -> Vec<OutlineGroup> {
    let mut nodes = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty()
            || text.starts_with("%%")
            || text == "block-beta"
            || text.starts_with("columns")
            || text.starts_with("space")
            || text.starts_with("style ")
            || text.starts_with("classDef")
            || text.starts_with("class ")
            || text == "}"
        {
            continue;
        }
        if let Some((id, label)) = bracket_decl(text) {
            let id = id.rsplit(':').next().unwrap_or(id);
            push_node(&mut nodes, &mut seen, id, label, line);
            continue;
        }
        if !text.contains(':') && !text.contains("->") {
            for token in text.split_whitespace() {
                push_node(&mut nodes, &mut seen, token, token, line);
            }
        }
    }
    group("块", nodes).into_iter().collect()
}

fn mermaid_c4(body: &str) -> Vec<OutlineGroup> {
    const ELEMENTS: &[&str] = &[
        "Person", "Person_Ext", "System", "System_Ext", "SystemDb", "SystemDb_Ext", "System_Boundary",
        "Enterprise_Boundary", "Container", "Container_Ext", "ContainerDb", "ContainerQueue",
        "Container_Boundary", "Component", "Component_Ext", "Deployment_Node", "Node", "Boundary",
    ];
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty()
            || text.starts_with("%%")
            || text.starts_with("title")
            || text.starts_with("accTitle")
            || text.starts_with("accDescr")
            || text.starts_with("UpdateLayoutConfig")
            || text.starts_with("UpdateRelStyle")
        {
            continue;
        }
        let (Some(open), Some(close)) = (text.find('('), text.rfind(')')) else {
            continue;
        };
        if close <= open {
            continue;
        }
        let kind = text[..open].trim();
        let args = split_args(&text[open + 1..close]);
        if kind == "Rel" || kind.starts_with("Rel_") || kind.starts_with("BiRel") {
            if let (Some(a), Some(b)) = (args.first().copied(), args.get(1).copied()) {
                if !a.is_empty() && !b.is_empty() {
                    push_node(&mut nodes, &mut seen, a, a, line);
                    push_node(&mut nodes, &mut seen, b, b, line);
                    edges.push(row(text, "edge", line));
                }
            }
        } else if ELEMENTS.contains(&kind) {
            if let Some(id) = args.first().copied() {
                let label = args.get(1).copied().unwrap_or(id);
                push_node(&mut nodes, &mut seen, id, label, line);
            }
        }
    }
    [group("元素", nodes), group("关系", edges)].into_iter().flatten().collect()
}

fn mermaid_requirement(body: &str) -> Vec<OutlineGroup> {
    const KINDS: &[&str] = &[
        "requirement", "functionalRequirement", "performanceRequirement", "physicalRequirement",
        "designConstraint", "interfaceRequirement", "element",
    ];
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text == "requirementDiagram" || text == "}" {
            continue;
        }
        if let Some((kind, rest)) = KINDS.iter().find_map(|k| strip_kw(text, k).map(|rest| (*k, rest))) {
            let id = rest.split(|c: char| c.is_whitespace() || c == '{').next().unwrap_or("");
            push_node(&mut nodes, &mut seen, id, id, line);
            let _ = kind;
            continue;
        }
        if let Some((left, right)) = text.split_once(" -> ") {
            let left = left.split(" - ").next().unwrap_or(left).trim();
            let right = right.split(':').next().unwrap_or("").trim();
            if !left.is_empty() && !right.is_empty() {
                push_node(&mut nodes, &mut seen, left, left, line);
                push_node(&mut nodes, &mut seen, right, right, line);
                edges.push(row(text, "edge", line));
            }
        }
    }
    [group("需求", nodes), group("关系", edges)].into_iter().flatten().collect()
}

fn mermaid_kanban(body: &str) -> Vec<OutlineGroup> {
    let mut clusters = Vec::new();
    let mut nodes = Vec::new();
    let mut seen = HashSet::new();
    // 列与卡片靠缩进区分：第一层（最浅缩进）是列，往里缩的是卡片。
    // 不能写死 `indent == 0` —— 真实文档的整个 kanban 块通常是缩进过的。
    let mut base: Option<usize> = None;
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text == "kanban" {
            continue;
        }
        let indent = raw.len() - raw.trim_start().len();
        let decl = match bracket_decl(text) {
            Some(v) => Some(v),
            // 卡片可以只写 `[Task]`（没有 id）
            None => text
                .strip_prefix('[')
                .and_then(|rest| rest.find(']').map(|j| (&rest[..j], &rest[..j]))),
        };
        if let Some((id, label)) = decl {
            let level = *base.get_or_insert(indent);
            if indent <= level {
                push_cluster(&mut clusters, &mut seen, id, label, line);
            } else {
                push_node(&mut nodes, &mut seen, id, label, line);
            }
        }
    }
    [group("列", clusters), group("卡片", nodes)].into_iter().flatten().collect()
}

fn mermaid_sankey(body: &str) -> Vec<OutlineGroup> {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text.starts_with("sankey") {
            continue;
        }
        let parts: Vec<&str> = text.split(',').map(|s| unquote(s)).collect();
        if parts.len() >= 3 {
            let (a, b, v) = (parts[0], parts[1], parts[2]);
            if !a.is_empty() && !b.is_empty() {
                push_node(&mut nodes, &mut seen, a, a, line);
                push_node(&mut nodes, &mut seen, b, b, line);
                edges.push(row(format!("{a} → {b}（{v}）"), "edge", line));
            }
        }
    }
    [group("节点", nodes), group("流量", edges)].into_iter().flatten().collect()
}

fn mermaid_packet(body: &str) -> Vec<OutlineGroup> {
    let mut nodes = Vec::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text.starts_with("packet") {
            continue;
        }
        if let Some((_, label)) = text.split_once(':') {
            let label = unquote(label);
            if !label.is_empty() {
                nodes.push(row(label, "node", line));
            }
        }
    }
    group("字段", nodes).into_iter().collect()
}

fn mermaid_radar(body: &str) -> Vec<OutlineGroup> {
    let mut axes = Vec::new();
    let mut curves = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text == "radar-beta" || text.starts_with("title") {
            continue;
        }
        if let Some(rest) = strip_kw(text, "axis") {
            for a in rest.split(',') {
                let a = unquote(a.trim());
                if !a.is_empty() && seen.insert(a.to_string()) {
                    axes.push(row(a, "node", line));
                }
            }
        } else if let Some(rest) = strip_kw(text, "curve") {
            let name = rest.split('{').next().unwrap_or("").trim();
            if !name.is_empty() {
                curves.push(row(name, "node", line));
            }
        }
    }
    [group("轴", axes), group("曲线", curves)].into_iter().flatten().collect()
}

fn mermaid_treeview(body: &str) -> Vec<OutlineGroup> {
    let mut nodes = Vec::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text.starts_with("treeView") {
            continue;
        }
        nodes.push(row(unquote(text), "node", line));
    }
    group("节点", nodes).into_iter().collect()
}

fn mermaid_treemap(body: &str) -> Vec<OutlineGroup> {
    let mut nodes = Vec::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text.starts_with("treemap") {
            continue;
        }
        let label = match text.split_once(':') {
            Some((label, _)) => label.trim(),
            None => text,
        };
        let label = unquote(label);
        if !label.is_empty() {
            nodes.push(row(label, "node", line));
        }
    }
    group("节点", nodes).into_iter().collect()
}

fn mermaid_venn(body: &str) -> Vec<OutlineGroup> {
    let mut nodes = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text == "venn-beta" || text.starts_with("title") || text.starts_with("style ") {
            continue;
        }
        if let Some(rest) = ["set", "union", "text"].iter().find_map(|k| strip_kw(text, k)) {
            let (id, label) = match bracket_decl(rest) {
                Some((id, label)) => (id, label),
                None => {
                    let id = rest.split(':').next().unwrap_or(rest).trim();
                    (id, id)
                }
            };
            push_node(&mut nodes, &mut seen, id, label, line);
        }
    }
    group("集合", nodes).into_iter().collect()
}

fn mermaid_cynefin(body: &str) -> Vec<OutlineGroup> {
    const DOMAINS: &[&str] = &["complex", "complicated", "clear", "chaotic", "confusion"];
    let mut clusters = Vec::new();
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text == "cynefin-beta" || text.starts_with("title") {
            continue;
        }
        if DOMAINS.contains(&text) {
            push_cluster(&mut clusters, &mut seen, text, text, line);
            continue;
        }
        if text.starts_with('"') {
            let label = unquote(text);
            if !label.is_empty() {
                nodes.push(row(label, "node", line));
            }
            continue;
        }
        if text.contains("-->") {
            edges.push(row(text, "edge", line));
        }
    }
    [group("领域", clusters), group("条目", nodes), group("转移", edges)]
        .into_iter()
        .flatten()
        .collect()
}

fn mermaid_wardley(body: &str) -> Vec<OutlineGroup> {
    let mut nodes = Vec::new();
    let mut seen = HashSet::new();
    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = raw.trim();
        if text.is_empty() || text.starts_with("%%") || text.starts_with("wardley") || text.starts_with("title") {
            continue;
        }
        if let Some(rest) = strip_kw(text, "component").or_else(|| strip_kw(text, "anchor")) {
            let name = rest.split('[').next().unwrap_or("").trim();
            push_node(&mut nodes, &mut seen, name, name, line);
        }
    }
    group("组件", nodes).into_iter().collect()
}

fn mermaid_flowchart(body: &str) -> Vec<OutlineGroup> {
    let mut clusters = Vec::new();
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    // 同一节点常在多行里出现，按 id 去重，行号取第一次出现的
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

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

        for (id, label) in mermaid_nodes_in(text) {
            if seen.insert(id) {
                nodes.push(row(label, "node", line));
            }
        }

        if text.contains("-->") || text.contains("---") || text.contains("-.-") || text.contains("==>") {
            edges.push(row(text.split_whitespace().take(6).collect::<Vec<_>>().join(" "), "edge", line));
        }
    }

    // 泳道图里顶层 subgraph 是**泳道**（不是普通分组）：同一份数据，标题按图类型叫。
    let cluster_title = if crate::format::mermaid_is_swimlane(body) {
        "泳道 lane"
    } else {
        "子图 subgraph"
    };

    [group(cluster_title, clusters), group("节点", nodes), group("边", edges)]
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

/// D2 大纲：容器（`名: {` … `}`）→ 分组，`a -> b: 标签` → 节点与边，`a: 标签` → 节点。
///
/// **不解析样式**：`a.shape: cylinder` / `a.style.fill: "#f00"` 这类属性行的键里带 `.`，
/// 一律跳过；`classes: { … }` 这类保留字块也不算容器（它们不是图里的东西）。
/// D2 的容器比 Mermaid 的 subgraph 更适合做大纲 —— 它本来就是树的形状。
fn d2(body: &str) -> Vec<OutlineGroup> {
    use crate::d2syntax;

    let mut containers = Vec::new();
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    // >0 表示正在跳过保留字块（`classes: { … }` 这类不是图里的东西）；值是块内花括号净值
    let mut skipped: i32 = 0;
    // 块字符串（`x: |md … |`）里的正文不是节点（审计 2026-11-03 L-32）：
    // 不认它的话大纲里会出现名叫 `|md` / `|` 的条目，散文也会被列成节点。
    let mut blocks = d2syntax::BlockStrings::new();

    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        if matches!(blocks.step(raw), d2syntax::BlockLine::Content) {
            continue;
        }
        // 开块那一行只保留声明部分（`x: |md` → `x:`），否则会列出一个名叫 `|md` 的节点
        let decl_buf;
        let src: &str = if blocks.in_block() {
            decl_buf = d2syntax::block_string_decl(raw);
            decl_buf.as_str()
        } else {
            raw
        };
        let text = d2syntax::strip_comment(src).trim().to_string();
        if text.is_empty() {
            continue;
        }
        let net = text.matches('{').count() as i32 - text.matches('}').count() as i32;
        if skipped > 0 {
            skipped += net;
            continue;
        }
        if let Some(name) = d2syntax::container_name(&text) {
            if d2syntax::is_keyword(&name) {
                skipped += net;
            } else {
                containers.push(row(name, "cluster", line));
            }
            continue;
        }
        if text == "}" {
            continue;
        }
        if d2syntax::is_edge(&text) {
            edges.push(row(text.split_whitespace().take(6).collect::<Vec<_>>().join(" "), "edge", line));
            for id in d2syntax::edge_endpoints(&text) {
                if seen.insert(id.clone()) {
                    nodes.push(row(id, "node", line));
                }
            }
            continue;
        }
        match text.split_once(':') {
            // 属性行（`a.shape: …`）不是节点声明
            Some((key, value)) if !key.contains('.') => {
                let key = key.trim().trim_matches('"').trim().to_string();
                if key.is_empty() || d2syntax::is_keyword(&key) {
                    continue;
                }
                let label = value.trim().trim_matches('"').trim();
                let name = if label.is_empty() { key.clone() } else { label.to_string() };
                if seen.insert(key) {
                    nodes.push(row(name, "node", line));
                }
            }
            Some(_) => {}
            // 裸节点名（`a` 单独一行）
            None => {
                let id = text.trim_matches('"').trim();
                if !id.is_empty() && !id.contains(char::is_whitespace) && seen.insert(id.to_string()) {
                    nodes.push(row(id, "node", line));
                }
            }
        }
    }

    [group("容器", containers), group("节点", nodes), group("边", edges)]
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
    fn mermaid_swimlane_outline_calls_top_level_subgraphs_lanes() {
        let src = "swimlane-beta LR\n  subgraph Customer\n    Browse[Browse catalogue]\n  end\n  subgraph Warehouse\n    Pick[Pick items]\n  end\n  Browse --> Pick\n";
        let g = outline(FormatId::Mermaid, src);
        let titles: Vec<_> = g.iter().map(|x| x.title.as_str()).collect();
        assert_eq!(titles, vec!["泳道 lane", "节点", "边"]);
        assert_eq!(g[0].rows[0].name, "Customer");
        assert_eq!(g[0].rows[0].line, 2);
    }

    /// 架构图的标签在 `[]` 里、图标名在 `()` 里。旧实现把括号里的图标名当成节点名，
    /// 于是大纲显示 cloud / database / server —— 用户看不出这跟图有什么关系。
    #[test]
    fn mermaid_architecture_outline_uses_labels_not_icon_names() {
        let src = concat!(
            "architecture-beta\n",
            "    group api(cloud)[API]\n",
            "    service db(database)[Database] in api\n",
            "    service server(server)[Server] in api\n",
            "    junction j1 in api\n",
            "    db:R -- L:server\n",
            "    server:B -- T:j1\n",
            "    align row db server\n",
        );
        let g = outline(FormatId::Mermaid, src);
        let titles: Vec<_> = g.iter().map(|x| x.title.as_str()).collect();
        assert_eq!(titles, vec!["分组 group", "节点", "边"]);

        assert_eq!(g[0].rows[0].name, "API");
        assert_eq!(g[0].rows[0].line, 2);

        let names: Vec<_> = g[1].rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["Database", "Server", "j1"]);
        assert!(!names.contains(&"cloud"), "图标名不能当节点名");

        let edges: Vec<_> = g[2].rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(edges, vec!["db:R -- L:server", "server:B -- T:j1"]);
        assert_eq!(g[2].rows[0].line, 6);
    }

    #[test]
    fn mermaid_architecture_outline_skips_frontmatter_and_comments() {
        let src = "---\nconfig:\n  architecture:\n    randomize: true\n---\n%% 说明\narchitecture-beta\nservice a(server)[A]\nservice b(database)[B]\na:R --> L:b\n";
        let g = outline(FormatId::Mermaid, src);
        let titles: Vec<_> = g.iter().map(|x| x.title.as_str()).collect();
        assert_eq!(titles, vec!["节点", "边"]);
        let names: Vec<_> = g[0].rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["A", "B"]);
        assert_eq!(g[0].rows[0].line, 8);
    }

    fn names(g: &[OutlineGroup], title: &str) -> Vec<String> {
        g.iter()
            .find(|x| x.title == title)
            .map(|x| x.rows.iter().map(|r| r.name.clone()).collect())
            .unwrap_or_default()
    }

    #[test]
    fn mermaid_mindmap_outline_lists_node_labels() {
        let g = outline(
            FormatId::Mermaid,
            "mindmap\n  root((Root))\n    A[Alpha]\n    B(Beta)\n    plain\n",
        );
        assert_eq!(names(&g, "节点"), vec!["Root", "Alpha", "Beta", "plain"]);
    }

    #[test]
    fn mermaid_sequence_outline_has_participants_and_messages() {
        let g = outline(
            FormatId::Mermaid,
            "sequenceDiagram\n participant A as Alice\n actor Bob\n A->>Bob: Hi\n Bob-->>A: Ok\n",
        );
        assert_eq!(names(&g, "参与者"), vec!["Alice", "Bob"]);
        assert_eq!(names(&g, "消息").len(), 2);
    }

    #[test]
    fn mermaid_class_outline_has_classes_and_relations() {
        let g = outline(
            FormatId::Mermaid,
            "classDiagram\n class Animal { +int age }\n class Dog\n Animal <|-- Dog : owns\n",
        );
        assert_eq!(names(&g, "类"), vec!["Animal", "Dog"]);
        assert_eq!(names(&g, "关系").len(), 1);
    }

    #[test]
    fn mermaid_state_outline_has_states_and_transitions() {
        let g = outline(
            FormatId::Mermaid,
            "stateDiagram-v2\n [*] --> Idle\n Idle --> Running : go\n state Done\n",
        );
        assert_eq!(names(&g, "状态"), vec!["Idle", "Running", "Done"]);
        assert_eq!(names(&g, "转移").len(), 2);
    }

    #[test]
    fn mermaid_er_outline_has_entities_and_relations() {
        let g = outline(
            FormatId::Mermaid,
            "erDiagram\n CUSTOMER ||--o{ ORDER : places\n ORDER {\n  int id\n }\n",
        );
        assert_eq!(names(&g, "实体"), vec!["CUSTOMER", "ORDER"]);
        assert_eq!(names(&g, "关系").len(), 1);
    }

    #[test]
    fn mermaid_gantt_outline_has_sections_and_tasks() {
        let g = outline(
            FormatId::Mermaid,
            "gantt\n title A\n dateFormat YYYY-MM-DD\n section Design\n Wireframe :a1, 2024-01-01, 5d\n",
        );
        assert_eq!(names(&g, "分组"), vec!["Design"]);
        assert_eq!(names(&g, "任务"), vec!["Wireframe"]);
    }

    #[test]
    fn mermaid_pie_and_journey_outlines() {
        let pie = outline(FormatId::Mermaid, "pie title Pets\n \"Dogs\" : 10\n \"Cats\" : 5\n");
        assert_eq!(names(&pie, "分片"), vec!["Dogs", "Cats"]);

        let journey = outline(
            FormatId::Mermaid,
            "journey\n title Day\n section Work\n Task: 5: Me\n",
        );
        assert_eq!(names(&journey, "阶段"), vec!["Work"]);
        assert_eq!(names(&journey, "任务"), vec!["Task"]);
    }

    #[test]
    fn mermaid_gitgraph_and_timeline_outlines() {
        let git = outline(
            FormatId::Mermaid,
            "gitGraph\n commit\n branch dev\n checkout dev\n commit id: \"abc\"\n",
        );
        assert_eq!(names(&git, "分支"), vec!["dev"]);
        assert_eq!(names(&git, "提交").len(), 2);

        let tl = outline(
            FormatId::Mermaid,
            "timeline\n title H\n section S\n 2024 : Event\n",
        );
        assert_eq!(names(&tl, "分组"), vec!["S"]);
        assert_eq!(names(&tl, "事件"), vec!["2024 : Event"]);
    }

    #[test]
    fn mermaid_quadrant_and_xychart_outlines() {
        let q = outline(
            FormatId::Mermaid,
            "quadrantChart\n title T\n quadrant-1 Q1\n A: [0.1, 0.2]\n",
        );
        assert_eq!(names(&q, "象限"), vec!["Q1"]);
        assert_eq!(names(&q, "数据点"), vec!["A"]);

        let xy = outline(FormatId::Mermaid, "xychart-beta\n title \"T\"\n bar [1, 2]\n");
        assert_eq!(names(&xy, "系列"), vec!["bar"]);
    }

    #[test]
    fn mermaid_block_outline_has_blocks() {
        let g = outline(FormatId::Mermaid, "block-beta\n columns 3\n a b c\n");
        assert_eq!(names(&g, "块"), vec!["a", "b", "c"]);
    }

    /// C4 的元素行是 `Person(alias, "Label")`，旧解析器会把 `Person` 当节点、
    /// 把整段参数当标签；现在必须显示 alias 对应的标签，并把 `Rel` 收成边。
    #[test]
    fn mermaid_c4_outline_uses_element_labels_and_relations() {
        let g = outline(
            FormatId::Mermaid,
            "C4Context\n Person(user, \"User\")\n System(sys, \"System\")\n Rel(user, sys, \"Uses\")\n",
        );
        assert_eq!(names(&g, "元素"), vec!["User", "System"]);
        assert_eq!(names(&g, "关系").len(), 1);
        assert!(!names(&g, "元素").contains(&"Person".to_string()));
    }

    #[test]
    fn mermaid_requirement_outline_has_requirements_and_relations() {
        let g = outline(
            FormatId::Mermaid,
            "requirementDiagram\n requirement r {\n  id: 1\n  text: x\n  risk: low\n  verifymethod: test\n }\n element e {\n  type: simulation\n }\n e - satisfies -> r\n",
        );
        assert_eq!(names(&g, "需求"), vec!["r", "e"]);
        assert_eq!(names(&g, "关系").len(), 1);
    }

    #[test]
    fn mermaid_kanban_sankey_packet_outlines() {
        let k = outline(FormatId::Mermaid, "kanban\n todo[Todo]\n  task1[Task]\n");
        assert_eq!(names(&k, "列"), vec!["Todo"]);
        assert_eq!(names(&k, "卡片"), vec!["Task"]);

        let s = outline(FormatId::Mermaid, "sankey-beta\n A,B,10\n B,C,5\n");
        assert_eq!(names(&s, "节点"), vec!["A", "B", "C"]);
        assert_eq!(names(&s, "流量").len(), 2);

        let p = outline(FormatId::Mermaid, "packet-beta\n 0-15: \"Source Port\"\n");
        assert_eq!(names(&p, "字段"), vec!["Source Port"]);
    }

    #[test]
    fn mermaid_radar_treeview_treemap_outlines() {
        let r = outline(FormatId::Mermaid, "radar-beta\n axis a, b, c\n curve x{1, 2, 3}\n");
        assert_eq!(names(&r, "轴"), vec!["a", "b", "c"]);
        assert_eq!(names(&r, "曲线"), vec!["x"]);

        let tv = outline(FormatId::Mermaid, "treeView-beta\n root\n  child\n");
        assert_eq!(names(&tv, "节点"), vec!["root", "child"]);

        let tm = outline(FormatId::Mermaid, "treemap-beta\n \"Root\"\n  \"A\": 10\n");
        assert_eq!(names(&tm, "节点"), vec!["Root", "A"]);
    }

    #[test]
    fn mermaid_venn_cynefin_wardley_outlines() {
        let v = outline(
            FormatId::Mermaid,
            "venn-beta\n set A[\"Alpha\"]\n union A,B[\"AB\"]\n",
        );
        assert_eq!(names(&v, "集合"), vec!["Alpha", "AB"]);

        let c = outline(
            FormatId::Mermaid,
            "cynefin-beta\n complex\n \"Item\"\n complex --> clear : \"x\"\n",
        );
        assert_eq!(names(&c, "领域"), vec!["complex"]);
        assert_eq!(names(&c, "条目"), vec!["Item"]);
        assert_eq!(names(&c, "转移").len(), 1);

        let w = outline(FormatId::Mermaid, "wardley-beta\n component C [0.5, 0.5]\n");
        assert_eq!(names(&w, "组件"), vec!["C"]);
    }

    /// 没有专门解析器的图种必须返回空，而不是套用 flowchart 的括号扫描造出假节点。
    #[test]
    fn mermaid_unknown_type_returns_empty_outline() {
        assert!(outline(FormatId::Mermaid, "info\n").is_empty());
        assert!(outline(FormatId::Mermaid, "usecase\n actor User\n uc(Do)\n").is_empty());
    }

    #[test]
    fn outline_omits_empty_groups() {
        let g = outline(FormatId::Mermaid, "flowchart TD\n    A --> B\n");
        assert_eq!(g.len(), 1, "没有 subgraph 与节点声明时只应剩「边」一组");
        assert_eq!(g[0].title, "边");
    }

    /// 审计 L-32：块字符串里的正文与收尾 `|` 不能被列成节点。
    #[test]
    fn d2_outline_skips_block_string_content() {
        let src = "x: |md\n  # 标题\n  正文里有个 { 花括号\n  还有 a -> b\n|\ny -> z\n";
        let g = outline(FormatId::D2, src);
        let names: Vec<String> = g
            .iter()
            .flat_map(|grp| grp.rows.iter())
            .map(|r| r.name.clone())
            .collect();
        for bad in ["|md", "|", "还有 a", "正文里有个 { 花括号", "# 标题"] {
            assert!(!names.iter().any(|n| n == bad), "正文被列成节点了：{bad} → {names:?}");
        }
        assert!(names.iter().any(|n| n == "y") && names.iter().any(|n| n == "z"), "{names:?}");
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
    fn d2_outline_groups_containers_nodes_and_edges() {
        let src = "direction: right\n网关: 网关服务\n前端应用 -> 网关: HTTPS 请求\n集成层: {\n  网关 -> 数据库: SELECT\n}\nclasses: {\n  danger: { style.fill: \"#f00\" }\n}\n";
        let g = outline(FormatId::D2, src);
        let titles: Vec<_> = g.iter().map(|x| x.title.as_str()).collect();
        assert_eq!(titles, vec!["容器", "节点", "边"]);

        let containers = &g[0];
        assert_eq!(containers.rows.len(), 1, "classes 是保留字块，不算容器");
        assert_eq!(containers.rows[0].name, "集成层");
        assert_eq!(containers.rows[0].line, 4);

        let nodes = &g[1];
        let names: Vec<_> = nodes.rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["网关服务", "前端应用", "数据库"], "`名: 标签` 取标签，边的端点取 id，整体按首现去重");
        assert_eq!(nodes.rows[0].line, 2);

        let edges = &g[2];
        assert_eq!(edges.rows.len(), 2);
        assert_eq!(edges.rows[0].line, 3);
        assert!(edges.rows[0].name.contains("HTTPS 请求"));
    }

    #[test]
    fn d2_outline_ignores_style_attributes_and_comments() {
        let src = "a.shape: cylinder\na.style.fill: \"#f00\" # 注释\n# 整行注释\nb\n";
        let g = outline(FormatId::D2, src);
        assert_eq!(g.len(), 1, "只有节点一组");
        let names: Vec<_> = g[0].rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["b"], "属性行与注释都不产生条目");
    }

    #[test]
    fn invalid_body_yields_empty_outline_instead_of_panicking() {
        assert!(outline(FormatId::Excalidraw, "{ not json").is_empty());
        assert!(outline(FormatId::Mermaid, "").is_empty());
    }
}
