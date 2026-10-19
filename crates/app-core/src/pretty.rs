//! 幂等格式化器（修 G22：以前“格式化源码”只删行尾空格，却报“已完成”）。
//!
//! 三条纪律：
//! 1. **幂等**：`pretty(pretty(x)) == pretty(x)`；
//! 2. **结构等价**：格式化前后 AST 等价（Mermaid / DOT 用现有解析器验证）；
//! 3. **注释原样保留**（`convert.rs::parse` 会跳过 `%%` 注释，不能拿它当实现）。
//!
//! 只动空白与缩进，不重排节点、不改 id、不合并语句。D2 没有 AST，只做空白规整。

use app_ipc::FormatId;

/// `(新正文, 改动处数)`。`0` 表示“无需改动”（界面据此不要再报“已完成”）。
pub fn pretty(format: FormatId, body: &str) -> (String, usize) {
    let before: Vec<String> = body.replace("\r\n", "\n").split('\n').map(|l| l.trim_end().to_string()).collect();
    let mut after: Vec<String> = match format {
        FormatId::Mermaid => reindent(&before, true),
        FormatId::Dot => reindent(&before, false),
        // D2 没有 AST：不重排、不缩进，只清行尾与连续空行
        FormatId::D2 | FormatId::Drawio | FormatId::Excalidraw => collapse_blank(&before),
    };
    // 去掉末尾空行，统一以一个换行结束（空正文保持空）
    while after.last().map(|l| l.is_empty()).unwrap_or(false) {
        after.pop();
    }
    let mut out = after.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    let mut changes = 0usize;
    // 末尾空行不算“改动”（格式化器统一以单个换行收尾，这是约定而不是内容变化）
    let mut old = before.clone();
    while old.last().map(|l| l.is_empty()).unwrap_or(false) {
        old.pop();
    }
    let mut new = after.clone();
    while new.last().map(|l| l.is_empty()).unwrap_or(false) {
        new.pop();
    }
    let n = old.len().max(new.len());
    for i in 0..n {
        if old.get(i) != new.get(i) {
            changes += 1;
        }
    }
    (out, changes)
}

fn collapse_blank(lines: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    for line in lines {
        let blank = line.trim().is_empty();
        if blank && out.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
            continue;
        }
        out.push(if blank { String::new() } else { line.clone() });
    }
    out
}

/// 按块结构重排缩进。`mermaid` 为真时处理 `subgraph…end` 与 `{…}`；
/// DOT 只处理花括号（跳过引号内的花括号）。
fn reindent(lines: &[String], mermaid: bool) -> Vec<String> {
    let unit = if mermaid { "    " } else { "  " };
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut depth = 0usize;

    for raw in lines {
        let line = raw.trim();
        if line.is_empty() {
            // 保留一个空行（连续空行由 collapse 处理）
            if !out.last().map(|l: &String| l.is_empty()).unwrap_or(false) {
                out.push(String::new());
            }
            continue;
        }
        let closes = if mermaid {
            line == "end" || line == "}" || line.starts_with("} ")
        } else {
            line.starts_with('}')
        };
        if closes {
            depth = depth.saturating_sub(1);
        }
        out.push(format!("{}{}", unit.repeat(depth), line));

        let opens = if mermaid {
            let opens_block = line.starts_with("subgraph ")
                || matches!(
                    line.split_whitespace().next().unwrap_or(""),
                    "loop" | "alt" | "opt" | "par" | "critical" | "rect" | "break" | "box"
                );
            let opens_brace = line.ends_with('{') && !line.starts_with('}');
            opens_block || opens_brace
        } else {
            brace_delta(line) > 0
        };
        if opens {
            depth += 1;
        }
        // DOT 同一行既开又闭（`subgraph x { a }`）时按净值修正
        if !mermaid {
            let delta = brace_delta(line);
            if delta < 0 && !line.starts_with('}') {
                depth = depth.saturating_sub((-delta) as usize);
            }
        }
    }
    collapse_blank(&out)
}

fn brace_delta(line: &str) -> i32 {
    let mut delta = 0i32;
    let mut in_str: Option<char> = None;
    let mut escaped = false;
    for ch in line.chars() {
        if let Some(q) = in_str {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == q {
                in_str = None;
            }
            continue;
        }
        match ch {
            '"' | '\'' => in_str = Some(ch),
            '{' => delta += 1,
            '}' => delta -= 1,
            _ => {}
        }
    }
    delta
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mermaid_is_idempotent_and_preserves_comments() {
        let src = "flowchart TD\n  A-->B\n\n\n  %% 这是注释\n  subgraph 组\n A-->C\n end\n";
        let (once, _) = pretty(FormatId::Mermaid, src);
        let (twice, changes) = pretty(FormatId::Mermaid, &once);
        assert_eq!(once, twice, "格式化必须幂等");
        assert_eq!(changes, 0, "第二次不应再有改动");
        assert!(once.contains("%% 这是注释"));
        assert!(once.contains("    A-->C"), "{once}");
        assert!(!once.contains("  \n"), "行尾空白要清掉");
    }

    #[test]
    fn mermaid_ast_is_equivalent() {
        let src = "flowchart TD\n  A-->B\n      B-->C\n";
        let (out, _) = pretty(FormatId::Mermaid, src);
        let a = crate::convert::mermaid_to_dot(src).unwrap();
        let b = crate::convert::mermaid_to_dot(&out).unwrap();
        assert_eq!(a.body, b.body, "格式化不能改变结构");
    }

    #[test]
    fn dot_is_idempotent_and_ast_equivalent() {
        let src = "digraph G {\n  rankdir=LR;\n    a -> b [label=\"x { y }\"];\n subgraph cluster_a {\n  c;\n }\n}\n";
        let (once, _) = pretty(FormatId::Dot, src);
        let (twice, changes) = pretty(FormatId::Dot, &once);
        assert_eq!(once, twice);
        assert_eq!(changes, 0);
        let a = crate::convert_dot::dot_to_d2(src).unwrap();
        let b = crate::convert_dot::dot_to_d2(&once).unwrap();
        assert_eq!(a.body, b.body, "引号内的花括号不能参与缩进计算");
    }

    #[test]
    fn d2_only_touches_whitespace() {
        let src = "direction: right\n\n\n  a -> b: 标签   \n";
        let (out, changes) = pretty(FormatId::D2, src);
        assert!(changes > 0);
        assert_eq!(out, "direction: right\n\n  a -> b: 标签\n");
        let (again, zero) = pretty(FormatId::D2, &out);
        assert_eq!(again, out);
        assert_eq!(zero, 0);
    }

    #[test]
    fn empty_body_stays_empty() {
        assert_eq!(pretty(FormatId::Mermaid, "").0, "");
        assert_eq!(pretty(FormatId::Mermaid, "  \n\n").0, "");
    }
}
