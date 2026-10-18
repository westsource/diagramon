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
        FormatId::D2 => d2(body),
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

/// 去掉 mermaid 的注释（`%%` 到行尾）与**引号内容**，避免把文本里的括号算进配对。
///
/// 与 `strip_noise` 的关键差别：这里只丢*引号里的内容*，`"` 之后的代码照旧保留 ——
/// 旧实现以第二个 `"` 截断**整行**，于是 `A["文本"] --> B` 的 `]` 和后半句一起消失，
/// 每个带引号的标签都会凭空多报一条"括号没有闭合"（2026-10-17 真机：一张图 35 条）。
///
/// `in_string` 由调用方**跨行**持有：mermaid 10.x 起 `A["` + 换行 + `"]` 合法，
/// 引号内的行不参与配对（那些行往往含 `()` 等自由文本）。
fn strip_mermaid_line(line: &str, in_string: &mut bool) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if *in_string {
            if ch == '"' {
                *in_string = false;
                out.push(ch);
            }
            continue;
        }
        if ch == '"' {
            // 未闭合的引号（跨行标签）在这里开栈，内容由后续行继续丢弃
            *in_string = true;
            out.push(ch);
            continue;
        }
        if ch == '%' && chars.peek() == Some(&'%') {
            break; // 注释到行尾
        }
        out.push(ch);
    }
    out
}

/// 去掉行内注释（`#` / `%%`）与字符串字面量，避免把注释里的括号算进去。
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
    // 括号深度按"行内成对"检查；引号内容跨行丢弃（见 strip_mermaid_line）
    let mut bracket_stack: Vec<(char, u32)> = Vec::new();
    let mut in_string = false;

    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        let text = strip_mermaid_line(raw, &mut in_string).trim().to_string();
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

/* ---------------- D2 ---------------- */

/// D2 的**真语法错交给渲染器**：wasm 编译器抛的是带行列号的 JSON（`index:1:1: connection missing
/// destination`），能直接回喂 AI 修正一次。本地只报"扫一遍就能确证"的两件事：
/// 花括号是块的边界（未闭合 / 多余）、引号成对。
///
/// **刻意不查圆括号与方括号**：D2 的标签是自由文本（`a: 用户服务 (beta`），
/// 那在 D2 里合法但在括号配对规则下会变成假报警 —— 问题面板一旦有噪音就没人看了。
fn d2(body: &str) -> Vec<Issue> {
    use crate::d2syntax;

    let mut out = Vec::new();
    let mut stack: Vec<u32> = Vec::new();

    for (idx, raw) in body.lines().enumerate() {
        let line = idx as u32 + 1;
        // 注释与引号内的 `#` 都要先拿掉，否则 `style.fill: "#f00"` 会被当成注释起点
        let text = d2syntax::strip_comment(raw).trim().to_string();
        if text.is_empty() {
            continue;
        }

        if text.matches('"').count() % 2 == 1 {
            out.push(err(line, "字符串引号没有闭合", "这一行的 \" 少了配对的一个（标签里的引号要写成 \\\"）"));
        }

        for c in text.chars() {
            match c {
                '{' => stack.push(line),
                '}' => {
                    if stack.pop().is_none() {
                        out.push(err(line, "多余的 }", "没有与之配对的 {"));
                    }
                }
                _ => {}
            }
        }
    }

    for line in stack {
        out.push(err(line, "花括号没有闭合", "这个容器没有关掉，补一个 }"));
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

    /// 引号标签是**常态**（`A["文本"]`），不该被报成"括号没有闭合"。
    ///
    /// 旧实现 `strip_noise` 在第二个 `"` 处**截断整行**，于是引号后的 `]` 与后半句
    /// 一起消失 —— 每个带引号的标签凭空多一条错误（真机实测：一张 20+ 节点的图报 35 条，
    /// 问题面板变成噪音）。现在只丢引号**内容**，`"` 之后的源码照旧参与配对。
    #[test]
    fn mermaid_quoted_labels_are_not_reported() {
        for src in [
            "flowchart TD\n    A[\"文本\"] --> B\n",
            "flowchart TD\n    A[\"<b>粗体</b>\"] --> B[\"另一个\"]\n",
            // 引号里的括号是自由文本，不参与配对
            "flowchart TD\n    A[\"含 ( [ { 与 </b> 的文本\"]\n",
            // 跨行引号（10.x 起合法）：引号内的行不参与配对
            "flowchart LR\n    EMQX[\"\n        <b>EMQX 集群</b>\n        MQTT：1883\n    \"]\n",
        ] {
            let v = issues(FormatId::Mermaid, src);
            assert!(v.is_empty(), "带引号的标签不该报问题：{src:?} → {v:?}");
        }

        // 反例：引号**外**的括号照样要报
        let v = issues(FormatId::Mermaid, "flowchart TD\n    A[\"文本\" --> B\n");
        assert!(has_error(&v, "括号没有闭合"), "{v:?}");
    }

    #[test]
    fn d2_reports_unclosed_brace_and_odd_quote() {
        let v = issues(FormatId::D2, "a -> b\n集成层: {\n  x -> y\n");
        assert!(has_error(&v, "花括号没有闭合"), "{v:?}");
        assert_eq!(v.iter().find(|i| i.message.contains("花括号没有闭合")).unwrap().line, 2);

        let q = issues(FormatId::D2, "a: \"没关的引号\n");
        assert!(has_error(&q, "引号没有闭合"), "{q:?}");

        let extra = issues(FormatId::D2, "a -> b\n}\n");
        assert!(has_error(&extra, "多余的 }"), "{extra:?}");
    }

    /// 两个**必须不报**的形态：引号里的颜色值不是注释；标签里的圆括号是自由文本。
    /// （假报警会把问题面板变成噪音 —— 与 mermaid 尖括号那条测试同一个理由。）
    #[test]
    fn d2_colors_and_label_parens_are_not_reported() {
        let src = "a: 用户服务 (beta)\n风格: { style.fill: \"#f00\" } # 这是注释\n";
        let v = issues(FormatId::D2, src);
        assert!(v.is_empty(), "合法 D2 不该报问题：{v:?}");
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
