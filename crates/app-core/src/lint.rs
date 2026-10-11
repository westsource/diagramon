//! 语法校验：本机完成，产出「问题」面板与源码行内标注所需的数据。
//!
//! 刻意**只报能确证的问题**（括号/引号/标签不配对、JSON 解析失败这类），
//! 不做"疑似不规范"的风格指摘 —— 假报警会把问题面板变成噪音。

use app_ipc::{FormatId, Issue, Severity};

/// 校验一份正文。返回的问题按行号升序。
pub fn issues(format: FormatId, body: &str) -> Vec<Issue> {
    let mut out = match format {
        FormatId::Mermaid => mermaid(body),
        FormatId::Dot => dot(body),
        FormatId::Drawio => xml(body),
        FormatId::Excalidraw => json(body),
    };
    out.sort_by_key(|i| i.line);
    out
}

fn err(line: u32, message: impl Into<String>, hint: impl Into<String>) -> Issue {
    Issue { severity: Severity::Error, line, message: message.into(), hint: hint.into() }
}

fn warn(line: u32, message: impl Into<String>, hint: impl Into<String>) -> Issue {
    Issue { severity: Severity::Warning, line, message: message.into(), hint: hint.into() }
}

/// 去掉行内注释（`%%`）与字符串字面量，避免把注释里的括号算进去。
fn strip_noise(line: &str, comment: &str) -> String {
    let mut s = match line.find(comment) {
        Some(i) => &line[..i],
        None => line,
    };
    if let Some(i) = s.find('"') {
        if let Some(j) = s[i + 1..].find('"') {
            s = &s[..i + 1 + j + 1];
        }
    }
    s.to_string()
}

/* ---------------- Mermaid ---------------- */

fn mermaid(body: &str) -> Vec<Issue> {
    let mut out = Vec::new();
    // 未闭合的 subgraph 栈（记住它出现在哪一行）
    let mut subgraph_stack: Vec<u32> = Vec::new();
    // 括号深度按"行内成对"检查：mermaid 的节点标签不跨行
    let mut bracket_stack: Vec<(char, u32)> = Vec::new();

    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = strip_noise(raw, "%%").trim().to_string();
        if text.is_empty() {
            continue;
        }

        if text.starts_with("subgraph") {
            subgraph_stack.push(line);
        } else if text == "end" {
            if subgraph_stack.pop().is_none() {
                out.push(warn(line, "多余的 end：没有与之配对的 subgraph", "删掉它，或补一个 subgraph"));
            }
        }

        // 括号配对（逐字符扫描，跨行也能收敛）
        for c in text.chars() {
            match c {
                '[' | '{' | '(' => bracket_stack.push((c, line)),
                ']' => match bracket_stack.pop() {
                    Some(('[', _)) => {}
                    Some((o, _)) => out.push(err(line, format!("括号不配对：这里闭合了 ]，但最近打开的是 {o}"), "检查节点标签的括号")),
                    None => out.push(err(line, "括号不配对：多余的 ]", "补上对应的 [")),
                },
                '}' => match bracket_stack.pop() {
                    Some(('{', _)) => {}
                    Some((o, _)) => out.push(err(line, format!("括号不配对：这里闭合了 }}，但最近打开的是 {o}"), "检查判定节点的花括号")),
                    None => out.push(err(line, "括号不配对：多余的 }", "补上对应的 {")),
                },
                ')' => match bracket_stack.pop() {
                    Some(('(', _)) => {}
                    Some((o, _)) => out.push(err(line, format!("括号不配对：这里闭合了 )，但最近打开的是 {o}"), "检查圆角节点或子图的括号")),
                    None => out.push(err(line, "括号不配对：多余的 )", "补上对应的 (")),
                },
                _ => {}
            }
        }
    }

    for line in bracket_stack {
        out.push(err(line.1, "括号没有闭合", "这一行打开的括号在文件结束前没有关掉"));
    }
    for line in subgraph_stack {
        out.push(err(line, "subgraph 没有闭合", "补一个 end"));
    }
    out
}

/* ---------------- Graphviz DOT ---------------- */

