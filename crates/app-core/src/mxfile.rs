//! `mxfile` 只读扫描器（3.9.0：只做 `inspect`）。
//!
//! 为什么不引 XML 库：仓库的纪律是零新依赖，而 mxfile 的语法面很窄 ——
//! 手写扫描器能带行列号报错，且与 `lint::xml` 的报错风格一致。
//!
//! **本文件在 3.10.0 才长出 `parse` / `emit`**。现在只数：
//! 页、顶点、边、容器、标签 —— 报告面板与转换矩阵用它们回答
//! “这次转换到底产出了多少东西”。不要顺手把树结构先写了（那会把一版拖成两周）。

use app_ipc::Counts;

/// 扫描失败的位置（1 起）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub line: u32,
    pub col: u32,
    pub message: String,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "第 {} 行第 {} 列：{}", self.line, self.col, self.message)
    }
}

impl std::error::Error for ParseError {}

pub(crate) fn err_at(xml: &str, at: usize, message: impl Into<String>) -> ParseError {
    let before = &xml[..at.min(xml.len())];
    let line = before.matches('\n').count() as u32 + 1;
    let col = before.rsplit('\n').next().map(|s| s.chars().count() as u32 + 1).unwrap_or(1);
    ParseError { line, col, message: message.into() }
}

/// 解 XML 属性里的实体。`&#10;` 是 drawio 存换行的方式 —— **不解就会把多行标签压成一行**。
fn decode_entities(raw: &str) -> String {
    if !raw.contains('&') {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        let Some(semi) = tail.find(';') else {
            out.push_str(tail);
            return out;
        };
        let body = &tail[1..semi];
        let decoded = match body {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => {
                let digits = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X"));
                if let Some(hex) = digits {
                    u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
                } else if let Some(dec) = body.strip_prefix('#') {
                    dec.parse::<u32>().ok().and_then(char::from_u32)
                } else {
                    None
                }
            }
        };
        match decoded {
            Some(ch) => out.push(ch),
            // 不认识的实体原样保留：宁可显示 `&nbsp;`，也不要静默吞字符
            None => out.push_str(&tail[..=semi]),
        }
        rest = &tail[semi + 1..];
    }
    out.push_str(rest);
    out
}

/// 一个标签的解析结果。
pub(crate) struct Tag {
    pub(crate) name: String,
    pub(crate) closing: bool,
    pub(crate) self_closing: bool,
    pub(crate) attrs: Vec<(String, String)>,
    /// 标签结束后的字节位置。
    pub(crate) end: usize,
}

impl Tag {
    pub(crate) fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// 从 `<` 开始读一个标签。属性值支持单/双引号或无引号。
pub(crate) fn read_tag(xml: &str, start: usize) -> Result<Tag, ParseError> {
    let b = xml.as_bytes();
    let mut i = start + 1; // 跳过 '<'
    let closing = b.get(i) == Some(&b'/');
    if closing {
        i += 1;
    }
    let name_start = i;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_whitespace() || c == b'>' || c == b'/' {
            break;
        }
        i += 1;
    }
    if i == name_start {
        return Err(err_at(xml, start, "标签缺少名字"));
    }
    let name = xml[name_start..i].to_string();

    let mut attrs = Vec::new();
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            return Err(err_at(xml, start, format!("<{name}> 没有闭合的 `>`")));
        }
        if b[i] == b'>' {
            return Ok(Tag { name, closing, self_closing: false, attrs, end: i + 1 });
        }
        if b[i] == b'/' {
            if b.get(i + 1) == Some(&b'>') {
                return Ok(Tag { name, closing, self_closing: true, attrs, end: i + 2 });
            }
            i += 1;
            continue;
        }
        // 属性名
        let key_start = i;
        while i < b.len() {
            let c = b[i];
            if c.is_ascii_whitespace() || c == b'=' || c == b'>' || c == b'/' {
                break;
            }
            i += 1;
        }
        if i == key_start {
            return Err(err_at(xml, i, format!("<{name}> 的属性名不合法")));
        }
        let key = xml[key_start..i].to_string();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if b.get(i) != Some(&b'=') {
            // 布尔风格属性（非法 XML，但宿主偶尔会发）：当作空值
            attrs.push((key, String::new()));
            continue;
        }
        i += 1; // '='
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            return Err(err_at(xml, start, format!("<{name}> 的属性 {key} 没有值")));
        }
        let value_start;
        let value_end;
        if b[i] == b'"' || b[i] == b'\'' {
            let quote = b[i];
            i += 1;
            value_start = i;
            while i < b.len() && b[i] != quote {
                i += 1;
            }
            if i >= b.len() {
                return Err(err_at(xml, start, format!("<{name}> 的属性 {key} 引号没有闭合")));
            }
            value_end = i;
            i += 1; // 闭合引号
        } else {
            value_start = i;
            while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'>' && b[i] != b'/' {
                i += 1;
            }
            value_end = i;
        }
        attrs.push((key, decode_entities(&xml[value_start..value_end])));
    }
}

