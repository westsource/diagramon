//! DOT → D2：手写的词法分析 + 递归下降解析器。
//!
//! **为什么不引 DOT 库**：要迁的只是 DOT 的常用子集（节点 / 边 / 容器 / 属性四样），
//! 引一个库等于把它的 AST 与报错风格一起引进来，而这里要的是「第 N 行：……」这种
//! 与 `mermaid_to_d2` 同一口吻的错误。这一层的依赖是零。
//!
//! **保真度**：DOT 的版式是**算出来的**（rank / pos / weight / 端口 / splines），
//! D2 把版式交给布局引擎，于是这个方向必然有损 —— 丢掉的东西逐条进 `notes`，
//! 不静默丢（与 `mermaid_to_d2` 同一策略）。产出结构照抄 `mermaid_to_d2`：
//! 先 `direction`，再节点与容器，**边一律写在全文件末尾**（边若写进容器，
//! 另一头在别处的边会凭空造出一个同名新节点）。

use std::collections::{BTreeSet, HashMap};
use std::fmt::Write as _;

use crate::convert::Conversion;
use crate::d2syntax::{d2_id, d2_str};

/* ------------------------------------------------------------------ 词法 */

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    /// 裸名字 / 数字（DOT 的 ID 允许中文，所以这里按 Unicode 字母数字判）
    Id(String),
    /// `"…"` 里的正文（DOT 的 `\n` / `\l` / `\r` 已换成真正的换行）
    Str(String),
    /// `<…>` 里的正文（HTML-like label）
    Html(String),
    /// `->`
    Arrow,
    /// `--`
    Dash,
    LBrace,
    RBrace,
    LBracket,
    RBracket,
    Semi,
    Comma,
    Eq,
    Colon,
    Plus,
}

fn tok_text(t: &Tok) -> String {
    match t {
        Tok::Id(s) => s.clone(),
        Tok::Str(s) => format!("\"{s}\""),
        Tok::Html(s) => format!("<{s}>"),
        Tok::Arrow => "->".into(),
        Tok::Dash => "--".into(),
        Tok::LBrace => "{".into(),
        Tok::RBrace => "}".into(),
        Tok::LBracket => "[".into(),
        Tok::RBracket => "]".into(),
        Tok::Semi => ";".into(),
        Tok::Comma => ",".into(),
        Tok::Eq => "=".into(),
        Tok::Colon => ":".into(),
        Tok::Plus => "+".into(),
    }
}

/// 裸 ID 的构成：Unicode 字母数字、`_`、`.`（`1.5` 这类数以及某些工具的 `a.b` 名字）。
fn is_bare_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '.'
}

/// 词法分析：注释先吃掉（`//`、`/* … */`、`#`），字符串里的 `#` 是正文不是注释。
///
/// 每个 token 带上**所在行号**（1 起）—— 没有它就报不出「第 N 行」那种错。
fn lex(src: &str) -> Result<Vec<(Tok, usize)>, String> {
    let cs: Vec<char> = src.chars().collect();
    let mut out: Vec<(Tok, usize)> = Vec::new();
    let mut i = 0usize;
    let mut line = 1usize;

    while i < cs.len() {
        let c = cs[i];
        if c == '\n' {
            line += 1;
            i += 1;
            continue;
        }
        if c.is_whitespace() || c == '\u{feff}' {
            i += 1;
            continue;
        }
        match c {
            '#' => {
                while i < cs.len() && cs[i] != '\n' {
                    i += 1;
                }
            }
            '/' if cs.get(i + 1) == Some(&'/') => {
                while i < cs.len() && cs[i] != '\n' {
                    i += 1;
                }
            }
            '/' if cs.get(i + 1) == Some(&'*') => {
                let start = line;
                i += 2;
                let mut closed = false;
                while i < cs.len() {
                    if cs[i] == '\n' {
                        line += 1;
                    }
                    if cs[i] == '*' && cs.get(i + 1) == Some(&'/') {
                        i += 2;
                        closed = true;
                        break;
                    }
                    i += 1;
                }
                if !closed {
                    return Err(format!("第 {start} 行：`/*` 注释没有闭合"));
                }
            }
            '"' => {
                let start = line;
                i += 1;
                let mut s = String::new();
                loop {
                    match cs.get(i) {
                        None => {
                            return Err(format!("第 {start} 行：字符串没有闭合（引号少了另一半）"))
                        }
                        Some('"') => {
                            i += 1;
                            break;
                        }
                        Some(&'\\') => {
                            // graphviz 里 `\n` / `\l` / `\r` 是**换行**（靠它们排版），
                            // 这里先还原成真正的换行，emit 时再由 `d2_str` 写成 D2 的 `\n`
                            match cs.get(i + 1) {
                                None => {
                                    return Err(format!(
                                        "第 {start} 行：字符串没有闭合（引号少了另一半）"
                                    ))
                                }
                                Some(&e) => {
                                    match e {
                                        'n' | 'l' | 'r' => s.push('\n'),
                                        '"' => s.push('"'),
                                        '\\' => s.push('\\'),
                                        other => s.push(other),
                                    }
                                    i += 2;
                                }
                            }
                        }
                        Some(&ch) => {
                            if ch == '\n' {
                                line += 1;
                            }
                            s.push(ch);
                            i += 1;
                        }
                    }
                }
                out.push((Tok::Str(s), start));
            }
            '<' => {
                // HTML-like label：尖括号配对（`<<b>粗</b>>` 这种两层括号也是这么数的）
                let start = line;
                i += 1;
                let mut depth = 1usize;
                let mut s = String::new();
                while i < cs.len() {
                    match cs[i] {
                        '<' => {
                            depth += 1;
                            s.push('<');
                            i += 1;
                        }
                        '>' => {
                            depth -= 1;
                            i += 1;
                            if depth == 0 {
                                break;
                            }
                            s.push('>');
                        }
                        other => {
                            if other == '\n' {
                                line += 1;
                            }
                            s.push(other);
                            i += 1;
                        }
                    }
                }
                if depth != 0 {
                    return Err(format!("第 {start} 行：`<…>` 标签没有闭合"));
                }
                out.push((Tok::Html(s), start));
            }
            '-' if cs.get(i + 1) == Some(&'>') => {
                out.push((Tok::Arrow, line));
                i += 2;
            }
            '-' if cs.get(i + 1) == Some(&'-') => {
                out.push((Tok::Dash, line));
                i += 2;
            }
            '-' if cs.get(i + 1).map_or(false, |n| n.is_numeric()) => {
                let start = i;
                i += 1;
                while i < cs.len() && (cs[i].is_numeric() || cs[i] == '.') {
                    i += 1;
                }
                out.push((Tok::Id(cs[start..i].iter().collect()), line));
            }
            '{' => {
                out.push((Tok::LBrace, line));
                i += 1;
            }
            '}' => {
                out.push((Tok::RBrace, line));
                i += 1;
            }
            '[' => {
                out.push((Tok::LBracket, line));
                i += 1;
            }
            ']' => {
                out.push((Tok::RBracket, line));
                i += 1;
            }
            ';' => {
                out.push((Tok::Semi, line));
                i += 1;
            }
            ',' => {
                out.push((Tok::Comma, line));
                i += 1;
            }
            '=' => {
                out.push((Tok::Eq, line));
                i += 1;
            }
            ':' => {
                out.push((Tok::Colon, line));
                i += 1;
            }
            '+' => {
                out.push((Tok::Plus, line));
                i += 1;
            }
            _ if is_bare_char(c) => {
                let start = i;
                while i < cs.len() && is_bare_char(cs[i]) {
                    i += 1;
                }
                out.push((Tok::Id(cs[start..i].iter().collect()), line));
            }
            _ => return Err(format!("第 {line} 行：不认识的字符 `{c}`")),
        }
    }
    Ok(out)
}

