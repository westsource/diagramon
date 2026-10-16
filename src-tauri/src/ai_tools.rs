//! 工具循环能用到的领域工具 —— **全部只读内存里的文档模型，且只有一个写口**。
//!
//! # 与方案的一点有意偏离（3 个工具，不是 4 个）
//!
//! 方案里列的第一批工具含 `apply_patch`（把补丁落进文档）。实现时去掉了它，理由：
//!
//! 1. **`validate` 改成接受候选正文**（`validate { body }`）之后，模型已经能完整地
//!    "写一版 → 校验 → 改一版 → 再校验"，**全程不碰用户的文档**。那正是它需要的全部能力。
//! 2. 让模型在循环中途改文档，意味着**用户一个字都没点，文件内容就变了**。这与客户端
//!    一贯的姿态（AI 产出先以代码卡呈现、由用户按「应用」才落盘）直接冲突。
//! 3. 渲染级的问题另有归宿：「渲染校验回环」（`render_retry`）本来就在做
//!    "落盘后渲染失败 → 回喂报错修正一次"。工具循环负责把图做到**语法上成立**，
//!    渲染级的兜底留在原处，两者不重叠、也不互相掩盖。
//!
//! 于是这里只有三个工具，且**没有任何一个接触文件系统、shell 或网络** —— 一旦某个工具的
//! 签名里出现了 async，就说明它想做不该做的事。

use std::sync::Arc;

use serde_json::{json, Value};

use ai::Tool;

use crate::state::AppState;

/// 一次读回正文的行数上限。`read_document` 是"看一眼上下文"，不是把整份大文件
/// 灌进上下文——那会直接顶到窗口预算上。
pub const READ_MAX_LINES: usize = 200;

/// `read_document` 支持的最大区间长度。
pub const READ_MAX_SPAN: usize = 200;

pub fn build(state: Arc<AppState>, doc_id: String) -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(ReadDocument { state: state.clone(), doc_id: doc_id.clone() }),
        Box::new(FormatGrammar { state: state.clone(), doc_id: doc_id.clone() }),
        Box::new(ValidateBody { state, doc_id }),
    ]
}

/* ------------------------------------------------------------------ read_document */

struct ReadDocument {
    state: Arc<AppState>,
    doc_id: String,
}

impl Tool for ReadDocument {
    fn name(&self) -> &str {
        "read_document"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "read_document",
                "description": "读取当前文档的正文。可选 range 指定行区间（如 \"1-40\"），\
                                省略则从头读最多 200 行。返回的每行都带行号。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "range": {
                            "type": "string",
                            "description": "行区间，形如 \"1-40\"；省略表示从头开始"
                        }
                    }
                }
            }
        })
    }

    fn call(&self, args: &Value) -> Result<String, String> {
        let body = {
            let session = self.state.session();
            let doc = session.get(&self.doc_id).ok_or("当前文档不存在")?;
            doc.body.clone()
        };
        let range = args.get("range").and_then(|v| v.as_str()).unwrap_or("");
        slice_lines(&body, range)
    }
}

/// 取一段带行号的正文。
///
/// 抽成纯函数是为了能单测 —— 工具本体只是一层取文档的胶水，值得测的是这里的边界：
/// 区间写反了、超出行数、压根没给区间。
pub fn slice_lines(body: &str, range: &str) -> Result<String, String> {
    let lines: Vec<&str> = body.lines().collect();
    let total = lines.len();
    if total == 0 {
        return Ok("（文档是空的）".to_string());
    }

    let (start, end) = if range.trim().is_empty() {
        (1, total.min(READ_MAX_LINES))
    } else {
        parse_range(range)?
    };
    if start > total {
        return Ok(format!("（文档只有 {total} 行，第 {start} 行不存在）"));
    }
    let end = end.min(total).min(start + READ_MAX_SPAN - 1);

    let mut out = String::new();
    for (i, line) in lines[start - 1..end].iter().enumerate() {
        out.push_str(&format!("{:>4}| {line}\n", start + i));
    }
    if end < total {
        out.push_str(&format!("……（共 {total} 行，此处到第 {end} 行为止）"));
    }
    Ok(out)
}

fn parse_range(range: &str) -> Result<(usize, usize), String> {
    let raw = range.trim();
    let (a, b) = match raw.split_once('-') {
        Some((a, b)) => (a.trim(), b.trim()),
        None => (raw, raw),
    };
    let start: usize = a.parse().map_err(|_| format!("区间格式不对：{raw}（应形如 \"1-40\"）"))?;
    let end: usize = if b.is_empty() {
        start + READ_MAX_SPAN - 1
    } else {
        b.parse().map_err(|_| format!("区间格式不对：{raw}（应形如 \"1-40\"）"))?
    };
    if start == 0 {
        return Err("行号从 1 开始".to_string());
    }
    if end < start {
        return Err(format!("区间写反了：{raw}"));
    }
    Ok((start, end))
}

/* ------------------------------------------------------------------ format_grammar */

struct FormatGrammar {
    state: Arc<AppState>,
    doc_id: String,
}