/// 容器判定：drawio 用 `container=1`，泳道用 `swimlane`。
fn is_container(style: &str) -> bool {
    style
        .split(';')
        .map(|part| part.trim())
        .any(|part| part == "container=1" || part.starts_with("swimlane") || part == "shape=swimlane")
}

fn non_empty(value: Option<&str>) -> bool {
    value.map(|v| !v.trim().is_empty()).unwrap_or(false)
}

/// 解析一段 mxfile（实现见 `mxfile_parse`，与扫描/输出分开以免单文件过长）。
pub use crate::mxfile_parse::{normalize, parse};

/// 只数不建树。
///
/// 计数口径（与 `ConvReport.counts` 对齐）：
/// - `pages` = `<diagram>` 个数（没有 `<diagram>` 但确有 `<mxfile>` 时按 1 页）；
/// - `nodes` = `vertex="1"` 的 `mxCell`（不含 `id="0"` / `id="1"` 两层骨架）；
/// - `edges` = `edge="1"` 的 `mxCell`；
/// - `containers` = 顶点里带 `container=1` / `swimlane` 的；
/// - `labels` = 非空 `value` / `label`（`UserObject` 的 label 只算一次）。
pub fn inspect(xml: &str) -> Result<Counts, ParseError> {
    let mut counts = Counts { pages: 0, ..Counts::default() };
    let mut saw_file = false;
    let mut pending_label: Option<String> = None;
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
            continue;
        }

        match tag.name.as_str() {
            "mxfile" => saw_file = true,
            "diagram" => counts.pages = counts.pages.saturating_add(1),
            // drawio 的“包一层”写法：label 在外层，几何与样式在内层 mxCell
            "UserObject" | "object" => {
                if let Some(label) = tag.attr("label") {
                    if non_empty(Some(label)) {
                        pending_label = Some(label.to_string());
                    }
                }
            }
            "mxCell" => {
                let id = tag.attr("id").unwrap_or_default();
                let vertex = tag.attr("vertex") == Some("1");
                let edge = tag.attr("edge") == Some("1");
                if vertex || edge {
                    if id != "0" && id != "1" {
                        if vertex {
                            counts.nodes = counts.nodes.saturating_add(1);
                            if is_container(tag.attr("style").unwrap_or_default()) {
                                counts.containers = counts.containers.saturating_add(1);
                            }
                        }
                        if edge {
                            counts.edges = counts.edges.saturating_add(1);
                        }
                    }
                }
                // UserObject 的 label 已经算过这一条；内层 mxCell 的 value 通常为空
                let label = match pending_label.take() {
                    Some(label) => label,
                    None => tag.attr("value").unwrap_or_default().to_string(),
                };
                if non_empty(Some(&label)) {
                    counts.labels = counts.labels.saturating_add(1);
                }
            }
            _ => {}
        }
    }

    if !saw_file {
        return Err(err_at(xml, 0, "不是 mxfile：找不到 `<mxfile>`"));
    }
    if counts.pages == 0 {
        counts.pages = 1;
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="Diagramon">
  <diagram name="Page-1" id="p1">
    <mxGraphModel dx="800" dy="600" grid="1" page="1">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="box" value="网络" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry" /></mxCell>
        <mxCell id="group" value="子网" vertex="1" style="container=1;collapsible=0;" parent="1"><mxGeometry x="0" y="60" width="200" height="120" as="geometry" /></mxCell>
        <mxCell id="e1" value="HTTPS" edge="1" parent="1" source="box" target="group"><mxGeometry relative="1" as="geometry" /></mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>"#;

    #[test]
    fn counts_cells_edges_containers_pages_and_labels() {
        let c = inspect(SIMPLE).unwrap();
        assert_eq!(c.pages, 1);
        assert_eq!(c.nodes, 2);
        assert_eq!(c.containers, 1);
        assert_eq!(c.edges, 1);
        // 网络 + 子网 + HTTPS
        assert_eq!(c.labels, 3);
    }

    #[test]
    fn multi_page_is_counted_per_diagram() {
        let c = inspect(&SIMPLE.replace("</mxfile>", "<diagram name=\"p2\" id=\"p2\"><mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/><mxCell id=\"v\" value=\"v\" vertex=\"1\" parent=\"1\"/></root></mxGraphModel></diagram></mxfile>")).unwrap();
        assert_eq!(c.pages, 2);
        assert_eq!(c.nodes, 3);
    }

    #[test]
    fn userobject_label_counts_once_and_entities_decode() {
        let xml = r#"<mxfile host="x"><diagram name="p"><mxGraphModel><root>
          <mxCell id="0"/><mxCell id="1" parent="0"/>
          <UserObject label="第一行&#10;第二行" id="u1"><mxCell style="rounded=1;" vertex="1" parent="1"><mxGeometry width="10" height="10" as="geometry"/></mxCell></UserObject>
        </root></mxGraphModel></diagram></mxfile>"#;
        let c = inspect(xml).unwrap();
        assert_eq!(c.nodes, 1);
        assert_eq!(c.labels, 1, "UserObject 的 label 与内层 mxCell 不能重复计数");
        let tag = read_tag(xml, xml.find("<UserObject").unwrap()).unwrap();
        assert_eq!(tag.attr("label"), Some("第一行\n第二行"));
    }

    #[test]
    fn malformed_xml_reports_line_and_column() {
        let e = inspect("<mxfile>\n  <diagram name=\"p\">\n    <mxCell id=\"2\"").unwrap_err();
        assert_eq!(e.line, 3);
        assert!(e.col > 1, "{e:?}");
        assert!(e.message.contains("mxCell"), "{e:?}");
    }

    #[test]
    fn non_mxfile_is_an_error_not_zero_counts() {
        let e = inspect(r#"{"type":"excalidraw","elements":[]}"#).unwrap_err();
        assert!(e.message.contains("mxfile"));
    }

    #[test]
    fn comments_and_doctype_are_skipped() {
        let xml = "<!DOCTYPE mxfile>\n<!-- <mxCell id=\"ghost\" vertex=\"1\"/> -->\n<mxfile><diagram name=\"p\"/></mxfile>";
        let c = inspect(xml).unwrap();
        assert_eq!(c.pages, 1);
        assert_eq!(c.nodes, 0);
    }

    /// 语料（`tools/dev/fixtures/convert/`）必须**真的能被扫描器读**：
    /// 否则 3.10.0 的结构守恒门禁会拿一份没人验证过的样本当地基。
    #[test]
    fn shipped_fixtures_are_inspectable() {
        let stencil = include_str!("../../../tools/dev/fixtures/convert/stencil.drawio");
        let c = inspect(stencil).unwrap();
        assert_eq!((c.pages, c.nodes, c.edges, c.labels), (1, 2, 1, 3), "{c:?}");

        let container = include_str!("../../../tools/dev/fixtures/convert/container.drawio");
        let c = inspect(container).unwrap();
        assert_eq!((c.pages, c.nodes, c.edges, c.containers), (1, 3, 1, 1), "{c:?}");
        assert_eq!(c.labels, 3, "子网 / 网关 / UserObject 的“数据库(主)”");
    }
}

/* ------------------------------------------------------------------ 输出 */

use crate::plan::{Arrow, CanvasPlan, PlanContainer, PlanPage, Rect, ShapeRole};

/// XML 属性值转义。**换行写成 `&#10;`** —— drawio 存多行标签的方式，别直接塞裸换行。
fn attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\n' => out.push_str("&#10;"),
            '\r' => {}
            _ => out.push(ch),
        }
    }
    out
}

