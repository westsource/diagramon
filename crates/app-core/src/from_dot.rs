//! Graphviz `json` 输出 → `CanvasPlan`。
//!
//! **实测事实（2026-10-20，`ui/vendor/graphviz.js`）**，每条都对应一个真实会踩的坑：
//!
//! - `json` **没有 `subgraphs` 字段**：cluster 与节点一样在 `objects` 里
//!   （`{name:"cluster_a", bb:"x1,y1,x2,y2", nodes:[gvid…], edges:[…]}`）。
//! - 外层 cluster 的 `nodes` 是**扁平的**（含内层 cluster 的全部节点）⇒ 父子关系必须按
//!   `bb` 包含关系判定，不能拿 `nodes` 直接建层级。
//! - `pos` 是**节点中心**，单位 pt，**y 轴向上**；`width`/`height` 是**英寸**（×96 = px）；
//!   `bb` 也是 pt。三种单位混在一份 JSON 里，必须分别换算。
//! - 边的 `_draw_` 里 `{"op":"b","points":[…]}` 是**三次贝塞尔控制点**（每段 4 点）；
//!   `p`/`L` 才是折线；`e` 是椭圆弧（只能近似）。
//!
//! 所有几何在这里**量化成整数 px**，之后不再改；绝对 → 相对只在 `mxfile::emit` 里做。

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

use app_ipc::{ConvIssue, FormatId, Level};

use crate::plan::{
    Arrow, CanvasPlan, PlanContainer, PlanEdge, PlanNode, PlanPage, Point, Provenance, Rect,
    ShapeRole, StyleRole,
};

/// Graphviz 的点（pt）→ px（96dpi）的换算系数。
const PT_TO_PX: f64 = 4.0 / 3.0;
/// 英寸 → px。
const IN_TO_PX: f64 = 96.0;

#[derive(Debug, Clone)]
pub struct DotOpts {
    pub layout: String,
    pub cluster_as_container: bool,
    pub source_hash: String,
}

#[derive(Debug, Deserialize)]
struct DotJson {
    #[serde(default)]
    bb: Option<String>,
    #[serde(default)]
    objects: Vec<GObject>,
    #[serde(default)]
    edges: Vec<GEdge>,
}

#[derive(Debug, Deserialize)]
struct GObject {
    #[serde(rename = "_gvid")]
    gvid: u32,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    pos: Option<String>,
    #[serde(default)]
    width: Option<Value>,
    #[serde(default)]
    height: Option<Value>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    shape: Option<String>,
    #[serde(default)]
    style: Option<String>,
    #[serde(default)]
    fillcolor: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    bb: Option<String>,
    #[serde(default)]
    nodes: Option<Vec<u32>>,
}

#[derive(Debug, Deserialize)]
struct GEdge {
    #[serde(rename = "_gvid")]
    gvid: u32,
    tail: u32,
    head: u32,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    dir: Option<String>,
    #[serde(default)]
    style: Option<String>,
    #[serde(rename = "_draw_", default)]
    draw: Vec<DrawOp>,
    #[serde(rename = "_hdraw_", default)]
    hdraw: Vec<DrawOp>,
    #[serde(rename = "_ldraw_", default)]
    ldraw: Vec<DrawOp>,
}

