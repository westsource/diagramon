//! 源码格式化：把缩进混乱 / 行尾空白 / 空行堆叠的正文整理成可读形式。
//!
//! **只动空白，不动语义**：
//! - Mermaid / D2：按结构（`subgraph`…`end`、`else`、花括号）重算行首缩进；
//!   前者 4 空格，后者 2 空格 —— 两者都是官方示例的写法。
//! - DOT：DOT 的空白在字符串/HTML 标签之外完全无意义，所以走词法级重排
//!   （一行一条语句、属性表内联、子图缩进），这也是 `dot -Tcanon` 那一类工具的常规做法。
//! - 画布型（drawio / excalidraw）：画布即编辑器，界面在调到这里之前就拦下了；
//!   这里返回原文，绝不静默改动画布数据。
//!
//! 引号内的内容（含跨行标签）、YAML frontmatter、D2 的 `|md` 块字符串一律逐字节保留 ——
//! 这些地方的空白**是内容**，改了就改语义。这也是本模块按行/按词处理、不硬造 AST 的原因：
//! 语法变体只会让"不重排"，不会让正文被改坏。

use app_ipc::{FormatId, FormatOutcome};

/// 格式化入口。`changed=false` ⇒ 输出与输入逐字节相同。
pub fn format_body(format: FormatId, body: &str) -> FormatOutcome {
    let out = match format {
        FormatId::Mermaid => mermaid(body),
        FormatId::Dot => dot(body),
        FormatId::D2 => d2(body),
        FormatId::Drawio | FormatId::Excalidraw => body.to_string(),
    };
    FormatOutcome { changed: out != body, body: out }
}

fn normalize_eol(body: &str) -> String {
    body.replace("\r\n", "\n").replace('\r', "\n")
}

/// 一行正文。`raw` ⇒ 这一行的空白是内容（frontmatter / 跨行字符串 / 块字符串），
/// 后面任何一步都不许 trim 或重排。
#[derive(Clone)]
struct Line {
    text: String,
    raw: bool,
}

impl Line {
    fn text(text: &str) -> Self {
        Self { text: text.to_string(), raw: false }
    }
    fn raw(text: &str) -> Self {
        Self { text: text.to_string(), raw: true }
    }
}

/// 收尾：行尾空白、空行堆叠、结尾换行。正文为空时输出空串（不凭空造一个 `\n`）。
fn finish(lines: Vec<Line>) -> String {
    let mut out: Vec<Line> = Vec::new();
    let mut prev_blank = false;
    let mut started = false;
    for mut line in lines {
        if line.raw {
            started = true;
            out.push(line);
            prev_blank = false;
            continue;
        }
        line.text = line.text.trim_end().to_string();
        if line.text.is_empty() {
            if !started || prev_blank {
                continue;
            }
            out.push(line);
            prev_blank = true;
            continue;
        }
        started = true;
        prev_blank = false;
        out.push(line);
    }
    while out.last().map(|l| !l.raw && l.text.is_empty()).unwrap_or(false) {
        out.pop();
    }
    if out.is_empty() {
        return String::new();
    }
    let mut s = out.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n");
    s.push('\n');
    s
}

/* ------------------------------------------------------------------ Mermaid */

const MERMAID_INDENT: usize = 4;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Diagram {
    /// `flowchart` / `graph`：只有 `subgraph`…`end` 改变层级。
    Flow,
    /// `sequenceDiagram`：`loop/alt/opt/par/rect/critical/break/box`…`end`。
    Sequence,
    /// `classDiagram` / `stateDiagram` / `erDiagram`：花括号。
    Braces,
    /// 其余图种（gantt / pie / mindmap / …）：缩进不重排，只做收尾清理。
    Other,
}