fn container_depth(id: &str, page: &PlanPage, guard: usize) -> usize {
    if guard == 0 {
        return 1; // 环：当两层处理，别递归爆栈
    }
    match page.containers.iter().find(|c| c.id == id).and_then(|c| c.parent.as_deref()) {
        Some(parent) => 1 + container_depth(parent, page, guard - 1),
        None => 1,
    }
}

fn edge_style(edge: &crate::plan::PlanEdge) -> String {
    let mut s = crate::plan::style_of(edge.role, ShapeRole::Rect);
    s.push_str(match edge.arrow {
        Arrow::None => "endArrow=none;",
        Arrow::Classic => "endArrow=classic;",
        Arrow::Block => "endArrow=block;",
        Arrow::Open => "endArrow=open;",
    });
    if edge.dashed {
        s.push_str("dashed=1;");
    }
    if edge.curved {
        s.push_str("curved=1;");
    }
    for raw in &edge.raw_style {
        if !raw.trim().is_empty() {
            s.push_str(raw.trim());
            if !raw.trim_end().ends_with(';') {
                s.push(';');
            }
        }
    }
    s
}

fn node_style(node: &crate::plan::PlanNode) -> String {
    let mut s = crate::plan::style_of(node.role, node.shape);
    for raw in &node.raw_style {
        if !raw.trim().is_empty() {
            s.push_str(raw.trim());
            if !raw.trim_end().ends_with(';') {
                s.push(';');
            }
        }
    }
    s
}

