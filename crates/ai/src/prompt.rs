//! 提示词与输出提取。
//!
//! 三件事在提示词里必须说清：**目标格式**、**只输出代码**、**当前正文是上下文而不是要重写的东西**。
//! 提取侧则要容错：模型很爱把代码包在 ``` 里再配一段解释，围栏提取失败就退化为"整段当代码"。

use app_ipc::{AiIntent, FormatId};

fn format_name(id: FormatId) -> &'static str {
    match id {
        FormatId::Mermaid => "Mermaid",
        FormatId::Dot => "Graphviz DOT",
        FormatId::Drawio => "drawio（mxfile XML）",
        FormatId::Excalidraw => "Excalidraw（场景 JSON）",
    }
}

fn format_rules(id: FormatId) -> &'static str {
    match id {
        FormatId::Mermaid => {
            "语法要点：用 flowchart TD/LR 开头；节点标签里不要出现裸的 < 或 >（会被当成 HTML），要写成 &lt; / &gt;；\n\
             判定节点用 {…}，圆角用 (…)，子图用 subgraph … end。"
        }
        FormatId::Dot => {
            "语法要点：digraph 用 ->，graph 用 --；属性写在 [ ] 里；子图写成 subgraph cluster_xxx { … }（cluster_ 前缀才会画边框）。"
        }
        FormatId::Drawio => {
            "输出 mxfile XML：根节点 <mxfile>，内含 <diagram> → <mxGraphModel> → <root>，每个图形是一个 <mxCell>，\
             几何属性写在 <mxGeometry> 里。不要输出 HTML 片段。"
        }
        FormatId::Excalidraw => {
            "输出 Excalidraw 场景 JSON：顶层要有 type=\"excalidraw\"、version、elements 数组、appState；\
             每个元素带 id/type/x/y/width/height。"
        }
    }
}

/// 生成系统提示词。`intent` 决定任务是"从头画"、"看图还原"还是"局部改"。
pub fn system_prompt(format: FormatId, intent: AiIntent) -> String {
    let head = match intent {
        AiIntent::Generate => format!(
            "你是 Diagramon 的图表助手。请把用户的描述画成 {} 图表。",
            format_name(format)
        ),
        AiIntent::Vision => format!(
            "你是 Diagramon 的图表助手。用户给了一张图表截图，请把它**如实还原**成 {} 代码：\
             节点文字照抄（看不清的按上下文合理补全并在代码注释里标注），连线方向不要臆造。",
            format_name(format)
        ),
        AiIntent::Review => format!(
            "你是 Diagramon 的图表助手。用户会给你一份 {} 源码，请**只做局部修改**，不要重写整张图；\
             保留原有的节点 id 与结构，除非用户明确要求改。",
            format_name(format)
        ),
    };
    format!(
        "{head}\n\n{rules}\n\n输出要求：\n\
         1. 只输出一段可直接粘贴的代码，用 ``` 围栏包起来；\n\
         2. 围栏外面最多一句话说明你改了什么，不要写教程；\n\
         3. 不要解释语法，不要重复贴出用户已经给你的源码。",
        rules = format_rules(format)
    )
}

/// 组装发给模型的 messages。
pub fn build_messages(
    format: FormatId,
    intent: AiIntent,
    prompt: &str,
    context: Option<&str>,
    image_data_url: Option<&str>,
) -> Vec<serde_json::Value> {
    use serde_json::json;

    let mut messages = vec![json!({ "role": "system", "content": system_prompt(format, intent) })];

    let mut user_text = String::new();
    if let Some(ctx) = context {
        if !ctx.trim().is_empty() {
            user_text.push_str("当前图表源码（作为上下文，不要整段重写）：\n```\n");
            user_text.push_str(ctx.trim_end());
            user_text.push_str("\n```\n\n");
        }
    }
    user_text.push_str(prompt.trim());

    match image_data_url {
        Some(url) => {
            // 视觉档：content 走数组形态
            messages.push(json!({
                "role": "user",
                "content": [
                    { "type": "text", "text": user_text },
                    { "type": "image_url", "image_url": { "url": url } }
                ]
            }));
        }
        None => messages.push(json!({ "role": "user", "content": user_text })),
    }
    messages
}