#[derive(Debug, Deserialize)]
struct DrawOp {
    op: String,
    #[serde(default)]
    points: Option<Vec<Vec<f64>>>,
    #[serde(default)]
    rect: Option<Vec<f64>>,
    #[serde(default)]
    text: Option<String>,
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn point_of(pos: &str) -> Option<(f64, f64)> {
    let (x, y) = pos.split_once(',')?;
    Some((x.trim().parse().ok()?, y.trim().parse().ok()?))
}

fn rect_of(bb: &str) -> Option<(f64, f64, f64, f64)> {
    let parts: Vec<f64> = bb.split(',').filter_map(|s| s.trim().parse().ok()).collect();
    if parts.len() != 4 {
        return None;
    }
    Some((parts[0], parts[1], parts[2], parts[3]))
}

fn px(pt: f64) -> i32 {
    (pt * PT_TO_PX).round() as i32
}

/// 点字符串 `"x,y"` → 画布坐标（y 已翻转）。
fn to_px(x: f64, y: f64, max_y: f64) -> Point {
    Point { x: px(x), y: px(max_y - y) }
}

/// 把端点吸附到节点边界（沿“中心 → 该点”方向与矩形求交）。
///
/// 为什么必须做：Graphviz 给的端点本来就在边界上，但它给的是**样条控制点**，
/// 采样后的首末点可能落在形状内部；直接连中心会让线穿过框（1pt 断言抓不到、人眼一秒看出）。
fn snap(rect: &Rect, center: Point, p: Point) -> Point {
    let dx = (p.x - center.x) as f64;
    let dy = (p.y - center.y) as f64;
    if dx == 0.0 && dy == 0.0 {
        return p;
    }
    let tx = if dx > 0.0 {
        (rect.right() - center.x) as f64 / dx
    } else if dx < 0.0 {
        (rect.x - center.x) as f64 / dx
    } else {
        f64::INFINITY
    };
    let ty = if dy > 0.0 {
        (rect.bottom() - center.y) as f64 / dy
    } else if dy < 0.0 {
        (rect.y - center.y) as f64 / dy
    } else {
        f64::INFINITY
    };
    let t = tx.min(ty);
    if !t.is_finite() || t <= 0.0 {
        return p;
    }
    Point {
        x: (center.x as f64 + dx * t).round() as i32,
        y: (center.y as f64 + dy * t).round() as i32,
    }
}

fn shape_of(obj: &GObject, used_fallback: &mut Vec<String>) -> ShapeRole {
    let shape = obj.shape.as_deref().unwrap_or("box").trim();
    let styled_round = obj.style.as_deref().unwrap_or("").split(',').any(|s| s.trim() == "rounded");
    let mapped = match shape {
        "box" | "rect" | "rectangle" | "square" => {
            if styled_round {
                ShapeRole::Rounded
            } else {
                ShapeRole::Rect
            }
        }
        "ellipse" | "oval" | "circle" => ShapeRole::Ellipse,
        "diamond" | "rhombus" => ShapeRole::Diamond,
        "cylinder" => ShapeRole::Cylinder,
        "note" => ShapeRole::Note,
        "box3d" | "component" | "document" => ShapeRole::Document,
        "plaintext" | "none" => ShapeRole::Plain,
        other => {
            used_fallback.push(other.to_string());
            ShapeRole::Rect
        }
    };
    mapped
}

fn label_of(obj: &GObject) -> String {
    let raw = obj.label.clone().unwrap_or_else(|| obj.name.clone().unwrap_or_default());
    // `\N` = 节点名；Graphviz 的 `\n` 在 JSON 里是两个字面字符
    let raw = if raw == "\\N" { obj.name.clone().unwrap_or_default() } else { raw };
    raw.replace("\\n", "\n")
}

fn edge_points(edge: &GEdge, max_y: f64) -> (Vec<Point>, bool, bool) {
    let mut out: Vec<Point> = Vec::new();
    let mut curved = false;
    let mut approx = false;

    let Some(draw) = edge
        .draw
        .iter()
        .find(|d| d.points.as_ref().map(|p| !p.is_empty()).unwrap_or(false))
    else {
        return (out, curved, approx);
    };
    let pts = draw.points.as_deref().unwrap_or_default();
    match draw.op.as_str() {
        "b" => {
            curved = true;
            // 每段 4 点（p0, c1, c2, p1）；按 1/3、2/3 采样，段尾入列
            for chunk in pts.chunks_exact(4) {
                let p0 = (chunk[0][0], chunk[0][1]);
                let c1 = (chunk[1][0], chunk[1][1]);
                let c2 = (chunk[2][0], chunk[2][1]);
                let p1 = (chunk[3][0], chunk[3][1]);
                if out.is_empty() {
                    out.push(to_px(p0.0, p0.1, max_y));
                }
                for t in [1.0 / 3.0, 2.0 / 3.0, 1.0] {
                    let mt = 1.0 - t;
                    let x = mt * mt * mt * p0.0
                        + 3.0 * mt * mt * t * c1.0
                        + 3.0 * mt * t * t * c2.0
                        + t * t * t * p1.0;
                    let y = mt * mt * mt * p0.1
                        + 3.0 * mt * mt * t * c1.1
                        + 3.0 * mt * t * t * c2.1
                        + t * t * t * p1.1;
                    out.push(to_px(x, y, max_y));
                }
            }
        }
        "p" | "L" => {
            for p in pts {
                out.push(to_px(p[0], p[1], max_y));
            }
        }
        "e" => {
            // 椭圆弧不逐点还原：取首末 + 包围盒中心，报告里写明是近似
            approx = true;
            if let Some(p) = pts.first() {
                out.push(to_px(p[0], p[1], max_y));
            }
            if let Some(r) = draw.rect.as_ref().filter(|r| r.len() == 4) {
                out.push(to_px(r[0] + r[2] / 2.0, r[1] + r[3] / 2.0, max_y));
            }
            if let Some(p) = pts.last() {
                out.push(to_px(p[0], p[1], max_y));
            }
        }
        _ => {
            for p in pts {
                out.push(to_px(p[0], p[1], max_y));
            }
        }
    }
    out.dedup();
    (out, curved, approx)
}

fn arrow_of(edge: &GEdge) -> Arrow {
    if edge.dir.as_deref() == Some("none") {
        return Arrow::None;
    }
    // `_hdraw_` 里出现 `P`（多边形）就是有箭头；具体形状不追（drawio 只有几种）
    if edge.hdraw.iter().any(|d| d.op == "P") {
        Arrow::Block
    } else {
        Arrow::None
    }
}

/// 把一份 Graphviz `json` 转成 `CanvasPlan`。
pub fn dot_json_to_plan(json: &str, opts: &DotOpts) -> Result<CanvasPlan, String> {
    let doc: DotJson = serde_json::from_str(json).map_err(|e| format!("Graphviz json 解析失败：{e}"))?;
    if doc.objects.is_empty() {
        return Err("Graphviz 没有给出任何对象（布局可能失败）".into());
    }

    // 1) 分类：cluster 有 bb+nodes、没有 pos；节点有 pos。
    let clusters: Vec<&GObject> = doc
        .objects
        .iter()
        .filter(|o| o.bb.is_some() && o.nodes.is_some() && o.pos.is_none())
        .collect();
    let nodes: Vec<&GObject> = doc.objects.iter().filter(|o| o.pos.is_some() && o.width.is_some()).collect();

    // 2) 全局 maxY 必须**先扫一遍整张图**（y 翻转依赖它，不能边转边算）
    let mut max_y = 0.0f64;
    for n in &nodes {
        let Some((x, y)) = n.pos.as_deref().and_then(point_of) else { continue };
        let _ = x;
        let h_in = n.height.as_ref().and_then(num).unwrap_or(0.5);
        max_y = max_y.max(y + h_in * 72.0 / 2.0);
    }
    if max_y == 0.0 {
        if let Some(bb) = doc.bb.as_deref().and_then(rect_of) {
            max_y = bb.3;
        }
    }

    // 3) cluster 矩形（px）—— 父子层级按 bb 包含关系判定
    let mut cluster_rect: HashMap<u32, Rect> = HashMap::new();
    for c in &clusters {
        if let Some((x1, y1, x2, y2)) = c.bb.as_deref().and_then(rect_of) {
            cluster_rect.insert(
                c.gvid,
                Rect {
                    x: px(x1),
                    y: px(max_y - y2),
                    w: px(x2 - x1),
                    h: px(y2 - y1),
                },
            );
        }
    }

    let mut issues: Vec<ConvIssue> = Vec::new();
    let mut used_fallback: Vec<String> = Vec::new();
    let mut containers: Vec<PlanContainer> = Vec::new();
    if opts.cluster_as_container {
        for c in &clusters {
            let Some(rect) = cluster_rect.get(&c.gvid).copied() else { continue };
            // 直接父 = 包含它且面积最小的另一个 cluster
            let parent = cluster_rect
                .iter()
                .filter(|(gid, other)| **gid != c.gvid && other.contains_rect(&rect))
                .min_by_key(|(_, r)| r.w as i64 * r.h as i64)
                .map(|(gid, _)| format!("dot-c{gid}"));
            containers.push(PlanContainer {
                id: format!("dot-c{}", c.gvid),
                label: label_of(c),
                rect,
                parent,
                role: StyleRole::Container,
                raw_style: vec![],
            });
        }
        if !containers.is_empty() {
            issues.push(ConvIssue {
                level: Level::Info,
                code: "cluster.mapped".into(),
                params: Default::default(),
                at: None,
            });
        }
    } else if !clusters.is_empty() {
        issues.push(ConvIssue {
            level: Level::Degraded,
            code: "cluster.flattened".into(),
            params: [("n".to_string(), clusters.len().to_string())].into_iter().collect(),
            at: None,
        });
    }

    // 4) 节点
    let mut plan_nodes: Vec<PlanNode> = Vec::new();
    let mut node_rect: HashMap<u32, Rect> = HashMap::new();
    let mut colored = 0usize;
    for n in &nodes {
        let Some((x, y)) = n.pos.as_deref().and_then(point_of) else { continue };
        let w_in = n.width.as_ref().and_then(num).unwrap_or(0.75);
        let h_in = n.height.as_ref().and_then(num).unwrap_or(0.5);
        let w = (w_in * IN_TO_PX).round() as i32;
        let h = (h_in * IN_TO_PX).round() as i32;
        let center_x = px(x);
        // top_graph = y + h_pt/2；画布 y = (maxY - top_graph) * 4/3
        let rect = Rect {
            x: center_x - w / 2,
            y: px(max_y - (y + h_in * 72.0 / 2.0)),
            w,
            h,
        };
        node_rect.insert(n.gvid, rect);
        let parent = if opts.cluster_as_container {
            cluster_rect
                .iter()
                .filter(|(_, r)| r.contains(rect.center()))
                .min_by_key(|(_, r)| r.w as i64 * r.h as i64)
                .map(|(gid, _)| format!("dot-c{gid}"))
        } else {
            None
        };
        if n.fillcolor.is_some() || n.color.is_some() {
            colored += 1;
        }
        let shape = shape_of(n, &mut used_fallback);
        plan_nodes.push(PlanNode {
            id: format!("dot-{}", n.gvid),
            label: label_of(n),
            rect,
            shape,
            role: StyleRole::Primary,
            parent,
            raw_style: vec![],
            raw_children: vec![],
            at: None,
        });
    }

    if colored > 0 {
        issues.push(ConvIssue {
            level: Level::Degraded,
            code: "style.approx".into(),
            params: [("n".to_string(), colored.to_string())].into_iter().collect(),
            at: None,
        });
    }
    if !used_fallback.is_empty() {
        used_fallback.sort();
        used_fallback.dedup();
        issues.push(ConvIssue {
            level: Level::Degraded,
            code: "shape.fallback".into(),
            params: [("shapes".to_string(), used_fallback.join(" / "))].into_iter().collect(),
            at: None,
        });
    }

    // 5) 边
    let gvid_index: HashMap<u32, &GObject> = doc.objects.iter().map(|o| (o.gvid, o)).collect();
    let mut plan_edges: Vec<PlanEdge> = Vec::new();
    let mut routing_approx = 0usize;
    for e in &doc.edges {
        let Some(tail) = gvid_index.get(&e.tail).and_then(|o| o.pos.as_deref()) else { continue };
        let Some(head) = gvid_index.get(&e.head).and_then(|o| o.pos.as_deref()) else { continue };
        let _ = (tail, head);
        let (mut points, curved, approx) = edge_points(e, max_y);
        if approx {
            routing_approx += 1;
        }
        // 端点在边界上：沿“中心 → 采样点”方向吸附
        if points.is_empty() {
            if let (Some(tr), Some(hr)) = (node_rect.get(&e.tail), node_rect.get(&e.head)) {
                points = vec![tr.center(), hr.center()];
            }
        } else {
            if let (Some(tr), Some(p0)) = (node_rect.get(&e.tail), points.first().copied()) {
                points[0] = snap(tr, tr.center(), p0);
            }
            if let (Some(hr), Some(pl)) = (node_rect.get(&e.head), points.last().copied()) {
                let i = points.len() - 1;
                points[i] = snap(hr, hr.center(), pl);
            }
        }
        points.dedup();
        let label = e
            .label
            .clone()
            .filter(|l| !l.trim().is_empty())
            .or_else(|| {
                e.ldraw
                    .iter()
                    .find(|d| d.op == "T")
                    .and_then(|d| d.text.clone())
                    .filter(|t| !t.trim().is_empty())
            });
        let dashed = e
            .style
            .as_deref()
            .map(|s| s.split(',').any(|p| p.trim() == "dashed" || p.trim() == "dotted"))
            .unwrap_or(false);
        plan_edges.push(PlanEdge {
            id: format!("dot-e{}", e.gvid),
            from: format!("dot-{}", e.tail),
            to: format!("dot-{}", e.head),
            label,
            points,
            curved,
            arrow: arrow_of(e),
            dashed,
            role: StyleRole::Primary,
            raw_style: vec![],
            at: None,
        });
    }
    if routing_approx > 0 {
        issues.push(ConvIssue {
            level: Level::Degraded,
            code: "edge.routing.approx".into(),
            params: [("n".to_string(), routing_approx.to_string())].into_iter().collect(),
            at: None,
        });
    }

    let page = PlanPage {
        name: "Page-1".into(),
        id: "p1".into(),
        nodes: plan_nodes,
        edges: plan_edges,
        containers,
    };
    Ok(CanvasPlan {
        pages: vec![page],
        provenance: Provenance {
            from: FormatId::Dot,
            source_hash: opts.source_hash.clone(),
            converted_at: now_ms(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
        },
        issues,
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mxfile;

    fn opts() -> DotOpts {
        DotOpts {
            layout: "dot".into(),
            cluster_as_container: true,
            source_hash: "0123456789abcdef".into(),
        }
    }

    #[test]
    fn nested_clusters_are_built_from_objects_and_bb_containment() {
        let json = r#"{"bb":"0,0,200,200","objects":[
          {"_gvid":0,"name":"cluster_out","bb":"8,64,166,196","nodes":[2,3,4]},
          {"_gvid":1,"name":"cluster_in","bb":"16,136,158,188","nodes":[2,3]},
          {"_gvid":2,"name":"A","pos":"30,160","width":"0.75","height":"0.5","shape":"box"},
          {"_gvid":3,"name":"B","pos":"90,160","width":"0.75","height":"0.5","shape":"box"},
          {"_gvid":4,"name":"C","pos":"130,90","width":"0.75","height":"0.5","shape":"box"}
        ],"edges":[]}"#;
        let plan = dot_json_to_plan(json, &opts()).unwrap();
        let page = &plan.pages[0];
        assert_eq!(page.containers.len(), 2);
        let inner = page.containers.iter().find(|c| c.id == "dot-c1").unwrap();
        assert_eq!(inner.parent.as_deref(), Some("dot-c0"));
        assert_eq!(page.nodes.len(), 3);
        assert_eq!(inner.label, "cluster_in");
        // 不生成假容器：每个容器都有真实 bb
        assert!(page.containers.iter().all(|c| c.rect.w > 0 && c.rect.h > 0));
    }

    #[test]
    fn units_and_y_are_converted_once() {
        // A: 0.75×0.5 in，pos x=27 → 宽 72px，x=27*4/3-36=0；maxY=18+18=36 → y=0
        let json = r#"{"bb":"0,0,54,36","objects":[
          {"_gvid":0,"name":"A","pos":"27,18","width":"0.75","height":"0.5","shape":"box","label":"A"}
        ],"edges":[]}"#;
        let plan = dot_json_to_plan(json, &opts()).unwrap();
        assert_eq!(plan.pages[0].nodes[0].rect, Rect { x: 0, y: 0, w: 72, h: 48 });
        assert_eq!(plan.pages[0].nodes[0].label, "A");
    }