/// 把一份 `CanvasPlan` 写成 mxfile。
///
/// 顺序约束（**必须**）：容器先于其子节点。drawio 对 `parent` 的前向引用会**静默丢 cell**，
/// 而 d2.js 已经踩过一次；这里用拓扑序兜住，不赌调用方的顺序。
pub fn emit(plan: &CanvasPlan) -> String {
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<mxfile host=\"Diagramon\">\n");
    for page in &plan.pages {
        out.push_str(&format!(
            "  <diagram name=\"{}\" id=\"{}\">\n    <mxGraphModel dx=\"800\" dy=\"600\" grid=\"1\" page=\"1\">\n      <root>\n        <mxCell id=\"0\" />\n        <mxCell id=\"1\" parent=\"0\" />\n",
            attr(&page.name),
            attr(&page.id)
        ));

        // 绝对坐标索引（容器 + 节点）。相对化只减**直接父**的原点。
        let mut abs: std::collections::HashMap<&str, Rect> = std::collections::HashMap::new();
        for c in &page.containers {
            abs.insert(c.id.as_str(), c.rect);
        }
        for n in &page.nodes {
            abs.insert(n.id.as_str(), n.rect);
        }
        let rel = |rect: Rect, parent: Option<&str>| -> Rect {
            let (dx, dy) = parent
                .and_then(|p| abs.get(p).copied())
                .map(|p| (p.x, p.y))
                .unwrap_or((0, 0));
            Rect { x: rect.x - dx, y: rect.y - dy, w: rect.w, h: rect.h }
        };

        // 容器按嵌套深度升序（先父后子）
        let mut containers: Vec<&PlanContainer> = page.containers.iter().collect();
        containers.sort_by_key(|c| container_depth(&c.id, page, 32));
        for c in containers {
            let r = rel(c.rect, c.parent.as_deref());
            out.push_str(&format!(
                "        <mxCell id=\"{}\" value=\"{}\" style=\"{}\" vertex=\"1\" parent=\"{}\"><mxGeometry x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" as=\"geometry\" /></mxCell>\n",
                attr(&c.id),
                attr(&c.label),
                crate::plan::style_of(c.role, ShapeRole::Rect)
                    + &c
                        .raw_style
                        .iter()
                        .filter(|s| !s.trim().is_empty())
                        .map(|s| if s.trim_end().ends_with(';') { s.trim().to_string() } else { format!("{};", s.trim()) })
                        .collect::<String>(),
                attr(c.parent.as_deref().unwrap_or("1")),
                r.x,
                r.y,
                r.w,
                r.h
            ));
        }

        for n in &page.nodes {
            let r = rel(n.rect, n.parent.as_deref());
            out.push_str(&format!(
                "        <mxCell id=\"{}\" value=\"{}\" style=\"{}\" vertex=\"1\" parent=\"{}\"><mxGeometry x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" as=\"geometry\" /></mxCell>\n",
                attr(&n.id),
                attr(&n.label),
                node_style(n),
                attr(n.parent.as_deref().unwrap_or("1")),
                r.x,
                r.y,
                r.w,
                r.h
            ));
        }

        for e in &page.edges {
            out.push_str(&format!(
                "        <mxCell id=\"{}\" value=\"{}\" style=\"{}\" edge=\"1\" parent=\"1\" source=\"{}\" target=\"{}\">\n          <mxGeometry relative=\"1\" as=\"geometry\"",
                attr(&e.id),
                attr(e.label.as_deref().unwrap_or("")),
                edge_style(e),
                attr(&e.from),
                attr(&e.to)
            ));
            if e.points.is_empty() {
                out.push_str(" />\n");
            } else {
                // 中间点作为 waypoints；首尾是端点，不放进 Array（否则走线两端各折一下）
                out.push_str(">\n            <Array as=\"points\">\n");
                for p in e.points.iter().skip(1).take(e.points.len().saturating_sub(2)) {
                    out.push_str(&format!(
                        "              <mxPoint x=\"{}\" y=\"{}\" />\n",
                        p.x, p.y
                    ));
                }
                out.push_str("            </Array>\n          </mxGeometry>\n");
            }
            out.push_str("        </mxCell>\n");
        }

        out.push_str("      </root>\n    </mxGraphModel>\n  </diagram>\n");
    }
    out.push_str("</mxfile>\n");
    out
}

