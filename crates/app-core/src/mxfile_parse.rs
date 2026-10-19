//! `mxfile` 的**解析**半边（与 `mxfile.rs` 的扫描/输出分开，避免单文件过长）。
//!
//! 3.11.0 的承诺：能把 `emit` 的产物读回来（语义相等）、保留 `UserObject` 的 label 与
//! 不认识的样式键。**字节级往返不在承诺里** —— 端点坐标在 drawio 里不存（只存 waypoints），
//! 所以边几何以“两次 emit 幂等”验证。

use std::collections::{BTreeMap, HashMap};

use app_ipc::{ConvIssue, FormatId, Level};

use crate::mxfile::{err_at, read_tag, ParseError};
use crate::plan::{
    Arrow, CanvasPlan, PlanContainer, PlanEdge, PlanNode, PlanPage, Point, Provenance, Rect,
    ShapeRole, StyleRole,
};

#[derive(Default, Clone)]
struct RawCell {
    id: String,
    label: String,
    style: String,
    parent: Option<String>,
    vertex: bool,
    edge: bool,
    source: Option<String>,
    target: Option<String>,
    geom: Option<Rect>,
    points: Vec<Point>,
}

#[derive(Default)]
struct PendingPage {
    name: String,
    id: String,
    cells: Vec<RawCell>,
}

fn style_map(style: &str) -> HashMap<&str, &str> {
    style
        .split(';')
        .filter_map(|part| {
            let part = part.trim();
            if part.is_empty() {
                return None;
            }
            Some(match part.split_once('=') {
                Some((k, v)) => (k.trim(), v.trim()),
                None => (part, ""),
            })
        })
        .collect()
}

fn role_from_style(map: &HashMap<&str, &str>) -> StyleRole {
    if map.get("container").copied() == Some("1") {
        return StyleRole::Container;
    }
    let fill = map.get("fillColor").copied().unwrap_or("");
    let stroke = map.get("strokeColor").copied().unwrap_or("");
    match (fill, stroke) {
        ("#e4efec", "#3d7d72") => StyleRole::Primary,
        ("#f2f4f3", "#cfd4d3") => StyleRole::Secondary,
        ("#f8e9e6", "#b0554a") => StyleRole::Danger,
        ("#e9eceb", "#e2e5e4") => StyleRole::Muted,
        ("none", "#cfd4d3") => StyleRole::Container,
        ("#fbfbfb", "#cfd4d3") => StyleRole::Note,
        _ => StyleRole::Primary,
    }
}

fn shape_from_style(map: &HashMap<&str, &str>) -> ShapeRole {
    if map.contains_key("text") {
        return ShapeRole::Plain;
    }
    if map.get("rounded").copied() == Some("1") {
        return ShapeRole::Rounded;
    }
    if map.contains_key("ellipse") {
        return ShapeRole::Ellipse;
    }
    if map.contains_key("rhombus") {
        return ShapeRole::Diamond;
    }
    match map.get("shape").copied().unwrap_or("") {
        "cylinder3" => ShapeRole::Cylinder,
        "note" => ShapeRole::Note,
        "document" => ShapeRole::Document,
        "swimlane" => ShapeRole::Swimlane,
        _ => ShapeRole::Rect,
    }
}

fn is_known_style_key(key: &str) -> bool {
    matches!(
        key,
        "rounded"
            | "ellipse"
            | "rhombus"
            | "swimlane"
            | "text"
            | "fillColor"
            | "strokeColor"
            | "fontColor"
            | "container"
            | "collapsible"
            | "html"
            | "shape"
            | "endArrow"
            | "dashed"
            | "curved"
            | "edgeStyle"
            | "orthogonalLoop"
            | "jettySize"
    )
}