fn mermaid(body: &str) -> String {
    let src = normalize_eol(body);
    let raw: Vec<&str> = src.split('\n').collect();
    let mut lines: Vec<Line> = Vec::new();
    let mut i = 0usize;
    // YAML frontmatter 的缩进是语法，整段逐字节保留。
    if raw.first().map(|l| l.trim_end() == "---").unwrap_or(false) {
        if let Some(end) = (1..raw.len()).find(|&j| raw[j].trim_end() == "---") {
            for line in raw.iter().take(end + 1) {
                lines.push(Line::raw(line));
            }
            i = end + 1;
        }
    }
    let diagram = mermaid_diagram(&raw[i..]);
    let mut depth: usize = 0;
    let mut in_string = false;
    while i < raw.len() {
        let line = raw[i];
        i += 1;
        if in_string {
            lines.push(Line::raw(line));
            scan_quotes(line, &mut in_string);
            continue;
        }
        let structure = strip_mermaid_comment(line);
        if diagram == Diagram::Other {
            // 不认识的图种：保留原缩进，只做行尾空白/空行/结尾换行
            lines.push(Line::text(line.trim_end()));
            scan_quotes(&structure, &mut in_string);
            continue;
        }
        let head = structure.trim();
        let (line_depth, next_depth) = match diagram {
            Diagram::Flow => flow_step(head, depth),
            Diagram::Sequence => sequence_step(head, depth),
            Diagram::Braces => braces_step(head, depth),
            Diagram::Other => (depth, depth),
        };
        depth = next_depth;
        let text = line.trim();
        if text.is_empty() {
            lines.push(Line::text(""));
        } else {
            lines.push(Line::text(&format!(
                "{}{}",
                " ".repeat(line_depth * MERMAID_INDENT),
                text
            )));
        }
        scan_quotes(&structure, &mut in_string);
    }
    finish(lines)
}

fn mermaid_diagram(lines: &[&str]) -> Diagram {
    for line in lines {
        let s = strip_mermaid_comment(line);
        let head = s.trim();
        if head.is_empty() {
            continue;
        }
        let kw = head.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
        return match kw.as_str() {
            "flowchart" | "graph" => Diagram::Flow,
            "sequencediagram" => Diagram::Sequence,
            "classdiagram" | "statediagram" | "statediagram-v2" | "erdiagram" => Diagram::Braces,
            _ => Diagram::Other,
        };
    }
    Diagram::Other
}

fn flow_step(head: &str, depth: usize) -> (usize, usize) {
    if head == "end" {
        let d = depth.saturating_sub(1);
        return (d, d);
    }
    if starts_kw(head, "subgraph") && !has_arrow(head) {
        return (depth, depth + 1);
    }
    (depth, depth)
}

const SEQ_OPENERS: [&str; 8] = ["loop", "alt", "opt", "par", "rect", "critical", "break", "box"];
const SEQ_MIDDLES: [&str; 4] = ["else", "and", "option", "branch"];

fn sequence_step(head: &str, depth: usize) -> (usize, usize) {
    if head == "end" {
        let d = depth.saturating_sub(1);
        return (d, d);
    }
    if SEQ_MIDDLES.iter().any(|k| starts_kw(head, k)) {
        // `else` / `and` / `option` 与开块那行同层，块内层级不变
        return (depth.saturating_sub(1), depth);
    }
    if SEQ_OPENERS.iter().any(|k| starts_kw(head, k)) && !has_arrow(head) {
        return (depth, depth + 1);
    }
    (depth, depth)
}

fn braces_step(head: &str, depth: usize) -> (usize, usize) {
    let (lead_close, net) = brace_delta(head);
    let line_depth = depth.saturating_sub(lead_close);
    let next = (depth as isize + net).max(0) as usize;
    (line_depth, next)
}

/// 关键词必须独立成词：`subgraph x` 算，`subgraphx` 不算。
fn starts_kw(head: &str, kw: &str) -> bool {
    head == kw || head.starts_with(&format!("{kw} ")) || head.starts_with(&format!("{kw}\t"))
}

/// 这一行里有没有连接符。有连接符的行不是块开头 —— 否则 `alt --> B` 这类节点行
/// 会被当成 `alt` 语句块，后面的缩进全部错位。
fn has_arrow(s: &str) -> bool {
    ["-->", "--x", "--o", "-.->", "==>", "~~~", "->>", "-->>", "->", "<-", "--"]
        .iter()
        .any(|a| s.contains(a))
}