/* ------------------------------------------------------------------ 形状与样式映射 */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShapeMap {
    /// 与 D2 的默认矩形一致 —— 不写字形行
    Default,
    /// 有对应形状
    Named(&'static str),
    /// `record` / `Mrecord`：外框留着，字段与端口不迁移
    Record,
    /// 没有对应形状：退回 D2 默认矩形，由 notes 说明
    Degraded,
}

/// DOT 的 `shape` → D2 的 `shape`。
///
/// D2 只认这些形状名：rectangle / square / oval / circle / cylinder / diamond / hexagon /
/// parallelogram / document / package / step / queue / page / callout / person / block_arrow。
/// 对不上的**退化**成默认矩形，并且**不假装还在**（`notes` 逐条说明）。
fn map_shape(dot: &str) -> ShapeMap {
    match dot.trim().to_ascii_lowercase().as_str() {
        "box" | "rect" | "rectangle" => ShapeMap::Default,
        "ellipse" | "oval" => ShapeMap::Named("oval"),
        "circle" | "doublecircle" => ShapeMap::Named("circle"),
        "cylinder" => ShapeMap::Named("cylinder"),
        "diamond" => ShapeMap::Named("diamond"),
        "hexagon" => ShapeMap::Named("hexagon"),
        "parallelogram" => ShapeMap::Named("parallelogram"),
        "square" => ShapeMap::Named("square"),
        "record" | "mrecord" => ShapeMap::Record,
        _ => ShapeMap::Degraded,
    }
}

/// DOT 属性 → D2 的 `style.*` 键（顺序固定，产出才稳定）。
const STYLE_MAP: [(&str, &str); 5] = [
    ("color", "stroke"),
    ("fontcolor", "font-color"),
    ("penwidth", "stroke-width"),
    ("fillcolor", "fill"),
    ("fontsize", "font-size"),
];

/// D2 的 `direction`。
fn d2_direction(v: &str) -> Option<&'static str> {
    match v.trim().to_ascii_uppercase().as_str() {
        "LR" => Some("right"),
        "TB" => Some("down"),
        "BT" => Some("up"),
        "RL" => Some("left"),
        _ => None,
    }
}

/// DOT 的多色列表（`color="red:blue"`、`"red;0.6:blue"`）D2 只认单色：取第一个，丢掉权重。
fn first_color(v: &str) -> String {
    let first = v.split(':').next().unwrap_or(v);
    first.split(';').next().unwrap_or(first).trim().to_string()
}

/// 一组属性里的 `label`（同名后者覆盖前者，`merge_attrs` 已保证只剩一条）。
fn attr_label(attrs: &[(String, String)]) -> Option<String> {
    attrs
        .iter()
        .rev()
        .find(|(k, _)| k.eq_ignore_ascii_case("label"))
        .map(|(_, v)| v.clone())
}

fn attr_shape(attrs: &[(String, String)]) -> Option<String> {
    attrs
        .iter()
        .rev()
        .find(|(k, _)| k.eq_ignore_ascii_case("shape"))
        .map(|(_, v)| v.clone())
}

/// 属性里能迁的样式（颜色加引号：`#f00` 裸写会被当注释起点）。
fn attr_styles(attrs: &[(String, String)]) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    for (dot, d2) in STYLE_MAP {
        if let Some((_, v)) = attrs.iter().rev().find(|(k, _)| k.eq_ignore_ascii_case(dot)) {
            out.push((d2, d2_style_value(d2, &first_color(v))));
        }
    }
    out
}

/// 样式值：**数字类**的键（线宽 / 字号）裸写数字，颜色与其余一律加引号。
///
/// 与 `mermaid_to_d2` 的 `d2_value` 同一口径 —— 两个 emitter 的输出不该长得不一样，
/// 而 D2 那边 `stroke-width: 2` 与 `stroke-width: "2"` 是两种值（前者才是长度）。
fn d2_style_value(key: &str, v: &str) -> String {
    let numeric = matches!(key, "stroke-width" | "font-size" | "stroke-dash");
    if numeric && v.parse::<f32>().is_ok() {
        v.to_string()
    } else {
        d2_str(v)
    }
}

/// `style=dashed` / `style=dotted` → 虚线段长 3（D2 只接受一个数字）。
fn style_values(attrs: &[(String, String)]) -> Vec<String> {
    attrs
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("style"))
        .flat_map(|(_, v)| v.split(','))
        .map(|p| p.trim().to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .collect()
}

fn is_dash(attrs: &[(String, String)]) -> bool {
    style_values(attrs).iter().any(|p| p == "dashed" || p == "dotted")
}

/// 新值覆盖同名的旧值（DOT 里同名属性后者生效；名字大小写不敏感）。
fn merge_attrs(dst: &mut Vec<(String, String)>, src: &[(String, String)]) {
    for (k, v) in src {
        dst.retain(|(dk, _)| !dk.eq_ignore_ascii_case(k));
        dst.push((k.clone(), v.clone()));
    }
}

/// HTML-like label 只取纯文本（D2 的标签是纯文本，没有标签与实体这一说）。
fn strip_html(raw: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in raw.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/* ------------------------------------------------------------------ 中间模型 */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Digraph,
    Graph,
}

impl Default for Kind {
    fn default() -> Self {
        Kind::Digraph
    }
}

/// 一个 subgraph = 一个 D2 容器。
struct Cluster {
    /// subgraph 的名字（`cluster_x` 里的 `cluster_x`）；容器名优先用 label
    name: String,
    parent: Option<usize>,
    children: Vec<usize>,
}

#[derive(Default, Clone)]
struct NodeInfo {
    /// 已并入 `node [...]` 默认值的 DOT 属性（顺序 = 声明顺序）
    attrs: Vec<(String, String)>,
}

struct Edge {
    from: String,
    to: String,
    attrs: Vec<(String, String)>,
}

