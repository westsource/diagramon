//! 格式转换：Mermaid → DOT（纯 Rust）。
//!
//! 另外两个方向（Mermaid → drawio / Excalidraw）**不在这里**：它们由各自的引擎自己解析
//! （drawio 有 `js/mermaid/drawio-mermaid`，Excalidraw 有 `mermaid-to-excalidraw`），
//! 前端把源码交给承载页、再把结果取回来即可。理由见 design/ui-proto/index.html §9.1：
//! 库型转换的上游是 JS 库，进不了 Rust；重新实现一遍只会得到两个不一致的解析器。
//!
//! ## 保真度
//!
//! 转换是**单向且有损**的，所以这里刻意返回 [`Conversion`] 而不是裸字符串：
//! `notes` 里逐条写明「丢了什么」，界面照它展示（转换记录里注明「样式未迁移」，不静默丢）。
//! 这是路线图里的 P2 决策。
//!
//! 支持的是 Mermaid flowchart 的**常用子集**：节点四类形状、带/不带标签的六种边、
//! subgraph、classDef/class/style、direction、`%%` 注释。序列图 / 状态图 / 甘特等
//! 不在范围内 —— 遇到不认识的头部会明确报错，不猜。

use std::collections::HashMap;
use std::fmt::Write as _;

use crate::d2syntax::{d2_id, d2_str};

/// 一次转换的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversion {
    /// 目标格式的正文。
    pub body: String,
    /// 保真度说明：逐条写清「哪一类信息没迁移过去」。
    pub notes: Vec<String>,
}