/// 去掉 Mermaid 的 `%%` 注释（引号里的 `%%` 是正文）。
fn strip_mermaid_comment(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut in_quote = false;
    let mut escaped = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quote {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_quote = false;
            }
            continue;
        }
        if c == '"' {
            in_quote = true;
            out.push(c);
            continue;
        }
        if c == '%' && chars.peek() == Some(&'%') {
            break;
        }
        out.push(c);
    }
    out
}

/// 跨行引号状态（`A["第一行` + 换行 + `第二行"]` 从 mermaid 10.x 起合法）。
fn scan_quotes(line: &str, in_string: &mut bool) {
    let mut escaped = false;
    for c in line.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' => escaped = true,
            '"' => *in_string = !*in_string,
            _ => {}
        }
    }
}

/// 引号感知的花括号计数：返回（行首连续 `}` 的个数，整行净增量）。
fn brace_delta(s: &str) -> (usize, isize) {
    let mut lead_close = 0usize;
    let mut opens = 0isize;
    let mut closes = 0isize;
    let mut seen_content = false;
    let mut in_quote = false;
    let mut escaped = false;
    for c in s.chars() {
        if in_quote {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_quote = false;
            }
            continue;
        }
        match c {
            '"' => in_quote = true,
            '{' => {
                opens += 1;
                seen_content = true;
            }
            '}' => {
                closes += 1;
                if !seen_content {
                    lead_close += 1;
                }
            }
            _ => {
                if !c.is_whitespace() {
                    seen_content = true;
                }
            }
        }
    }
    (lead_close, opens - closes)
}

/* ------------------------------------------------------------------ D2 */

const D2_INDENT: usize = 2;

fn d2(body: &str) -> String {
    let src = normalize_eol(body);
    let raw: Vec<&str> = src.split('\n').collect();
    let mut lines = Vec::new();
    let mut depth: usize = 0;
    let mut in_block = false;
    let mut in_string = false;
    for line in raw {
        if in_block {
            // `|md` 块里的空白（尤其缩进）是内容
            lines.push(Line::raw(line));
            if line.trim() == "|" {
                in_block = false;
            }
            continue;
        }
        if in_string {
            lines.push(Line::raw(line));
            scan_quotes(line, &mut in_string);
            continue;
        }
        let structure = crate::d2syntax::strip_comment(line);
        let head = structure.trim();
        if opens_block_string(head) {
            let text = line.trim();
            lines.push(Line::text(&format!(
                "{}{}",
                " ".repeat(depth * D2_INDENT),
                text
            )));
            scan_quotes(&structure, &mut in_string);
            in_block = true;
            continue;
        }
        let (lead_close, net) = brace_delta(head);
        let line_depth = depth.saturating_sub(lead_close);
        depth = (depth as isize + net).max(0) as usize;
        let text = line.trim();
        if text.is_empty() {
            lines.push(Line::text(""));
        } else {
            lines.push(Line::text(&format!(
                "{}{}",
                " ".repeat(line_depth * D2_INDENT),
                text
            )));
        }
        scan_quotes(&structure, &mut in_string);
    }
    finish(lines)
}

/// 这一行是不是在开一个块字符串：`x: |md` / `x: |`（`|` 必须在值的位置）。
fn opens_block_string(head: &str) -> bool {
    let Some(pos) = last_unquoted(head, '|') else {
        return false;
    };
    let tail = &head[pos + 1..];
    if !tail.chars().all(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    head[..pos].trim_end().ends_with(':')
}

fn last_unquoted(s: &str, target: char) -> Option<usize> {
    let mut found = None;
    let mut in_quote = false;
    let mut escaped = false;
    for (i, c) in s.char_indices() {
        if in_quote {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_quote = false;
            }
            continue;
        }
        if c == '"' {
            in_quote = true;
        } else if c == target {
            found = Some(i);
        }
    }
    found
}