/// 保真度账本：哪一类信息没迁过去。只记录**源里真的出现过**的东西。
#[derive(Default)]
struct Fidelity {
    /// 没迁移的属性键（去重排序后汇总成一条 note）
    dropped: BTreeSet<String>,
    /// 用到的布局约束类键（rank / constraint / …）
    rank_like: BTreeSet<String>,
    /// 退化成默认矩形的 DOT 形状
    degraded: BTreeSet<String>,
    fixed_pos: bool,
    splines: bool,
    record: bool,
    html: bool,
    port: bool,
    multi_color: bool,
    dash: bool,
}

#[derive(Default)]
struct Graph {
    kind: Kind,
    clusters: Vec<Cluster>,
    /// 容器 → 它的 `label`（有 label 就用 label 当 D2 容器名）
    cluster_label: Vec<Option<String>>,
    /// 容器 → 容器内声明的局部 `direction`（D2 支持，DOT 只有全局 rankdir）
    cluster_dir: Vec<Option<String>>,
    /// 当前的子图栈（空 = 顶层）
    stack: Vec<usize>,
    /// 节点首次声明的顺序
    order: Vec<String>,
    /// 节点 → 首次声明时所在的容器（`None` = 顶层）
    node_container: HashMap<String, Option<usize>>,
    nodes: HashMap<String, NodeInfo>,
    edges: Vec<Edge>,
    node_defaults: Vec<(String, String)>,
    edge_defaults: Vec<(String, String)>,
    top_direction: Option<String>,
    f: Fidelity,
}

impl Graph {
    /// 记一条 DOT 属性的去向：迁得过去的放过，其余进账本。
    fn absorb_attr(&mut self, k: &str, v: &str) {
        let key = k.trim().to_ascii_lowercase();
        if matches!(key.as_str(), "color" | "fillcolor" | "fontcolor") && v.contains(':') {
            self.f.multi_color = true;
        }
        if key == "shape" {
            match map_shape(v) {
                ShapeMap::Record => self.f.record = true,
                ShapeMap::Degraded => {
                    self.f.degraded.insert(v.trim().to_string());
                }
                _ => {}
            }
        }
        if key == "style" {
            for p in style_values(&[(k.to_string(), v.to_string())]) {
                match p.as_str() {
                    // `filled` 在 D2 里是默认（容器/节点本来就是填色矩形），`rounded` 也是
                    "filled" | "rounded" | "solid" => {}
                    "dashed" | "dotted" => self.f.dash = true,
                    _ => {
                        self.f.dropped.insert("style".to_string());
                    }
                }
            }
        }
        match key.as_str() {
            "label" | "shape" | "style" | "rankdir" => {}
            "color" | "fontcolor" | "penwidth" | "fillcolor" | "fontsize" => {}
            "rank" | "constraint" | "weight" | "group" | "compound" | "lhead" | "ltail" => {
                self.f.rank_like.insert(key.clone());
                self.f.dropped.insert(key);
            }
            "pos" | "pin" => {
                self.f.fixed_pos = true;
                self.f.dropped.insert(key);
            }
            "splines" => {
                self.f.splines = true;
                self.f.dropped.insert(key);
            }
            "tailport" | "headport" => {
                self.f.port = true;
                self.f.dropped.insert(key);
            }
            _ => {
                self.f.dropped.insert(key);
            }
        }
    }

    fn absorb(&mut self, attrs: &[(String, String)]) {
        for (k, v) in attrs {
            self.absorb_attr(k, v);
        }
    }

    /// 定下节点归属：**首次提及**决定容器，但「顶层提过、后来又在容器里用到」要**升级进容器**
    /// —— 那正是 DOT 里把节点塞进 cluster 的常见写法（`start [label=…]` 写在顶层，
    /// `subgraph cluster_x { start -> check }` 写在下面；graphviz 里 start 就是 cluster 的成员）。
    /// 反方向**不改归属**：容器里的节点被顶层边提到时留在容器里，否则一条顶层边会把
    /// 容器里的节点拽出来（这正是 mermaid_to_dot 那套归属规则，两边保持同一套语义）。
    fn touch_node(&mut self, id: &str) {
        let parent = self.stack.last().copied();
        match self.node_container.get(id).copied() {
            None => {
                self.order.push(id.to_string());
                self.node_container.insert(id.to_string(), parent);
                let defaults = self.node_defaults.clone();
                self.nodes.insert(id.to_string(), NodeInfo { attrs: defaults });
            }
            // 顶层 → 容器：升级（只升不改降）
            Some(None) if parent.is_some() => {
                self.node_container.insert(id.to_string(), parent);
            }
            Some(_) => {}
        }
    }

    fn container_name(&self, idx: usize) -> String {
        self.cluster_label[idx]
            .clone()
            .unwrap_or_else(|| self.clusters[idx].name.clone())
    }

    /// 容器在 D2 里的引用路径（祖先名字用 `.` 连起来）。
    fn container_path(&self, idx: usize) -> String {
        let mut segs: Vec<String> = vec![d2_id(&self.container_name(idx))];
        let mut cur = self.clusters[idx].parent;
        while let Some(p) = cur {
            segs.push(d2_id(&self.container_name(p)));
            cur = self.clusters[p].parent;
        }
        segs.reverse();
        segs.join(".")
    }

    /// 节点在全文里的引用名：容器里的节点要写点号路径（`容器.节点`），
    /// 否则顶层那行边会造出一个新的同名节点。
    fn path_of(&self, id: &str) -> String {
        match self.node_container.get(id).copied().flatten() {
            Some(idx) => format!("{}.{}", self.container_path(idx), d2_id(id)),
            None => d2_id(id),
        }
    }

    /* ------------------------------ 输出 ------------------------------ */

    fn emit_node(&self, out: &mut String, id: &str, indent: usize) {
        let pad = "    ".repeat(indent);
        let empty: Vec<(String, String)> = Vec::new();
        let attrs = self.nodes.get(id).map(|n| &n.attrs).unwrap_or(&empty);
        if let Some(l) = attr_label(attrs) {
            let _ = writeln!(out, "{pad}{}: {}", d2_id(id), d2_str(&l));
        }
        if let Some(ShapeMap::Named(shape)) = attr_shape(attrs).as_deref().map(map_shape) {
            let _ = writeln!(out, "{pad}{}.shape: {shape}", d2_id(id));
        }
        for (k, v) in attr_styles(attrs) {
            let _ = writeln!(out, "{pad}{}.style.{k}: {v}", d2_id(id));
        }
        if is_dash(attrs) {
            let _ = writeln!(out, "{pad}{}.style.stroke-dash: 3", d2_id(id));
        }
    }

    fn emit_container(&self, out: &mut String, idx: usize, indent: usize) {
        let pad = "    ".repeat(indent);
        let _ = writeln!(out, "{pad}{}: {{", d2_id(&self.container_name(idx)));
        if let Some(dir) = &self.cluster_dir[idx] {
            let _ = writeln!(out, "{pad}    direction: {dir}");
        }
        for id in &self.order {
            if self.node_container.get(id).copied().flatten() == Some(idx) {
                self.emit_node(out, id, indent + 1);
            }
        }
        for child in &self.clusters[idx].children {
            self.emit_container(out, *child, indent + 1);
        }
        let _ = writeln!(out, "{pad}}}");
    }

