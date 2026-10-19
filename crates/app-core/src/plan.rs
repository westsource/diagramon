//! `CanvasPlan`：三种源格式落到 drawio 之前的**唯一中间表示**。
//!
//! 为什么需要它：Mermaid / DOT / D2 各自有自己的几何与语义，但最终都要变成同一份 mxfile。
//! 如果没有中间表示，每条链都会自己拼一遍 XML —— 相对坐标、转义、容器先于子节点这些坑
//! 会在三处各踩一次，而且只有一处能修好。
//!
//! **几何一律整数 px（96dpi），且只量化一次**：这样 `CanvasPlan` 可 `Eq`，测试能整结构比对；
//! 1pt 容差（≈1.33px）仍在。绝对 → 相对只在 `mxfile::emit` 里做。

use serde::{Deserialize, Serialize};

use app_ipc::{ConvIssue, FormatId, SourceRef};

/// 轴对齐矩形（绝对坐标，px）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn center(&self) -> Point {
        Point { x: self.x + self.w / 2, y: self.y + self.h / 2 }
    }

    pub fn right(&self) -> i32 {
        self.x + self.w
    }

    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }

    /// 点是否落在矩形内（含边界）。
    pub fn contains(&self, p: Point) -> bool {
        p.x >= self.x && p.x <= self.right() && p.y >= self.y && p.y <= self.bottom()
    }

    /// 是否完全包含另一个矩形（用于判定集群嵌套）。
    pub fn contains_rect(&self, other: &Rect) -> bool {
        other.x >= self.x
            && other.y >= self.y
            && other.right() <= self.right()
            && other.bottom() <= self.bottom()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// 形状语义。`Rect` 是兜底；不认识的上游形状一律退化成它，并由 issue 说明。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ShapeRole {
    Rect,
    Rounded,
    Ellipse,
    Diamond,
    Cylinder,
    Note,
    Document,
    Plain,
    Swimlane,
}

/// 样式角色：颜色**不逐值保留**，而是映射到主题角色（报告里记为 `style.approx`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StyleRole {
    Primary,
    Secondary,
    Danger,
    Muted,
    Container,
    Note,
}

/// 边的箭头形态（只保留 drawio 能直接表达的几种）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Arrow {
    None,
    Classic,
    Block,
    Open,
}

/// 一个顶点。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanNode {
    pub id: String,
    pub label: String,
    /// 绝对坐标（px）。
    pub rect: Rect,
    pub shape: ShapeRole,
    pub role: StyleRole,
    /// 所属容器 id（绝对坐标是全局的，emit 时再相对化）。
    pub parent: Option<String>,
    /// 不认识的 drawio 样式键：原样透传（归一化不吃掉上游特性的唯一保证）。
    pub raw_style: Vec<String>,
    /// 不认识的子元素原文（本期为空，3.11 的 `parse` 用）。
    pub raw_children: Vec<String>,
    pub at: Option<SourceRef>,
}

/// 一条边。`points` 已含首尾（首位 = 源锚点，末位 = 目标锚点），坐标是绝对值。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub label: Option<String>,
    pub points: Vec<Point>,
    pub curved: bool,
    pub arrow: Arrow,
    pub dashed: bool,
    pub role: StyleRole,
    pub raw_style: Vec<String>,
    pub at: Option<SourceRef>,
}

/// 一个容器（drawio 的 `container=1` 顶点）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanContainer {
    pub id: String,
    pub label: String,
    pub rect: Rect,
    pub parent: Option<String>,
    pub role: StyleRole,
    pub raw_style: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanPage {
    pub name: String,
    pub id: String,
    pub nodes: Vec<PlanNode>,
    pub edges: Vec<PlanEdge>,
    pub containers: Vec<PlanContainer>,
}

/// 溯源：谁转的、从哪来、什么时候、哪个版本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Provenance {
    pub from: FormatId,
    pub source_hash: String,
    pub converted_at: i64,
    pub app_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanvasPlan {
    pub pages: Vec<PlanPage>,
    pub provenance: Provenance,
    pub issues: Vec<ConvIssue>,
}