/* ------------------------------------------------------------------ Graphviz DOT */

/// DOT 的空白在字符串/HTML 标签之外**不承载语义**，所以这里直接走词法级重排：
/// 一条语句一行、属性表内联、子图缩进 4 空格。字符串、HTML 标签、注释原样搬运。
fn dot(body: &str) -> String {
    let src = normalize_eol(body);
    let toks = dot_tokenize(&src);
    let lines = dot_layout(&toks);
    finish(lines)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum DotKind {
    Word,
    Str,
    Html,
    LineComment,
    BlockComment,
    /// `#` 开头的预处理器行（DOT 要求它在行首）
    Sharp,
    Edge,
    LBrace,
    RBrace,
    LBracket,
    RBracket,
    Semi,
    Comma,
    Eq,
    Colon,
    Plus,
    Newline,
    Other,
}

struct DotTok {
    kind: DotKind,
    text: String,
}

fn dot_tokenize(src: &str) -> Vec<DotTok> {
    let mut out = Vec::new();
    let len = src.len();
    let mut i = 0usize;
    while i < len {
        let c = src[i..].chars().next().unwrap();
        let rest = &src[i..];
        if c == '\n' {
            out.push(DotTok { kind: DotKind::Newline, text: "\n".into() });
            i += 1;
            continue;
        }
        if c == ' ' || c == '\t' || c == '\r' {
            i += 1;
            continue;
        }
        if rest.starts_with("//") {
            let end = rest.find('\n').map(|p| i + p).unwrap_or(len);
            out.push(DotTok { kind: DotKind::LineComment, text: src[i..end].into() });
            i = end;
            continue;
        }
        if rest.starts_with("/*") {
            let end = rest[2..].find("*/").map(|p| i + 2 + p + 2).unwrap_or(len);
            out.push(DotTok { kind: DotKind::BlockComment, text: src[i..end].into() });
            i = end;
            continue;
        }
        if c == '#' {
            let end = rest.find('\n').map(|p| i + p).unwrap_or(len);
            out.push(DotTok { kind: DotKind::Sharp, text: src[i..end].into() });
            i = end;
            continue;
        }
        if c == '"' {
            let n = scan_quoted(rest);
            out.push(DotTok { kind: DotKind::Str, text: src[i..i + n].into() });
            i += n;
            continue;
        }
        if c == '<' {
            let n = scan_html(rest);
            out.push(DotTok { kind: DotKind::Html, text: src[i..i + n].into() });
            i += n;
            continue;
        }
        if rest.starts_with("->") || rest.starts_with("--") {
            out.push(DotTok { kind: DotKind::Edge, text: src[i..i + 2].into() });
            i += 2;
            continue;
        }
        let punct = match c {
            '{' => Some(DotKind::LBrace),
            '}' => Some(DotKind::RBrace),
            '[' => Some(DotKind::LBracket),
            ']' => Some(DotKind::RBracket),
            ';' => Some(DotKind::Semi),
            ',' => Some(DotKind::Comma),
            '=' => Some(DotKind::Eq),
            ':' => Some(DotKind::Colon),
            '+' => Some(DotKind::Plus),
            _ => None,
        };
        if let Some(kind) = punct {
            out.push(DotTok { kind, text: src[i..i + c.len_utf8()].into() });
            i += c.len_utf8();
            continue;
        }
        // 标识符 / 数字：DOT 的裸 ID 不含空白与标点
        let mut j = i;
        while j < len {
            let ch = src[j..].chars().next().unwrap();
            if ch == '-' {
                // 负数是合法 numeral；`->` / `--` 是连接符
                let tail = &src[j + 1..];
                if tail.starts_with('>') || tail.starts_with('-') {
                    break;
                }
                j += 1;
                continue;
            }
            if ch.is_whitespace()
                || matches!(
                    ch,
                    '{' | '}' | '[' | ']' | ';' | ',' | '=' | ':' | '+' | '"' | '<' | '>' | '#'
                        | '/'
                )
            {
                break;
            }
            j += ch.len_utf8();
        }
        if j == i {
            out.push(DotTok { kind: DotKind::Other, text: src[i..i + c.len_utf8()].into() });
            i += c.len_utf8();
        } else {
            out.push(DotTok { kind: DotKind::Word, text: src[i..j].into() });
            i = j;
        }
    }
    out
}

/// 引号字符串长度（含两端引号）；未闭合时吃到结尾。
fn scan_quoted(s: &str) -> usize {
    let mut chars = s.char_indices();
    chars.next(); // 开引号
    let mut escaped = false;
    for (i, c) in chars {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '"' {
            return i + 1;
        }
    }
    s.len()
}

/// HTML 标签长度。DOT 的 HTML 串用**配对的尖括号**定界（`<<TABLE>…</TABLE>>`），
/// 所以按深度数尖括号；标签属性里的引号、`<!-- -->` 里的尖括号不算。
fn scan_html(s: &str) -> usize {
    let len = s.len();
    let mut i = 0usize;
    let mut depth = 0usize;
    let mut quote: Option<char> = None;
    while i < len {
        if s[i..].starts_with("<!--") {
            match s[i + 4..].find("-->") {
                Some(p) => {
                    i = i + 4 + p + 3;
                    continue;
                }
                None => return len,
            }
        }
        let c = s[i..].chars().next().unwrap();
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
        } else {
            match c {
                '"' | '\'' => quote = Some(c),
                '<' => depth += 1,
                '>' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        return i + 1;
                    }
                }
                _ => {}
            }
        }
        i += c.len_utf8();
    }
    len
}