    fn emit_edge(&self, out: &mut String, e: &Edge) {
        let arrow = if self.kind == Kind::Digraph { "->" } else { "--" };
        let mut line = format!("{} {arrow} {}", self.path_of(&e.from), self.path_of(&e.to));
        if let Some(l) = attr_label(&e.attrs) {
            line.push_str(&format!(": {}", d2_str(&l)));
        }
        let mut styles: Vec<String> = attr_styles(&e.attrs)
            .into_iter()
            .map(|(k, v)| format!("style.{k}: {v}"))
            .collect();
        if is_dash(&e.attrs) {
            styles.push("style.stroke-dash: 3".to_string());
        }
        if !styles.is_empty() {
            line.push_str(&format!(" {{ {} }}", styles.join("; ")));
        }
        let _ = writeln!(out, "{line}");
    }

    /// 保真度说明。口吻与 `mermaid_to_d2` 一致：逐条写清「哪一类信息没迁过去」。
    fn notes(&self) -> Vec<String> {
        let mut notes = Vec::new();
        if !self.clusters.is_empty() {
            notes.push("subgraph 映射为 D2 容器（嵌套关系保留，label 当容器名）".to_string());
        }
        for s in &self.f.degraded {
            notes.push(format!("DOT 的 `{s}` 形状在 D2 里没有对应形状，退化为默认矩形"));
        }
        if self.f.record {
            notes.push(
                "`record` / `Mrecord` 形状只保留外框：字段与端口（`<f0>` 这类引用）未迁移"
                    .to_string(),
            );
        }
        if self.f.html {
            notes.push("HTML 风格的标签（`<…>`）只取纯文本，标签与实体不迁移".to_string());
        }
        if self.f.port {
            notes.push("端口（`tailport` / `headport` / `a:port` 写法）未迁移".to_string());
        }
        if self.f.multi_color {
            notes.push("多色 `color=\"a:b\"` 列表在 D2 里只认单色：已取第一个颜色".to_string());
        }
        if !self.f.rank_like.is_empty() {
            notes.push(format!(
                "布局约束类属性（{}）未迁移：D2 没有显式的 rank / constraint",
                self.f.rank_like.iter().cloned().collect::<Vec<_>>().join(" / ")
            ));
        }
        if self.f.fixed_pos {
            notes.push("`pos` / `pin` 固定坐标未迁移（坐标由 D2 的布局引擎算）".to_string());
        }
        if self.f.splines {
            notes.push("`splines` 走线样式未迁移（走线由 D2 的布局引擎决定）".to_string());
        }
        if self.f.dash {
            notes.push("虚线（`style=dashed` / `dotted`）以 `style.stroke-dash` 表达".to_string());
        }
        if !self.f.dropped.is_empty() {
            notes.push(format!(
                "样式只迁移 color / fontcolor / penwidth / fillcolor / fontsize；其余键未迁移：{}",
                self.f.dropped.iter().cloned().collect::<Vec<_>>().join(" / ")
            ));
        }
        notes.push("版式会重新计算（DOT 的 rank/pos 约束在 D2 里没有对应物）".to_string());
        notes.dedup();
        notes
    }

    fn emit(&self) -> Conversion {
        let mut out = String::new();
        if let Some(dir) = &self.top_direction {
            let _ = writeln!(out, "direction: {dir}");
        }
        for id in &self.order {
            if self.node_container.get(id).copied().flatten().is_none() {
                self.emit_node(&mut out, id, 0);
            }
        }
        for i in 0..self.clusters.len() {
            if self.clusters[i].parent.is_none() {
                self.emit_container(&mut out, i, 0);
            }
        }
        for e in &self.edges {
            self.emit_edge(&mut out, e);
        }
        Conversion { body: out, notes: self.notes() }
    }
}

/* ------------------------------------------------------------------ 语法分析 */

