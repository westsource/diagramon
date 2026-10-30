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
//! 支持的是 Mermaid flowchart 的**常用子集**：节点四类形状、带/不带标签的六种边
//! （含两端端点标记 `-->` / `<-->` / `o--o` / `x--x`，以及用重复字符拉长的
//! `--->` / `-..->` / `====>`）、`A & B` 多源/多目标、subgraph（含 `id ["标题"]` 与
//! 「连到 subgraph」的跨容器边）、classDef/class/style、direction、`%%` 注释。
//! 序列图 / 状态图 / 甘特等不在范围内 —— 遇到不认识的头部会明确报错，不猜。

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

/// 边某一端的端点标记（Mermaid 的 `[xo<]` / `[-xo>]`）。
///
/// 取值照 Mermaid 自己的分类器（`flowDb.destructLink` → `IUt`）：**末位字符**决定端点，
/// 首位只有在「与末位同款」时才是「两端都有」的 `double_*` —— 所以 `x--o`、`<--`
/// 这类写法 Mermaid 也只按末位画端点、首位直接丢掉，这里照抄它的判定（`link_ends`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum End {
    /// 没有标记（`---`）
    None,
    /// 箭头 `-->`
    Point,
    /// 圆圈 `--o`
    Circle,
    /// 叉 `--x`
    Cross,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Link {
    family: Family,
    /// 起点端：只有两端同款（`<-->` / `o--o` / `x--x`）时才不是 `End::None`
    source: End,
    /// 目标端
    target: End,
    label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Operand {
    id: String,
    label: Option<String>,
    shape: Shape,
    /// 内联类名：`A["x"]:::cls` 里的 `cls`（可多个，逗号分隔）。
    ///
    /// Mermaid 允许把 class 直接写在节点上，效果与 `class A cls` 完全一致。
    /// **不认它会让整份文件转不出来**：`:::` 被当成"尾部没解析完的内容"，
    /// 用户拿到的是「第 26 行：语句尾部有没解析完的内容」这种与真实原因无关的报错
    /// （真实语料实测：带 `:::` 的部署图 100% 失败）。
    classes: Vec<String>,
    /// 这个操作数**显式写了形状**吗（`B[x]` / `B{x}`）？
    ///
    /// 必须区分：`A[x] --> B` 里第二次提到的 `A` 是裸 id，不能把先前解析出的形状
    /// 覆盖成默认的 Box —— 否则同一个节点在"提到两次"之后形状就丢了（判断节点变回方框、
    /// 圆柱变回方框），自动配色的角色推断也跟着错。
    shaped: bool,
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
    /// `subgraph id ["标题"]`：`id` 是**引用名**（跨 subgraph 的边用它），`label` 是显示文本。
    ///
    /// 两者必须分开：Mermaid 的 `subgraph L_MGMT ["🔍 管理平面…"]` 里
    /// `L_VALUE -. 说明 .-> L_STORAGE` 这种「容器到容器」的边引用的是 **id**，
    /// 而画在框上的字是括号里的标题。早先把整行 `L_MGMT ["…"]` 当一个名字，结果
    /// DOT 的 cluster 标签里出现方括号与引号、D2 的容器名也被污染成带引号的怪串。
    SubgraphOpen { id: Option<String>, label: String },
    SubgraphClose,
    /// 一条链：操作数与连接件交替（通常 `operands.len() == links.len() + 1`）。
    ///
    /// 唯一的例外是「只有端点、没有边」的声明行（`A & B`）：那时 `links` 为空，
    /// 操作数只用来登记节点 —— 取边的地方必须 `links.get(i - 1)`，不能直接下标。
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
        // 首行的 BOM 要去掉：Windows 记事本存 UTF-8 默认带 BOM，而 `\u{feff}` 不是
        // `char::is_whitespace`，`trim()` 去不掉 ⇒ 头部会被读成「﻿flowchart」，
        // 报「只支持 Mermaid flowchart」这种看着莫名其妙的错。（`convert_dot` 早就处理了，
        // 这里当初漏了；语料里带 BOM 的那批文件正好全被这条挡住。）
        let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
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
            // `A & B --> C` 会展开成多条链（笛卡尔积），所以这里收的是**一批**语句。
            stmts.extend(parse_stmt(&piece, idx + 1)?);
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

/// 解析一条语句。返回**一批**：`A & B --> C & D` 会展开成 4 条链（笛卡尔积）。
fn parse_stmt(text: &str, line_no: usize) -> Result<Vec<Stmt>, String> {
    let t = text.trim().trim_end_matches(';').trim();
    if t.is_empty() {
        return Ok(Vec::new());
    }

    if t == "end" {
        return Ok(vec![Stmt::SubgraphClose]);
    }
    if let Some(rest) = t.strip_prefix("subgraph") {
        return Ok(vec![parse_subgraph(rest)]);
    }
    if let Some(rest) = t.strip_prefix("direction ") {
        return Ok(vec![Stmt::Direction(map_direction(rest.trim())?)]);
    }
    if let Some(rest) = t.strip_prefix("classDef ") {
        let (name, style) = split_once_ws(rest);
        return Ok(vec![Stmt::ClassDef { name, style }]);
    }
    if let Some(rest) = t.strip_prefix("class ") {
        let (name, ids) = match rest.rsplit_once(' ') {
            Some((ids, name)) => (name.to_string(), ids.to_string()),
            None => return Ok(vec![Stmt::Ignored]),
        };
        return Ok(vec![Stmt::ClassAssign {
            name,
            ids: ids.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
        }]);
    }
    if let Some(rest) = t.strip_prefix("style ") {
        // 别把 `style --> B` 当成 style 语句（节点叫 style 也是合法的）
        if !rest.starts_with(['-', '=']) {
            let (id, style) = split_once_ws(rest);
            if !style.is_empty() {
                return Ok(vec![Stmt::StyleAssign { id, style }]);
            }
        }
    }
    // 认得但不迁移的指令：不报错，也不假装迁移了
    if t.starts_with("click ")
        || t.starts_with("linkStyle")
        || t.starts_with("accTitle")
        || t.starts_with("accDescr")
    {
        return Ok(vec![Stmt::Ignored]);
    }

    // `A & B --> C` 的多源/多目标：按 Mermaid 的语义展开成两两相连的边
    // （`A & B --> C & D` 是 4 条），而不是像早先那样直接报「尚未支持」——
    // 真实语料里 `DDM --> A & B & C` 这种写法很常见，报错等于整份文件转不出来。
    let (groups, links, leftover) = parse_chain(t)
        .ok_or_else(|| format!("第 {line_no} 行：看不懂的语句「{}」", truncate(t, 60)))?;
    if leftover {
        return Err(format!(
            "第 {line_no} 行：语句尾部有没解析完的内容「{}」",
            truncate(t, 60)
        ));
    }
    Ok(expand_groups(groups, links))
}

/// `subgraph` 后面的部分 → 引用名 + 显示标题。
///
/// Mermaid 的写法有三种，都要认（真实语料三种都有）：
/// `subgraph 风控`（只有名字）、`subgraph L_MGMT ["🔍 管理平面"]`（id + 括号标题）、
/// `subgraph "标题里有空格"`（整段就是标题，没有单独 id）。
fn parse_subgraph(rest: &str) -> Stmt {
    let t = rest.trim();
    // 括号标题：`id [标题]` / `id["标题"]`。取第一个 `[` 之前的是 id。
    if let Some(open) = t.find('[') {
        let id = t[..open].trim().trim_matches('"').trim();
        let inner = t[open + 1..].trim();
        let inner = inner.strip_suffix(']').unwrap_or(inner);
        let label = strip_one_quote_pair(inner.trim()).to_string();
        let id = (!id.is_empty()).then(|| id.to_string());
        let label = if label.is_empty() { id.clone().unwrap_or_default() } else { label };
        return Stmt::SubgraphOpen { id, label };
    }
    // 没有括号：整段就是名字（可能被引号包住）。这时引用名与标题同一个。
    let label = strip_one_quote_pair(t).trim().to_string();
    Stmt::SubgraphOpen {
        id: Some(label.clone()).filter(|s| !s.is_empty()),
        label,
    }
}

/// 把「操作数分组 + 连接件」展开成两两相连的链（`&` 的笛卡尔积）。
///
/// `[A, B] --x--> [C, D]` 展开成 `A->C` / `A->D` / `B->C` / `B->D` —— 与 Mermaid
/// 把 `&` 当作「多重端点」的语义一致。单组（`A & B` 不带边）保持一条声明链。
fn expand_groups(groups: Vec<Vec<Operand>>, links: Vec<Link>) -> Vec<Stmt> {
    debug_assert_eq!(groups.len(), links.len() + 1, "parse_chain 保证分组比连接件多一个");
    // 每个分组只有一个操作数 ⇒ 本来就是一条普通链，原样交出去（保住链式写法）
    if links.is_empty() || groups.iter().all(|g| g.len() == 1) {
        let operands = groups.into_iter().flatten().collect();
        return vec![Stmt::Chain { operands, links }];
    }
    let mut out = Vec::new();
    for (i, pair) in groups.windows(2).enumerate() {
        let link = links[i].clone();
        for a in &pair[0] {
            for b in &pair[1] {
                out.push(Stmt::Chain {
                    operands: vec![a.clone(), b.clone()],
                    links: vec![link.clone()],
                });
            }
        }
    }
    out
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

/// `A([开始]) --> B{判断} -- 否 --> C` → 操作数分组与连接件交替。
///
/// 分组是 `&` 分隔的多端点（`A & B --> C`），每个分组至少一个操作数。
fn parse_chain(text: &str) -> Option<(Vec<Vec<Operand>>, Vec<Link>, bool)> {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    let mut groups: Vec<Vec<Operand>> = Vec::new();
    let mut links = Vec::new();

    loop {
        i = skip_ws(bytes, i);
        // 一组：`op` 或 `op & op & …`
        let mut group = Vec::new();
        loop {
            let (op, ni) = parse_operand(text, i)?;
            group.push(op);
            i = skip_ws(bytes, ni);
            if i < bytes.len() && bytes[i] == b'&' {
                i = skip_ws(bytes, i + 1);
                continue;
            }
            break;
        }
        groups.push(group);

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

    if groups.len() != links.len() + 1 {
        return None;
    }
    // 尾部还有内容 ⇒ 没解析干净，交给调用方报错（别静默丢掉）
    Some((groups, links, !text[i..].trim().is_empty()))
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

    // `&` 分隔的多端点由 `parse_chain` 在分组层处理，这里不再跳过它 ——
    // 真在操作数位置遇到 `&` 说明语法不对，让它明确失败。
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
        // 裸 id 也可能带内联类名（`A:::cls`），那它在解析里算"没有形状"的一个操作数
        let (classes, end_ci) = parse_inline_classes(&chars, ci);
        return Some((
            Operand { id, label: None, shape: Shape::Box, classes, shaped: false },
            char_to_byte(text, end_ci),
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
    let close_at = find_close(&tail, close)?;
    let label_raw = &tail[..close_at];
    let label = strip_one_quote_pair(label_raw.trim()).to_string();
    let next_ci = inner_start + tail[..close_at + close.len()].chars().count();

    // 形状闭合之后还可能跟内联类名（`A["x"]:::cls`），一起吃掉
    let (classes, end_ci) = parse_inline_classes(&chars, next_ci);

    Some((
        Operand {
            id,
            label: if label.is_empty() { None } else { Some(label) },
            shape,
            classes,
            shaped: true,
        },
        char_to_byte(text, end_ci),
    ))
}

/// 吃掉节点后面的内联类名：`:::cls` / `:::a,b`（Mermaid 允许一个节点挂多个类）。
///
/// 返回（类名列表, 字符游标）。没有 `:::` 时原样返回 (空, 传入的游标)。
///
/// 为什么值得单独一个函数：`:::` 后面紧跟的类名可能为中文/带数字，
/// 而 `is_id_char` 不吃 `-`，所以这里按"读到空白或 `;` 或箭头为止"来收，
/// 与 `class A cls` 那条语句的语义保持一致（那边是按逗号切）。
fn parse_inline_classes(chars: &[char], start: usize) -> (Vec<String>, usize) {
    if start + 3 > chars.len() {
        return (Vec::new(), start);
    }
    // 必须正好是三个冒号；两个冒号（`A:x`）在 Mermaid 里是别的语义，不在这里吃
    if !(chars[start] == ':' && chars[start + 1] == ':' && chars[start + 2] == ':') {
        return (Vec::new(), start);
    }
    let mut ci = start + 3;
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    while ci < chars.len() {
        let c = chars[ci];
        if c.is_whitespace() || c == ';' {
            break;
        }
        // 箭头 / 连线开头就停（`A["x"]:::c --> B` 里 `:::` 后面不该把 `-->` 吃进类名）。
        // **但不能见 `-` 就停**：类名里带连字符是合法的（`:::lvl-entry`、`:::my-class`），
        // 早先一刀切在 `-` 上，于是 `A:::lvl-entry --> B` 被读成「语句尾部有没解析完的内容」——
        // 整份图连解析都过不去。只有真正开始一条连线（`--` / `->` / `==>` / `<--`）才停。
        if c == '-' || c == '=' || c == '<' || c == '&' {
            let next = chars.get(ci + 1).copied().unwrap_or(' ');
            let starts_link = match c {
                '-' => next == '-' || next == '>',
                '=' => next == '=' || next == '>',
                '<' => next == '-',
                _ => true,
            };
            if starts_link {
                break;
            }
        }
        if c == ',' {
            let name = cur.trim();
            if !name.is_empty() {
                out.push(name.to_string());
            }
            cur.clear();
            ci += 1;
            continue;
        }
        cur.push(c);
        ci += 1;
    }
    let name = cur.trim();
    if !name.is_empty() {
        out.push(name.to_string());
    }
    (out, ci)
}

/// 在标签正文里找节点闭合符号。
///
/// 为什么不能直接 `find(close)`：真实语料里 `D["直接返回缓存 byte[]"]` 这样的标签很常见，
/// 正文里带 `]`。直接找会把标签从中间截断，剩下的 `（O(1)，无 CLI 调用）"]` 留在语句尾部，
/// 整条边被判成「尾部有没解析完的内容」而转换失败（语料实测：15 份里 4 份因此挂掉）。
///
/// 规则：
/// * 标签**以引号开头**时，收尾引号之后的那个才是节点闭合（`"说了""]` 里两个引号，
///   只有紧跟 `]` 的那个算收尾，前一个是标签正文里的引号）。
///   找不到这样的收尾就退回普通查找 —— 语法不对时让它按原样报错，别吞掉。
/// * 不以引号开头时照旧收第一个 `close`（`D[it's fine]` 这种带撇号的标签不能被当成引号）。
fn find_close(tail: &str, close: &str) -> Option<usize> {
    let head = tail.trim_start();
    let Some(q) = head.chars().next().filter(|c| *c == '"') else {
        return tail.find(close);
    };
    for (at, c) in head.char_indices().skip(1) {
        if c != q {
            continue;
        }
        let after = &head[at + c.len_utf8()..];
        let after = after.trim_start();
        if after.starts_with(close) {
            // 换算回 `tail` 里的下标（trim_start 只影响前缀，这里用 head 的相对位置重找）
            let closed_at = tail.len() - after.len();
            return Some(closed_at);
        }
    }
    tail.find(close)
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

/// 连接件：`-->` / `---` / `-.->` / `-.-` / `==>` / `===`（每种都允许把字符重复拉长，
/// 如 `--->` / `-..->` / `====>`），以及带内联标签的
/// `-- 是 -->` / `-. 是 .->` / `== 是 ==>`，还有 `-->|是|` / `-->|"带 空格"|`。
///
/// 两端端点标记（Mermaid 的 `[xo<]` / `[-xo>]`）在这里一并吃掉：
/// `<-->`（双向箭头）、`o--o` / `x--x`、单端点的 `--o` / `--x`、以及 `<-- 文本 -->`。
fn parse_link(text: &str, start: usize) -> Option<(Link, usize)> {
    let rest = &text[start..];

    // 起点端的标记：`o` / `x` / `<` 后面紧跟连接件本体才算（否则 `A o B` 里的 `o` 是节点名，
    // 那种情况压根不会走到这里 —— 操作数先被 `parse_operand` 吃掉）。
    let (marked, body_start) = match rest.as_bytes().first() {
        Some(&c @ (b'o' | b'x' | b'<'))
            if rest[1..].starts_with('-') || rest[1..].starts_with('=') =>
        {
            (Some(c as char), start + 1)
        }
        _ => (None, start),
    };
    let rest = &text[body_start..];

    // 1) 先试「纯连接件」（不带内联标签）。Mermaid 允许把连接件加长
    //    （`--->` / `====>` / `-..->` 与更长的重复），所以这里按**游程**扫描，
    //    而不是枚举几个固定 token —— 枚举法下 `DP ===>|"标签"| DDM` 会把 `===>`
    //    切成 `===` + 残留 `>`，整条边报「看不懂的语句」。
    if let Some((tok_len, family, target)) = scan_link_token(rest) {
        let (label, used) = parse_pipe_label(&rest[tok_len..]);
        let (source, target) = link_ends(marked, target);
        return Some((
            Link { family, source, target, label },
            body_start + tok_len + used,
        ));
    }

    // 2) 带内联标签：`-- text -->` / `-. text .->` / `== text ==>`（也允许无箭头的收尾）
    let (lead, family): (&str, Family) = if rest.starts_with("-.") {
        ("-.", Family::Dotted)
    } else if rest.starts_with("==") {
        ("==", Family::Thick)
    } else if rest.starts_with("--") {
        ("--", Family::Solid)
    } else {
        return None;
    };

    let body = &rest[lead.len()..];
    // 虚线的收尾是首部的镜像（`.->` / `.-`），不以 `-` 开头，单独找
    let (at, closer_len, target) = if family == Family::Dotted {
        let arrow = body.find(".->").map(|a| (a, 3, End::Point));
        let plain = body.find(".-").map(|a| (a, 2, End::None));
        match (arrow, plain) {
            (Some(a), Some(p)) => {
                if p.0 < a.0 {
                    p
                } else {
                    a
                }
            }
            (Some(a), None) => a,
            (None, Some(p)) => p,
            (None, None) => return None,
        }
    } else {
        find_family_token(body, family)?
    };
    let label = body[..at].trim().trim_matches('"').trim_matches('\'').trim();
    let used = lead.len() + at + closer_len;
    let (source, target) = link_ends(marked, target);
    Some((
        Link {
            family,
            source,
            target,
            label: (!label.is_empty()).then(|| label.to_string()),
        },
        body_start + used,
    ))
}

/// 扫描一个连接件游程：返回 (字节长度, 线型, 目标端标记)。
///
/// 规则与 Mermaid 一致：
/// * 实线是 `-` 的游程，粗线是 `=` 的游程，虚线是 `-.` 后跟 `.` / `-` 的游程；
/// * 游程后面紧跟 `>` / `o` / `x` ⇒ 那是目标端标记；
/// * 没有端点标记时，**至少三个字符**才算一条线（`---` / `===` / `-.-`），
///   两个字符的 `--` / `==` 只是「带内联标签的连接件首部」，留给调用方接着找收尾。
fn scan_link_token(rest: &str) -> Option<(usize, Family, End)> {
    let b = rest.as_bytes();

    // 虚线要先判：它也以 `-` 开头
    if rest.starts_with("-.") {
        let mut i = 2;
        while i < b.len() && (b[i] == b'.' || b[i] == b'-') {
            i += 1;
        }
        if let Some(end) = end_marker_at(b.get(i).copied()) {
            return Some((i + 1, Family::Dotted, end));
        }
        if i >= 3 && b[i - 1] == b'.' {
            return Some((i, Family::Dotted, End::None));
        }
        return None;
    }

    // 粗线
    if b.first() == Some(&b'=') {
        let run = b.iter().take_while(|c| **c == b'=').count();
        if run >= 2 {
            if let Some(end) = end_marker_at(b.get(run).copied()) {
                return Some((run + 1, Family::Thick, end));
            }
            if run >= 3 {
                return Some((run, Family::Thick, End::None));
            }
        }
        return None;
    }

    // 实线
    if b.first() == Some(&b'-') {
        let run = b.iter().take_while(|c| **c == b'-').count();
        if run >= 2 {
            if let Some(end) = end_marker_at(b.get(run).copied()) {
                return Some((run + 1, Family::Solid, end));
            }
            if run >= 3 {
                return Some((run, Family::Solid, End::None));
            }
        }
    }
    None
}

/// 指定的线型在正文里最早出现的收尾 token（内联标签用）。
fn find_family_token(body: &str, family: Family) -> Option<(usize, usize, End)> {
    let b = body.as_bytes();
    for i in 0..b.len() {
        if !body.is_char_boundary(i) {
            continue;
        }
        // 只在连接件可能的起始字符上试，避免对每个字符做一次游程扫描
        if b[i] != b'-' && b[i] != b'=' {
            continue;
        }
        if let Some((len, fam, end)) = scan_link_token(&body[i..]) {
            if fam == family {
                return Some((i, len, end));
            }
        }
    }
    None
}

/// 端点标记字符 → `End`。
fn end_marker_at(c: Option<u8>) -> Option<End> {
    match c {
        Some(b'>') => Some(End::Point),
        Some(b'o') => Some(End::Circle),
        Some(b'x') => Some(End::Cross),
        _ => None,
    }
}

/// 起点的标记字符 + 目标端端点 → 两端的端点。
///
/// 判据照 `IUt`：末位是 `>` / `o` / `x` 时，首位必须是 `<` / `o` / `x` **同款**才升级成
/// `double_*`（两端都有）；否则首位不算标记（`x--o` 就只画目标端的圈，`<--` 更是连端点都没有）。
fn link_ends(marked: Option<char>, target: End) -> (End, End) {
    let doubled = match target {
        End::Point => marked == Some('<'),
        End::Circle => marked == Some('o'),
        End::Cross => marked == Some('x'),
        End::None => false,
    };
    (if doubled { target } else { End::None }, target)
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
            // Mermaid 允许 `-->|"带 空格 的标签"|`：成对引号只是定界，不该画进标签
            let label = strip_one_quote_pair(t[1..1 + at].trim()).trim().to_string();
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

/// DOT 的关键字（**大小写无关**）。裸写会被当成语句关键字，必须加引号：
/// `AI1 -> EDGE` 在 graphviz 里是语法错误，得写 `AI1 -> "EDGE"`。
const DOT_KEYWORDS: [&str; 6] = ["node", "edge", "graph", "digraph", "subgraph", "strict"];

pub(crate) fn dot_id(id: &str) -> String {
    let lower = id.to_ascii_lowercase();
    let bare = !id.is_empty()
        && id.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !DOT_KEYWORDS.contains(&lower.as_str());
    if bare {
        id.to_string()
    } else {
        format!("\"{}\"", esc_attr(id))
    }
}

/* ------------------------------------------------------------------ 只读事实（配色用） */

/// Mermaid 的节点形状，对外用**稳定名字**而不是内部枚举（`Shape` 随转换细节变）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowShape {
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

impl FlowShape {
    fn from_shape(s: Shape) -> Self {
        match s {
            Shape::Box => Self::Box,
            Shape::Rounded => Self::Rounded,
            Shape::Stadium => Self::Stadium,
            Shape::Subroutine => Self::Subroutine,
            Shape::Cylinder => Self::Cylinder,
            Shape::Hexagon => Self::Hexagon,
            Shape::Circle => Self::Circle,
            Shape::Diamond => Self::Diamond,
            Shape::Asymmetric => Self::Asymmetric,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Self::Box => "box",
            Self::Rounded => "rounded",
            Self::Stadium => "stadium",
            Self::Subroutine => "subroutine",
            Self::Cylinder => "cylinder",
            Self::Hexagon => "hexagon",
            Self::Circle => "circle",
            Self::Diamond => "diamond",
            Self::Asymmetric => "asymmetric",
        }
    }
}

/// 一个 flowchart 节点（只读视图，给自动配色用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowNode {
    pub id: String,
    pub label: Option<String>,
    pub shape: FlowShape,
    /// 内联 `:::cls` 与 `class X cls` 合并后的类名（按出现顺序去重）。
    pub classes: Vec<String>,
    /// 有 `style <id> …` 语句。这类语句**优先级高于 classDef**，配色要动它得先删。
    pub styled: bool,
}

#[derive(Debug, Clone, Default)]
pub struct FlowFacts {
    pub nodes: Vec<FlowNode>,
    /// 文档里出现过的 classDef 名字（判断"某个类是我们的角色类还是用户自己的"）。
    pub class_defs: Vec<String>,
}

/// Mermaid flowchart 的节点事实：**只读**，不改文档、不生成任何代码。
///
/// 自动配色（`palette`）要的就是"这份图里有哪些节点、各自什么形状/标签/类名"。
/// 这里刻意复用同一个 `parse`：Mermaid 的解析只该有一份，另写一个扫描器迟早漂。
pub fn flow_facts(src: &str) -> Result<FlowFacts, String> {
    let (_, stmts) = parse(src)?;
    let mut order: Vec<String> = Vec::new();
    let mut info: HashMap<String, (Option<String>, FlowShape, Vec<String>, bool)> = HashMap::new();
    let mut class_of: HashMap<String, Vec<String>> = HashMap::new();
    let mut class_defs: Vec<String> = Vec::new();
    let mut styled: std::collections::HashSet<String> = std::collections::HashSet::new();

    let touch = |id: &str, info: &mut HashMap<_, _>, order: &mut Vec<String>| {
        if !info.contains_key(id) {
            order.push(id.to_string());
            info.insert(id.to_string(), (None, FlowShape::Box, Vec::new(), false));
        }
    };
    for stmt in &stmts {
        match stmt {
            Stmt::Chain { operands, .. } => {
                for op in operands {
                    touch(&op.id, &mut info, &mut order);
                    let slot = info.get_mut(&op.id).expect("刚 inserted");
                    if op.label.is_some() {
                        slot.0 = op.label.clone();
                    }
                    // 裸 id（边上的重复提及）不带形状，别用它覆盖已经解析出来的形状
                    if op.shaped {
                        slot.1 = FlowShape::from_shape(op.shape);
                    }
                    for c in &op.classes {
                        if !slot.2.contains(c) {
                            slot.2.push(c.clone());
                        }
                    }
                }
            }
            Stmt::ClassDef { name, .. } => {
                if !class_defs.contains(name) {
                    class_defs.push(name.clone());
                }
            }
            Stmt::ClassAssign { name, ids } => {
                for id in ids {
                    let list = class_of.entry(id.clone()).or_default();
                    if !list.contains(name) {
                        list.push(name.clone());
                    }
                }
            }
            Stmt::StyleAssign { id, .. } => {
                styled.insert(id.clone());
            }
            _ => {}
        }
    }
    let nodes = order
        .into_iter()
        .map(|id| {
            let (label, shape, mut classes, _) = info.remove(&id).expect("order 与 info 同源");
            for c in class_of.remove(&id).unwrap_or_default() {
                if !classes.contains(&c) {
                    classes.push(c);
                }
            }
            FlowNode { id: id.clone(), label, shape, classes, styled: styled.contains(&id) }
        })
        .collect();
    Ok(FlowFacts { nodes, class_defs })
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
    // 节点上内联写的类名（`A["x"]:::cls`）：先收着，等 classDef 全收齐再合并
    let mut inline_classes: HashMap<String, Vec<String>> = HashMap::new();
    let mut dropped_keys: Vec<String> = Vec::new();
    let mut used_shapes: Vec<Shape> = Vec::new();
    // 用到的圆圈 / 叉端点（DOT 没有对应形状，要记进 notes）
    let mut used_ends: Vec<End> = Vec::new();
    let mut nested_direction = false;
    let mut ignored_directive = false;

    // subgraph 的引用名 → 簇下标。边可以先于 subgraph 定义出现，所以先扫一遍收集。
    let mut subgraph_idx: HashMap<String, usize> = HashMap::new();
    {
        let mut n = 0usize;
        for st in &stmts {
            if let Stmt::SubgraphOpen { id, .. } = st {
                if let Some(id) = id {
                    subgraph_idx.entry(id.clone()).or_insert(n);
                }
                n += 1;
            }
        }
    }

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
            Stmt::SubgraphOpen { id, label } => {
                let idx = clusters.len();
                clusters.push(Cluster {
                    name: label.clone(),
                    id: id.clone(),
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
                    // subgraph 也能当边的端点（`subgraph A -.-> subgraph B`）：它不是一个节点，
                    // 别在 order / label_of 里造出一个同名占位节点（那会在图上多出一对空框）。
                    if subgraph_idx.contains_key(&op.id) {
                        if i > 0 {
                            if let Some(link) = links.get(i - 1) {
                                attach_edge(&mut edges, &mut used_ends, &operands[i - 1].id, &op.id, link);
                            }
                        }
                        continue;
                    }
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
                    // 内联类名（`A["x"]:::cls`）：与 `class A cls` 等价，先挂到 node_styles，
                    // 等所有 classDef 都收齐后再合并（classDef 可能写在这些节点之后）。
                    for cls in &op.classes {
                        inline_classes
                            .entry(op.id.clone())
                            .or_default()
                            .push(cls.clone());
                    }
                    if op.shape != Shape::Box && !used_shapes.contains(&op.shape) {
                        used_shapes.push(op.shape);
                    }
                    if i > 0 {
                        if let Some(link) = links.get(i - 1) {
                            attach_edge(&mut edges, &mut used_ends, &operands[i - 1].id, &op.id, link);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if !stack.is_empty() {
        return Err("subgraph 没有配对的 `end`".into());
    }

    // 内联类名与 `class A cls` 同语义：现在 classDef 与节点都收齐了，按名字合并进 node_styles。
    // 找不到同名 classDef 就跳过（等价于 Mermaid 里挂了个未定义的类 —— 那里也不报错）。
    for (id, names) in &inline_classes {
        for name in names {
            if let Some(attrs) = class_styles.get(name) {
                node_styles.entry(id.clone()).or_default().extend(attrs.iter().cloned());
            }
        }
    }

    /* ---------- 第三遍：按归属分组输出 ---------- */
    let mut out = String::new();
    let _ = writeln!(out, "digraph G {{");
    let _ = writeln!(out, "    rankdir={direction};");
    let _ = writeln!(out, "    node [shape=box, style=\"rounded\", fontname=\"Helvetica\"];");
    let _ = writeln!(out, "    edge [fontname=\"Helvetica\"];");
    // cluster 之间的边要靠 compound + ltail/lhead 才能落在簇的边界上
    let has_cluster_edge = edges
        .iter()
        .any(|(f, t, _)| subgraph_idx.contains_key(f) || subgraph_idx.contains_key(t));
    if has_cluster_edge {
        let _ = writeln!(out, "    compound=true;");
    }

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
        emit_edge(
            &mut out,
            from,
            to,
            link,
            1,
            &subgraph_idx,
            &order,
            &cluster_of,
            &clusters,
        );
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
    for e in &used_ends {
        match e {
            End::Circle => notes.push("`o`（圆圈）端点标记在 DOT 里没有对应形状，退化为不带端点".to_string()),
            End::Cross => notes.push("`x`（叉）端点标记在 DOT 里没有对应形状，退化为不带端点".to_string()),
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
    /// 显示标题（`subgraph id ["标题"]` 里括号中的那一段）
    name: String,
    /// Mermaid 里用来引用的名字（跨 subgraph 的边用它）。没有单独 id 时是 `None`。
    id: Option<String>,
    parent: Option<usize>,
    children: Vec<usize>,
}

/// 容器在目标格式里的引用名：有专门 id 就用 id，否则用标题
/// （`subgraph 风控` 这种没有单独 id 的写法，名字本身就是引用名）。
fn cluster_ref(c: &Cluster) -> &str {
    c.id.as_deref().filter(|s| !s.is_empty()).unwrap_or(&c.name)
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

#[allow(clippy::too_many_arguments)]
fn emit_edge(
    out: &mut String,
    from: &str,
    to: &str,
    link: &Link,
    indent: usize,
    subgraph_idx: &HashMap<String, usize>,
    order: &[String],
    cluster_of: &HashMap<String, Option<usize>>,
    clusters: &[Cluster],
) {
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
    match (link.source, link.target) {
        // DOT 的默认正好是「目标端一个箭头」
        (End::None, End::Point) => {}
        (End::Point, End::Point) => attrs.push("dir=both".into()),
        // 无端点，以及圆圈 / 叉（DOT 没有这两种端点形状）—— 都退化成不带端点
        _ => attrs.push("dir=none".into()),
    }

    // 端点可能是 subgraph：DOT 不能直接连 cluster，只能连到簇里的某个节点，
    // 再用 ltail / lhead 把这条边裁到簇的边界上（graph 里已写了 `compound=true`）。
    let (tail_id, tail_cluster) = anchor_end(from, subgraph_idx, clusters, order, cluster_of);
    let (head_id, head_cluster) = anchor_end(to, subgraph_idx, clusters, order, cluster_of);
    if let Some(i) = tail_cluster {
        attrs.push(format!("ltail=cluster_{i}"));
    }
    if let Some(i) = head_cluster {
        attrs.push(format!("lhead=cluster_{i}"));
    }

    let suffix = if attrs.is_empty() {
        String::new()
    } else {
        format!(" [{}]", attrs.join(", "))
    };
    let _ = writeln!(out, "{pad}{} -> {}{suffix};", dot_id(&tail_id), dot_id(&head_id));
}

/// 边的一端落在哪个节点上；那一端若是 subgraph，额外返回簇下标（要写 ltail/lhead）。
fn anchor_end(
    id: &str,
    subgraph_idx: &HashMap<String, usize>,
    clusters: &[Cluster],
    order: &[String],
    cluster_of: &HashMap<String, Option<usize>>,
) -> (String, Option<usize>) {
    let Some(&idx) = subgraph_idx.get(id) else {
        return (id.to_string(), None);
    };
    // 簇里的第一个节点当代表；节点可以属于子簇（祖先簇的 lhead/ltail 同样有效）
    let anchor = order
        .iter()
        .find(|nid| {
            let mut cur = cluster_of.get(*nid).copied().flatten();
            while let Some(c) = cur {
                if c == idx {
                    return true;
                }
                cur = clusters[c].parent;
            }
            false
        })
        .cloned();
    match anchor {
        Some(a) => (a, Some(idx)),
        // 空簇（只有 subgraph 没有节点）：没有可连的节点，退回同名占位节点，
        // 至少不会把这条关系整条丢掉。
        None => (id.to_string(), None),
    }
}

/// 记一条边，并登记它用到的圆圈 / 叉端点（DOT 没有这两种形状，要进 notes）。
fn attach_edge(
    edges: &mut Vec<(String, String, Link)>,
    used_ends: &mut Vec<End>,
    from: &str,
    to: &str,
    link: &Link,
) {
    for e in [link.source, link.target] {
        if matches!(e, End::Circle | End::Cross) && !used_ends.contains(&e) {
            used_ends.push(e);
        }
    }
    edges.push((from.to_string(), to.to_string(), link.clone()));
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
/// 返回 `(保留的键值对, 丢弃的键, 被截断的 stroke-width 原值)` —— 丢掉的键与截断
/// 都由 `notes` 逐条说明（不静默丢）。
fn style_to_d2(style: &str) -> (Vec<(String, String)>, Vec<String>, Vec<String>) {
    let mut kept: Vec<(String, String)> = Vec::new();
    let mut dropped: Vec<String> = Vec::new();
    let mut clamped: Vec<String> = Vec::new();

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
        // `stroke-width` 在 mermaid 里带单位（`2px`），D2 要的是 **0–15 的整数**
        // （上游报错：`expected "stroke-width" to be a number between 0 and 15`，
        // 小数同样被挡下来）—— 取整并按上限截断，别产出一份编译不过的正文。
        if k == "stroke-width" {
            match v.trim_end_matches("px").trim().parse::<f32>() {
                Ok(n) if n.is_finite() => {
                    let capped = n.round().clamp(0.0, 15.0);
                    if capped != n {
                        clamped.push(v.to_string());
                    }
                    kept.push(("stroke-width".into(), capped.to_string()));
                }
                _ => dropped.push(k.to_string()),
            }
            continue;
        }
        let key = match k {
            "fill" => "fill",
            "stroke" => "stroke",
            "color" => "font-color",
            _ => {
                dropped.push(k.to_string());
                continue;
            }
        };
        kept.push((key.to_string(), d2_value(v)));
    }
    (kept, dropped, clamped)
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
    // `stroke-width` 被 D2 上限截断过的原值（进 notes）
    let mut clamped_widths: Vec<String> = Vec::new();
    let mut ignored_directive = false;
    for st in &stmts {
        match st {
            Stmt::ClassDef { name, style } => {
                let (kv, dropped, clamped) = style_to_d2(style);
                class_styles.insert(name.clone(), kv);
                dropped_keys.extend(dropped);
                clamped_widths.extend(clamped);
            }
            Stmt::Ignored => ignored_directive = true,
            _ => {}
        }
    }

    /* ---------- 第二遍：结构 ---------- */
    // subgraph 的引用名 → 容器下标（与 DOT 侧同一套语义：跨 subgraph 的边引用 id）
    let mut subgraph_idx: HashMap<String, usize> = HashMap::new();
    {
        let mut n = 0usize;
        for st in &stmts {
            if let Stmt::SubgraphOpen { id, .. } = st {
                if let Some(id) = id {
                    subgraph_idx.entry(id.clone()).or_insert(n);
                }
                n += 1;
            }
        }
    }

    let mut order: Vec<String> = Vec::new();
    let mut label_of: HashMap<String, (Option<String>, Shape)> = HashMap::new();
    let mut container_of: HashMap<String, Option<usize>> = HashMap::new();
    let mut containers: Vec<Cluster> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut edges: Vec<(String, String, Link)> = Vec::new();
    let mut node_styles: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut node_class: HashMap<String, String> = HashMap::new();
    // 一个节点写了多个内联类名（`A:::a,b`）时记下来：D2 的 `.class` 是单值，
    // 只取第一个，其余如实进 notes（不静默丢）。
    let mut notes_inline_multi_class = false;
    let mut container_direction: HashMap<usize, String> = HashMap::new();
    let mut used_shapes: Vec<Shape> = Vec::new();
    let mut used_families: Vec<Family> = Vec::new();
    // 用到的圆圈 / 叉端点（D2 的箭头语法里没有对应写法，要记进 notes）
    let mut used_ends: Vec<End> = Vec::new();

    for st in &stmts {
        match st {
            Stmt::Direction(d) => {
                // 容器内的 direction：D2 支持，原样带过去
                if let Some(top) = stack.last().copied() {
                    container_direction.insert(top, d2_direction(d).to_string());
                }
            }
            Stmt::SubgraphOpen { id, label } => {
                let idx = containers.len();
                containers.push(Cluster {
                    name: if label.is_empty() { format!("组{}", idx + 1) } else { label.clone() },
                    id: id.clone(),
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
                let (kv, dropped, clamped) = style_to_d2(style);
                node_styles.entry(id.clone()).or_default().extend(kv);
                dropped_keys.extend(dropped);
                clamped_widths.extend(clamped);
            }
            Stmt::Chain { operands, links } => {
                for (i, op) in operands.iter().enumerate() {
                    // subgraph 当端点：D2 里容器本身就能连边，别再声明同名节点
                    if subgraph_idx.contains_key(&op.id) {
                        if i > 0 {
                            if let Some(link) = links.get(i - 1) {
                                attach_d2_edge(&mut edges, &mut used_families, &mut used_ends, &operands[i - 1].id, &op.id, link);
                            }
                        }
                        continue;
                    }
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
                    // 内联类名（`A["x"]:::cls`）：与 `class A cls` 等价。
                    // D2 的 `.class` 是单值属性 ⇒ 多类时只取第一个，并记进 notes 如实说明。
                    if let Some(first) = op.classes.first() {
                        if op.classes.len() > 1 {
                            notes_inline_multi_class = true;
                        }
                        node_class.entry(op.id.clone()).or_insert_with(|| first.clone());
                    }
                    if op.shape != Shape::Box && !used_shapes.contains(&op.shape) {
                        used_shapes.push(op.shape);
                    }
                    if i > 0 {
                        if let Some(link) = links.get(i - 1) {
                            attach_d2_edge(&mut edges, &mut used_families, &mut used_ends, &operands[i - 1].id, &op.id, link);
                        }
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
    for e in &used_ends {
        match e {
            End::Circle => {
                notes.push("`o`（圆圈）端点标记在 D2 的箭头语法里没有对应写法，退化为不带端点".to_string())
            }
            End::Cross => {
                notes.push("`x`（叉）端点标记在 D2 的箭头语法里没有对应写法，退化为不带端点".to_string())
            }
            _ => {}
        }
    }
    if notes_inline_multi_class {
        notes.push(
            "节点上的多个内联类名（`:::a,b`）：D2 的 `.class` 只能挂一个，只保留了第一个"
                .to_string(),
        );
    }
    if !dropped_keys.is_empty() {
        dropped_keys.sort();
        dropped_keys.dedup();
        notes.push(format!(
            "样式只迁移 fill / stroke / stroke-width / color / stroke-dasharray；其余键未迁移：{}",
            dropped_keys.join(" / ")
        ));
    }
    if !clamped_widths.is_empty() {
        clamped_widths.sort();
        clamped_widths.dedup();
        notes.push(format!(
            "`stroke-width` 在 D2 里只接受 0–15 的整数，以下原值已取整（并受上限约束）：{}",
            clamped_widths.join(" / ")
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

/// 记一条 D2 边，并登记它用到的线型 / 端点（notes 要用）。
fn attach_d2_edge(
    edges: &mut Vec<(String, String, Link)>,
    used_families: &mut Vec<Family>,
    used_ends: &mut Vec<End>,
    from: &str,
    to: &str,
    link: &Link,
) {
    if link.family != Family::Solid && !used_families.contains(&link.family) {
        used_families.push(link.family);
    }
    for e in [link.source, link.target] {
        if matches!(e, End::Circle | End::Cross) && !used_ends.contains(&e) {
            used_ends.push(e);
        }
    }
    edges.push((from.to_string(), to.to_string(), link.clone()));
}

fn emit_d2_edge(out: &mut String, from: &str, to: &str, link: &Link, indent: usize) {
    let pad = "    ".repeat(indent);
    let arrow = match (link.source, link.target) {
        (End::None, End::Point) => "->",
        (End::Point, End::Point) => "<->",
        // 无端点，以及圆圈 / 叉（`o` / `x` 在 D2 的箭头语法里没有对应写法）
        _ => "--",
    };
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
        // subgraph 本身也能当边的端点（`L_VALUE -.-> L_STORAGE`）：走容器的完整路径，
        // 嵌套容器也一样（否则 D2 会在顶层造一个同名空容器）。
        if let Some(idx) = self.containers.iter().position(|c| cluster_ref(c) == id) {
            return self.container_path(idx);
        }
        match self.container_of.get(id).copied().flatten() {
            Some(idx) => format!("{}.{}", self.container_path(idx), d2_id(id)),
            None => d2_id(id),
        }
    }

    fn container_path(&self, idx: usize) -> String {
        let mut segs: Vec<String> = vec![d2_id(cluster_ref(&self.containers[idx]))];
        let mut cur = self.containers[idx].parent;
        while let Some(p) = cur {
            segs.push(d2_id(cluster_ref(&self.containers[p])));
            cur = self.containers[p].parent;
        }
        segs.reverse();
        segs.join(".")
    }

    fn emit_node(&self, out: &mut String, id: &str, indent: usize) {
        let pad = "    ".repeat(indent);
        let (label, shape) = self.label_of.get(id).cloned().unwrap_or((None, Shape::Box));
        let mut wrote = false;
        if let Some(l) = &label {
            let _ = writeln!(out, "{pad}{}: {}", d2_id(id), d2_str(l));
            wrote = true;
        }
        if let Some(s) = shape.d2_shape() {
            let _ = writeln!(out, "{pad}{}.shape: {s}", d2_id(id));
            wrote = true;
        }
        if let Some(cls) = self.node_class.get(id) {
            let _ = writeln!(out, "{pad}{}.class: {}", d2_id(id), d2_id(cls));
            wrote = true;
        }
        if let Some(kv) = self.node_styles.get(id) {
            for (k, v) in kv {
                let _ = writeln!(out, "{pad}{}.style.{k}: {v}", d2_id(id));
            }
            wrote = true;
        }
        // 上面四项都空时一行都没写，但节点本体仍要声明 —— D2 里写个裸 id 就是声明。
        // 否则孤立节点（无边、无标签、默认方框）会整段消失（B3：D2 导出静默丢节点）。
        if !wrote {
            let _ = writeln!(out, "{pad}{}", d2_id(id));
        }
    }

    fn emit_container(&self, out: &mut String, idx: usize, order: &[String], indent: usize) {
        let pad = "    ".repeat(indent);
        let c = &self.containers[idx];
        let r = cluster_ref(c);
        if c.name == r {
            let _ = writeln!(out, "{pad}{}: {{", d2_id(r));
        } else {
            // 引用名与显示标题不同：`id: "标题" {`（Mermaid 的 `subgraph id ["标题"]`）
            let _ = writeln!(out, "{pad}{}: {} {{", d2_id(r), d2_str(&c.name));
        }
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

    /// 双向边 `<-->`：DOT 是 `dir=both`，D2 是 `<->`。以前这一整条语句会被判成
    /// 「尾部有没解析完的内容」—— 端点标记压根没进词法。
    #[test]
    fn bidirectional_arrows_survive_both_emitters() {
        let src = "flowchart LR\n    EDGE <-->|跨网 MQTT 通道| EMQX\n";
        let c = mermaid_to_dot(src).unwrap();
        // `EDGE` 是 DOT 关键字，必须加引号（见 dot_keyword_ids_are_quoted）
        assert!(
            c.body.contains("\"EDGE\" -> EMQX [label=\"跨网 MQTT 通道\", dir=both];"),
            "{}",
            c.body
        );

        let c = mermaid_to_d2(src).unwrap();
        assert!(c.body.contains("EDGE <-> EMQX: \"跨网 MQTT 通道\""), "{}", c.body);
    }

    /// 带内联标签的双向边（Mermaid 文档里的 `<-- 文本 -->`）。
    #[test]
    fn inline_labelled_bidirectional_arrow() {
        let c = mermaid_to_dot("flowchart TD\n    C <-- 是 --> D\n").unwrap();
        assert!(c.body.contains("C -> D [label=\"是\", dir=both];"), "{}", c.body);
        assert!(mermaid_to_d2("flowchart TD\n    C <-- 是 --> D\n").unwrap().body.contains("C <-> D: \"是\""));
    }

    /// 节点上的**内联类名** `:::cls`：与 `class A cls` 完全等价。
    ///
    /// 真实语料（`service/var/例子-智控平台应用部署…​.mmd`）里 11 个节点用这种写法，
    /// 修复前**整份文件转不出来**：`:::` 没进词法，被当成「第 26 行：语句尾部有没
    /// 解析完的内容」，用户看到的是与真实原因无关的报错。三个断言各钉一件事：
    /// ① 能转（不再报末尾残留）；② 样式真的挂上了；③ 声明时是裸 id 也要认。
    #[test]
    fn inline_class_suffix_is_parsed_and_applied() {
        let src = "flowchart LR\n    classDef user fill:#dbeafe,stroke:#2563eb\n    A([开始]):::user\n    B[中间]:::user --> C[结束]\n";

        let c = mermaid_to_dot(src).unwrap();
        // ① 不再报「尾部有没解析完的内容」（能到这一步就是转成功了）
        assert!(c.body.contains("digraph"), "{}", c.body);
        // ② 样式挂到两个节点上（fill 是 #dbeafe）
        let dbeafe = c.body.matches("dbeafe").count();
        assert!(dbeafe >= 2, "内联类名没生效，只出现 {} 次 fillColor：{}", dbeafe, c.body);
        // ③ 裸 id + `:::`（B 那一行是 `B[中间]:::user`，A 是 `A([开始]):::user`，两者都要挂上）

        let d = mermaid_to_d2(src).unwrap();
        assert!(d.body.contains("classes: {"), "{}", d.body);
        // D2 侧：节点挂 `.class`
        assert!(d.body.contains("A.class: user"), "{}", d.body);
        assert!(d.body.contains("B.class: user"), "{}", d.body);
    }

    /// 类名里带连字符（`:::lvl-entry`）：**不能**被当成边箭头切碎。
    ///
    /// 自动配色的角色类名就是 `lvl-*`，这个洞会让「AI 写角色」整条链路在解析层就失败。
    #[test]
    fn inline_class_names_may_contain_hyphens() {
        let src = "flowchart TD\n    A([开始]):::lvl-entry --> C{是否通过?}:::lvl-decide\n    C --> D:::lvl-main\n";
        let facts = flow_facts(src).expect("带连字符的类名必须能解析");
        let by_id: std::collections::HashMap<&str, Vec<String>> =
            facts.nodes.iter().map(|n| (n.id.as_str(), n.classes.clone())).collect();
        assert_eq!(by_id["A"], vec!["lvl-entry"]);
        assert_eq!(by_id["C"], vec!["lvl-decide"]);
        assert_eq!(by_id["D"], vec!["lvl-main"]);
        // 转换那条路也顺带稳住（它用的是同一个 parse）
        assert!(mermaid_to_dot(src).is_ok());
    }

    /// `:::a,b` 多类名：DOT 全挂上；D2 的 `.class` 是单值，只挂第一个并**如实进 notes**。
    #[test]
    fn inline_multiple_classes() {
        let src = "flowchart LR\n    classDef a fill:#111111\n    classDef b fill:#222222\n    X[叶子]:::a,b\n";
        let c = mermaid_to_dot(src).unwrap();
        assert!(c.body.contains("111111") && c.body.contains("222222"), "DOT 两个类都该挂上：{}", c.body);
        let d = mermaid_to_d2(src).unwrap();
        assert!(d.body.contains("X.class: a"), "{}", d.body);
        assert!(
            d.notes.iter().any(|n| n.contains("内联类名")),
            "多类名被截断却没进 notes：{:?}",
            d.notes
        );
    }

    /// `:::` 后面跟着箭头时，不能把箭头吃进类名（`A["x"]:::c --> B`）。
    #[test]
    fn inline_class_does_not_swallow_the_arrow() {
        let src = "flowchart LR\n    classDef c fill:#333333\n    A[\"x\"]:::c --> B\n";
        let c = mermaid_to_dot(src).unwrap();
        assert!(c.body.contains("A -> B"), "箭头被类名吃掉了：{}", c.body);
        assert!(c.body.contains("333333"), "类名没挂上：{}", c.body);
    }

    /// `o--o` / `x--x`：两端分别是圆圈与叉，DOT / D2 都没有对应端点形状 ——
    /// 退化成不带端点，并逐条记进 notes（不静默丢）。
    #[test]
    fn circle_and_cross_ends_degrade_and_are_noted() {
        let c = mermaid_to_dot("flowchart LR\n    A o--o B\n    C x--x D\n").unwrap();
        assert!(c.body.contains("A -> B [dir=none];"), "{}", c.body);
        assert!(c.body.contains("C -> D [dir=none];"), "{}", c.body);
        assert!(c.notes.iter().any(|n| n.contains("圆圈")), "{:?}", c.notes);
        assert!(c.notes.iter().any(|n| n.contains("叉")), "{:?}", c.notes);

        let c = mermaid_to_d2("flowchart LR\n    A o--o B\n    C x--x D\n").unwrap();
        assert!(c.body.contains("A -- B"), "{}", c.body);
        assert!(c.body.contains("C -- D"), "{}", c.body);
        assert!(c.notes.iter().any(|n| n.contains("圆圈")), "{:?}", c.notes);
    }

    /// 单端点的 `--o` / `--x`（Mermaid 的末位字符判定）。
    #[test]
    fn single_sided_end_marker() {
        let c = mermaid_to_dot("flowchart LR\n    A --o B\n    C --x D\n").unwrap();
        assert!(c.body.contains("A -> B [dir=none];"), "{}", c.body);
        assert!(c.body.contains("C -> D [dir=none];"), "{}", c.body);
    }

    /// 首尾不同款时按 Mermaid 自己的判定走（`IUt`：只有首位 `<` / `o` / `x` 与末位同款
    /// 才算「两端都有」）—— `x--o` 就只认目标端的圆圈，首位丢掉；`<--` 连端点都没有
    /// （Mermaid 也把它画成一条没有箭头的线）。
    #[test]
    fn mismatched_end_markers_follow_mermaid() {
        let c = mermaid_to_dot("flowchart LR\n    A x--o B\n").unwrap();
        assert!(c.body.contains("A -> B [dir=none];"), "{}", c.body);
        // `<--` 的 `<` 在 Mermaid 里不产生端点，但两个字符的 `--` 我们的词法不认 ⇒ 明确报错
        let e = mermaid_to_dot("flowchart LR\n    A <-- B\n").unwrap_err();
        assert!(e.contains("第 2 行"), "{e}");
    }

    /// 加长连接件：`--->` / `====>` / `-..->`（Mermaid 允许重复连接件字符把线拉长）。
    ///
    /// 修前词法是**枚举固定 token**：`===>` 只吃到 `===`、剩下的 `>` 被当成节点名的开头，
    /// 于是真实语料里 `DP ===>|"发布至服务网关"| DDM` 整行报「看不懂的语句」。
    #[test]
    fn longer_links_are_recognised_not_split() {
        let c = mermaid_to_dot(
            "flowchart LR\n    A ---> B\n    B ===>|发布| C\n    C -..-> D\n    D --> E\n",
        )
        .unwrap();
        assert!(c.body.contains("A -> B;"), "{}", c.body);
        assert!(c.body.contains("B -> C [label=\"发布\", penwidth=2];"), "{}", c.body);
        assert!(c.body.contains("C -> D [style=\"dotted\"];"), "{}", c.body);
        assert!(c.body.contains("D -> E;"), "{}", c.body);
    }

    /// 管道标签允许成对引号（`-->|"带 空格 的标签"|`）：引号是定界，不该画进标签。
    #[test]
    fn quoted_pipe_label_drops_the_quotes() {
        let c = mermaid_to_dot("flowchart LR\n    A -->|\"发布至服务网关\"| B\n").unwrap();
        assert!(c.body.contains("A -> B [label=\"发布至服务网关\"];"), "{}", c.body);
    }

    /// `&` 多源 / 多目标：`A --> B & C` 是两条边，`A & B --> C` 也是两条。
    ///
    /// 修前这一行直接报「`&` 多源/多目标语法尚未支持」，整份文件转不出来。
    #[test]
    fn ampersand_expands_to_one_edge_per_pair() {
        let c = mermaid_to_dot("flowchart TB\n    A --> B & C\n    C & B --> D\n").unwrap();
        for e in ["A -> B", "A -> C", "B -> D", "C -> D"] {
            assert!(c.body.contains(&format!("{e};")) || c.body.contains(&format!("{e} ")), "缺 {e}：{}", c.body);
        }
        // 每个端点只声明一次
        assert_eq!(c.body.matches("B [shape=").count(), 1, "{}", c.body);
        assert_eq!(c.body.matches("C [shape=").count(), 1, "{}", c.body);
    }

    /// 只有端点、没有边的 `A & B`：能当两条声明，且**不能 panic**
    /// （之前边与操作数同下标取用，这种行会越界）。
    #[test]
    fn bare_multi_node_line_declares_both_without_panicking() {
        let c = mermaid_to_dot("flowchart LR\n    A & B\n").unwrap();
        assert!(c.body.contains("A [") && c.body.contains("B ["), "{}", c.body);
        let d = mermaid_to_d2("flowchart LR\n    A & B\n").unwrap();
        assert!(d.body.contains('A') && d.body.contains('B'), "{}", d.body);
    }

    /// `subgraph id ["标题"]`：id 是引用名、标题是画在框上的字，两者不能混成一个。
    /// 容器到容器的边只能靠 `compound` + `ltail`/`lhead` 落到簇边界上，
    /// 而且**不能**因此多出两个同名占位节点。
    #[test]
    fn subgraph_id_and_label_are_separate_and_cluster_edges_use_compound() {
        let src = "flowchart TB\n    subgraph L_ONE [\"组 一\"]\n        A\n    end\n    subgraph L_TWO\n        B\n    end\n    L_ONE -.-> L_TWO\n";
        let c = mermaid_to_dot(src).unwrap();
        assert!(c.body.contains("label=\"组 一\";"), "标题没落到 cluster label：{}", c.body);
        assert!(c.body.contains("compound=true;"), "{}", c.body);
        assert!(c.body.contains("ltail=cluster_") && c.body.contains("lhead=cluster_"), "{}", c.body);
        assert!(!c.body.contains("L_ONE ["), "subgraph id 被当成节点又声明了一次：{}", c.body);

        let d = mermaid_to_d2(src).unwrap();
        assert!(d.body.contains("L_ONE: \"组 一\" {"), "{}", d.body);
        // `-.->` 是带目标的虚线：D2 里箭头仍是 `->`，虚线靠 style.stroke-dash
        assert!(d.body.contains("L_ONE -> L_TWO { style.stroke-dash: 3 }"), "{}", d.body);
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

    /// 标签正文里带闭合符号（`byte[]`）时不能把标签从中截断。
    ///
    /// 真实语料（`design/用户点击复制或保存图片流程图.mmd`）里就有
    /// `C -->|是| D["直接返回缓存 byte[]<br/>（O(1)，无 CLI 调用）"]`，
    /// 直接 `find(']')` 会截在 `byte[` 后面，整条边报「尾部有没解析完的内容」。
    #[test]
    fn a_label_may_contain_the_closing_bracket() {
        let src = "flowchart TD\n    C -->|是| D[\"缓存 byte[]，无调用\"] --> E\n";
        let c = mermaid_to_dot(src).unwrap();
        assert!(c.body.contains("缓存 byte[]，无调用"), "标签被截断了：{}", c.body);
        assert!(c.body.contains("C -> D"), "{}", c.body);
        assert!(c.body.contains("D -> E"), "{}", c.body);
        // 边标签也要在
        assert!(c.body.contains("是"), "{}", c.body);
    }

    /// 撇号开头的普通标签不能被当成「引号包裹」。
    /// 撇号不是引号起始：`A['quoted] --> B` 必须整段当成标签（含撇号），
    /// 不能把 `'` 当引号起点导致标签被截断/边丢失。
    #[test]
    fn a_plain_label_starting_with_an_apostrophe_is_fine() {
        let c = mermaid_to_dot("flowchart TD\n    A['quoted] --> B\n").unwrap();
        // 标签必须完整保留撇号与右侧（`'quoted` 不能在半截 `'` 处被吞）。
        assert!(c.body.contains("'quoted"), "标签要整段保留撇号: {}", c.body);
        // 节点与边都要完整，不能被吞。
        assert!(c.body.contains("A [label="), "节点 A 的标签要保留: {}", c.body);
        assert!(c.body.contains("B ["), "节点 B 不能丢: {}", c.body);
        assert!(c.body.contains("A -> B;"), "边不能丢: {}", c.body);
    }

    /// 带 BOM 的源文件要能解析（Windows 记事本默认就这么存）。
    #[test]
    fn a_leading_bom_does_not_break_the_header() {
        let c = mermaid_to_dot("\u{feff}flowchart TD\n    A --> B\n").unwrap();
        assert!(c.body.contains("A -> B;"), "{}", c.body);
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

    /// B3：D2 导出不得静默丢节点。孤立节点（无边、无标签、默认方框）也必须出现在产物里。
    ///
    /// 这是回归测试：修之前 `emit_node` 四项全空时一行不写，`Z` 会整个消失且 notes 不提示。
    #[test]
    fn d2_does_not_drop_isolated_nodes() {
        // 裸节点
        let c = mermaid_to_d2("flowchart TD\n    A --> B\n    Z\n").unwrap();
        assert!(c.body.contains("Z"), "裸节点 Z 未出现在 D2 产物：\n{}", c.body);
        // 空方括号
        let c = mermaid_to_d2("flowchart TD\n    A --> B\n    Z[]\n").unwrap();
        assert!(c.body.contains("Z"), "空方括号 Z[] 被丢：\n{}", c.body);
        // 空引号标签
        let c = mermaid_to_d2("flowchart TD\n    A --> B\n    Z[\"\"]\n").unwrap();
        assert!(c.body.contains("Z"), "空引号标签 Z[\"\"] 被丢：\n{}", c.body);
        // subgraph 内的孤立节点
        let c = mermaid_to_d2("flowchart TD\n    A --> B\n    subgraph g\n        L\n        M\n    end\n").unwrap();
        let inside = c.body;
        assert!(inside.contains("L"), "subgraph 内孤立节点 L 被丢：\n{}", inside);
        assert!(inside.contains("M"), "subgraph 内孤立节点 M 被丢：\n{}", inside);
    }

    /// B3 对照组：有标签 / 有非默认形状的节点必须照旧保留（不能被裸 id 逻辑弄乱）。
    #[test]
    fn d2_keeps_labeled_and_shaped_nodes() {
        let c = mermaid_to_d2("flowchart TD\n    A --> B\n    Z[\"说明\"]\n    O{决策}\n").unwrap();
        assert!(c.body.contains("Z: \"说明\"") || c.body.contains("Z"), "有标签节点 Z：\n{}", c.body);
        assert!(c.body.contains("O.shape: diamond"), "决策节点 O 的形状丢了：\n{}", c.body);
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

    /// DOT 的关键字**大小写无关**，裸写会被当成语句关键字 —— `AI1 -> EDGE` 是语法错
    /// （graphviz：`syntax error near 'EDGE'`）。叫 `EDGE` / `graph` 的节点必须加引号。
    #[test]
    fn dot_keyword_ids_are_quoted() {
        let c = mermaid_to_dot("flowchart LR\n    AI1 --> EDGE\n    graph --> strict\n").unwrap();
        assert!(c.body.contains("AI1 -> \"EDGE\";"), "{}", c.body);
        assert!(c.body.contains("\"graph\" -> \"strict\";"), "{}", c.body);
        // 只是前缀像关键字的照旧裸写
        let c = mermaid_to_dot("flowchart LR\n    graph1 --> edge2\n").unwrap();
        assert!(c.body.contains("graph1 -> edge2;"), "{}", c.body);
    }

    /// D2 的 `stroke-width` 只吃 **0–15 的整数**，而 mermaid 写的是 `2px` / `1.5px` ——
    /// 直接搬过去（带 px 的字符串、或小数）D2 编译不过。
    #[test]
    fn d2_stroke_width_is_stripped_and_rounded() {
        let c = mermaid_to_d2("flowchart LR\n    classDef a stroke-width:1.5px\n    A --> B\n")
            .unwrap();
        assert!(c.body.contains("stroke-width: 2"), "{}", c.body);
        assert!(c.notes.iter().any(|n| n.contains("1.5px")), "{:?}", c.notes);

        // 超过 D2 上限的按上限收，且照样写进 notes
        let c = mermaid_to_d2("flowchart LR\n    classDef a stroke-width:20px\n    A --> B\n")
            .unwrap();
        assert!(c.body.contains("stroke-width: 15"), "{}", c.body);
        assert!(c.notes.iter().any(|n| n.contains("20px")), "{:?}", c.notes);

        // 整数原样带走，不产生多余的 notes
        let c = mermaid_to_d2("flowchart LR\n    classDef a stroke-width:2px\n    A --> B\n")
            .unwrap();
        assert!(c.body.contains("stroke-width: 2"), "{}", c.body);
        assert!(!c.notes.iter().any(|n| n.contains("stroke-width")), "{:?}", c.notes);
    }
}