struct DotOut {
    lines: Vec<Line>,
    cur: String,
    indent: usize,
    in_attrs: bool,
    /// 边端点的花括号集合（`a -> {b c}`）的嵌套层数；>0 时花括号不再开新行
    inline: usize,
    /// 刚输出过一个块的 `}`：紧跟的 `;` 吞掉，不要再空一行
    after_close: bool,
    /// 刚输出过行注释/预处理行：紧跟的换行已经消费过
    after_line_comment: bool,
    prev: Option<DotKind>,
}

impl DotOut {
    fn new() -> Self {
        Self {
            lines: Vec::new(),
            cur: String::new(),
            indent: 0,
            in_attrs: false,
            inline: 0,
            after_close: false,
            after_line_comment: false,
            prev: None,
        }
    }

    fn pad(&self) -> String {
        " ".repeat(self.indent * 4)
    }

    fn flush(&mut self) {
        let text = self.cur.trim_end();
        if !text.is_empty() {
            let line = format!("{}{}", self.pad(), text);
            self.lines.push(Line::text(&line));
        }
        self.cur.clear();
    }

    fn trim_cur(&mut self) {
        self.cur = self.cur.trim_end().to_string();
    }

    fn word(&mut self, s: &str) {
        if !self.cur.is_empty() {
            let last = self.cur.chars().last().unwrap();
            if !matches!(last, ' ' | '[' | '{' | '=' | ':') {
                self.cur.push(' ');
            }
        }
        self.cur.push_str(s);
    }

    fn edge(&mut self, text: &str) {
        self.trim_cur();
        if !self.cur.is_empty() {
            self.cur.push(' ');
        }
        self.cur.push_str(text);
        self.cur.push(' ');
    }

    fn open_brace(&mut self, after_edge: bool) {
        self.trim_cur();
        if !self.cur.is_empty() && !self.cur.ends_with(' ') {
            self.cur.push(' ');
        }
        self.cur.push('{');
        if after_edge || self.inline > 0 {
            self.inline += 1;
        } else {
            self.flush();
            self.indent += 1;
        }
    }

    fn close_brace(&mut self) {
        if self.inline > 0 {
            self.trim_cur();
            self.cur.push('}');
            self.inline -= 1;
        } else {
            self.flush();
            self.indent = self.indent.saturating_sub(1);
            let line = format!("{}}}", self.pad());
            self.lines.push(Line::text(&line));
            self.after_close = true;
        }
    }