#[cfg(test)]
mod emit_tests {
    use super::*;
    use crate::plan::{CanvasPlan, PlanEdge, PlanNode, PlanPage, Point, Provenance, Rect, ShapeRole, StyleRole};
    use app_ipc::FormatId;

    fn page() -> PlanPage {
        PlanPage {
            name: "Page-1".into(),
            id: "p1".into(),
            containers: vec![PlanContainer {
                id: "c1".into(),
                label: "子网".into(),
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
        }
    }

    fn plan() -> CanvasPlan {
        CanvasPlan {
            pages: vec![page()],
            provenance: Provenance {
                from: FormatId::Dot,
                source_hash: "abc".into(),
                converted_at: 0,
                app_version: "test".into(),
            },
            issues: vec![],
        }
    }

    #[test]
    fn emit_output_is_inspectable_and_counts_match() {
        let p = plan();
        let xml = emit(&p);
        let c = inspect(&xml).unwrap();
        assert_eq!(c, p.counts(), "{xml}");
        assert_eq!(c.pages, 1);
        assert_eq!(c.nodes, 2, "节点 + 容器顶点");
        assert_eq!(c.containers, 1);
        assert_eq!(c.edges, 1);
        assert_eq!(c.labels, 3, "网关 / 自环 / 子网");
    }

    #[test]
    fn emit_escapes_attributes_and_newlines() {
        let xml = emit(&plan());
        assert!(xml.contains("网关 &amp; &lt;API&gt;&#10;第二行"), "{xml}");
        assert!(!xml.contains("网关 & <API>"), "{xml}");
    }

    #[test]
    fn child_geometry_is_relative_to_its_container() {
        let xml = emit(&plan());
        // 容器 (100,100)，节点 (150,130) ⇒ 相对 (50,30)
        assert!(xml.contains("x=\"50\" y=\"30\" width=\"80\" height=\"40\""), "{xml}");
        // 容器自身保持绝对
        assert!(xml.contains("x=\"100\" y=\"100\" width=\"300\" height=\"200\""), "{xml}");
    }

    #[test]
    fn container_precedes_its_children() {
        let xml = emit(&plan());
        let ci = xml.find("id=\"c1\"").unwrap();
        let ni = xml.find("id=\"n1\"").unwrap();
        assert!(ci < ni, "drawio 对 parent 前向引用会静默丢 cell\n{xml}");
    }

    #[test]
    fn edge_waypoints_exclude_endpoints_and_keep_style_tokens() {
        let xml = emit(&plan());
        assert!(xml.contains("curved=1;"), "{xml}");
        assert!(xml.contains("endArrow=block;"), "{xml}");
        assert!(xml.contains("<mxPoint x=\"140\" y=\"140\" />"), "{xml}");
        assert!(!xml.contains("<mxPoint x=\"150\" y=\"150\" />"), "首点不应进 waypoints");
        assert!(!xml.contains("<mxPoint x=\"230\" y=\"150\" />"), "末点不应进 waypoints");
    }
}