    #[test]
    fn bezier_edges_are_sampled_and_snapped() {
        let json = r#"{"bb":"0,0,150,36","objects":[
          {"_gvid":0,"name":"A","pos":"27,18","width":"0.75","height":"0.5","shape":"box"},
          {"_gvid":1,"name":"B","pos":"123,18","width":"0.75","height":"0.5","shape":"box"}
        ],"edges":[{"_gvid":0,"tail":0,"head":1,"label":"x",
          "_draw_":[{"op":"c"},{"op":"b","points":[[54.46,18],[64.04,18],[75.04,18],[85.39,18]]}],
          "_hdraw_":[{"op":"P","points":[[85.17,21.5],[95.17,18],[85.17,14.5]]}],
          "_ldraw_":[{"op":"T","text":"x"}]}]}"#;
        let plan = dot_json_to_plan(json, &opts()).unwrap();
        let e = &plan.pages[0].edges[0];
        assert!(!e.points.is_empty());
        assert!(e.curved);
        assert_eq!(e.arrow, Arrow::Block);
        assert_eq!(e.label.as_deref(), Some("x"));
        // 首末点必须落在各自节点矩形里
        let a = plan.pages[0].nodes.iter().find(|n| n.id == "dot-0").unwrap();
        let b = plan.pages[0].nodes.iter().find(|n| n.id == "dot-1").unwrap();
        assert!(a.rect.contains(*e.points.first().unwrap()), "{:?} {:?}", a.rect, e.points.first());
        assert!(b.rect.contains(*e.points.last().unwrap()), "{:?} {:?}", b.rect, e.points.last());
    }

    #[test]
    fn emit_roundtrip_counts_and_no_forward_parent() {
        let json = r#"{"bb":"0,0,200,200","objects":[
          {"_gvid":0,"name":"cluster_a","bb":"8,64,166,196","nodes":[1,2]},
          {"_gvid":1,"name":"A","pos":"50,160","width":"0.75","height":"0.5","shape":"box","label":"A"},
          {"_gvid":2,"name":"B","pos":"120,160","width":"0.75","height":"0.5","shape":"diamond","label":"B"}
        ],"edges":[{"_gvid":0,"tail":1,"head":2,"_draw_":[{"op":"b","points":[[68,160],[80,160],[90,160],[102,160]]}],"_hdraw_":[{"op":"P","points":[]}]}]}"#;
        let plan = dot_json_to_plan(json, &opts()).unwrap();
        let xml = mxfile::emit(&plan);
        let c = mxfile::inspect(&xml).unwrap();
        assert_eq!(c, plan.counts());
        let ci = xml.find("id=\"dot-c0\"").unwrap();
        let ni = xml.find("id=\"dot-1\"").unwrap();
        assert!(ci < ni, "{xml}");
    }

    #[test]
    fn cluster_can_be_flattened_with_an_issue() {
        let json = r#"{"bb":"0,0,200,200","objects":[
          {"_gvid":0,"name":"cluster_a","bb":"8,64,166,196","nodes":[1]},
          {"_gvid":1,"name":"A","pos":"50,160","width":"0.75","height":"0.5","shape":"box"}
        ],"edges":[]}"#;
        let mut o = opts();
        o.cluster_as_container = false;
        let plan = dot_json_to_plan(json, &o).unwrap();
        assert!(plan.pages[0].containers.is_empty());
        assert!(plan.issues.iter().any(|i| i.code == "cluster.flattened"));
    }

    #[test]
    fn unknown_shape_falls_back_and_is_reported() {
        let json = r#"{"bb":"0,0,100,100","objects":[
          {"_gvid":0,"name":"A","pos":"20,20","width":"0.75","height":"0.5","shape":"hexagon"}
        ],"edges":[]}"#;
        let plan = dot_json_to_plan(json, &opts()).unwrap();
        assert_eq!(plan.pages[0].nodes[0].shape, ShapeRole::Rect);
        assert!(plan.issues.iter().any(|i| i.code == "shape.fallback"));
    }

    /// 语料是 Graphviz 真产物（`node ... > .json`）：结构计数必须对得上。
    #[test]
    fn shipped_fixtures_convert_with_expected_counts() {
        let cases: [(&str, usize, usize, usize); 4] = [
            (include_str!("../../../tools/dev/fixtures/convert/login_lr.json"), 6, 7, 0),
            (include_str!("../../../tools/dev/fixtures/convert/subgraph_two_levels.json"), 6, 5, 3),
            (include_str!("../../../tools/dev/fixtures/convert/self_loop.json"), 1, 1, 0),
            (include_str!("../../../tools/dev/fixtures/convert/chinese_labels.json"), 4, 3, 0),
        ];
        for (json, nodes, edges, clusters) in cases {
            let plan = dot_json_to_plan(json, &opts()).unwrap();
            let page = &plan.pages[0];
            assert_eq!(page.nodes.len(), nodes, "节点数");
            assert_eq!(page.edges.len(), edges, "边数");
            assert_eq!(page.containers.len(), clusters, "容器数");
        }
        // 两层子图：内层容器的 parent 必须是外层
        let plan = dot_json_to_plan(
            include_str!("../../../tools/dev/fixtures/convert/subgraph_two_levels.json"),
            &opts(),
        )
        .unwrap();
        let page = &plan.pages[0];
        assert_eq!(page.containers.len(), 3);
        assert!(page.containers.iter().any(|c| c.parent.is_some()), "至少要有一个嵌套容器");
        assert!(page.nodes.iter().any(|n| n.parent.is_some()), "容器里的节点要挂 parent");
    }

    /// 1pt 门禁的**几何半边**：产出的节点中心与 Graphviz `pos` 的差 ≤ 1px。
    ///
    /// 应用内预览 vs 画布的整条链路要等真机探针；这条先钉住“单位/翻转/量化”三处换算。
    #[test]
    fn node_centers_match_graphviz_positions_within_one_pixel() {
        for json in [
            include_str!("../../../tools/dev/fixtures/convert/login_lr.json"),
            include_str!("../../../tools/dev/fixtures/convert/subgraph_two_levels.json"),
            include_str!("../../../tools/dev/fixtures/convert/self_loop.json"),
            include_str!("../../../tools/dev/fixtures/convert/chinese_labels.json"),
        ] {
            let doc: DotJson = serde_json::from_str(json).unwrap();
            let mut max_y = 0.0f64;
            for o in &doc.objects {
                if let Some((_, y)) = o.pos.as_deref().and_then(point_of) {
                    let h = o.height.as_ref().and_then(num).unwrap_or(0.5);
                    max_y = max_y.max(y + h * 72.0 / 2.0);
                }
            }
            let plan = dot_json_to_plan(json, &opts()).unwrap();
            let page = &plan.pages[0];
            let by_id: HashMap<&str, &PlanNode> = page.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
            for o in &doc.objects {
                let Some((x, y)) = o.pos.as_deref().and_then(point_of) else { continue };
                let n = by_id.get(format!("dot-{}", o.gvid).as_str()).expect("每个 pos 对象都要有节点");
                let want = to_px(x, y, max_y);
                let got = n.rect.center();
                assert!(
                    (got.x - want.x).abs() <= 1 && (got.y - want.y).abs() <= 1,
                    "{} 中心 {:?} ≠ Graphviz {:?}（结构化整数化误差应 ≤1px）",
                    o.name.as_deref().unwrap_or("?"),
                    got,
                    want
                );
            }
        }
    }
}