    fn open_bracket(&mut self) {
        self.trim_cur();
        if !self.cur.is_empty() {
            self.cur.push(' ');
        }
        self.cur.push('[');
        self.in_attrs = true;
    }

    fn close_bracket(&mut self) {
        self.trim_cur();
        self.cur.push(']');
        self.in_attrs = false;
    }
}

/// 语句开头也可能是**端点集合**：`{a b} -> c`。这种花括号不能当子图块开新行，
/// 判据是配对的那个 `}` 后面紧跟连接符（匿名子图 `{ rank=same; … }` 后面不会）。
fn brace_is_endpoint(toks: &[DotTok], start: usize) -> bool {
    let mut depth = 0i32;
    for (j, t) in toks.iter().enumerate().skip(start) {
        match t.kind {
            DotKind::LBrace => depth += 1,
            DotKind::RBrace => {
                depth -= 1;
                if depth == 0 {
                    let next = toks[j + 1..].iter().find(|t| t.kind != DotKind::Newline);
                    return matches!(next.map(|t| t.kind), Some(DotKind::Edge));
                }
            }
            _ => {}
        }
    }
    false
}

fn dot_layout(toks: &[DotTok]) -> Vec<Line> {
    let mut out = DotOut::new();
    let mut i = 0usize;
    while i < toks.len() {
        let tok = &toks[i];
        if tok.kind == DotKind::Newline {
            i += 1;
            if out.in_attrs {
                continue;
            }
            if out.after_line_comment {
                out.after_line_comment = false;
                continue;
            }
            if out.after_close {
                out.after_close = false;
                continue;
            }
            let next = toks[i..].iter().find(|t| t.kind != DotKind::Newline).map(|t| t.kind);
            let next_continues = matches!(
                next,
                Some(
                    DotKind::Edge
                        | DotKind::LBracket
                        | DotKind::Comma
                        | DotKind::Eq
                        | DotKind::RBracket
                        | DotKind::RBrace
                        | DotKind::Semi
                        | DotKind::BlockComment
                        | DotKind::LineComment
                )
            );
            let prev_continues = matches!(
                out.prev,
                Some(
                    DotKind::Edge
                        | DotKind::LBracket
                        | DotKind::LBrace
                        | DotKind::Comma
                        | DotKind::Eq
                        | DotKind::Colon
                        | DotKind::Plus
                        | DotKind::BlockComment
                )
            );
            let header = {
                let head = out.cur.trim();
                matches!(head, "strict" | "digraph" | "graph" | "subgraph")
                    || (head.starts_with("subgraph ") && !head.contains('{'))
            };
            if next_continues || prev_continues || header {
                continue;
            }
            out.flush();
            continue;
        }
        if out.after_close && tok.kind != DotKind::Semi {
            out.after_close = false;
        }
        match tok.kind {
            DotKind::Word | DotKind::Str | DotKind::Html => out.word(&tok.text),
            DotKind::Edge => out.edge(&tok.text),
            DotKind::LBrace => {
                let endpoint = out.prev == Some(DotKind::Edge) || brace_is_endpoint(toks, i);
                out.open_brace(endpoint);
            }
            DotKind::RBrace => out.close_brace(),
            DotKind::LBracket => out.open_bracket(),
            DotKind::RBracket => out.close_bracket(),
            DotKind::Semi => {
                if out.in_attrs {
                    out.trim_cur();
                    out.cur.push_str(", ");
                } else if out.after_close {
                    out.after_close = false;
                } else {
                    out.flush();
                }
            }
            DotKind::Comma => {
                out.trim_cur();
                out.cur.push_str(if out.in_attrs { ", " } else { " " });
            }
            DotKind::Eq => {
                out.trim_cur();
                out.cur.push('=');
            }
            DotKind::Colon => {
                out.trim_cur();
                out.cur.push(':');
            }
            DotKind::Plus => {
                out.trim_cur();
                out.cur.push_str(" + ");
            }
            DotKind::LineComment => {
                if !out.cur.is_empty() {
                    out.cur.push(' ');
                }
                out.cur.push_str(&tok.text);
                out.flush();
                out.after_line_comment = true;
            }
            DotKind::BlockComment => {
                if !out.cur.is_empty() {
                    out.cur.push(' ');
                }
                out.cur.push_str(&tok.text);
                out.cur.push(' ');
            }
            DotKind::Sharp => {
                out.flush();
                out.lines.push(Line::text(&tok.text));
                out.after_line_comment = true;
            }
            DotKind::Other => out.word(&tok.text),
            DotKind::Newline => {}
        }
        out.prev = Some(tok.kind);
        i += 1;
    }
    out.flush();
    out.lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fmt(format: FormatId, body: &str) -> String {
        format_body(format, body).body
    }

    #[test]
    fn mermaid_reindents_subgraph_with_four_spaces() {
        let src = "flowchart TD\nsubgraph S\nA --> B\nend\n";
        assert_eq!(
            fmt(FormatId::Mermaid, src),
            "flowchart TD\nsubgraph S\n    A --> B\nend\n"
        );
    }

    #[test]
    fn mermaid_sequence_middles_sit_at_block_level() {
        let src = "sequenceDiagram\nalt ok\nA->>B: hi\nelse no\nB->>A: no\nend\n";
        assert_eq!(
            fmt(FormatId::Mermaid, src),
            "sequenceDiagram\nalt ok\n    A->>B: hi\nelse no\n    B->>A: no\nend\n"
        );
    }

    #[test]
    fn mermaid_class_braces_indent() {
        let src = "classDiagram\nclass A {\n+run()\n}\n";
        assert_eq!(
            fmt(FormatId::Mermaid, src),
            "classDiagram\nclass A {\n    +run()\n}\n"
        );
    }

    #[test]
    fn mermaid_frontmatter_is_byte_exact() {
        let src = "---\ntitle: 示例\nconfig:\n  theme: dark\n---\nflowchart TD\nsubgraph S\nA --> B\nend\n";
        assert_eq!(
            fmt(FormatId::Mermaid, src),
            "---\ntitle: 示例\nconfig:\n  theme: dark\n---\nflowchart TD\nsubgraph S\n    A --> B\nend\n"
        );
    }

    #[test]
    fn mermaid_multiline_quote_content_is_untouched() {
        let src = "flowchart TD\nsubgraph S\nA[\"第一行\n  第二行\"]\nend\n";
        assert_eq!(
            fmt(FormatId::Mermaid, src),
            "flowchart TD\nsubgraph S\n    A[\"第一行\n  第二行\"]\nend\n"
        );
    }

    #[test]
    fn mermaid_node_named_alt_is_not_a_block() {
        // sequence 之外不会重排；在 sequence 里带连接符的 `alt --> B` 也不能当开块
        let src = "sequenceDiagram\nalt --> B\nend\n";
        assert_eq!(fmt(FormatId::Mermaid, src), src);
    }

    #[test]
    fn common_tail_cleanup() {
        assert_eq!(
            fmt(FormatId::Mermaid, "flowchart TD   \n\n\nA --> B\t"),
            "flowchart TD\n\nA --> B\n"
        );
        assert_eq!(fmt(FormatId::Mermaid, ""), "");
        assert_eq!(format_body(FormatId::Mermaid, "flowchart TD\n").changed, false);
    }

    #[test]
    fn dot_one_liner_expands_into_indented_lines() {
        let src = "digraph G{a->b;b->c}";
        assert_eq!(fmt(FormatId::Dot, src), "digraph G {\n    a -> b\n    b -> c\n}\n");
    }

    #[test]
    fn dot_newline_separated_statements_stay_separate() {
        let src = "digraph {\n  a -> b\n  b -> c\n}\n";
        assert_eq!(fmt(FormatId::Dot, src), "digraph {\n    a -> b\n    b -> c\n}\n");
    }

    #[test]
    fn dot_attrs_and_endpoint_sets_stay_inline() {
        let src = "digraph {\n  rankdir=LR;\n  node [shape=box, style=\"rounded,filled\"];\n  a -> {b c} [label=\"x\"]\n}\n";
        assert_eq!(
            fmt(FormatId::Dot, src),
            "digraph {\n    rankdir=LR\n    node [shape=box, style=\"rounded,filled\"]\n    a -> {b c} [label=\"x\"]\n}\n"
        );
    }

    #[test]
    fn dot_statement_leading_endpoint_set_stays_inline() {
        let src = "digraph {\n  {a b} -> c;\n}\n";
        assert_eq!(
            fmt(FormatId::Dot, src),
            "digraph {\n    {a b} -> c\n}\n"
        );
    }

    #[test]
    fn dot_anonymous_subgraph_is_still_a_block() {
        let src = "digraph {\n  { rank=same; a; b }\n  a -> b\n}\n";
        assert_eq!(
            fmt(FormatId::Dot, src),
            "digraph {\n    {\n        rank=same\n        a\n        b\n    }\n    a -> b\n}\n"
        );
    }

    #[test]
    fn dot_comments_and_sharp_lines_are_preserved() {
        let src = "digraph { // 图\n# line 7 \"x\"\n  a -> b /* 边 */\n}\n";
        assert_eq!(
            fmt(FormatId::Dot, src),
            "digraph {\n    // 图\n# line 7 \"x\"\n    a -> b /* 边 */\n}\n"
        );
    }

    #[test]
    fn dot_html_label_is_one_token() {
        let src = "digraph { a [label=<<TABLE><TR><TD>x</TD></TR></TABLE>>]; }";
        assert_eq!(
            fmt(FormatId::Dot, src),
            "digraph {\n    a [label=<<TABLE><TR><TD>x</TD></TR></TABLE>>]\n}\n"
        );
    }

    #[test]
    fn dot_edge_chain_continued_on_next_line_stays_one_statement() {
        let src = "digraph {\n  a ->\n    b [label=\"x\"];\n}\n";
        assert_eq!(
            fmt(FormatId::Dot, src),
            "digraph {\n    a -> b [label=\"x\"]\n}\n"
        );
    }

    #[test]
    fn d2_braces_indent_with_two_spaces() {
        let src = "a: {\nb: c\n}\n";
        assert_eq!(fmt(FormatId::D2, src), "a: {\n  b: c\n}\n");
    }

    #[test]
    fn d2_block_string_is_byte_exact() {
        let src = "x: |md\n# 标题\n\n正文\n|\n";
        assert_eq!(fmt(FormatId::D2, src), src);
        assert_eq!(format_body(FormatId::D2, src).changed, false);
    }

    #[test]
    fn d2_braces_in_quotes_do_not_change_depth() {
        let src = "a: \"x {\"\nb: c\n";
        assert_eq!(fmt(FormatId::D2, src), src);
    }

    #[test]
    fn formatting_is_idempotent() {
        let samples = [
            (FormatId::Mermaid, "flowchart TD\nsubgraph S\nA --> B\nend\n"),
            (
                FormatId::Mermaid,
                "sequenceDiagram\nalt ok\nA->>B: hi\nelse no\nB->>A: no\nend\n",
            ),
            (FormatId::Dot, "digraph G{a->b;b->c}"),
            (
                FormatId::Dot,
                "digraph {\nsubgraph cluster_x {\nnode [shape=box]\na -> b\n}\nb -> c\n}\n",
            ),
            (FormatId::D2, "a: {\nb: {\nc\n}\n}\n"),
        ];
        for (format, src) in samples {
            let once = fmt(format, src);
            let twice = fmt(format, &once);
            assert_eq!(once, twice, "{format:?} 不幂等");
        }
    }

    #[test]
    fn canvas_formats_are_never_rewritten() {
        for format in [FormatId::Drawio, FormatId::Excalidraw] {
            let body = "{\"elements\":[]}";
            let out = format_body(format, body);
            assert_eq!(out.body, body);
            assert!(!out.changed);
        }
    }
}