/// 从模型回复里抠出代码。
///
/// 顺序：**最后一个**非空围栏块（模型常先给一版再给修正版）→ 无围栏时，
/// 若整段看起来就是目标格式的代码，就整段返回；否则返回 `None`（宁可让用户看到原文，也别乱应用）。
pub fn extract_code(text: &str, format: FormatId) -> Option<String> {
    let mut blocks: Vec<String> = Vec::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            match current.take() {
                Some(buf) => blocks.push(buf),
                None => current = Some(String::new()),
            }
            continue;
        }
        if let Some(buf) = current.as_mut() {
            buf.push_str(line);
            buf.push('\n');
        }
    }
    if let Some(last) = blocks.into_iter().filter(|b| !b.trim().is_empty()).next_back() {
        return Some(last.trim_end().to_string());
    }

    // 没有围栏：整段当代码？
    let body = text.trim();
    if body.is_empty() {
        return None;
    }
    let looks_like_code = match format {
        FormatId::Mermaid => {
            body.starts_with("flowchart")
                || body.starts_with("graph")
                || body.starts_with("sequenceDiagram")
                || body.starts_with("stateDiagram")
                || body.starts_with("classDiagram")
                || body.starts_with("erDiagram")
                || body.starts_with("%%")
        }
        FormatId::Dot => body.starts_with("digraph") || body.starts_with("graph") || body.starts_with("strict"),
        FormatId::Drawio => body.starts_with("<?xml") || body.starts_with("<mxfile") || body.starts_with("<mxGraphModel"),
        FormatId::Excalidraw => body.starts_with('{') && body.ends_with('}'),
    };
    if looks_like_code {
        Some(body.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_prompt_names_the_target_format_and_forbids_chatter() {
        let p = system_prompt(FormatId::Dot, AiIntent::Generate);
        assert!(p.contains("Graphviz DOT"));
        assert!(p.contains("只输出一段可直接粘贴的代码"));
    }

    #[test]
    fn review_prompt_forbids_full_rewrite() {
        let p = system_prompt(FormatId::Mermaid, AiIntent::Review);
        assert!(p.contains("只做局部修改"), "改图必须明确不重写整张图：{p}");
    }

    #[test]
    fn vision_message_carries_image_as_content_array() {
        let m = build_messages(FormatId::Mermaid, AiIntent::Vision, "转成 mermaid", None, Some("data:image/png;base64,AAA"));
        assert_eq!(m.len(), 2);
        let content = m[1].get("content").unwrap();
        assert!(content.is_array(), "视觉请求的 content 必须是数组");
        assert_eq!(content[1]["type"], "image_url");
    }

    #[test]
    fn context_is_wrapped_in_a_fence_so_the_model_does_not_echo_it() {
        let m = build_messages(FormatId::Mermaid, AiIntent::Review, "加一条失败分支", Some("flowchart TD\n A-->B\n"), None);
        let text = m[1]["content"].as_str().unwrap();
        assert!(text.contains("作为上下文，不要整段重写"));
        assert!(text.contains("flowchart TD"));
        assert!(text.ends_with("加一条失败分支"));
    }

    #[test]
    fn extract_takes_the_last_fenced_block() {
        let reply = "第一版：\n```mermaid\nflowchart TD\n A-->B\n```\n改好了：\n```mermaid\nflowchart LR\n A-->B\n```\n";
        let code = extract_code(reply, FormatId::Mermaid).unwrap();
        assert!(code.contains("flowchart LR"), "应取最后一版：{code}");
        assert!(!code.contains("第一版"));
    }

    #[test]
    fn extract_handles_fence_without_language_tag() {
        let code = extract_code("```\ndigraph G { a->b }\n```", FormatId::Dot).unwrap();
        assert_eq!(code, "digraph G { a->b }");
    }

    #[test]
    fn extract_falls_back_to_whole_text_when_it_already_is_code() {
        let code = extract_code("flowchart TD\n    A --> B\n", FormatId::Mermaid).unwrap();
        assert!(code.starts_with("flowchart TD"));
    }

    #[test]
    fn extract_refuses_prose_so_we_never_apply_a_sentence_as_code() {
        assert_eq!(extract_code("抱歉，我无法完成这个请求。", FormatId::Mermaid), None);
        assert_eq!(extract_code("", FormatId::Dot), None);
    }

    #[test]
    fn extract_keeps_multiline_body_intact() {
        let reply = "```mermaid\nflowchart TD\n    A([开始]) --> B[第一步]\n    B --> C{判断}\n```";
        let code = extract_code(reply, FormatId::Mermaid).unwrap();
        // `lines()` 不把结尾换行当空行：四行文本 + 末尾 \n ⇒ 3 行
        assert_eq!(code.lines().count(), 3);
        assert!(code.starts_with("flowchart TD"));
        assert!(code.trim_end().ends_with("B --> C{判断}"));
        assert!(!code.contains("```"), "围栏标记本身不能留在代码里");
    }
}