fn raw_style_tokens(style: &str) -> Vec<String> {
    style
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter(|s| {
            let key = s.split_once('=').map(|(k, _)| k.trim()).unwrap_or(s);
            !is_known_style_key(key)
        })
        .map(str::to_string)
        .collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn ensure_page(pages: &mut Vec<PendingPage>, current: &mut Option<usize>) -> usize {
    if current.is_none() {
        let n = pages.len() + 1;
        pages.push(PendingPage { name: "Page-1".into(), id: format!("p{n}"), cells: Vec::new() });
        *current = Some(n - 1);
    }
    current.unwrap()
}

/// 解析一份 mxfile。
pub fn parse(xml: &str) -> Result<CanvasPlan, ParseError> {
    let mut pages: Vec<PendingPage> = Vec::new();
    let mut current_page: Option<usize> = None;
    let mut current: Option<RawCell> = None;
    let mut pending_wrapper: Option<(String, String)> = None;
    let mut wrappers = 0usize;
    let mut in_points = false;
    let mut saw_file = false;
    let mut i = 0usize;

    while let Some(rel) = xml[i..].find('<') {
        let start = i + rel;
        let rest = &xml[start..];
        if rest.starts_with("<!--") {
            match rest[4..].find("-->") {
                Some(end) => {
                    i = start + 4 + end + 3;
                    continue;
                }
                None => return Err(err_at(xml, start, "注释没有闭合的 `-->`")),
            }
        }
        if rest.starts_with("<?") || rest.starts_with("<!") {
            match rest.find('>') {
                Some(end) => {
                    i = start + end + 1;
                    continue;
                }
                None => return Err(err_at(xml, start, "声明没有闭合的 `>`")),
            }
        }
        let tag = read_tag(xml, start)?;
        i = tag.end;

        if tag.closing {
            match tag.name.as_str() {
                "mxCell" => {
                    if let Some(cell) = current.take() {
                        let pi = ensure_page(&mut pages, &mut current_page);
                        pages[pi].cells.push(cell);
                    }
                }
                "UserObject" | "object" => pending_wrapper = None,
                "Array" => in_points = false,
                "diagram" => current_page = None,
                _ => {}
            }
            continue;
        }

        match tag.name.as_str() {
            "mxfile" => saw_file = true,
            "diagram" => {
                let n = pages.len() + 1;
                let id = tag.attr("id").map(str::to_string).unwrap_or_else(|| format!("p{n}"));
                pages.push(PendingPage {
                    name: tag.attr("name").unwrap_or("Page-1").to_string(),
                    id,
                    cells: Vec::new(),
                });
                current_page = Some(n - 1);
            }
            "UserObject" | "object" => {
                let label = tag.attr("label").unwrap_or_default().to_string();
                let id = tag.attr("id").unwrap_or_default().to_string();
                if !id.is_empty() || !label.is_empty() {
                    wrappers += 1;
                    pending_wrapper = Some((id, label));
                }
            }
            "mxCell" => {
                if let Some(prev) = current.take() {
                    let pi = ensure_page(&mut pages, &mut current_page);
                    pages[pi].cells.push(prev);
                }
                let (wid, wlabel) = pending_wrapper.take().unwrap_or_default();
                let id = tag
                    .attr("id")
                    .map(str::to_string)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(wid);
                let label = tag
                    .attr("value")
                    .map(str::to_string)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(wlabel);
                current = Some(RawCell {
                    id,
                    label,
                    style: tag.attr("style").unwrap_or_default().to_string(),
                    parent: tag.attr("parent").map(str::to_string),
                    vertex: tag.attr("vertex") == Some("1"),
                    edge: tag.attr("edge") == Some("1"),
                    source: tag.attr("source").map(str::to_string),
                    target: tag.attr("target").map(str::to_string),
                    geom: None,
                    points: Vec::new(),
                });
                if tag.self_closing {
                    if let Some(cell) = current.take() {
                        let pi = ensure_page(&mut pages, &mut current_page);
                        pages[pi].cells.push(cell);
                    }
                }
            }
            "mxGeometry" => {
                if let Some(cell) = current.as_mut() {
                    let x = tag.attr("x").and_then(|v| v.parse().ok()).unwrap_or(0);
                    let y = tag.attr("y").and_then(|v| v.parse().ok()).unwrap_or(0);
                    let w = tag.attr("width").and_then(|v| v.parse().ok()).unwrap_or(0);
                    let h = tag.attr("height").and_then(|v| v.parse().ok()).unwrap_or(0);
                    cell.geom = Some(Rect { x, y, w, h });
                }
            }
            "Array" => in_points = tag.attr("as") == Some("points") || in_points,
            "mxPoint" => {
                if in_points {
                    if let Some(cell) = current.as_mut() {
                        let x = tag.attr("x").and_then(|v| v.parse().ok()).unwrap_or(0);
                        let y = tag.attr("y").and_then(|v| v.parse().ok()).unwrap_or(0);
                        cell.points.push(Point { x, y });
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(cell) = current.take() {
        let pi = ensure_page(&mut pages, &mut current_page);
        pages[pi].cells.push(cell);
    }
    if !saw_file {
        return Err(err_at(xml, 0, "不是 mxfile：找不到 `<mxfile>`"));
    }
    if pages.is_empty() {
        pages.push(PendingPage { name: "Page-1".into(), id: "p1".into(), cells: Vec::new() });
    }

    let mut plan_pages = Vec::new();
    for pending in pages {
        let by_id: HashMap<String, RawCell> =
            pending.cells.iter().cloned().map(|c| (c.id.clone(), c)).collect();
        let is_container = |c: &RawCell| {
            let map = style_map(&c.style);
            map.get("container").copied() == Some("1") || map.contains_key("swimlane")
        };

        fn abs_rect(
            id: &str,
            by_id: &HashMap<String, RawCell>,
            memo: &mut HashMap<String, Rect>,
            guard: usize,
        ) -> Rect {
            if let Some(r) = memo.get(id) {
                return *r;
            }
            let Some(c) = by_id.get(id) else {
                return Rect::default();
            };
            let mut r = c.geom.unwrap_or_default();
            if guard > 0 {
                if let Some(parent) = c.parent.as_deref() {
                    if parent != "0" && parent != "1" {
                        let p = abs_rect(parent, by_id, memo, guard - 1);
                        r.x += p.x;
                        r.y += p.y;
                    }
                }
            }
            memo.insert(id.to_string(), r);
            r
        }

        let mut memo: HashMap<String, Rect> = HashMap::new();
        let mut containers = Vec::new();
        let mut nodes = Vec::new();
        for c in pending.cells.iter().filter(|c| c.vertex) {
            if c.id == "0" || c.id == "1" {
                continue;
            }
            let rect = abs_rect(&c.id, &by_id, &mut memo, 32);
            let map = style_map(&c.style);
            let parent = c
                .parent
                .as_deref()
                .filter(|p| *p != "0" && *p != "1" && by_id.get(*p).map(is_container).unwrap_or(false))
                .map(str::to_string);
            if is_container(c) {
                containers.push(PlanContainer {
                    id: c.id.clone(),
                    label: c.label.clone(),
                    rect,
                    parent,
                    role: StyleRole::Container,
                    raw_style: raw_style_tokens(&c.style),
                });
            } else {
                nodes.push(PlanNode {
                    id: c.id.clone(),
                    label: c.label.clone(),
                    rect,
                    shape: shape_from_style(&map),
                    role: role_from_style(&map),
                    parent,
                    raw_style: raw_style_tokens(&c.style),
                    raw_children: vec![],
                    at: None,
                });
            }
        }

        let node_rect: HashMap<&str, Rect> = nodes.iter().map(|n| (n.id.as_str(), n.rect)).collect();
        let mut edges = Vec::new();
        for c in pending.cells.iter().filter(|c| c.edge) {
            let map = style_map(&c.style);
            let mut points = c.points.clone();
            if let (Some(f), Some(t)) = (c.source.as_deref(), c.target.as_deref()) {
                if let (Some(fr), Some(tr)) = (node_rect.get(f), node_rect.get(t)) {
                    // drawio 只存 waypoints；PlanEdge 的契约是“首尾含端点”。
                    // 这里补上节点中心作为端点 —— 它们不会再被 emit 写回 Array，
                    // 所以 `emit(parse(emit(p))) == emit(p)`。
                    if points.is_empty() {
                        points = vec![fr.center(), tr.center()];
                    } else {
                        points.insert(0, fr.center());
                        points.push(tr.center());
                    }
                }
            }
            edges.push(PlanEdge {
                id: c.id.clone(),
                from: c.source.clone().unwrap_or_default(),
                to: c.target.clone().unwrap_or_default(),
                label: if c.label.trim().is_empty() { None } else { Some(c.label.clone()) },
                points,
                curved: map.get("curved").copied() == Some("1"),
                arrow: match map.get("endArrow").copied().unwrap_or("") {
                    "none" => Arrow::None,
                    "classic" => Arrow::Classic,
                    "open" => Arrow::Open,
                    _ => Arrow::Block,
                },
                dashed: map.get("dashed").copied() == Some("1"),
                role: role_from_style(&map),
                raw_style: raw_style_tokens(&c.style),
                at: None,
            });
        }

        plan_pages.push(PlanPage { name: pending.name, id: pending.id, nodes, edges, containers });
    }

    let mut issues = Vec::new();
    if wrappers > 0 {
        // 本期的 parse 只保留 label/id；`mermaidData` 之类的自定义字段没有原样回写。
        // **不静默丢**：报告里明确说这一层被拍平（3.12.0 再做完整 raw 保留）。
        let mut params = BTreeMap::new();
        params.insert("n".to_string(), wrappers.to_string());
        issues.push(ConvIssue { level: Level::Degraded, code: "userobject.flattened".into(), params, at: None });
    }
    Ok(CanvasPlan {
        pages: plan_pages,
        provenance: Provenance {
            from: FormatId::Drawio,
            source_hash: crate::report::source_hash(xml),
            converted_at: now_ms(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
        },
        issues,
    })
}

/// 给 plan 里的 id 加前缀并同步所有引用（`parent` / `from` / `to`）。
pub fn normalize(plan: &mut CanvasPlan, prefix: &str) -> Vec<ConvIssue> {
    let mut map: HashMap<String, String> = HashMap::new();
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut renamed = 0usize;
    let mut add = |id: &str, map: &mut HashMap<String, String>| {
        let base = if prefix.is_empty() { id.to_string() } else { format!("{prefix}{id}") };
        let mut next = base.clone();
        let mut n = 2;
        while used.contains(&next) {
            next = format!("{base}-{n}");
            n += 1;
        }
        used.insert(next.clone());
        if next != id {
            renamed += 1;
        }
        map.insert(id.to_string(), next);
    };
    for p in &plan.pages {
        for c in &p.containers {
            add(&c.id, &mut map);
        }
        for n in &p.nodes {
            add(&n.id, &mut map);
        }
        for e in &p.edges {
            add(&e.id, &mut map);
        }
    }
    let remap = |id: &str| map.get(id).cloned().unwrap_or_else(|| id.to_string());
    for p in &mut plan.pages {
        for c in &mut p.containers {
            c.id = remap(&c.id);
            c.parent = c.parent.as_deref().map(remap);
        }
        for n in &mut p.nodes {
            n.id = remap(&n.id);
            n.parent = n.parent.as_deref().map(remap);
        }
        for e in &mut p.edges {
            e.id = remap(&e.id);
            e.from = remap(&e.from);
            e.to = remap(&e.to);
        }
    }
    let mut params = BTreeMap::new();
    params.insert("n".to_string(), renamed.to_string());
    params.insert("prefix".to_string(), prefix.to_string());
    vec![ConvIssue { level: Level::Info, code: "normalize.applied".into(), params, at: None }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mxfile;
    use crate::plan::{CanvasPlan, PlanEdge, PlanNode, PlanPage, PlanContainer, Rect};

    fn sample() -> CanvasPlan {
        CanvasPlan {
            pages: vec![PlanPage {
                name: "Page-1".into(),
                id: "p1".into(),
                containers: vec![PlanContainer {
                    id: "c1".into(),
                    label: "组".into(),
                    rect: Rect { x: 100, y: 100, w: 300, h: 200 },
                    parent: None,
                    role: StyleRole::Container,
                    raw_style: vec![],
                }],
                nodes: vec![PlanNode {
                    id: "n1".into(),
                    label: "网关 & <API>\n第二行".into(),
                    rect: Rect { x: 150, y: 130, w: 80, h: 40 },
                    shape: ShapeRole::Rounded,
                    role: StyleRole::Primary,
                    parent: Some("c1".into()),
                    raw_style: vec!["sketch=1".into()],
                    raw_children: vec![],
                    at: None,
                }],
                edges: vec![PlanEdge {
                    id: "e1".into(),
                    from: "n1".into(),
                    to: "n1".into(),
                    label: Some("自环".into()),
                    points: vec![Point { x: 150, y: 150 }, Point { x: 140, y: 140 }, Point { x: 230, y: 150 }],
                    curved: true,
                    arrow: Arrow::Block,
                    dashed: false,
                    role: StyleRole::Primary,
                    raw_style: vec![],
                    at: None,
                }],
            }],
            provenance: Provenance {
                from: FormatId::Dot,
                source_hash: "x".into(),
                converted_at: 0,
                app_version: "test".into(),
            },
            issues: vec![],
        }
    }

    #[test]
    fn emit_parse_emit_is_idempotent() {
        let xml = mxfile::emit(&sample());
        let parsed = parse(&xml).unwrap();
        let xml2 = mxfile::emit(&parsed);
        assert_eq!(xml2, xml, "parse/emit 必须幂等（端点不存于 drawio，几何以幂等验证）");
        assert_eq!(parsed.pages.len(), 1);
        assert_eq!(parsed.pages[0].nodes.len(), 1);
        assert_eq!(parsed.pages[0].containers.len(), 1);
        assert_eq!(parsed.pages[0].edges.len(), 1);
        // 相对坐标解析回绝对
        assert_eq!(parsed.pages[0].nodes[0].rect, Rect { x: 150, y: 130, w: 80, h: 40 });
        // 不认识的样式键原样保留
        assert_eq!(parsed.pages[0].nodes[0].raw_style, vec!["sketch=1"]);
        assert_eq!(parsed.pages[0].edges[0].label.as_deref(), Some("自环"));
        assert!(parsed.pages[0].edges[0].curved);
    }

    #[test]
    fn userobject_label_and_nested_geometry_are_parsed() {
        let xml = include_str!("../../../tools/dev/fixtures/convert/container.drawio");
        let plan = parse(xml).unwrap();
        let page = &plan.pages[0];
        assert_eq!(page.containers.len(), 1);
        let n1 = page.nodes.iter().find(|n| n.id == "n1").unwrap();
        assert_eq!(n1.rect, Rect { x: 60, y: 70, w: 90, h: 40 }, "子节点几何要加上父容器偏移");
        let n2 = page.nodes.iter().find(|n| n.id == "n2").unwrap();
        assert_eq!(n2.label, "数据库\n(主)", "UserObject 的 label 与 &#10; 都要解出来");
        assert_eq!(n2.rect, Rect { x: 180, y: 120, w: 80, h: 60 });
        let e = &page.edges[0];
        assert_eq!(e.from, "n1");
        assert_eq!(e.to, "n2");
        assert_eq!(e.points.len(), 4, "2 个 waypoints + 补上的首尾端点");
        assert!(e.points.contains(&Point { x: 150, y: 120 }));
        assert!(e.points.contains(&Point { x: 190, y: 150 }));
    }

    #[test]
    fn normalize_remaps_ids_and_references() {
        let mut plan = sample();
        let issues = normalize(&mut plan, "mm-");
        assert!(issues.iter().any(|i| i.code == "normalize.applied"));
        let page = &plan.pages[0];
        assert_eq!(page.nodes[0].id, "mm-n1");
        assert_eq!(page.nodes[0].parent.as_deref(), Some("mm-c1"));
        assert_eq!(page.containers[0].id, "mm-c1");
        assert_eq!(page.edges[0].from, "mm-n1");
        assert_eq!(page.edges[0].to, "mm-n1");
    }
}