impl CanvasPlan {
    pub fn counts(&self) -> app_ipc::Counts {
        let mut counts = app_ipc::Counts { pages: self.pages.len() as u32, ..Default::default() };
        for page in &self.pages {
            // 与 `mxfile::inspect` 同口径：节点数**包含容器顶点**（容器另计一份）。
            counts.nodes += (page.nodes.len() + page.containers.len()) as u32;
            counts.edges += page.edges.len() as u32;
            counts.containers += page.containers.len() as u32;
            counts.labels += page
                .nodes
                .iter()
                .filter(|n| !n.label.trim().is_empty())
                .count() as u32
                + page
                    .edges
                    .iter()
                    .filter(|e| e.label.as_deref().map(|l| !l.trim().is_empty()).unwrap_or(false))
                    .count() as u32
                + page.containers.iter().filter(|c| !c.label.trim().is_empty()).count() as u32;
        }
        counts
    }
}

/// 角色 → drawio 样式串。
///
/// 颜色与 `ui/app.css` 的 `--accent-soft` / `--accent` 同源；不要另造一套配色。
pub fn style_of(role: StyleRole, shape: ShapeRole) -> String {
    if shape == ShapeRole::Plain {
        return "text;strokeColor=none;fillColor=none;".into();
    }
    let (fill, stroke, font) = match role {
        StyleRole::Primary => ("#e4efec", "#3d7d72", "#232b2a"),
        StyleRole::Secondary => ("#f2f4f3", "#cfd4d3", "#4b5756"),
        StyleRole::Danger => ("#f8e9e6", "#b0554a", "#232b2a"),
        StyleRole::Muted => ("#e9eceb", "#e2e5e4", "#7d8887"),
        StyleRole::Container => ("none", "#cfd4d3", "#7d8887"),
        StyleRole::Note => ("#fbfbfb", "#cfd4d3", "#4b5756"),
    };
    let mut parts: Vec<String> = Vec::new();
    match shape {
        ShapeRole::Rounded => parts.push("rounded=1".into()),
        ShapeRole::Ellipse => parts.push("ellipse".into()),
        ShapeRole::Diamond => parts.push("rhombus".into()),
        ShapeRole::Cylinder => parts.push("shape=cylinder3".into()),
        ShapeRole::Note => parts.push("shape=note".into()),
        ShapeRole::Document => parts.push("shape=document".into()),
        ShapeRole::Swimlane => parts.push("swimlane".into()),
        ShapeRole::Plain => unreachable!("Plain 已在函数开头返回"),
        ShapeRole::Rect => {}
    }
    parts.push(format!("fillColor={fill}"));
    parts.push(format!("strokeColor={stroke}"));
    parts.push(format!("fontColor={font}"));
    if role == StyleRole::Container {
        parts.push("container=1".into());
        parts.push("collapsible=0".into());
    }
    parts.push("html=1".into());
    format!("{};", parts.join(";"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_and_shapes_map_to_drawio_tokens() {
        assert!(style_of(StyleRole::Primary, ShapeRole::Rounded).contains("rounded=1"));
        assert!(style_of(StyleRole::Primary, ShapeRole::Diamond).contains("rhombus"));
        assert!(style_of(StyleRole::Primary, ShapeRole::Ellipse).contains("ellipse"));
        assert!(style_of(StyleRole::Primary, ShapeRole::Cylinder).contains("shape=cylinder3"));
        assert!(style_of(StyleRole::Container, ShapeRole::Rect).contains("container=1"));
        assert!(style_of(StyleRole::Container, ShapeRole::Rect).contains("fillColor=none"));
        assert_eq!(style_of(StyleRole::Primary, ShapeRole::Plain), "text;strokeColor=none;fillColor=none;");
    }

    #[test]
    fn counts_include_container_vertices_like_inspect() {
        let page = PlanPage {
            name: "p".into(),
            id: "p1".into(),
            nodes: vec![],
            edges: vec![],
            containers: vec![PlanContainer {
                id: "c".into(),
                label: "组".into(),
                rect: Rect { x: 0, y: 0, w: 10, h: 10 },
                parent: None,
                role: StyleRole::Container,
                raw_style: vec![],
            }],
        };
        let plan = CanvasPlan {
            pages: vec![page],
            provenance: Provenance {
                from: FormatId::Dot,
                source_hash: "x".into(),
                converted_at: 0,
                app_version: "test".into(),
            },
            issues: vec![],
        };
        let c = plan.counts();
        assert_eq!((c.nodes, c.containers, c.labels), (1, 1, 1));
    }
}
