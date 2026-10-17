//! D2 的行级语法片段：剥注释、认容器、取边的端点。
//!
//! **为什么不各写一份**：`scope` / `outline` / `lint` 看的是同一份正文，
//! 三处各抄一段"剥注释 + 认容器"的代码，加语法变体时必然漂。D2 这一层刻意**没有 AST**
//! （与 lint 里其它文本格式同一策略：行式扫描、可预测、不会因为一个语法变体整页空白），
//! 于是共享这一小层的收益最大。真正的语法错交给 D2 的 wasm 编译器报（它带行列号）。
//!
//! ⚠️ 剥注释必须**认引号**：D2 里 `style.fill: "#f00"` 是常规写法，
//! 按"见到 `#` 就截断"处理会把 `#f00` 前面的引号留下，于是每份带颜色的文档都报一次
//! 「引号没有闭合」—— 假报警会把问题面板变成噪音。

/// D2 的保留字：它们开的块是**属性块**（`classes: { … }`），不是图里的容器。
/// `outline` 不把它们当容器、`scope` 不把它们当作用域。
pub(crate) const KEYWORDS: [&str; 9] = [
    "classes", "vars", "layers", "scenarios", "steps", "style", "direction", "title", "label",
];

pub(crate) fn is_keyword(name: &str) -> bool {
    KEYWORDS.contains(&name)
}

/// 去掉行内的 `#` 注释；引号内的 `#` 是正文（颜色值），不能当注释起点。
pub(crate) fn strip_comment(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut in_quote = false;
    let mut escaped = false;
    for c in line.chars() {
        if escaped {
            out.push(c);
            escaped = false;
            continue;
        }
        match c {
            '\\' if in_quote => {
                out.push(c);
                escaped = true;
            }
            '"' => {
                in_quote = !in_quote;
                out.push(c);
            }
            '#' if !in_quote => break,
            _ => out.push(c),
        }
    }
    out
}

/// 这一行是不是"开了一个块"：`名: {`（或裸 `{`）。返回容器名；裸块返回 `"(匿名)"`。
///
/// 一行内既开又关（`名: { a -> b }`）不算 —— 那种行不改变缩进层级。
pub(crate) fn container_name(text: &str) -> Option<String> {
    if !text.ends_with('{') {
        return None;
    }
    let head = text.trim_end_matches('{').trim().trim_end_matches(':').trim();
    let name = head.trim_matches('"').trim();
    if name.is_empty() {
        return Some("(匿名)".to_string());
    }
    if name.contains(char::is_whitespace) {
        // `footnote: 说明 {` 之类：取最后一个词之外的部分都不可靠，宁可当普通行
        return Some(name.to_string());
    }
    Some(name.to_string())
}

/// 这一行里有连接符（`->` / `<-` / `<->` / `--`）。
pub(crate) fn is_edge(text: &str) -> bool {
    text.contains("->") || text.contains("<-") || text.contains("--")
}

/// 边的两端（链式 `a -> b -> c` 会给出三个）。
///
/// 标签（`a -> b: 说明`）先切掉，避免把标签里的 `-` 当连接符。
pub(crate) fn edge_endpoints(text: &str) -> Vec<String> {
    // 没有连接符就不是边：`a: 标签` 这种行切完标签只剩裸 `a`，会吐出一个假端点。
    if !is_edge(text) {
        return Vec::new();
    }
    let body = match text.split_once(':') {
        Some((head, _)) => head,
        None => text,
    };
    body.replace("<->", "->")
        .replace("--", "->")
        .split("->")
        .map(|s| s.trim().trim_matches('"').trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/* ---------------- 写入方向：转义与健壮的名字 ---------------- */

/// D2 的保留字：写成裸字会被当成属性键，不是节点名。
pub(crate) const RESERVED: &[&str] = &[
    "direction", "shape", "style", "label", "icon", "near", "tooltip", "link", "class", "classes",
    "vars", "title", "layers", "scenarios", "steps", "constraint", "width", "height",
    "source-arrowhead", "target-arrowhead",
];

/// D2 字符串字面量：**一律加引号**。
///
/// 标签里出现 `#`（D2 的注释符）、`{`、`;`、`->` 时裸写都会被解析成别的东西，
/// 引号是唯一处处安全的写法（`style.fill` 的颜色值同理）。
pub(crate) fn d2_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// 一个名字在 D2 里能不能裸写；不能就加引号。
///
/// D2 的 `.` 是路径分隔符，而 Mermaid 的 id 允许 `.`（`a.b` 裸写会被当成「容器 a 里的 b」）；
/// 保留字、带空格与标点的 id 同理。中文裸写是合法的（`前端应用` 不需要引号）。
pub(crate) fn d2_id(id: &str) -> String {
    let bare = !id.is_empty()
        && id.chars().all(|c| c.is_alphanumeric() || c == '_')
        && !RESERVED.contains(&id);
    if bare { id.to_string() } else { d2_str(id) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comment_stripping_respects_quotes() {
        // 颜色值里的 `#` 不是注释
        // 颜色值 `"#f00"` 里的 `"#` 会提前终止 `r#"…"#`，故用 `r##"…"##`
        assert_eq!(strip_comment(r##"a.style.fill: "#f00" # 真的注释"##).trim(), r##"a.style.fill: "#f00""##);
        assert_eq!(strip_comment("x -> y: 说明").trim(), "x -> y: 说明");
        assert_eq!(strip_comment(r#"a: "含 \" 引号""#).trim(), r#"a: "含 \" 引号""#);
    }

    #[test]
    fn container_name_reads_the_head_before_the_brace() {
        assert_eq!(container_name("集成层: {"), Some("集成层".to_string()));
        assert_eq!(container_name("组{"), Some("组".to_string()));
        assert_eq!(container_name("{"), Some("(匿名)".to_string()));
        // 一行既开又关：不改变层级
        assert_eq!(container_name("组: { a -> b }"), None);
        assert_eq!(container_name("a -> b"), None);
    }

    #[test]
    fn edge_endpoints_handle_chains_arrows_and_labels() {
        assert_eq!(edge_endpoints("a -> b: 标签"), vec!["a", "b"]);
        assert_eq!(edge_endpoints("a -> b -> c"), vec!["a", "b", "c"]);
        assert_eq!(edge_endpoints("a <-> b"), vec!["a", "b"]);
        assert_eq!(edge_endpoints("a -- b"), vec!["a", "b"]);
        assert_eq!(edge_endpoints("a: 标签"), Vec::<String>::new());
    }

    #[test]
    fn ids_are_quoted_only_when_needed() {
        assert_eq!(d2_id("网关"), "网关");
        assert_eq!(d2_id("user_1"), "user_1");
        assert_eq!(d2_id("shape"), "\"shape\"", "保留字要加引号");
        assert_eq!(d2_id("a.b"), "\"a.b\"", "点号是路径分隔符，不能裸写");
        assert_eq!(d2_id("两 个词"), "\"两 个词\"");
        assert_eq!(d2_str("行1\n行2"), "\"行1\\n行2\"");
        assert_eq!(d2_str(r#"含 " 引号"#), r#""含 \" 引号""#);
    }
}