fn dot(body: &str) -> Vec<Issue> {
    let mut out = Vec::new();
    let mut stack: Vec<(char, u32)> = Vec::new();
    let mut directed = false;
    let mut undirected = false;

    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = strip_noise(raw, "//").trim().to_string();
        if text.is_empty() {
            continue;
        }
        if text.starts_with("digraph") {
            directed = true;
        }
        if text.starts_with("graph") && !text.starts_with("graph [") {
            undirected = true;
        }

        let quotes = text.matches('"').count();
        if quotes % 2 == 1 {
            out.push(err(line, "字符串引号没有闭合", "这一行的 \" 少了配对的一个"));
        }

        for c in text.chars() {
            match c {
                '{' => stack.push(('{', line)),
                '}' => {
                    if stack.pop().is_none() {
                        out.push(err(line, "多余的 }", "没有与之配对的 {"));
                    }
                }
                _ => {}
            }
        }

        if text.contains("->") && undirected && !directed {
            out.push(warn(line, "graph 是无向图，却用了 -> ", "无向图用 --，有向图用 -> 并把 graph 改成 digraph"));
        }
    }

    for (_, line) in stack {
        out.push(err(line, "花括号没有闭合", "补一个 }"));
    }
    out
}

/* ---------------- drawio（XML 文本） ---------------- */

fn xml(body: &str) -> Vec<Issue> {
    let mut out = Vec::new();
    if !body.contains("<mxfile") {
        out.push(warn(1, "没有找到 <mxfile> 根节点", "drawio 文件应以 <mxfile> 为根；如果这是旧版裸 <mxGraphModel>，仍可打开但另存后会被补全"));
    }

    let mut stack: Vec<(String, u32)> = Vec::new();
    let mut in_comment = false;

    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let mut rest = raw.to_string();
        loop {
            if in_comment {
                match rest.find("-->") {
                    Some(i) => {
                        in_comment = false;
                        rest = rest[i + 3..].to_string();
                        continue;
                    }
                    None => break,
                }
            }
            match rest.find('<') {
                None => break,
                Some(i) => {
                    let after = &rest[i + 1..];
                    if after.starts_with("!--") {
                        in_comment = true;
                        rest = after.to_string();
                        continue;
                    }
                    if after.starts_with('?') || after.starts_with('!') {
                        // 声明与 CDATA 不参与配对
                        match after.find('>') {
                            Some(j) => {
                                rest = after[j + 1..].to_string();
                                continue;
                            }
                            None => break,
                        }
                    }
                    let closing = after.starts_with('/');
                    let name_start = if closing { 1 } else { 0 };
                    let name: String = after[name_start..]
                        .chars()
                        .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || *c == ':')
                        .collect();
                    match rest[i..].find('>') {
                        None => {
                            out.push(err(line, format!("<{name}> 标签没有闭合的 >"), "属性值里的引号是否成对？"));
                            break;
                        }
                        Some(j) => {
                            let end = i + j;
                            // 自闭合：'>' 之前（去掉空白）是 '/'，即 "/>"
                            let self_closing = rest[i + 1..end].trim_end().ends_with('/');
                            if closing {
                                match stack.pop() {
                                    Some((open, _)) if open == name => {}
                                    Some((open, open_line)) => out.push(err(
                                        line,
                                        format!("标签交叉：</{name}> 关掉的是 <{open}>（第 {open_line} 行）"),
                                        "检查嵌套顺序",
                                    )),
                                    None => out.push(err(line, format!("多余的 </{name}>"), "没有与之配对的开始标签")),
                                }
                            } else if !self_closing && !name.is_empty() {
                                stack.push((name, line));
                            }
                            rest = rest[end + 1..].to_string();
                        }
                    }
                }
            }
        }
    }

    for (name, line) in stack {
        out.push(err(line, format!("<{name}> 没有闭合"), "补上对应的结束标签，或改成自闭合 />"));
    }
    out
}

/* ---------------- Excalidraw（场景 JSON） ---------------- */