struct Parser {
    toks: Vec<(Tok, usize)>,
    pos: usize,
    g: Graph,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos).map(|(t, _)| t)
    }

    fn peek_at(&self, n: usize) -> Option<&Tok> {
        self.toks.get(self.pos + n).map(|(t, _)| t)
    }

    fn line(&self) -> usize {
        self.toks
            .get(self.pos)
            .or_else(|| self.toks.last())
            .map(|(_, l)| *l)
            .unwrap_or(1)
    }

    fn bump(&mut self) -> Option<(Tok, usize)> {
        let t = self.toks.get(self.pos).cloned();
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    fn eat(&mut self, t: &Tok) -> bool {
        if self.peek() == Some(t) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn at_edge_op(&self) -> bool {
        matches!(self.peek(), Some(Tok::Arrow) | Some(Tok::Dash))
    }

    fn at_subgraph_start(&self) -> bool {
        match self.peek() {
            Some(Tok::LBrace) => true,
            Some(Tok::Id(w)) => w.eq_ignore_ascii_case("subgraph"),
            _ => false,
        }
    }

    /// `{` 直接开始，或 `subgraph {`（没名字）—— 这种是「匿名分组」，不是容器。
    fn anonymous_ahead(&self) -> bool {
        match self.peek() {
            Some(Tok::LBrace) => true,
            Some(Tok::Id(w)) if w.eq_ignore_ascii_case("subgraph") => {
                matches!(self.peek_at(1), Some(Tok::LBrace))
            }
            _ => false,
        }
    }

    /// 子图当边端点：DOT 里合法，但语义是「一整组节点对外连边」，
    /// 没法一对一到 D2 的一条边 —— 如实报错，不猜。
    fn group_operand_err(&self, line: usize, anonymous: bool) -> String {
        if anonymous {
            format!("第 {line} 行：{{…}} 这种匿名分组子图尚未支持")
        } else {
            format!("第 {line} 行：subgraph 作为边端点（`subgraph … {{ }} -> b`）尚未支持")
        }
    }

    /* ------------------------------ 头 ------------------------------ */

    fn parse_graph(mut self) -> Result<Graph, String> {
        if matches!(self.peek(), Some(Tok::Id(w)) if w.eq_ignore_ascii_case("strict")) {
            self.pos += 1;
        }
        let kind = match self.peek() {
            Some(Tok::Id(w)) if w.eq_ignore_ascii_case("digraph") => Kind::Digraph,
            Some(Tok::Id(w)) if w.eq_ignore_ascii_case("graph") => Kind::Graph,
            _ => return Err("没有找到 `digraph` / `graph` 头部".to_string()),
        };
        self.g.kind = kind;
        self.pos += 1;
        // 图名（可选）
        if matches!(self.peek(), Some(Tok::Id(_)) | Some(Tok::Str(_))) {
            self.pos += 1;
        }
        let open_line = self.line();
        if !self.eat(&Tok::LBrace) {
            return Err(format!("第 {open_line} 行：`digraph` / `graph` 后面缺少 `{{`"));
        }
        self.parse_stmt_list(open_line)?;
        match self.peek() {
            None => Ok(self.g),
            Some(Tok::RBrace) => Err(format!("第 {} 行：多余的 }}", self.line())),
            Some(_) => Err(format!("第 {} 行：`{{ … }}` 之后还有多余的内容", self.line())),
        }
    }

    /// 语句序列，直到配对的 `}`（`open_line` 是那个 `{` 的行号，没闭合时据它报错）。
    fn parse_stmt_list(&mut self, open_line: usize) -> Result<(), String> {
        loop {
            match self.peek() {
                None => return Err(format!("第 {open_line} 行：花括号没有闭合")),
                Some(Tok::RBrace) => {
                    self.pos += 1;
                    return Ok(());
                }
                Some(Tok::Semi) | Some(Tok::Comma) => self.pos += 1,
                Some(_) => self.parse_statement()?,
            }
        }
    }

    /* ------------------------------ 语句 ------------------------------ */

    fn parse_statement(&mut self) -> Result<(), String> {
        if self.at_subgraph_start() {
            let line = self.line();
            let anonymous = self.anonymous_ahead();
            self.parse_subgraph()?;
            if self.at_edge_op() {
                return Err(self.group_operand_err(line, anonymous));
            }
            return Ok(());
        }

        // 默认属性语句：`node [ … ]` / `edge [ … ]` / `graph [ … ]`
        if let Some(Tok::Id(w)) = self.peek() {
            let kw = w.to_ascii_lowercase();
            if matches!(kw.as_str(), "node" | "edge" | "graph")
                && matches!(self.peek_at(1), Some(Tok::LBracket))
            {
                self.pos += 1;
                let attrs = self.parse_attr_lists()?;
                self.apply_defaults(&kw, attrs, self.line());
                return Ok(());
            }
        }

        // 图属性赋值：`rankdir = LR` / `bgcolor = white`
        if matches!(self.peek(), Some(Tok::Id(_)) | Some(Tok::Str(_)))
            && self.peek_at(1) == Some(&Tok::Eq)
        {
            let key = match self.bump() {
                Some((Tok::Id(s), _)) | Some((Tok::Str(s), _)) => s,
                _ => unreachable!(),
            };
            self.pos += 1; // `=`
            let value = self.parse_value()?;
            self.apply_graph_attr(&key, &value);
            return Ok(());
        }

        // 其余：节点语句，或边链
        let first = self.parse_operand()?;
        if self.at_edge_op() {
            let mut prev = first;
            let mut fresh: Vec<usize> = Vec::new();
            while self.at_edge_op() {
                // `->` / `--` 只用来认出「这是条边」；画成箭头还是直线由头部（digraph/graph）定
                self.pos += 1;
                let next = self.parse_operand()?;
                let attrs = self.g.edge_defaults.clone();
                self.g.edges.push(Edge { from: prev, to: next.clone(), attrs });
                fresh.push(self.g.edges.len() - 1);
                prev = next;
            }
            if self.peek() == Some(&Tok::LBracket) {
                let attrs = self.parse_attr_lists()?;
                self.g.absorb(&attrs);
                for i in fresh {
                    merge_attrs(&mut self.g.edges[i].attrs, &attrs);
                }
            }
            Ok(())
        } else if self.peek() == Some(&Tok::LBracket) {
            let attrs = self.parse_attr_lists()?;
            self.apply_node_attrs(&first, attrs);
            Ok(())
        } else {
            // 光秃秃一个名字的节点语句（`a` 或 `a;`）：注册就够了
            Ok(())
        }
    }

    fn apply_defaults(&mut self, kind: &str, attrs: Vec<(String, String)>, _line: usize) {
        self.g.absorb(&attrs);
        match kind {
            "node" => merge_attrs(&mut self.g.node_defaults, &attrs),
            "edge" => merge_attrs(&mut self.g.edge_defaults, &attrs),
            "graph" => {
                for (k, v) in &attrs {
                    self.apply_graph_attr(k, v);
                }
            }
            _ => {}
        }
    }

    /// 图一级的属性：只有 `rankdir`（→ `direction`）与 subgraph 的 `label`（→ 容器名）有意义。
    fn apply_graph_attr(&mut self, k: &str, v: &str) {
        self.g.absorb_attr(k, v);
        match k.trim().to_ascii_lowercase().as_str() {
            "rankdir" => match d2_direction(v) {
                Some(d) => match self.g.stack.last().copied() {
                    Some(i) => self.g.cluster_dir[i] = Some(d.to_string()),
                    None => self.g.top_direction = Some(d.to_string()),
                },
                // 认不出的方向值：没有对应物，如实进账本
                None => {
                    self.g.f.dropped.insert("rankdir".to_string());
                }
            },
            "label" => match self.g.stack.last().copied() {
                Some(i) => self.g.cluster_label[i] = Some(v.to_string()),
                // 顶层图的 label 是图题，D2 那边不迁移
                None => {
                    self.g.f.dropped.insert("label".to_string());
                }
            },
            _ => {}
        }
    }

    fn apply_node_attrs(&mut self, id: &str, attrs: Vec<(String, String)>) {
        self.g.absorb(&attrs);
        let mut merged = self.g.node_defaults.clone();
        if let Some(existing) = self.g.nodes.get(id) {
            merge_attrs(&mut merged, &existing.attrs);
        }
        merge_attrs(&mut merged, &attrs);
        self.g.nodes.insert(id.to_string(), NodeInfo { attrs: merged });
    }

    /* ------------------------------ 子图 ------------------------------ */

    fn parse_subgraph(&mut self) -> Result<(), String> {
        let line = self.line();
        if matches!(self.peek(), Some(Tok::Id(w)) if w.eq_ignore_ascii_case("subgraph")) {
            self.pos += 1;
        }
        let name = match self.peek() {
            Some(Tok::Id(s)) | Some(Tok::Str(s)) => {
                let s = s.clone();
                self.pos += 1;
                s
            }
            _ => String::new(),
        };
        if !self.eat(&Tok::LBrace) {
            return Err(format!("第 {line} 行：`subgraph` 后面缺少 `{{`"));
        }
        // 没名字的 = 匿名分组：不新起容器，里面的语句仍归当前容器
        // （`{rank=same; a; b}` 与 `{a b}` 都是这一类）
        let idx = if name.is_empty() {
            None
        } else {
            let i = self.g.clusters.len();
            let parent = self.g.stack.last().copied();
            self.g.clusters.push(Cluster { name, parent, children: Vec::new() });
            self.g.cluster_label.push(None);
            self.g.cluster_dir.push(None);
            if let Some(p) = parent {
                self.g.clusters[p].children.push(i);
            }
            Some(i)
        };
        if let Some(i) = idx {
            self.g.stack.push(i);
        }
        let r = self.parse_stmt_list(line);
        if idx.is_some() {
            self.g.stack.pop();
        }
        r
    }

    /* ------------------------------ 端点与属性 ------------------------------ */

    fn parse_operand(&mut self) -> Result<String, String> {
        if self.at_subgraph_start() {
            let line = self.line();
            let anonymous = self.anonymous_ahead();
            return Err(self.group_operand_err(line, anonymous));
        }
        let line = self.line();
        let id = match self.bump() {
            Some((Tok::Id(s), _)) | Some((Tok::Str(s), _)) => s,
            Some((t, l)) => {
                return Err(format!("第 {l} 行：这里需要一个节点名，读到 `{}`", tok_text(&t)))
            }
            None => return Err(format!("第 {line} 行：语句没有写完（缺节点名）")),
        };
        // 端口写法 `a:port` / `a:port:ne`：解析掉，记一笔「没迁移」
        if self.peek() == Some(&Tok::Colon) {
            self.pos += 1;
            self.g.f.port = true;
            if matches!(self.peek(), Some(Tok::Id(_)) | Some(Tok::Str(_))) {
                self.pos += 1;
            }
            if self.peek() == Some(&Tok::Colon) {
                self.pos += 1;
                if matches!(self.peek(), Some(Tok::Id(_))) {
                    self.pos += 1;
                }
            }
        }
        self.g.touch_node(&id);
        Ok(id)
    }

    /// `[ a=b, c=d ]`，可以连着写好几组（`[a=1][b=2]`）。
    fn parse_attr_lists(&mut self) -> Result<Vec<(String, String)>, String> {
        let mut out = Vec::new();
        while self.peek() == Some(&Tok::LBracket) {
            let open_line = self.line();
            self.pos += 1;
            loop {
                match self.peek() {
                    None => return Err(format!("第 {open_line} 行：`[` 没有闭合")),
                    Some(Tok::RBracket) => {
                        self.pos += 1;
                        break;
                    }
                    Some(Tok::Semi) | Some(Tok::Comma) => self.pos += 1,
                    Some(_) => {
                        let line = self.line();
                        let key = match self.bump() {
                            Some((Tok::Id(s), _)) | Some((Tok::Str(s), _)) => s,
                            Some((t, _)) => {
                                return Err(format!(
                                    "第 {line} 行：属性名应该是名字或字符串，读到 `{}`",
                                    tok_text(&t)
                                ))
                            }
                            None => unreachable!(),
                        };
                        if !self.eat(&Tok::Eq) {
                            return Err(format!("第 {line} 行：属性 `{key}` 后面缺少 `=`"));
                        }
                        let value = self.parse_value()?;
                        out.push((key, value));
                    }
                }
            }
        }
        Ok(out)
    }

    /// 属性值：名字 / 字符串 / HTML（`+` 拼接也认，DOT 用它拼多行标签）。
    fn parse_value(&mut self) -> Result<String, String> {
        let (mut v, mut html) = self.parse_value_atom()?;
        while self.peek() == Some(&Tok::Plus) {
            self.pos += 1;
            let (tail, tail_html) = self.parse_value_atom()?;
            v.push_str(&tail);
            html |= tail_html;
        }
        if html {
            self.g.f.html = true;
        }
        Ok(v)
    }

    fn parse_value_atom(&mut self) -> Result<(String, bool), String> {
        let line = self.line();
        match self.bump() {
            Some((Tok::Id(s), _)) | Some((Tok::Str(s), _)) => Ok((s, false)),
            Some((Tok::Html(s), _)) => Ok((strip_html(&s), true)),
            Some((t, l)) => Err(format!(
                "第 {l} 行：属性值应该是一个名字或字符串，读到 `{}`",
                tok_text(&t)
            )),
            None => Err(format!("第 {line} 行：属性值缺了")),
        }
    }
}

/* ------------------------------------------------------------------ 入口 */

/// DOT → D2。
///
/// 迁过去的是**结构**：节点、边、subgraph（→ 容器）、`rankdir`（→ `direction`）、
/// 形状与那五个样式键。DOT 的版式是算出来的，D2 把它交给布局引擎 ——
/// 丢掉的每一样都在 `notes` 里写明。
pub fn dot_to_d2(src: &str) -> Result<Conversion, String> {
    let toks = lex(src)?;
    let p = Parser { toks, pos: 0, g: Graph::default() };
    p.parse_graph().map(|g| g.emit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conv(src: &str) -> Conversion {
        dot_to_d2(src).unwrap()
    }

    fn err(src: &str) -> String {
        dot_to_d2(src).unwrap_err()
    }

    /// 最小输入：没有 rankdir 就不写 `direction`，没有属性的节点不占行。
    #[test]
    fn minimal_graph_emits_exactly_the_edge() {
        let c = conv("digraph G { a -> b }");
        assert_eq!(c.body, "a -> b\n");
        assert!(!c.body.contains("direction"), "{}", c.body);
        assert!(c.notes.iter().any(|n| n.contains("版式会重新计算")), "{:?}", c.notes);
    }

    #[test]
    fn rankdir_maps_and_absent_rankdir_omits_direction() {
        assert_eq!(conv("digraph G { rankdir=LR; a -> b }").body.lines().next().unwrap(), "direction: right");
        assert_eq!(conv("digraph G { rankdir = TB\n a -> b }").body.lines().next().unwrap(), "direction: down");
        assert_eq!(conv("digraph G { rankdir=BT; a -> b }").body.lines().next().unwrap(), "direction: up");
        assert_eq!(conv("digraph G { rankdir=RL; a -> b }").body.lines().next().unwrap(), "direction: left");
        // `graph [rankdir=…]` 与裸赋值等价
        assert_eq!(
            conv("digraph G { graph [rankdir=LR]; a -> b }").body.lines().next().unwrap(),
            "direction: right"
        );
        assert!(!conv("digraph G { a -> b }").body.contains("direction"));
        // 认不出的方向值：不瞎猜一个方向，记进账本
        let c = conv("digraph G { rankdir=XX; a -> b }");
        assert!(!c.body.contains("direction"), "{}", c.body);
        assert!(c.notes.iter().any(|n| n.contains("rankdir")), "{:?}", c.notes);
    }

    #[test]
    fn chain_edges_carry_the_label_to_every_hop() {
        let c = conv(r#"digraph G { a -> b -> c [label="下一步"] }"#);
        assert!(c.body.contains(r#"a -> b: "下一步""#), "{}", c.body);
        assert!(c.body.contains(r#"b -> c: "下一步""#), "{}", c.body);
    }

    #[test]
    fn undirected_graph_uses_double_dash() {
        let c = conv("graph G { a -- b }");
        assert_eq!(c.body, "a -- b\n");
        let c = conv("strict graph G { a -- b -- c }");
        assert!(c.body.contains("a -- b") && c.body.contains("b -- c"), "{}", c.body);
    }

    #[test]
    fn node_shape_and_default_node_attrs() {
        let c = conv("digraph G { node [shape=cylinder]; a; b [shape=box]; c [shape=diamond] }");
        assert!(c.body.contains("a.shape: cylinder"), "{}", c.body);
        // box 就是 D2 的默认矩形，不写字形行
        assert!(!c.body.contains("b.shape"), "{}", c.body);
        assert!(c.body.contains("c.shape: diamond"), "{}", c.body);
        assert!(!c.body.contains("a: \"a\""), "没有 label 的节点不该凭空多出标签：{}", c.body);
    }

    #[test]
    fn default_node_style_rounds_and_fills_silently() {
        let c = conv(r#"digraph G { node [shape=box, style="rounded,filled"]; a [label="甲"] }"#);
        assert!(c.body.contains(r#"a: "甲""#), "{}", c.body);
        assert!(!c.body.contains("style."), "{}", c.body);
        assert!(!c.notes.iter().any(|n| n.contains("其余键未迁移")), "{:?}", c.notes);
    }

    #[test]
    fn dashed_style_becomes_stroke_dash() {
        let c = conv("digraph G { a -> b [style=dashed]; c [style=dotted] }");
        assert!(c.body.contains("a -> b { style.stroke-dash: 3 }"), "{}", c.body);
        assert!(c.body.contains("c.style.stroke-dash: 3"), "{}", c.body);
    }

    #[test]
    fn mapped_style_keys_and_multicolor_note() {
        let c = conv(r##"digraph G { a -> b [color="#f00", penwidth=2, fontcolor=blue] }"##);
        assert!(c.body.contains(r##"style.stroke: "#f00""##), "{}", c.body);
        // 数字类的键裸写：`stroke-width: "2"` 在 D2 里是字符串，不是长度
        assert!(c.body.contains("style.stroke-width: 2"), "{}", c.body);
        assert!(c.body.contains(r#"style.font-color: "blue""#), "{}", c.body);

        let c = conv(r#"digraph G { a -> b [color="red:blue"] }"#);
        assert!(c.body.contains(r#"style.stroke: "red""#), "{}", c.body);
        assert!(c.notes.iter().any(|n| n.contains("多色")), "{:?}", c.notes);
    }

    #[test]
    fn dir_none_keeps_arrow_and_reports_dir_as_dropped() {
        let c = conv("digraph G { a -> b [dir=none] }");
        assert!(c.body.contains("a -> b"), "{}", c.body);
        assert!(c.notes.iter().any(|n| n.contains("dir")), "{:?}", c.notes);
    }

    #[test]
    fn node_label_escapes_become_newlines() {
        let c = conv("digraph G { a [label=\"第一行\\n第二行\"] }");
        assert!(c.body.contains(r#"a: "第一行\n第二行""#), "{}", c.body);
    }

    #[test]
    fn subgraph_cluster_becomes_a_container_named_by_its_label() {
        let c = conv(
            r#"digraph G {
                subgraph cluster_x {
                    label="集成层";
                    gateway [label="网关"];
                    subgraph cluster_y { label="存储"; db [shape=cylinder] }
                }
            }"#,
        );
        assert!(c.body.contains("集成层: {"), "{}", c.body);
        assert!(c.body.contains(r#"    gateway: "网关""#), "{}", c.body);
        // 嵌套子图照样嵌着，缩进 4 空格一层
        assert!(c.body.contains("    存储: {"), "{}", c.body);
        assert!(c.body.contains("        db.shape: cylinder"), "{}", c.body);
    }

    #[test]
    fn subgraph_without_cluster_prefix_is_a_container_too() {
        let c = conv("digraph G { subgraph 甲 { a } }");
        assert!(c.body.contains("甲: {"), "{}", c.body);
    }

    #[test]
    fn nested_node_is_referenced_by_its_dot_path_from_a_top_level_edge() {
        let c = conv(
            r#"digraph G {
                subgraph cluster_x { label="集成层"; gateway [label="网关"] }
                gateway -> log
            }"#,
        );
        assert!(c.body.contains("集成层.gateway -> log"), "{}", c.body);
        // 节点还是留在容器里（不然顶层那条边会造出一个新的同名人）
        let container_at = c.body.find("集成层: {").unwrap();
        let edge_at = c.body.find("集成层.gateway -> log").unwrap();
        assert!(container_at < edge_at, "边必须在容器之后（一律写在全文件末尾）：{}", c.body);
        assert!(c.body.contains(r#"    gateway: "网关""#), "{}", c.body);
    }

    #[test]
    fn deep_nesting_builds_a_multi_segment_path() {
        let c = conv(
            r#"digraph G {
                subgraph cluster_a { label="外";
                    subgraph cluster_b { label="内"; x [label="X"] }
                }
                x -> y
            }"#,
        );
        assert!(c.body.contains("外.内.x -> y"), "{}", c.body);
    }

    /// 先在顶层声明、后在 subgraph 里用到的节点**归入容器** —— 这是 DOT 里最常见的
    /// 「把已有节点塞进 cluster」的写法，graphviz 也这么认。反方向不成立（见上一条）。
    #[test]
    fn a_top_level_node_used_inside_a_subgraph_joins_it() {
        let c = conv(
            r#"digraph G {
                start [label="开始"];
                check [label="检查"];
                subgraph cluster_flow { label="主流程"; start -> check }
                check -> done [label="完成"];
            }"#,
        );
        assert!(c.body.contains("主流程: {"), "{}", c.body);
        // 两个节点被移进容器，边改用点号路径
        assert!(c.body.contains(r#"    start: "开始""#), "{}", c.body);
        assert!(c.body.contains("主流程.start -> 主流程.check"), "{}", c.body);
        // 容器外的 done 仍是顶层节点，跨容器的边也用具名路径
        assert!(c.body.contains("主流程.check -> done"), "{}", c.body);
        assert!(!c.body.contains("    done:"), "done 不属于容器：{}", c.body);
    }

    #[test]
    fn comments_of_all_three_kinds_are_ignored() {
        let src = "digraph G {\n // 行注释\n # 另一种行注释\n /* 块注释\n    跨了两行 */\n a -> b\n}";
        let c = conv(src);
        assert_eq!(c.body, "a -> b\n");
        let c = conv("digraph G { /****/ a -> b /* 尾随 */ }");
        assert_eq!(c.body, "a -> b\n");
    }

    #[test]
    fn quoted_hash_is_a_value_not_a_comment() {
        let c = conv(r##"digraph G { a [fillcolor="#0f0", label="井#号"] }"##);
        assert!(c.body.contains(r##"a.style.fill: "#0f0""##), "{}", c.body);
        assert!(c.body.contains(r#"a: "井#号""#), "{}", c.body);
    }

    #[test]
    fn key_equals_value_with_spaces_round_bare_ids() {
        let c = conv("digraph G { a [ label = 起点 , shape = ellipse ] }");
        assert!(c.body.contains(r#"a: "起点""#), "{}", c.body);
        assert!(c.body.contains("a.shape: oval"), "{}", c.body);
    }

    #[test]
    fn semicolon_and_newline_both_separate_statements() {
        let a = conv("digraph G {\n a [label=\"甲\"]\n b [label=\"乙\"]\n a -> b\n}");
        let b = conv("digraph G { a [label=\"甲\"]; b [label=\"乙\"]; a -> b }");
        assert_eq!(a.body, b.body);
    }

    #[test]
    fn notes_are_raised_only_for_what_the_source_used() {
        let clean = conv("digraph G { a -> b [label=\"干净\"] }");
        for n in &clean.notes {
            assert!(
                n.contains("版式会重新计算"),
                "没用到的特性不该进 notes：{n}"
            );
        }

        let c = conv(
            r#"digraph G {
                rankdir=LR;
                {rank=same; a; b}
                splines=ortho;
                a [shape=record, label="<f0>甲|<f1>乙"];
                b [pos="1,2!", pin=true];
                a -> b [tailport=f0, weight=2, constraint=false]
            }"#,
        );
        for want in ["rank", "constraint", "pos", "record", "splines", "tailport", "版式会重新计算"] {
            assert!(
                c.notes.iter().any(|n| n.contains(want)),
                "notes 里少了 {want}：{:?}",
                c.notes
            );
        }
        // 默认矩形兜底：record 不假装形状还在
        assert!(!c.body.contains("a.shape"), "{}", c.body);
    }

    #[test]
    fn dropped_keys_are_aggregated_sorted_and_deduped() {
        let c = conv("digraph G { a [shape=box, fontname=Helvetica, bgcolor=white]; a -> b [fontname=Helvetica] }");
        let note = c
            .notes
            .iter()
            .find(|n| n.contains("其余键未迁移"))
            .unwrap_or_else(|| panic!("{:?}", c.notes));
        assert!(note.contains("bgcolor / fontname"), "{note}");
        assert_eq!(note.matches("fontname").count(), 1, "重复的键只写一次：{note}");
    }

    #[test]
    fn degraded_shapes_are_noted() {
        let c = conv("digraph G { a [shape=note]; b [shape=folder] }");
        assert!(c.notes.iter().any(|n| n.contains("note")), "{:?}", c.notes);
        assert!(c.notes.iter().any(|n| n.contains("folder")), "{:?}", c.notes);
        assert!(!c.body.contains(".shape"), "退化后就是默认矩形：{}", c.body);
    }

    #[test]
    fn html_label_is_flattened_to_text() {
        let c = conv("digraph G { a [label=<<b>粗</b>与<BR/>细>] }");
        assert!(c.body.contains(r#"a: "粗与细""#), "{}", c.body);
        assert!(c.notes.iter().any(|n| n.contains("HTML")), "{:?}", c.notes);
    }

    #[test]
    fn edge_defaults_apply_to_edges_without_their_own() {
        let c = conv(r#"digraph G { edge [color=red]; a -> b; c -> d [color=blue] }"#);
        assert!(c.body.contains(r#"a -> b { style.stroke: "red" }"#), "{}", c.body);
        assert!(c.body.contains(r#"c -> d { style.stroke: "blue" }"#), "{}", c.body);
    }

    #[test]
    fn errors_carry_the_line_number() {
        assert_eq!(err("flowchart TD\n a -> b"), "没有找到 `digraph` / `graph` 头部");
        assert_eq!(err(""), "没有找到 `digraph` / `graph` 头部");

        let e = err("digraph G { a -> b");
        assert!(e.contains("第 1 行") && e.contains("花括号没有闭合"), "{e}");

        let e = err("digraph G {\n subgraph cluster_x {\n a -> b\n}");
        // 那一个 `}` 配的是内层 subgraph，没闭合的是**外层**（第 1 行）
        assert!(e.contains("第 1 行") && e.contains("花括号没有闭合"), "{e}");

        let e = err("digraph G {\n a -> b\n subgraph cluster_x {\n");
        assert!(e.contains("第 3 行") && e.contains("花括号没有闭合"), "{e}");

        let e = err("digraph G { a -> b } }");
        assert!(e.contains("第 1 行") && e.contains("多余的 }"), "{e}");

        let e = err("digraph G {\n a [label=\"没闭合\n}");
        assert!(e.contains("第 2 行") && e.contains("没有闭合"), "{e}");

        let e = err("digraph G {\n {a b} -> c\n}");
        assert!(e.contains("第 2 行") && e.contains("匿名分组子图尚未支持"), "{e}");

        let e = err("digraph G { a -> }");
        assert!(e.contains("第 1 行") && e.contains("节点名"), "{e}");
    }

    #[test]
    fn missing_brace_after_header_is_reported() {
        let e = err("digraph G\n a -> b\n}");
        assert!(e.contains("缺少") || e.contains("多余的 }"), "{e}");
    }

    #[test]
    fn anonymous_group_without_edges_is_tolerated() {
        // `{rank=same; a; b}` 是合法 DOT：不新起容器，里面的节点仍归当前容器
        let c = conv("digraph G { {rank=same; a; b} a -> b }");
        assert!(c.body.contains("a -> b"), "{}", c.body);
        assert!(!c.body.contains(": {"), "匿名分组不该变成容器：{}", c.body);
        assert!(c.notes.iter().any(|n| n.contains("rank")), "{:?}", c.notes);
    }

    #[test]
    fn only_one_container_level_for_subgraph_rankdir() {
        let c = conv("digraph G { rankdir=LR; subgraph cluster_x { label=\"甲\"; rankdir=TB; a } }");
        assert_eq!(c.body.lines().next().unwrap(), "direction: right");
        // 顶层容器不缩进，它的局部 direction 缩进一层
        assert!(c.body.contains("\n甲: {"), "{}", c.body);
        assert!(c.body.contains("    direction: down"), "{}", c.body);
    }

    /// 接线检查：`convert.rs::convert(Dot, D2, …)` 直接调这里。
    /// 「不是 digraph/graph 头部」「花括号不闭合」这类错必须**由本模块自己报** ——
    /// `plan(Dot, D2)` 只回答「谁做」，拦不住坏源码。
    #[test]
    fn dispatch_calls_this_module_and_its_errors_surface() {
        use app_ipc::FormatId::*;
        let ok = crate::convert::convert(Dot, D2, "digraph G { rankdir=LR; a -> b }").unwrap();
        assert!(ok.body.contains("direction: right"), "{}", ok.body);
        assert_eq!(
            crate::convert::convert(Dot, D2, "flowchart TD\n a -> b").unwrap_err(),
            "没有找到 `digraph` / `graph` 头部"
        );
        let e = crate::convert::convert(Dot, D2, "digraph G { a -> b").unwrap_err();
        assert!(e.contains("花括号没有闭合"), "{e}");
    }
}