impl Tool for FormatGrammar {
    fn name(&self) -> &str {
        "format_grammar"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "format_grammar",
                "description": "取得当前文档目标格式的语法要点。不确定某段语法能不能写时先调它。",
                "parameters": {"type": "object", "properties": {}}
            }
        })
    }

    fn call(&self, _args: &Value) -> Result<String, String> {
        let session = self.state.session();
        let doc = session.get(&self.doc_id).ok_or("当前文档不存在")?;
        Ok(ai::prompt::format_hint(doc.format))
    }
}

/* ------------------------------------------------------------------ validate */

struct ValidateBody {
    state: Arc<AppState>,
    doc_id: String,
}

impl Tool for ValidateBody {
    fn name(&self) -> &str {
        "validate"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "validate",
                "description": "校验一段**候选**代码是否符合当前格式的语法。它不会改动文档。\
                                返回问题列表（含行号）；没问题就返回“没有发现问题”。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "body": {"type": "string", "description": "要校验的完整代码"}
                    },
                    "required": ["body"]
                }
            }
        })
    }

    fn call(&self, args: &Value) -> Result<String, String> {
        let body = args
            .get("body")
            .and_then(|v| v.as_str())
            .ok_or("缺少 body 参数：validate 需要待校验的完整代码")?;
        let format = {
            let session = self.state.session();
            let doc = session.get(&self.doc_id).ok_or("当前文档不存在")?;
            doc.format
        };
        let issues = app_core::lint::issues(format, body);
        Ok(render_issues(&issues))
    }
}

/// 把 lint 结果渲染成给模型看的一段话。
///
/// 用词刻意是"问题清单"而不是"错误"：`app_core::lint` 里有 warning 级别的项
/// （比如"无向图里用了 ->"），它们是建议不是语法错。混成一种口吻会让模型把
/// 没坏的东西改坏。
pub fn render_issues(issues: &[app_ipc::Issue]) -> String {
    if issues.is_empty() {
        return "没有发现问题，这段代码在当前格式下是合法的。".to_string();
    }
    let mut out = String::from("发现以下问题：\n");
    for issue in issues {
        let line = if issue.line > 0 { format!("第 {} 行：", issue.line) } else { String::new() };
        out.push_str(&format!("- [{:?}] {line}{}", issue.severity, issue.message));
        if !issue.hint.is_empty() {
            out.push_str(&format!("（{}）", issue.hint));
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use app_ipc::{FormatId, Issue, Severity};

    #[test]
    fn read_without_range_starts_from_the_top_with_line_numbers() {
        let body = "flowchart TD\n    A --> B\n    B --> C";
        let got = slice_lines(body, "").unwrap();
        assert!(got.starts_with("   1| flowchart TD"));
        assert!(got.contains("   3|     B --> C"));
    }

    /// 行号是给模型做定位用的（"第 3 行有问题"）—— 必须从 1 起、且与原文一致。
    #[test]
    fn a_range_returns_exactly_that_span() {
        let body = (1..=10).map(|i| format!("第{i}行")).collect::<Vec<_>>().join("\n");
        let got = slice_lines(&body, "3-4").unwrap();
        assert!(got.contains("   3| 第3行"));
        assert!(got.contains("   4| 第4行"));
        assert!(!got.contains("第5行"));
    }

    #[test]
    fn a_range_past_the_end_says_so_instead_of_panicking() {
        let got = slice_lines("只有一行", "99-120").unwrap();
        assert!(got.contains("第 99 行不存在"), "{got}");
    }

    #[test]
    fn reversed_and_malformed_ranges_are_explained() {
        assert!(slice_lines("a\nb", "9-2").unwrap_err().contains("写反"));
        assert!(slice_lines("a\nb", "abc").unwrap_err().contains("格式不对"));
        assert!(slice_lines("a\nb", "0-2").unwrap_err().contains("从 1 开始"));
    }

    #[test]
    fn an_empty_document_says_it_is_empty() {
        assert!(slice_lines("", "").unwrap().contains("空的"));
    }

    /// 长文档只读前 `READ_MAX_LINES` 行，并如实说明还有多少没读 ——
    /// 静默截断会让模型以为文档就到这儿了。
    #[test]
    fn a_long_document_is_capped_and_says_how_long_it_really_is() {
        let body = (1..=500).map(|i| format!("第{i}行")).collect::<Vec<_>>().join("\n");
        let got = slice_lines(&body, "").unwrap();
        assert!(got.contains("   200| 第200行"));
        assert!(!got.contains("第201行"));
        assert!(got.contains("共 500 行"), "{got}");
    }

    #[test]
    fn issues_are_rendered_with_lines_and_severity() {
        let issues = vec![
            Issue { severity: Severity::Error, line: 3, message: "括号没有闭合".into(), hint: "补一个 }".into() },
            Issue { severity: Severity::Warning, line: 0, message: "用了 -> 但图是无向的".into(), hint: String::new() },
        ];
        let text = render_issues(&issues);
        assert!(text.contains("第 3 行：括号没有闭合"));
        assert!(text.contains("补一个 }"));
        assert!(text.contains("Error") && text.contains("Warning"));
        // 没有行号的那条不该硬编一个"第 0 行"
        assert!(!text.contains("第 0 行"));
    }

    /// 没问题时也要**明确说出来**：回一个空串会让模型以为工具没跑成功，然后去瞎改。
    #[test]
    fn a_clean_body_gets_an_explicit_all_clear() {
        assert!(render_issues(&[]).contains("没有发现问题"));
    }
}