fn json(body: &str) -> Vec<Issue> {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(v) => {
            let mut out = Vec::new();
            if v.get("elements").and_then(|e| e.as_array()).is_none() {
                out.push(warn(1, "缺少 elements 数组", "Excalidraw 场景必须有 elements（可以为空数组）"));
            }
            if v.get("type").and_then(|t| t.as_str()) != Some("excalidraw") {
                out.push(warn(1, "type 不是 \"excalidraw\"", "另存时会被补成标准头"));
            }
            out
        }
        Err(e) => vec![err(e.line() as u32, format!("JSON 解析失败：{e}"), "按提示的行列位置检查语法")],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has_error(v: &[Issue], needle: &str) -> bool {
        v.iter().any(|i| i.severity == Severity::Error && i.message.contains(needle))
    }
    fn has_warn(v: &[Issue], needle: &str) -> bool {
        v.iter().any(|i| i.severity == Severity::Warning && i.message.contains(needle))
    }

    #[test]
    fn mermaid_accepts_a_well_formed_flowchart() {
        let src = "flowchart TD\n    A([开始]) --> B{判断}\n    B -- 是 --> C([结束])\n    subgraph 组\n      B\n    end\n";
        assert!(issues(FormatId::Mermaid, src).is_empty(), "正常流程图不应报问题");
    }

    #[test]
    fn mermaid_reports_unclosed_subgraph_and_unbalanced_bracket() {
        let v = issues(FormatId::Mermaid, "flowchart TD\n    subgraph 组\n    A[x --> B[y\n");
        assert!(has_error(&v, "subgraph 没有闭合"), "{v:?}");
        assert!(has_error(&v, "括号没有闭合"), "{v:?}");
    }

    /// **曾经报过假警的一条规则已删除**（2026-10-11 用户实测反馈）。
    ///
    /// 旧版对标签里的裸 `<` / `>` 一律告警，理由是"mermaid 10+ 会当 HTML 解析、渲染报错"。
    /// 拿本仓库实际打包的 `ui/vendor/mermaid.min.js`（`securityLevel: "strict"`，与应用一致）
    /// 逐个实测：`B{x>=5}`、`A[x >= 5]`、`A[a<br/>b]`、`A[<b>粗</b>]`、`A[abc</def>]`、`A[x -> y]`
    /// **全部 parse + render 通过**。一条都复现不出来 ⇒ 规则删掉，留这条测试挡着别再回来。
    #[test]
    fn mermaid_accepts_raw_angle_brackets_in_labels() {
        for src in [
            "flowchart TD\n    M{连续失败 >= 5?}\n",
            "flowchart TD\n    A[x >= 5]\n",
            "flowchart TD\n    A[abc</def>]\n",
            "flowchart TD\n    A[第一行<br/>第二行]\n",
        ] {
            let v = issues(FormatId::Mermaid, src);
            assert!(v.is_empty(), "不该再对尖括号报警：{src:?} → {v:?}");
        }
    }

    /// 用户实测片段（2026-10-11 反馈）：`>=` 在判定节点里 + subgraph 里未声明的 L/M。
    /// 钉成基线：这段**一条问题都不该有**（括号成对、subgraph 闭合、`>=` 合法）。
    #[test]
    fn mermaid_baseline_for_the_reported_snippet() {
        let src = "flowchart TD\nA([开始]) --> B{连续失败 >= 5?}\nB -- 是 --> C([结束])\nsubgraph 风控\nL --> M\nend\n";
        let v = issues(FormatId::Mermaid, src);
        assert!(v.is_empty(), "这段是合法 mermaid，不该报问题：{v:?}");
    }

    #[test]
    fn mermaid_ignores_brackets_inside_comments() {
        let v = issues(FormatId::Mermaid, "%% 这里有个 [ 不算\nflowchart TD\n    A-->B\n");
        assert!(v.is_empty(), "注释里的括号不该触发校验：{v:?}");
    }

    #[test]
    fn dot_reports_unclosed_brace_and_odd_quote() {
        let v = issues(FormatId::Dot, "digraph G {\n    a [label=\"x]\n");
        assert!(has_error(&v, "花括号没有闭合"), "{v:?}");
        assert!(has_error(&v, "引号没有闭合"), "{v:?}");
    }

    #[test]
    fn dot_warns_when_undirected_graph_uses_arrow() {
        let v = issues(FormatId::Dot, "graph G {\n    a -> b;\n}\n");
        assert!(has_warn(&v, "无向图"), "{v:?}");
    }

    #[test]
    fn xml_reports_mismatched_tag_with_line() {
        let v = issues(FormatId::Drawio, "<mxfile>\n  <diagram>\n</mxfile>\n");
        assert!(has_error(&v, "标签交叉"), "{v:?}");
        assert_eq!(v.iter().find(|i| i.message.contains("标签交叉")).unwrap().line, 3);
    }

    #[test]
    fn xml_accepts_self_closing_and_comments() {
        let src = "<mxfile>\n  <!-- 说明 -->\n  <diagram id=\"p1\">\n    <mxCell id=\"0\" />\n  </diagram>\n</mxfile>\n";
        let v = issues(FormatId::Drawio, src);
        assert!(v.is_empty(), "正常 mxfile 不应报问题：{v:?}");
    }

    #[test]
    fn json_reports_parse_error_line() {
        let v = issues(FormatId::Excalidraw, "{\n  \"type\": \"excalidraw\",\n  \"elements\": [ ,\n}\n");
        assert!(has_error(&v, "JSON 解析失败"), "{v:?}");
        assert!(v[0].line >= 2, "应给出行号，实得 {}", v[0].line);
    }

    #[test]
    fn json_warns_when_elements_missing() {
        let v = issues(FormatId::Excalidraw, "{ \"type\": \"excalidraw\" }");
        assert!(has_warn(&v, "缺少 elements"), "{v:?}");
    }
}