/* ------------------------------------------------------------------ 中间表示 */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Family {
    Solid,
    Dotted,
    Thick,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Link {
    family: Family,
    /// 带箭头（`-->`）还是不带（`---`）
    arrow: bool,
    label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Operand {
    id: String,
    label: Option<String>,
    shape: Shape,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shape {
    Box,
    Rounded,
    Stadium,
    Subroutine,
    Cylinder,
    Hexagon,
    Circle,
    Diamond,
    Asymmetric,
}

impl Shape {
    /// DOT 里等价的 `shape` / `style`。
    ///
    /// 没有直接对应的形状退化为最接近的一个，并由 `notes` 说明 —— 不假装形状还在。
    fn dot_attrs(self) -> &'static str {
        match self {
            Shape::Box => "shape=box",
            Shape::Rounded => "shape=box, style=\"rounded\"",
            // 体育场形 DOT 没有；退化成圆角框
            Shape::Stadium => "shape=box, style=\"rounded\"",
            Shape::Subroutine => "shape=box3d",
            Shape::Cylinder => "shape=cylinder",
            Shape::Hexagon => "shape=hexagon",
            Shape::Circle => "shape=circle",
            Shape::Diamond => "shape=diamond",
            // 非对称形 DOT 没有；退化成普通框
            Shape::Asymmetric => "shape=box",
        }
    }

    /// D2 里等价的形状。`None` = D2 的默认矩形（不必写 `shape` 属性）。
    ///
    /// 与 DOT 一样：没有对应形状的**退化**最接近的一个，并由 `notes` 说明 —— 不假装形状还在。
    fn d2_shape(self) -> Option<&'static str> {
        match self {
            // D2 的 rectangle 自带圆角，`[文本]` 与 `(文本)` 落到同一个形状
            Shape::Box | Shape::Rounded => None,
            // 体育场形 D2 没有；退化
            Shape::Stadium => Some("oval"),
            // 子程序框 D2 没有；退化
            Shape::Subroutine => Some("page"),
            Shape::Cylinder => Some("cylinder"),
            Shape::Hexagon => Some("hexagon"),
            Shape::Circle => Some("circle"),
            Shape::Diamond => Some("diamond"),
            // 非对称形 D2 没有；退化
            Shape::Asymmetric => Some("callout"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Stmt {
    Direction(String),
    SubgraphOpen(String),
    SubgraphClose,
    /// 一条链：操作数与连接件交替，`operands.len() == links.len() + 1`
    Chain { operands: Vec<Operand>, links: Vec<Link> },
    ClassDef { name: String, style: String },
    ClassAssign { name: String, ids: Vec<String> },
    StyleAssign { id: String, style: String },
    /// 认得但这一步不迁移（`click` / `linkStyle` / `classDef` 之外的指令）
    Ignored,
}

/* ------------------------------------------------------------------ 解析 */

fn parse(src: &str) -> Result<(String, Vec<Stmt>), String> {
    let mut direction: Option<String> = None;
    let mut stmts = Vec::new();
    let mut saw_header = false;

    for (idx, raw) in src.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with("%%") {
            continue;
        }

        // 头部：flowchart TD / graph LR / flowchart LR
        if !saw_header {
            let mut it = line.split_whitespace();
            match (it.next(), it.next()) {
                (Some("flowchart") | Some("graph"), Some(dir)) => {
                    saw_header = true;
                    direction = Some(map_direction(dir)?);
                    continue;
                }
                (Some(other), _) => {
                    return Err(format!(
                        "第 {} 行：只支持 Mermaid flowchart（当前是「{other}」）。序列图 / 状态图 / 类图等不在转换范围内",
                        idx + 1
                    ));
                }
                _ => {}
            }
        }

        // 一条语句可能以 `;` 结尾，甚至一行里放多条
        for piece in split_statements(line) {
            if let Some(stmt) = parse_stmt(&piece, idx + 1)? {
                stmts.push(stmt);
            }
        }
    }

    if !saw_header {
        return Err("没有找到 `flowchart` / `graph` 头部，无法判定图的方向".into());
    }
    Ok((direction.unwrap_or_else(|| "TB".into()), stmts))
}

/// 按 `;` 拆（mermaid 允许 `A --> B; B --> C;`）。
/// 引号内的 `;` 不动 —— 标签里出现分号是合法的。
fn split_statements(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote: Option<char> = None;
    let mut in_pipe = false;
    for c in line.chars() {
        if let Some(q) = in_quote {
            cur.push(c);
            if c == q {
                in_quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => {
                in_quote = Some(c);
                cur.push(c);
            }
            '|' => {
                in_pipe = !in_pipe;
                cur.push(c);
            }
            ';' if !in_pipe => {
                if !cur.trim().is_empty() {
                    out.push(cur.trim().to_string());
                }
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

fn map_direction(dir: &str) -> Result<String, String> {
    Ok(match dir.to_ascii_uppercase().as_str() {
        // Mermaid 的 TD（top-down）与 DOT 的 TB 是同一个意思
        "TD" | "TB" => "TB",
        "BT" => "BT",
        "LR" => "LR",
        "RL" => "RL",
        other => return Err(format!("不认识的布局方向「{other}」（支持 TD/TB/BT/LR/RL）")),
    }
    .to_string())
}

fn parse_stmt(text: &str, line_no: usize) -> Result<Option<Stmt>, String> {
    let t = text.trim().trim_end_matches(';').trim();
    if t.is_empty() {
        return Ok(None);
    }

    if t == "end" {
        return Ok(Some(Stmt::SubgraphClose));
    }
    if let Some(rest) = t.strip_prefix("subgraph") {
        let name = rest.trim().trim_matches('"').trim().to_string();
        return Ok(Some(Stmt::SubgraphOpen(name)));
    }
    if let Some(rest) = t.strip_prefix("direction ") {
        return Ok(Some(Stmt::Direction(map_direction(rest.trim())?)));
    }
    if let Some(rest) = t.strip_prefix("classDef ") {
        let (name, style) = split_once_ws(rest);
        return Ok(Some(Stmt::ClassDef { name, style }));
    }
    if let Some(rest) = t.strip_prefix("class ") {
        let (name, ids) = match rest.rsplit_once(' ') {
            Some((ids, name)) => (name.to_string(), ids.to_string()),
            None => return Ok(Some(Stmt::Ignored)),
        };
        return Ok(Some(Stmt::ClassAssign {
            name,
            ids: ids.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
        }));
    }
    if let Some(rest) = t.strip_prefix("style ") {
        // 别把 `style --> B` 当成 style 语句（节点叫 style 也是合法的）
        if !rest.starts_with(['-', '=']) {
            let (id, style) = split_once_ws(rest);
            if !style.is_empty() {
                return Ok(Some(Stmt::StyleAssign { id, style }));
            }
        }
    }
    // 认得但不迁移的指令：不报错，也不假装迁移了
    if t.starts_with("click ")
        || t.starts_with("linkStyle")
        || t.starts_with("accTitle")
        || t.starts_with("accDescr")
    {
        return Ok(Some(Stmt::Ignored));
    }

    // `A & B --> C` 的多源/多目标：宁可明确报错，也不要静默只取第一个 ——
    // 那样用户会得到一张少了一半连线的图，还以为转换成功了。
    if t.contains('&') {
        return Err(format!(
            "第 {line_no} 行：`&` 多源/多目标语法尚未支持（请拆成多条边再转）"
        ));
    }

    let (operands, links, leftover) = parse_chain(t)
        .ok_or_else(|| format!("第 {line_no} 行：看不懂的语句「{}」", truncate(t, 60)))?;
    if leftover {
        return Err(format!(
            "第 {line_no} 行：语句尾部有没解析完的内容「{}」",
            truncate(t, 60)
        ));
    }
    Ok(Some(Stmt::Chain { operands, links }))
}

fn split_once_ws(s: &str) -> (String, String) {
    match s.find(char::is_whitespace) {
        Some(i) => (s[..i].trim().to_string(), s[i..].trim().to_string()),
        None => (s.trim().to_string(), String::new()),
    }
}

fn truncate(s: &str, n: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= n {
        s.to_string()
    } else {
        format!("{}…", chars[..n].iter().collect::<String>())
    }
}

/// `A([开始]) --> B{判断} -- 否 --> C` → 操作数与连接件交替。
fn parse_chain(text: &str) -> Option<(Vec<Operand>, Vec<Link>, bool)> {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    let mut operands = Vec::new();
    let mut links = Vec::new();

    loop {
        i = skip_ws(bytes, i);
        let (op, ni) = parse_operand(text, i)?;
        i = ni;
        operands.push(op);

        let save = i;
        i = skip_ws(bytes, i);
        match parse_link(text, i) {
            Some((link, ni)) => {
                links.push(link);
                i = ni;
            }
            None => {
                i = save;
                break;
            }
        }
    }

    if operands.len() != links.len() + 1 {
        return None;
    }
    // 尾部还有内容 ⇒ 没解析干净，交给调用方报错（别静默丢掉）
    Some((operands, links, !text[i..].trim().is_empty()))
}

fn skip_ws(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && (bytes[i] as char).is_whitespace() {
        i += 1;
    }
    i
}

/// id 里的普通字符（**不含 `-`**）。
///
/// `-` 太容易和箭头撞（`A-->B` 没有空格也合法），所以按「试一下」处理：
/// 先读普通字符，遇到 `-` 时看它后面能不能解析成箭头 —— 能就是箭头，不能就当 id 的一部分。
fn is_id_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '.' || c == '$'
}

/// 操作数：`id` 或 `id[标签]` / `id(标签)` / `id([标签])` / …
fn parse_operand(text: &str, start: usize) -> Option<(Operand, usize)> {
    let chars: Vec<char> = text.chars().collect();
    // 把字节下标换成字符下标（下面全程按字符走）
    let mut ci = text[..start].chars().count();
    if ci >= chars.len() {
        return None;
    }

    // `&` 分隔的多源/多目标：只取第一个，其余交给调用方继续解析（会被忽略并计入 notes）
    if chars[ci] == '&' {
        ci += 1;
    }

    let id_start = ci;
    loop {
        while ci < chars.len() && is_id_char(chars[ci]) {
            ci += 1;
        }
        // `-`：是箭头的一部分，还是 id 里的连字符？
        if ci < chars.len() && chars[ci] == '-' {
            let bi = char_to_byte(text, ci);
            if parse_link(text, bi).is_some() {
                break; // 后面是箭头
            }
            ci += 1; // 当作 id 的一部分，继续读
            continue;
        }
        break;
    }
    if ci == id_start {
        return None;
    }
    let id: String = chars[id_start..ci].iter().collect();

    // 裸 id（subgraph 里常见：单独一行的 `L`）
    if ci >= chars.len() || !matches!(chars[ci], '[' | '(' | '{' | '>') {
        return Some((
            Operand {
                id,
                label: None,
                shape: Shape::Box,
            },
            char_to_byte(text, ci),
        ));
    }

    // 形状：先试双字符开头（([、[[、[、((、{{、[(），注意顺序
    let rest: String = chars[ci..].iter().collect();
    let (open_len, close, shape) = if rest.starts_with("([") {
        (2, "])", Shape::Stadium)
    } else if rest.starts_with("[[") {
        (2, "]]", Shape::Subroutine)
    } else if rest.starts_with("[(") {
        (2, ")]", Shape::Cylinder)
    } else if rest.starts_with("((") {
        (2, "))", Shape::Circle)
    } else if rest.starts_with("{{") {
        (2, "}}", Shape::Hexagon)
    } else {
        match chars[ci] {
            '[' => (1, "]", Shape::Box),
            '(' => (1, ")", Shape::Rounded),
            '{' => (1, "}", Shape::Diamond),
            '>' => (1, "]", Shape::Asymmetric),
            _ => return None,
        }
    };

    let inner_start = ci + open_len;
    // 找闭合串（从内层最先出现处收；不做括号配平 —— mermaid 标签里的括号必须用引号包起来）
    let tail: String = chars[inner_start..].iter().collect();
    // 注意：`find` 给的是**字节**下标，而这里的游标 `ci` 是**字符**下标。
    // 中文一个字符 3 字节，混用会直接错位（踩过：整条语句被判成「尾部有没解析完的内容」）。
    let close_at = tail.find(close)?;
    let label_raw = &tail[..close_at];
    let label = strip_one_quote_pair(label_raw.trim()).to_string();
    let next_ci = inner_start + tail[..close_at + close.len()].chars().count();

    Some((
        Operand {
            id,
            label: if label.is_empty() { None } else { Some(label) },
            shape,
        },
        char_to_byte(text, next_ci),
    ))
}

/// 两端**各剥一个**引号。
///
/// 不能用 `trim_matches`：那样 `["说了""]` 这类标签里本来就有的引号会被一起吃掉，
/// 只剩一个半截标签。
fn strip_one_quote_pair(s: &str) -> &str {
    for q in ['"', '\''] {
        if s.len() >= 2 && s.starts_with(q) && s.ends_with(q) {
            return &s[q.len_utf8()..s.len() - q.len_utf8()];
        }
    }
    s
}

/// 字符下标 → 字节下标。
fn char_to_byte(text: &str, ci: usize) -> usize {
    text.char_indices().nth(ci).map(|(b, _)| b).unwrap_or(text.len())
}

/// 连接件：`-->` / `---` / `-.->` / `-.-` / `==>` / `===`，以及带内联标签的
/// `-- 是 -->` / `-. 是 .->` / `== 是 ==>`，还有 `-->|是|`。
fn parse_link(text: &str, start: usize) -> Option<(Link, usize)> {
    let rest = &text[start..];
    if !rest.starts_with('-') && !rest.starts_with('=') {
        return None;
    }

    // 1) 先试无标签的整token（长的优先，否则 `-->` 会被 `--` 抢走）
    for (tok, family, arrow) in [
        ("-.->", Family::Dotted, true),
        ("-.-", Family::Dotted, false),
        ("-->", Family::Solid, true),
        ("---", Family::Solid, false),
        ("==>", Family::Thick, true),
        ("===", Family::Thick, false),
    ] {
        if let Some(after) = rest.strip_prefix(tok) {
            // 后面可能跟 `|标签|`
            let (label, used) = parse_pipe_label(after);
            return Some((
                Link { family, arrow, label },
                start + tok.len() + used,
            ));
        }
    }

    // 2) 带内联标签：`-- text -->` / `-. text .->` / `== text ==>`（也允许无箭头的收尾）
    let (lead, family, closers): (&str, Family, [&str; 2]) = if rest.starts_with("-.") {
        ("-.", Family::Dotted, [".->", ".-"])
    } else if rest.starts_with("==") {
        ("==", Family::Thick, ["==>", "=="])
    } else if rest.starts_with("--") {
        ("--", Family::Solid, ["-->", "--"])
    } else {
        return None;
    };

    let body = &rest[lead.len()..];
    // 取最早出现的收尾符（有箭头的那个优先，避免 `-->` 里的 `--` 抢先）
    let mut best: Option<(usize, &str)> = None;
    for c in closers {
        if let Some(at) = body.find(c) {
            match best {
                Some((b, _)) if b <= at => {}
                _ => best = Some((at, c)),
            }
        }
    }
    let (at, closer) = best?;
    let label = body[..at].trim().trim_matches('"').trim_matches('\'').trim();
    let used = lead.len() + at + closer.len();
    Some((
        Link {
            family,
            arrow: closer.ends_with('>'),
            label: (!label.is_empty()).then(|| label.to_string()),
        },
        start + used,
    ))
}

/// `|标签|` → (标签, 消耗的字节数)
fn parse_pipe_label(s: &str) -> (Option<String>, usize) {
    let t = s.trim_start();
    let skipped = s.len() - t.len();
    if !t.starts_with('|') {
        return (None, 0);
    }
    match t[1..].find('|') {
        Some(at) => {
            let label = t[1..1 + at].trim().to_string();
            (Some(label), skipped + 1 + at + 1)
        }
        None => (None, 0),
    }
}

/* ------------------------------------------------------------------ 样式 */

/// Mermaid 的样式串 → DOT 属性。返回 (属性, 丢弃的键)。
///
/// 只迁移**语义明确、DOT 有对应项**的四个键；其余如实记进 notes，
/// 而不是塞进 DOT 里当无效属性（那样看起来像迁移了，其实没有）。
fn style_to_dot(style: &str) -> (Vec<String>, Vec<String>) {
    let mut attrs = Vec::new();
    let mut dropped = Vec::new();
    let mut filled = false;
    let mut dashed = false;

    for pair in style.split(',') {
        let pair = pair.trim();
        if pair.is_empty() {
            continue;
        }
        let Some((k, v)) = pair.split_once(':') else {
            dropped.push(pair.to_string());
            continue;
        };
        let (k, v) = (k.trim(), v.trim());
        match k {
            "fill" => {
                filled = true;
                attrs.push(format!("fillcolor=\"{}\"", esc_attr(v)));
            }
            "stroke" => attrs.push(format!("color=\"{}\"", esc_attr(v))),
            "color" => attrs.push(format!("fontcolor=\"{}\"", esc_attr(v))),
            "stroke-width" => {
                let n = v.trim_end_matches("px").trim();
                attrs.push(format!("penwidth={n}"));
            }
            "stroke-dasharray" => dashed = true,
            "fill-opacity" | "stroke-opacity" | "opacity" => dropped.push(k.to_string()),
            other => dropped.push(other.to_string()),
        }
    }

    // DOT 的 style 是一个整体，filled / dashed / solid 要合成一个属性
    let mut styles: Vec<&str> = Vec::new();
    if filled {
        styles.push("filled");
    }
    if dashed {
        styles.push("dashed");
    }
    if !styles.is_empty() {
        attrs.push(format!("style=\"{}\"", styles.join(",")));
    }

    dropped.sort();
    dropped.dedup();
    (attrs, dropped)
}

fn esc_attr(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// DOT 标签：引号与反斜杠先转义，再把 `<br/>` 换成 DOT 的 `\n`。
///
/// 顺序不能反：`\n` 必须是**反斜杠 + n 两个字面量**（graphviz 才当折行），
/// 真换行字符它只会原样画出来。所以要在 `esc_attr` **之后**替换 ——
/// 否则那个反斜杠会被再转义一次，变成画在标签上的 `\n`。
fn to_dot_label(s: &str) -> String {
    esc_attr(s)
        .replace("<br/>", "\\n")
        .replace("<br />", "\\n")
        .replace("<br>", "\\n")
}

fn dot_id(id: &str) -> String {
    let bare = !id.is_empty()
        && id.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if bare {
        id.to_string()
    } else {
        format!("\"{}\"", esc_attr(id))
    }
}

/* ------------------------------------------------------------------ 生成 */

/// Mermaid flowchart → Graphviz DOT。
///
/// **两遍扫描**，不是一遍就够：
/// 一次扫描只能知道「节点第一次在哪儿被提到」，而 Mermaid 的实际语义是
/// 「subgraph 里提到过就归它」—— 程序里的示例文档正是这样：
/// `L` 先在边行（subgraph 外）出现，之后才在 `subgraph 风控` 里单独成行。
/// 按首次位置归类会把 L/M/N 全留在 cluster 外面，subgraph 就白写了。
///
/// 所以第一遍只收集（节点归属 + 标签 + 簇结构），第二遍按归属分组输出；
/// 边统一放在最后（DOT 允许，且避免把边写进 cluster 里改变它的布局含义）。
pub fn mermaid_to_dot(src: &str) -> Result<Conversion, String> {
    let (direction, stmts) = parse(src)?;

    /* ---------- 第一遍：收集 ---------- */
    let mut order: Vec<String> = Vec::new();
    let mut label_of: HashMap<String, (Option<String>, Shape)> = HashMap::new();
    // 值语义：`None` = 目前只在顶层出现过；`Some(i)` = 归第 i 个簇
    let mut cluster_of: HashMap<String, Option<usize>> = HashMap::new();
    let mut clusters: Vec<Cluster> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut edges: Vec<(String, String, Link)> = Vec::new();
    let mut class_styles: HashMap<String, Vec<String>> = HashMap::new();
    let mut node_styles: HashMap<String, Vec<String>> = HashMap::new();
    let mut dropped_keys: Vec<String> = Vec::new();
    let mut used_shapes: Vec<Shape> = Vec::new();
    let mut nested_direction = false;
    let mut ignored_directive = false;

    for st in &stmts {
        match st {
            Stmt::ClassDef { name, style } => {
                let (attrs, dropped) = style_to_dot(style);
                class_styles.insert(name.clone(), attrs);
                dropped_keys.extend(dropped);
            }
            Stmt::Ignored => ignored_directive = true,
            _ => {}
        }
    }

    for st in &stmts {
        match st {
            Stmt::Direction(d) => {
                // subgraph 内的 direction 在 DOT 里没有等价物
                if !stack.is_empty() {
                    nested_direction = true;
                    let _ = d;
                }
            }
            Stmt::SubgraphOpen(name) => {
                let idx = clusters.len();
                clusters.push(Cluster {
                    name: if name.is_empty() { format!("cluster_{idx}") } else { name.clone() },
                    parent: stack.last().copied(),
                    children: Vec::new(),
                });
                if let Some(p) = stack.last().copied() {
                    clusters[p].children.push(idx);
                }
                stack.push(idx);
            }
            Stmt::SubgraphClose => {
                stack.pop();
            }
            Stmt::ClassAssign { name, ids } => {
                let attrs = class_styles.get(name).cloned().unwrap_or_default();
                for id in ids {
                    node_styles.entry(id.clone()).or_default().extend(attrs.iter().cloned());
                }
            }
            Stmt::StyleAssign { id, style } => {
                let (attrs, dropped) = style_to_dot(style);
                node_styles.entry(id.clone()).or_default().extend(attrs);
                dropped_keys.extend(dropped);
            }
            Stmt::Chain { operands, links } => {
                for (i, op) in operands.iter().enumerate() {
                    if !label_of.contains_key(&op.id) {
                        order.push(op.id.clone());
                        cluster_of.insert(op.id.clone(), stack.last().copied());
                    } else if let Some(c) = stack.last().copied() {
                        // 顶层提过、后来又在簇里提到 ⇒ 归簇（Mermaid 的语义）
                        if cluster_of.get(&op.id) == Some(&None) {
                            cluster_of.insert(op.id.clone(), Some(c));
                        }
                    }
                    // 带标签的声明覆盖之前的；裸 id 不覆盖已有标签
                    if op.label.is_some() {
                        label_of.insert(op.id.clone(), (op.label.clone(), op.shape));
                    } else {
                        label_of.entry(op.id.clone()).or_insert((None, Shape::Box));
                    }
                    if op.shape != Shape::Box && !used_shapes.contains(&op.shape) {
                        used_shapes.push(op.shape);
                    }
                    if i > 0 {
                        let prev = &operands[i - 1].id;
                        edges.push((prev.clone(), op.id.clone(), links[i - 1].clone()));
                    }
                }
            }
            _ => {}
        }
    }

    if !stack.is_empty() {
        return Err("subgraph 没有配对的 `end`".into());
    }

    /* ---------- 第二遍：按归属分组输出 ---------- */
    let mut out = String::new();
    let _ = writeln!(out, "digraph G {{");
    let _ = writeln!(out, "    rankdir={direction};");
    let _ = writeln!(out, "    node [shape=box, style=\"rounded\", fontname=\"Helvetica\"];");
    let _ = writeln!(out, "    edge [fontname=\"Helvetica\"];");

    for id in &order {
        if cluster_of.get(id).copied().flatten().is_none() {
            emit_node(&mut out, id, &label_of, &node_styles, 1);
        }
    }
    let roots: Vec<usize> = (0..clusters.len())
        .filter(|i| clusters[*i].parent.is_none())
        .collect();
    for r in roots {
        emit_cluster(&mut out, &clusters, r, &order, &cluster_of, &label_of, &node_styles, 1);
    }

    for (from, to, link) in &edges {
        emit_edge(&mut out, from, to, link, 1);
    }
    let _ = writeln!(out, "}}");

    /* ---------- 保真度说明 ---------- */
    let mut notes = Vec::new();
    if !clusters.is_empty() {
        notes.push(
            "subgraph 映射为 DOT cluster（边框样式由布局引擎决定，Mermaid 的圆角虚线不保留）".to_string(),
        );
    }
    for s in &used_shapes {
        match s {
            Shape::Stadium => {
                notes.push("`([文本])` 体育场形在 DOT 里没有对应形状，退化为圆角框".to_string())
            }
            Shape::Asymmetric => {
                notes.push("`>文本]` 非对称形在 DOT 里没有对应形状，退化为普通框".to_string())
            }
            Shape::Subroutine => {
                notes.push("`[[文本]]` 映射为 box3d（子程序框），外观与 Mermaid 略有差异".to_string())
            }
            _ => {}
        }
    }
    if !dropped_keys.is_empty() {
        dropped_keys.sort();
        dropped_keys.dedup();
        notes.push(format!(
            "样式只迁移 fill / stroke / stroke-width / color；其余键未迁移：{}",
            dropped_keys.join(" / ")
        ));
    }
    if nested_direction {
        notes.push("subgraph 内的 `direction` 未迁移（DOT cluster 没有局部方向）".to_string());
    }
    if ignored_directive {
        notes.push("`click` / `linkStyle` 等指令未迁移".to_string());
    }

    notes.dedup();
    Ok(Conversion { body: out, notes })
}

/// 一个 subgraph 在 DOT 里的落点。
struct Cluster {
    name: String,
    parent: Option<usize>,
    children: Vec<usize>,
}

fn emit_node(
    out: &mut String,
    id: &str,
    label_of: &HashMap<String, (Option<String>, Shape)>,
    node_styles: &HashMap<String, Vec<String>>,
    indent: usize,
) {
    let pad = "    ".repeat(indent);
    let (label, shape) = label_of
        .get(id)
        .cloned()
        .unwrap_or((None, Shape::Box));
    let mut attrs: Vec<String> = Vec::new();
    if let Some(l) = &label {
        attrs.push(format!("label=\"{}\"", to_dot_label(l)));
    }
    attrs.push(shape.dot_attrs().to_string());
    if let Some(extra) = node_styles.get(id) {
        attrs.extend(extra.iter().cloned());
    }
    let _ = writeln!(out, "{pad}{} [{}];", dot_id(id), attrs.join(", "));
}

#[allow(clippy::too_many_arguments)]
fn emit_cluster(
    out: &mut String,
    clusters: &[Cluster],
    idx: usize,
    order: &[String],
    cluster_of: &HashMap<String, Option<usize>>,
    label_of: &HashMap<String, (Option<String>, Shape)>,
    node_styles: &HashMap<String, Vec<String>>,
    indent: usize,
) {
    let pad = "    ".repeat(indent);
    let c = &clusters[idx];
    let _ = writeln!(out, "{pad}subgraph cluster_{idx} {{");
    let _ = writeln!(out, "{pad}    label=\"{}\";", to_dot_label(&c.name));
    for id in order {
        if cluster_of.get(id).copied().flatten() == Some(idx) {
            emit_node(out, id, label_of, node_styles, indent + 1);
        }
    }
    for child in &c.children {
        emit_cluster(out, clusters, *child, order, cluster_of, label_of, node_styles, indent + 1);
    }
    let _ = writeln!(out, "{pad}}}");
}

fn emit_edge(out: &mut String, from: &str, to: &str, link: &Link, indent: usize) {
    let pad = "    ".repeat(indent);
    let mut attrs: Vec<String> = Vec::new();
    if let Some(label) = &link.label {
        attrs.push(format!("label=\"{}\"", to_dot_label(label)));
    }
    match link.family {
        Family::Solid => {}
        Family::Dotted => attrs.push("style=\"dotted\"".into()),
        Family::Thick => attrs.push("penwidth=2".into()),
    }
    if !link.arrow {
        attrs.push("dir=none".into());
    }
    let suffix = if attrs.is_empty() {
        String::new()
    } else {
        format!(" [{}]", attrs.join(", "))
    };
    let _ = writeln!(out, "{pad}{} -> {}{suffix};", dot_id(from), dot_id(to));
}

/* ------------------------------------------------------------------ Mermaid → D2 */

/// Mermaid 的布局方向 → D2 的 `direction`。
fn d2_direction(dir: &str) -> &'static str {
    match dir {
        "BT" => "up",
        "LR" => "right",
        "RL" => "left",
        // TD / TB（`parse` 已经把 TD 归一成 TB）
        _ => "down",
    }
}

/// 样式值：纯数字裸写，其余加引号（`#f00` 裸写会被当成注释起点）。
fn d2_value(v: &str) -> String {
    if v.parse::<f32>().is_ok() { v.to_string() } else { d2_str(v) }
}

/// Mermaid 的样式串（`fill:#f00,stroke:#333`）→ D2 的 `style.*` 键值对。
///
/// 返回 `(保留的键值对, 丢弃的键)` —— 丢掉的键由 `notes` 逐条说明（不静默丢）。
fn style_to_d2(style: &str) -> (Vec<(String, String)>, Vec<String>) {
    let mut kept: Vec<(String, String)> = Vec::new();
    let mut dropped: Vec<String> = Vec::new();

    for part in style.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (k, v) = match part.split_once(':') {
            Some((k, v)) => (k.trim(), v.trim()),
            None => (part, ""),
        };
        if v.is_empty() {
            dropped.push(k.to_string());
            continue;
        }
        // Mermaid 的 dasharray 是「线长 间隔」，D2 只接受一个数字（虚线段长）
        if matches!(k, "stroke-dasharray" | "stroke-dash") {
            match v.split_whitespace().next().filter(|n| n.parse::<f32>().is_ok()) {
                Some(n) => kept.push(("stroke-dash".into(), n.to_string())),
                None => dropped.push(k.to_string()),
            }
            continue;
        }
        let key = match k {
            "fill" => "fill",
            "stroke" => "stroke",
            "stroke-width" => "stroke-width",
            "color" => "font-color",
            _ => {
                dropped.push(k.to_string());
                continue;
            }
        };
        kept.push((key.to_string(), d2_value(v)));
    }
    (kept, dropped)
}

/// Mermaid flowchart → D2。
///
/// 复用 `mermaid_to_dot` 的解析器与归属规则（同一个 `parse()`，同样两遍），只换 emitter：
/// 形状 → `shape`，subgraph → **容器**（D2 的容器能带局部 `direction`，这点比转 DOT 强），
/// `classDef` → `classes` + `节点.class`，线型 → `style.stroke-dash` / `style.stroke-width`。
///
/// 边**一律写在全文件末尾**，容器里的节点用点号路径（`容器.节点`）引用 ——
/// 边若写进容器，另一头在别处的边会凭空造出一个同名新节点。
pub fn mermaid_to_d2(src: &str) -> Result<Conversion, String> {
    let (direction, stmts) = parse(src)?;

    /* ---------- 第一遍：classDef ---------- */
    let mut class_styles: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut dropped_keys: Vec<String> = Vec::new();
    let mut ignored_directive = false;
    for st in &stmts {
        match st {
            Stmt::ClassDef { name, style } => {
                let (kv, dropped) = style_to_d2(style);
                class_styles.insert(name.clone(), kv);
                dropped_keys.extend(dropped);
            }
            Stmt::Ignored => ignored_directive = true,
            _ => {}
        }
    }

    /* ---------- 第二遍：结构 ---------- */
    let mut order: Vec<String> = Vec::new();
    let mut label_of: HashMap<String, (Option<String>, Shape)> = HashMap::new();
    let mut container_of: HashMap<String, Option<usize>> = HashMap::new();
    let mut containers: Vec<Cluster> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut edges: Vec<(String, String, Link)> = Vec::new();
    let mut node_styles: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut node_class: HashMap<String, String> = HashMap::new();
    let mut container_direction: HashMap<usize, String> = HashMap::new();
    let mut used_shapes: Vec<Shape> = Vec::new();
    let mut used_families: Vec<Family> = Vec::new();

    for st in &stmts {
        match st {
            Stmt::Direction(d) => {
                // 容器内的 direction：D2 支持，原样带过去
                if let Some(top) = stack.last().copied() {
                    container_direction.insert(top, d2_direction(d).to_string());
                }
            }
            Stmt::SubgraphOpen(name) => {
                let idx = containers.len();
                containers.push(Cluster {
                    name: if name.is_empty() { format!("组{}", idx + 1) } else { name.clone() },
                    parent: stack.last().copied(),
                    children: Vec::new(),
                });
                if let Some(p) = stack.last().copied() {
                    containers[p].children.push(idx);
                }
                stack.push(idx);
            }
            Stmt::SubgraphClose => {
                stack.pop();
            }
            Stmt::ClassAssign { name, ids } => {
                for id in ids {
                    node_class.insert(id.clone(), name.clone());
                }
            }
            Stmt::StyleAssign { id, style } => {
                let (kv, dropped) = style_to_d2(style);
                node_styles.entry(id.clone()).or_default().extend(kv);
                dropped_keys.extend(dropped);
            }
            Stmt::Chain { operands, links } => {
                for (i, op) in operands.iter().enumerate() {
                    if !label_of.contains_key(&op.id) {
                        order.push(op.id.clone());
                        container_of.insert(op.id.clone(), stack.last().copied());
                    } else if let Some(c) = stack.last().copied() {
                        // 顶层提过、后来又在容器里提到 ⇒ 归容器（与转 DOT 同一套语义）
                        if container_of.get(&op.id) == Some(&None) {
                            container_of.insert(op.id.clone(), Some(c));
                        }
                    }
                    if op.label.is_some() {
                        label_of.insert(op.id.clone(), (op.label.clone(), op.shape));
                    } else {
                        label_of.entry(op.id.clone()).or_insert((None, Shape::Box));
                    }
                    if op.shape != Shape::Box && !used_shapes.contains(&op.shape) {
                        used_shapes.push(op.shape);
                    }
                    if i > 0 {
                        if links[i - 1].family != Family::Solid && !used_families.contains(&links[i - 1].family) {
                            used_families.push(links[i - 1].family);
                        }
                        edges.push((operands[i - 1].id.clone(), op.id.clone(), links[i - 1].clone()));
                    }
                }
            }
            _ => {}
        }
    }

    if !stack.is_empty() {
        return Err("subgraph 没有配对的 `end`".into());
    }

    let model = D2Emit {
        label_of,
        container_of,
        containers,
        node_styles,
        node_class,
        container_direction,
    };

    /* ---------- 输出 ---------- */
    let mut out = String::new();
    // Mermaid 的 `%%` 注释 → D2 的 `#` 注释。位置无法逐行保留（`parse` 不产出注释语句），
    // 所以按出现顺序汇总到文件开头，并在 notes 里说清这一点。
    let comments: Vec<&str> = src
        .lines()
        .filter_map(|l| l.trim().strip_prefix("%%").map(str::trim))
        .filter(|c| !c.is_empty())
        .collect();
    for c in &comments {
        let _ = writeln!(out, "# {c}");
    }
    let _ = writeln!(out, "direction: {}", d2_direction(&direction));

    if !class_styles.is_empty() {
        let _ = writeln!(out, "classes: {{");
        for (name, kv) in &class_styles {
            let _ = writeln!(out, "    {}: {{ style: {{ {} }} }}", d2_id(name), d2_style_inline(kv));
        }
        let _ = writeln!(out, "}}");
    }

    for id in &order {
        if model.container_of.get(id).copied().flatten().is_none() {
            model.emit_node(&mut out, id, 0);
        }
    }
    let roots: Vec<usize> = (0..model.containers.len())
        .filter(|i| model.containers[*i].parent.is_none())
        .collect();
    for r in roots {
        model.emit_container(&mut out, r, &order, 0);
    }
    for (from, to, link) in &edges {
        emit_d2_edge(&mut out, &model.path_of(from), &model.path_of(to), link, 0);
    }

    /* ---------- 保真度说明 ---------- */
    let mut notes = Vec::new();
    if !model.containers.is_empty() {
        notes.push("subgraph 映射为 D2 容器（嵌套关系保留；容器内的 direction 也带过去了）".to_string());
    }
    for s in &used_shapes {
        match s {
            Shape::Stadium => {
                notes.push("`([文本])` 体育场形在 D2 里没有对应形状，退化为 oval".to_string())
            }
            Shape::Subroutine => {
                notes.push("`[[文本]]` 映射为 page，外观与 Mermaid 的子程序框略有差异".to_string())
            }
            Shape::Asymmetric => {
                notes.push("`>文本]` 非对称形在 D2 里没有对应形状，退化为 callout".to_string())
            }
            Shape::Rounded => {
                notes.push("圆角 `(文本)` 与方框 `[文本]` 在 D2 里都是 rectangle（D2 的矩形自带圆角）".to_string())
            }
            _ => {}
        }
    }
    for f in &used_families {
        match f {
            Family::Dotted => notes.push("虚线边以 `style.stroke-dash` 表达".to_string()),
            Family::Thick => notes.push("加粗边以 `style.stroke-width` 表达".to_string()),
            Family::Solid => {}
        }
    }
    if !dropped_keys.is_empty() {
        dropped_keys.sort();
        dropped_keys.dedup();
        notes.push(format!(
            "样式只迁移 fill / stroke / stroke-width / color / stroke-dasharray；其余键未迁移：{}",
            dropped_keys.join(" / ")
        ));
    }
    if !comments.is_empty() {
        notes.push("`%%` 注释改写为 `#` 并汇总到文件开头（位置不再逐行对应）".to_string());
    }
    if ignored_directive {
        notes.push("`click` / `linkStyle` 等指令未迁移".to_string());
    }
    notes.push("版式由 D2 的布局引擎重新计算（Mermaid 不保留位置信息）".to_string());

    notes.dedup();
    Ok(Conversion { body: out, notes })
}

/// 把一组 `style.*` 键值对写成一行 `k: v; k2: v2`（`classes` 块里用）。
fn d2_style_inline(kv: &[(String, String)]) -> String {
    kv.iter()
        .map(|(k, v)| format!("{k}: {v}"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn emit_d2_edge(out: &mut String, from: &str, to: &str, link: &Link, indent: usize) {
    let pad = "    ".repeat(indent);
    let arrow = if link.arrow { "->" } else { "--" };
    let mut line = format!("{pad}{from} {arrow} {to}");
    if let Some(label) = &link.label {
        line.push_str(&format!(": {}", d2_str(label)));
    }
    // 边的属性块跟在标签之后（`a -> b: 标签 { style.stroke-dash: 3 }`）
    let attrs: Vec<(String, String)> = match link.family {
        Family::Solid => Vec::new(),
        Family::Dotted => vec![("stroke-dash".into(), "3".into())],
        Family::Thick => vec![("stroke-width".into(), "3".into())],
    };
    if !attrs.is_empty() {
        let body = attrs
            .iter()
            .map(|(k, v)| format!("style.{k}: {v}"))
            .collect::<Vec<_>>()
            .join("; ");
        line.push_str(&format!(" {{ {body} }}"));
    }
    let _ = writeln!(out, "{line}");
}

/// Mermaid → D2 的中间模型：一个 subgraph = 一个 D2 容器。
struct D2Emit {
    label_of: HashMap<String, (Option<String>, Shape)>,
    /// 值语义同转 DOT：`None` = 顶层，`Some(i)` = 归第 i 个容器
    container_of: HashMap<String, Option<usize>>,
    containers: Vec<Cluster>,
    node_styles: HashMap<String, Vec<(String, String)>>,
    node_class: HashMap<String, String>,
    /// 容器 → 容器内声明的局部 `direction`（D2 支持，DOT 不支持）
    container_direction: HashMap<usize, String>,
}

impl D2Emit {
    /// 节点在全文里的引用名：容器里的节点要写点号路径（`集成层.网关`），
    /// 否则顶层那行边会造出一个新的同名节点。
    fn path_of(&self, id: &str) -> String {
        match self.container_of.get(id).copied().flatten() {
            Some(idx) => format!("{}.{}", self.container_path(idx), d2_id(id)),
            None => d2_id(id),
        }
    }

    fn container_path(&self, idx: usize) -> String {
        let mut segs: Vec<String> = vec![d2_id(&self.containers[idx].name)];
        let mut cur = self.containers[idx].parent;
        while let Some(p) = cur {
            segs.push(d2_id(&self.containers[p].name));
            cur = self.containers[p].parent;
        }
        segs.reverse();
        segs.join(".")
    }

    fn emit_node(&self, out: &mut String, id: &str, indent: usize) {
        let pad = "    ".repeat(indent);
        let (label, shape) = self.label_of.get(id).cloned().unwrap_or((None, Shape::Box));
        if let Some(l) = &label {
            let _ = writeln!(out, "{pad}{}: {}", d2_id(id), d2_str(l));
        }
        if let Some(s) = shape.d2_shape() {
            let _ = writeln!(out, "{pad}{}.shape: {s}", d2_id(id));
        }
        if let Some(cls) = self.node_class.get(id) {
            let _ = writeln!(out, "{pad}{}.class: {}", d2_id(id), d2_id(cls));
        }
        if let Some(kv) = self.node_styles.get(id) {
            for (k, v) in kv {
                let _ = writeln!(out, "{pad}{}.style.{k}: {v}", d2_id(id));
            }
        }
    }

    fn emit_container(&self, out: &mut String, idx: usize, order: &[String], indent: usize) {
        let pad = "    ".repeat(indent);
        let c = &self.containers[idx];
        let _ = writeln!(out, "{pad}{}: {{", d2_id(&c.name));
        if let Some(dir) = self.container_direction.get(&idx) {
            let _ = writeln!(out, "{pad}    direction: {dir}");
        }
        for id in order {
            if self.container_of.get(id).copied().flatten() == Some(idx) {
                self.emit_node(out, id, indent + 1);
            }
        }
        for child in &c.children {
            self.emit_container(out, *child, order, indent + 1);
        }
        let _ = writeln!(out, "{pad}}}");
    }
}

/* ------------------------------------------------------------------ 分派 */

/// 某个转换方向该由谁执行。
///
/// 这一层存在的意义：让**前端不必自己维护一张「哪个方向归谁」的表**。
/// 契约里问一次，按返回值走对应路径。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    /// 纯 Rust，能给出完整结果
    Rust,
    /// 交给 drawio 自己的 Mermaid 导入器（`js/mermaid/drawio-mermaid`）
    Drawio,
    /// 交给 Excalidraw 的 `mermaid-to-excalidraw`
    Excalidraw,
    /// 交给**前端的 D2 wasm**：几何在页面里算出来，再转 mxGraph（Rust 侧没有 wasm 跑不了）
    D2Wasm,
    /// 暂不支持
    None,
}

impl Engine {
    /// 契约里回给前端的名字。前端按它决定「自己算」还是「转交承载页」。
    pub fn id(self) -> &'static str {
        match self {
            Engine::Rust => "rust",
            Engine::Drawio => "drawio",
            Engine::Excalidraw => "excalidraw",
            Engine::D2Wasm => "d2wasm",
            Engine::None => "none",
        }
    }
}

/// 一次转换的「谁来做」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub engine: Engine,
    /// 给界面看的说明：这个方向为什么由它做 / 为什么做不了。
    pub reason: String,
}

/// 问一次「这个方向该谁做」。
///
/// **结构化回答，而不是让前端从错误字符串里猜引擎** —— 猜字符串的方案一改文案就崩。
/// 真正的「做不了」（源格式不对）仍然返回 `Err`。
///
/// 这一层是全应用**唯一**的「哪个方向归谁」的真源：前端不维护第二张表
/// （每个格式的 `convert_to` 只管"能不能"，"谁做"在这里回答）。
///
/// 矩阵按 `from` 逐层展开（而不是 `match (from, to)` + `_`）：
/// 加第六种格式时编译器会把每一条**没想过的**方向都点名，不会静默落到兜底分支。
pub fn plan(from: app_ipc::FormatId, to: app_ipc::FormatId) -> Result<Plan, String> {
    use app_ipc::FormatId::*;

    fn same() -> String {
        "源格式与目标格式相同".to_string()
    }

    let (engine, reason) = match from {
        Mermaid => match to {
            Dot => (Engine::Rust, "由 Rust 侧的 Mermaid 解析器直接完成，可立即预览"),
            D2 => (Engine::Rust, "由 Rust 侧的 Mermaid 解析器直接完成，可立即预览（flowchart 子集）"),
            Drawio => (
                Engine::Drawio,
                "由 drawio 自带的 Mermaid 导入器解析（经画布承载页），结果落在新标签页",
            ),
            Excalidraw => (
                Engine::Excalidraw,
                "由 Excalidraw 的 mermaid-to-excalidraw 解析（经画布承载页），结果落在新标签页",
            ),
            Mermaid => return Err(same()),
        },
        Dot => match to {
            // 实验方向：没有映射器，转换中心如实标出来
            Mermaid => {
                return Err(
                    "DOT → Mermaid 只在 flowchart 子集内可行，尚无映射器（转换中心把它列为实验方向）".into(),
                )
            }
            D2 => (Engine::Rust, "由 Rust 侧的 DOT 解析器完成，可立即预览（基础子集，版式会重新计算）"),
            Drawio | Excalidraw => {
                return Err("DOT 只能转 D2 或（实验性的）Mermaid：画布承载页没有 DOT 导入器".into())
            }
            Dot => return Err(same()),
        },
        D2 => match to {
            Drawio => (
                Engine::D2Wasm,
                "由 D2 的 wasm 编译器产出绝对几何后转成 mxGraph（保几何），结果落在新标签页",
            ),
            Mermaid | Dot => return Err(
                "D2 → Mermaid / DOT 不做：D2 是它们的超集（容器、classes、vars、imports、layers…），\
                 反向压缩每一样都要单独决定丢什么。要可继续编辑的图形请转 drawio（保几何）"
                    .into(),
            ),
            Excalidraw => {
                return Err("D2 → Excalidraw 不做：Excalidraw 只接 Mermaid；D2 的图形要进画布请转 drawio".into())
            }
            D2 => return Err(same()),
        },
        Drawio => match to {
            Mermaid | Dot | D2 | Excalidraw => {
                return Err("drawio 不作为转换源：画布内容要转文本格式请先导出 XML".into())
            }
            Drawio => return Err(same()),
        },
        Excalidraw => match to {
            Mermaid | Dot | D2 | Drawio => {
                return Err("Excalidraw 不作为转换源：场景 JSON 没有到文本图表的通用映射".into())
            }
            Excalidraw => return Err(same()),
        },
    };
    Ok(Plan { engine, reason: reason.to_string() })
}

/// 执行一次**纯 Rust** 转换。
///
/// 引擎型的三个方向在这里返回 `Err`（并点名是谁的活）——
/// 调用方应先问 `plan()`，别把这里的 `Err` 当成「不支持」。
pub fn convert(
    from: app_ipc::FormatId,
    to: app_ipc::FormatId,
    source: &str,
) -> Result<Conversion, String> {
    use app_ipc::FormatId::*;

    let p = plan(from, to)?;
    match (from, to) {
        (Mermaid, Dot) => mermaid_to_dot(source),
        (Mermaid, D2) => mermaid_to_d2(source),
        (Dot, D2) => crate::convert_dot::dot_to_d2(source),
        _ => match p.engine {
            Engine::Drawio => {
                Err("mermaid → drawio 由 drawio 的 Mermaid 导入器完成（经画布承载页）".into())
            }
            Engine::Excalidraw => {
                Err("mermaid → Excalidraw 由 mermaid-to-excalidraw 完成（经画布承载页）".into())
            }
            Engine::D2Wasm => {
                Err("D2 → drawio 由前端的 D2 wasm 编译器完成（经画布承载页）".into())
            }
            // 走到这里说明 plan() 放行了却没有 Rust 侧的实现 —— 是接线漏了，如实说出来
            Engine::Rust => Err(format!("{from:?} → {to:?} 缺 Rust 侧的映射器")),
            Engine::None => Err(p.reason),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 程序里那份示例文档：形状、带标签边、链式边、subgraph 里的裸 id、
    /// classDef + class 全都出现了 —— 拿它当回归基准。
    const SAMPLE: &str = r#"flowchart TD
    A([开始]) --> B[打开登录页]
    B --> C{已记住账号?}
    C -- 是 --> D[填充账号]
    C -- 否 --> E[手动输入账号]
    D --> F[输入密码]
    E --> F
    F --> G[请求图形验证码]
    G --> H{验证码正确?}
    H -- 否 --> I[刷新验证码]
    I --> G
    H -- 是 --> J[调用 /auth/login]
    J --> K{账号密码匹配?}
    K -- 否 --> L[失败次数 +1]
    L --> M{连续失败 >= 5?}
    M -- 否 --> F
    M -- 是 --> N[锁定账号 15 分钟]
    N --> O([结束])
    K -- 是 --> P[签发 JWT]
    P --> Q[写入本地会话]
    Q --> R([进入首页])

    subgraph 风控
        L
        M
        N
    end

    classDef danger fill:#f8e9e6,stroke:#b0554a;
    class N,L danger;
"#;

    #[test]
    fn direction_maps_td_to_tb() {
        let c = mermaid_to_dot("flowchart TD\n    A --> B\n").unwrap();
        assert!(c.body.contains("rankdir=TB;"), "{}", c.body);
        let c = mermaid_to_dot("graph LR\n    A --> B\n").unwrap();
        assert!(c.body.contains("rankdir=LR;"), "{}", c.body);
    }

    #[test]
    fn chain_produces_every_edge() {
        let c = mermaid_to_dot("flowchart TD\n    A --> B --> C\n").unwrap();
        assert!(c.body.contains("A -> B;"), "{}", c.body);
        assert!(c.body.contains("B -> C;"), "{}", c.body);
    }

    /// 带内联标签的边：`-- 是 -->` 的标签要落到 DOT 的 label 上。
    #[test]
    fn inline_edge_label_is_kept() {
        let c = mermaid_to_dot("flowchart TD\n    C -- 是 --> D\n").unwrap();
        assert!(c.body.contains("C -> D [label=\"是\"];"), "{}", c.body);
    }

    /// 管道写法 `-->|标签|` 同样要认。
    #[test]
    fn pipe_edge_label_is_kept() {
        let c = mermaid_to_dot("flowchart TD\n    A -->|通过| B\n").unwrap();
        assert!(c.body.contains("A -> B [label=\"通过\"];"), "{}", c.body);
    }

    #[test]
    fn edge_styles_map_to_dot_attrs() {
        let c = mermaid_to_dot("flowchart TD\n    A -.-> B\n    C ==> D\n    E --- F\n").unwrap();
        assert!(c.body.contains("A -> B [style=\"dotted\"];"), "{}", c.body);
        assert!(c.body.contains("C -> D [penwidth=2];"), "{}", c.body);
        assert!(c.body.contains("E -> F [dir=none];"), "{}", c.body);
    }

    #[test]
    fn shapes_map_and_unmappable_ones_are_noted() {
        let c = mermaid_to_dot("flowchart TD\n    A([开始]) --> B{判断}\n    B --> C((圆))\n").unwrap();
        assert!(c.body.contains("A [label=\"开始\", shape=box, style=\"rounded\"];"), "{}", c.body);
        assert!(c.body.contains("shape=diamond"), "{}", c.body);
        assert!(c.body.contains("shape=circle"), "{}", c.body);
        assert!(
            c.notes.iter().any(|n| n.contains("体育场形")),
            "退化必须写进 notes：{:?}",
            c.notes
        );
    }

    /// subgraph 里的**裸 id**（示例文档里就是这样）要能解析，且落到 cluster 里。
    #[test]
    fn bare_ids_inside_subgraph_land_in_the_cluster() {
        let c = mermaid_to_dot(SAMPLE).unwrap();
        assert!(c.body.contains("subgraph cluster_0 {"), "{}", c.body);
        assert!(c.body.contains("label=\"风控\";"), "{}", c.body);
        // L / M / N 的三行声明必须落在 cluster 内（在第一个 `}` 之前）
        let cluster_start = c.body.find("subgraph cluster_0").unwrap();
        let cluster_end = c.body[cluster_start..].find("\n    }").unwrap() + cluster_start;
        let inside = &c.body[cluster_start..cluster_end];
        for id in ["L [", "M [", "N ["] {
            assert!(inside.contains(id), "{id} 没落在 cluster 内：\n{inside}");
        }
    }

    /// classDef + class 的样式要挂到节点上；只迁移认得的那几个键，其余进 notes。
    #[test]
    fn class_styles_attach_and_dropped_keys_are_reported() {
        let c = mermaid_to_dot(SAMPLE).unwrap();
        assert!(
            c.body.contains("fillcolor=\"#f8e9e6\"") && c.body.contains("color=\"#b0554a\""),
            "样式没挂上：{}",
            c.body
        );
        let n_line = c.body.lines().find(|l| l.trim_start().starts_with("N [")).unwrap();
        assert!(n_line.contains("fillcolor=\"#f8e9e6\""), "N 没拿到 class 样式：{n_line}");
        let l_line = c.body.lines().find(|l| l.trim_start().starts_with("L [")).unwrap();
        assert!(l_line.contains("fillcolor=\"#f8e9e6\""), "L 没拿到 class 样式：{l_line}");
    }

    #[test]
    fn subgraph_presence_is_noted() {
        let c = mermaid_to_dot(SAMPLE).unwrap();
        assert!(
            c.notes.iter().any(|n| n.contains("cluster")),
            "subgraph 的语义变化必须写进 notes：{:?}",
            c.notes
        );
    }

    #[test]
    fn comments_and_blank_lines_are_ignored() {
        let c = mermaid_to_dot("flowchart TD\n%% 说明\n\n    A --> B\n").unwrap();
        assert!(!c.body.contains('说'), "注释不该进产物：{}", c.body);
        assert!(c.body.contains("A -> B;"));
    }

    /// 非 flowchart 的头部要**明确报错**，而不是硬编出一个乱七八糟的图。
    #[test]
    fn non_flowchart_header_is_rejected() {
        let e = mermaid_to_dot("sequenceDiagram\n    A->>B: hi\n").unwrap_err();
        assert!(e.contains("flowchart"), "{e}");
        assert!(mermaid_to_dot("").is_err());
        assert!(mermaid_to_dot("flowchart\n").is_err(), "缺方向应报错");
    }

    #[test]
    fn unclosed_subgraph_is_an_error() {
        let e = mermaid_to_dot("flowchart TD\n    subgraph 组\n    A --> B\n").unwrap_err();
        assert!(e.contains("end"), "{e}");
    }

    /// 标签里的双引号要转义（否则 DOT 标签会被提前闭合），`<br/>` 转成 DOT 的换行。
    #[test]
    fn labels_are_escaped() {
        // 标签以双引号收尾：只该剥掉最外层那一对，内层的要留下并转义
        let c = mermaid_to_dot("flowchart TD\n    A[\"说了\"\"] --> B\n").unwrap();
        assert!(c.body.contains(r#"label="说了\""#), "{}", c.body);
        let c2 = mermaid_to_dot("flowchart LR\n    A[第一行<br/>第二行] --> B\n").unwrap();
        assert!(c2.body.contains("第一行\\n第二行"), "{}", c2.body);
    }

    /// 分派：mermaid → dot 走 Rust，引擎型方向点名引擎，不谎称「不支持」。
    #[test]
    fn dispatch_names_the_right_engine() {
        use app_ipc::FormatId::*;
        assert_eq!(plan(Mermaid, Dot).unwrap().engine, Engine::Rust);
        assert_eq!(plan(Mermaid, Drawio).unwrap().engine, Engine::Drawio);
        assert_eq!(plan(Mermaid, Excalidraw).unwrap().engine, Engine::Excalidraw);
        assert_eq!(plan(D2, Drawio).unwrap().engine, Engine::D2Wasm, "D2 → drawio 只能在前端跑（wasm）");
        assert_eq!(plan(Dot, D2).unwrap().engine, Engine::Rust);

        let ok = convert(Mermaid, Dot, "flowchart TD\n    A --> B\n").unwrap();
        assert!(ok.body.contains("A -> B;"));

        let e = convert(Mermaid, Drawio, "flowchart TD\n    A --> B\n").unwrap_err();
        assert!(e.contains("drawio"), "错误信息要指名引擎：{e}");
    }

    /// plan() 给出结构化的「谁来做」，前端不必从错误文案里猜。
    #[test]
    fn plan_reports_engine_and_reason() {
        use app_ipc::FormatId::*;
        let p = plan(Mermaid, Drawio).unwrap();
        assert_eq!(p.engine, Engine::Drawio);
        assert_eq!(p.engine.id(), "drawio");
        assert!(p.reason.contains("drawio"));
        assert_eq!(plan(Mermaid, Dot).unwrap().engine.id(), "rust");
        assert_eq!(plan(D2, Drawio).unwrap().engine.id(), "d2wasm");
        assert!(plan(Dot, Mermaid).is_err(), "源格式不对要报错，而不是返回 none");
    }

    #[test]
    fn same_format_and_non_mermaid_sources_are_rejected_with_reasons() {
        use app_ipc::FormatId::*;
        for id in [Mermaid, Dot, D2, Drawio, Excalidraw] {
            let e = plan(id, id).unwrap_err();
            assert!(e.contains("相同"), "{id:?} → 自己应报「相同」：{e}");
        }
        let e = convert(Dot, Mermaid, "digraph { a -> b }").unwrap_err();
        assert!(e.contains("实验方向"), "{e}");
        assert!(convert(Drawio, Dot, "<mxfile/>").is_err());
        let e = plan(D2, Mermaid).unwrap_err();
        assert!(e.contains("超集"), "反向转换要说清为什么不做的道理：{e}");
        assert!(plan(D2, Excalidraw).unwrap_err().contains("drawio"));
        assert!(plan(Dot, Drawio).unwrap_err().contains("没有 DOT 导入器"));
    }

    /* ---------------- Mermaid → D2 ---------------- */

    #[test]
    fn d2_direction_and_chain_edges() {
        let c = mermaid_to_d2("flowchart LR\n    A --> B --> C\n").unwrap();
        assert!(c.body.contains("direction: right"), "{}", c.body);
        assert!(c.body.contains("A -> B"), "{}", c.body);
        assert!(c.body.contains("B -> C"), "{}", c.body);
        // TD 归一成 TB 之后仍是 down
        assert!(mermaid_to_d2("flowchart TD\n    A --> B\n").unwrap().body.contains("direction: down"));
        assert!(mermaid_to_d2("flowchart BT\n    A --> B\n").unwrap().body.contains("direction: up"));
    }

    #[test]
    fn d2_shapes_and_labels_are_quoted() {
        let c = mermaid_to_d2("flowchart TD\n    A([开始]) --> B{判断}\n    B --> C((圆))\n").unwrap();
        assert!(c.body.contains("A.shape: oval"), "{}", c.body);
        assert!(c.body.contains("B.shape: diamond"), "{}", c.body);
        assert!(c.body.contains("C.shape: circle"), "{}", c.body);
        assert!(c.body.contains("A: \"开始\""), "标签一律加引号：{}", c.body);
        assert!(c.notes.iter().any(|n| n.contains("体育场")), "{:?}", c.notes);
    }

    /// 形状名写错 D2 会**编译失败**（实测 `unknown shape "nope"`），所以钉住这张表。
    #[test]
    fn d2_shape_names_are_the_ones_d2_knows() {
        for (src, want) in [
            ("flowchart TD\n    A([x]) --> B\n", "shape: oval"),
            ("flowchart TD\n    A[[x]] --> B\n", "shape: page"),
            ("flowchart TD\n    A[(x)] --> B\n", "shape: cylinder"),
            ("flowchart TD\n    A{{x}} --> B\n", "shape: hexagon"),
            ("flowchart TD\n    A>x] --> B\n", "shape: callout"),
            // 方框与圆角都是 D2 的默认矩形，不写 shape 属性（D2 的矩形自带圆角）
            ("flowchart TD\n    A[x] --> B\n", "A: \"x\""),
        ] {
            let c = mermaid_to_d2(src).unwrap();
            assert!(c.body.contains(want), "{src:?} 应映射到 {want}：{}", c.body);
            assert!(!c.body.contains("unknown"), "{}", c.body);
        }
    }

    #[test]
    fn d2_subgraph_becomes_container_with_local_direction() {
        let c = mermaid_to_d2("flowchart TD\n    subgraph 风控\n        direction LR\n        L --> M\n    end\n    A --> L\n").unwrap();
        assert!(c.body.contains("风控: {"), "{}", c.body);
        assert!(c.body.contains("direction: right"), "容器内的 direction 要保留：{}", c.body);
        assert!(c.body.contains("风控.L -> 风控.M"), "容器里的边用具名路径引用：{}", c.body);
        assert!(c.body.contains("A -> 风控.L"), "跨容器的边同样用点号路径：{}", c.body);
        assert!(c.body.find("风控: {").unwrap() < c.body.find("风控.L -> 风控.M").unwrap(), "边一律在末尾：{}", c.body);
    }

    #[test]
    fn d2_edge_styles_and_classes() {
        let c = mermaid_to_d2(
            "flowchart TD\n    A -.-> B\n    C ==> D\n    classDef danger fill:#f8e9e6,stroke:#b0554a\n    class A danger\n",
        )
        .unwrap();
        assert!(c.body.contains("style.stroke-dash: 3"), "{}", c.body);
        assert!(c.body.contains("style.stroke-width: 3"), "{}", c.body);
        assert!(c.body.contains("classes: {"), "{}", c.body);
        assert!(c.body.contains("A.class: danger"), "{}", c.body);
        assert!(c.body.contains("fill: \"#f8e9e6\""), "类样式值要带引号：{}", c.body);
        assert!(c.notes.iter().any(|n| n.contains("虚线")), "{:?}", c.notes);
    }

    #[test]
    fn d2_notes_list_what_was_lost() {
        let c = mermaid_to_d2("flowchart TD\n%% 说明\n    A[[子程序]] --> B\n    click A \"https://x\"\n").unwrap();
        assert!(c.body.starts_with("# 说明"), "注释汇总到开头：{}", c.body);
        assert!(c.notes.iter().any(|n| n.contains("page")), "{:?}", c.notes);
        assert!(c.notes.iter().any(|n| n.contains("click")), "{:?}", c.notes);
        assert!(c.notes.iter().any(|n| n.contains("注释")), "{:?}", c.notes);
        assert!(c.notes.iter().any(|n| n.contains("版式")), "{:?}", c.notes);
    }

    /// 带 `.` 的 id 必须加引号：D2 的 `.` 是路径分隔符，裸写会被当成「容器里的节点」。
    #[test]
    fn d2_quotes_ids_that_would_be_read_as_paths() {
        let c = mermaid_to_d2("flowchart TD\n    a.b[x] --> c\n").unwrap();
        assert!(c.body.contains("\"a.b\""), "{}", c.body);
        assert!(c.body.contains("\"a.b\" -> c"), "{}", c.body);
    }

    #[test]
    fn d2_conversion_is_dispatched_by_convert() {
        use app_ipc::FormatId::*;
        let c = convert(Mermaid, D2, "flowchart TD\n    A --> B\n").unwrap();
        assert!(c.body.contains("direction: down"));
        assert!(convert(Mermaid, D2, "sequenceDiagram\n    A->>B: hi\n").is_err(), "非 flowchart 要报错");
    }

    /// 生成物要能真的被 graphviz 跑（结构层面：括号配平、语句以分号收尾）。
    #[test]
    fn output_is_structurally_valid_dot() {
        let c = mermaid_to_dot(SAMPLE).unwrap();
        let opens = c.body.matches('{').count();
        let closes = c.body.matches('}').count();
        assert_eq!(opens, closes, "花括号不配平：\n{}", c.body);
        for line in c.body.lines() {
            let t = line.trim();
            if t.is_empty() || t.starts_with("//") || t.ends_with('{') || t == "}" {
                continue;
            }
            assert!(t.ends_with(';'), "语句缺分号：{t}");
        }
    }
}
