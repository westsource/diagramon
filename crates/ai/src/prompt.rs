//! 提示词与回复解析。
//!
//! 系统提示词逐字符沿用既有客户端（`Services/Documents/Formats/*.cs` 里的常量）——
//! 那是与模型长期调过的文案，不顺手改措辞。识图提示词单独一套：看图最大的风险是
//! **编造图里没有的东西**，因此约束与生成不同。

use app_ipc::DocFormat;

/// 生成用系统提示词。
pub fn system_prompt(format: DocFormat) -> String {
    match format {
        DocFormat::Mermaid => "你是一个专业的 Mermaid 图表代码生成助手。你的任务是根据用户的自然语言描述生成或修改 Mermaid 代码。\n\n\
规则：\n\
1. 只返回 Mermaid 代码，不要包含其他解释文字\n\
2. 代码必须符合 Mermaid 语法规范\n\
3. 如果用户要求修改现有代码，请基于现有代码进行修改\n\
4. 如果用户描述不清晰，生成一个合理的默认图表\n\
5. 支持的图表类型：流程图、时序图、类图、状态图、甘特图、饼图、ER图等\n\n\
返回格式：直接返回 Mermaid 代码，不要使用代码块标记。"
            .to_string(),
        DocFormat::Dot => "你是一个专业的 Graphviz DOT 图表代码生成助手。你的任务是根据用户的自然语言描述生成或修改 Graphviz DOT 代码。\n\n\
规则：\n\
1. 只返回 DOT 代码，不要包含其他解释文字\n\
2. 代码必须符合 Graphviz DOT 语法规范，顶层必须是 digraph 或 graph\n\
3. 如果用户要求修改现有代码，请基于现有代码进行修改\n\
4. 如果用户描述不清晰，生成一个合理的默认图\n\
5. 布局引擎通过代码里的 rankdir/splines 等属性表达即可，不要输出布局引擎名字\n\n\
返回格式：直接返回 DOT 代码，不要使用代码块标记。"
            .to_string(),
        // 画布格式不提供 AI 生成（图形编辑器不产源码）
        DocFormat::Drawio | DocFormat::Excalidraw => String::new(),
    }
}

/// 识图用系统提示词。
pub fn vision_prompt(format: DocFormat) -> String {
    let tail = match format {
        DocFormat::Dot => "6. 顶层必须是 digraph 或 graph，符合 DOT 语法\n返回格式：直接返回代码，不要使用代码块标记。",
        _ => "6. 用 flowchart / sequenceDiagram / classDiagram 等 Mermaid 标准语法\n返回格式：直接返回代码，不要使用代码块标记。",
    };
    format!(
        "你是一个图表识别助手。用户会给出一张图表截图，请把它逆向成{}源码。\n\
规则：\n\
1. 只输出代码，不要任何解释文字\n\
2. **只画图中确实存在的元素与连线**，不要补充你没看到的东西\n\
3. 标签文字**原样保留**（不翻译、不改写、不替用户纠正错别字）\n\
4. 尽量保持原有方向（从上到下 / 从左到右）与分组\n\
5. 无法辨认的文字用「?」占位，不要编造内容\n\
{}",
        if format == DocFormat::Dot { "Graphviz DOT" } else { "Mermaid" },
        tail
    )
}

/// 当前代码标题（拼进提示词，让模型基于现有代码改）。
pub fn current_code_header(format: DocFormat) -> &'static str {
    match format {
        DocFormat::Dot => "当前 DOT 代码：",
        _ => "当前 Mermaid 代码：",
    }
}

/// 该格式是否支持 AI 生成。
pub fn supports_ai(format: DocFormat) -> bool {
    matches!(format, DocFormat::Mermaid | DocFormat::Dot)
}

/// 组装"根据描述生成/修改代码"的完整消息序列。
pub fn build_messages(
    format: DocFormat,
    current_code: &str,
    history: &[crate::ChatMessage],
    instruction: &str,
) -> Vec<crate::ChatMessage> {
    let mut msgs = vec![crate::ChatMessage::system(system_prompt(format))];
    if !current_code.trim().is_empty() {
        msgs.push(crate::ChatMessage::user(format!(
            "{}\n{}",
            current_code_header(format),
            current_code
        )));
    }
    msgs.extend_from_slice(history);
    msgs.push(crate::ChatMessage::user(instruction));
    msgs
}

/// 组装识图请求。
pub fn build_vision_messages(
    format: DocFormat,
    history: &[crate::ChatMessage],
    image_data_url: &str,
) -> Vec<crate::ChatMessage> {
    let mut msgs = vec![crate::ChatMessage::system(vision_prompt(format))];
    msgs.extend_from_slice(history);
    msgs.push(crate::ChatMessage::user_with_image(
        "请按系统提示词的要求，把这张图转成代码。",
        image_data_url,
    ));
    msgs
}

/// 渲染失败后的自动修复请求（把错误原文交回模型，要求只改错）。
pub fn build_repair_messages(
    format: DocFormat,
    current_code: &str,
    error_text: &str,
) -> Vec<crate::ChatMessage> {
    vec![
        crate::ChatMessage::system(system_prompt(format)),
        crate::ChatMessage::user(format!(
            "{}\n{}",
            current_code_header(format),
            current_code
        )),
        crate::ChatMessage::user(format!(
            "上面这份代码在本地渲染时报错了，请修正后只返回完整代码：\n{error_text}"
        )),
    ]
}

/// 从模型回复里提取代码（优先取代码围栏，否则整段当代码）。
pub fn extract_code(reply: &str) -> String {
    if let Some(code) = first_fenced_block(reply) {
        return code;
    }
    reply.trim().to_string()
}

/// 取第一个 ``` 围栏的内容（忽略语言标记）。
fn first_fenced_block(text: &str) -> Option<String> {
    let start = text.find("```")?;
    let after = &text[start + 3..];
    match after.find('\n') {
        // 常规形态：```lang\n<body>\n```
        Some(nl) => {
            let body = &after[nl + 1..];
            let end = body.find("```")?;
            Some(body[..end].trim().to_string())
        }
        // 单行形态：```body```（少见，但别当成没有围栏）
        None => {
            let end = after.find("```")?;
            let body = after[..end].trim();
            // 单行且第一个词像是语言标记时，去掉它
            let body = match body.split_once(char::is_whitespace) {
                Some((head, rest)) if ["mermaid", "dot", "graphviz", "mmd"].contains(&head) => rest.trim(),
                _ => body,
            };
            Some(body.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_prompts_match_legacy_text() {
        let m = system_prompt(DocFormat::Mermaid);
        assert!(m.starts_with("你是一个专业的 Mermaid 图表代码生成助手。"));
        assert!(m.ends_with("不要使用代码块标记。"));
        assert!(m.contains("支持的图表类型：流程图、时序图、类图、状态图、甘特图、饼图、ER图等"));

        let d = system_prompt(DocFormat::Dot);
        assert!(d.contains("顶层必须是 digraph 或 graph"));

        assert!(system_prompt(DocFormat::Drawio).is_empty());
        assert!(!supports_ai(DocFormat::Drawio));
        assert!(supports_ai(DocFormat::Mermaid));
    }

    #[test]
    fn vision_prompt_is_constraining() {
        let v = vision_prompt(DocFormat::Mermaid);
        assert!(v.contains("只画图中确实存在的元素与连线"));
        assert!(v.contains("原样保留"));
        assert!(v.contains("无法辨认的文字用「?」占位"));
        assert!(vision_prompt(DocFormat::Dot).contains("Graphviz DOT"));
    }

    #[test]
    fn extract_code_handles_fences_and_plain() {
        assert_eq!(
            extract_code("```mermaid\ngraph TD\n  A-->B\n```"),
            "graph TD\n  A-->B"
        );
        assert_eq!(extract_code("```\ndigraph G {}\n```"), "digraph G {}");
        // 无围栏：整段当代码
        assert_eq!(extract_code("  graph TD\n  A-->B  "), "graph TD\n  A-->B");
        // 围栏前后有解释文字
        assert_eq!(
            extract_code("好的，这是代码：\n```mermaid\nA-->B\n```\n希望有帮助"),
            "A-->B"
        );
    }

    #[test]
    fn build_messages_includes_current_code_only_when_present() {
        let with_code = build_messages(DocFormat::Mermaid, "graph TD", &[], "加一个节点");
        assert_eq!(with_code[0].role, "system");
        assert!(with_code[1].text.contains("当前 Mermaid 代码："));
        assert_eq!(with_code.last().unwrap().text, "加一个节点");

        let without = build_messages(DocFormat::Dot, "   ", &[], "画个图");
        assert_eq!(without.len(), 2, "没有现有代码时不应插入代码消息");
    }

    #[test]
    fn build_repair_messages_carries_error() {
        let msgs = build_repair_messages(DocFormat::Mermaid, "bad", "Parse error on line 2");
        assert!(msgs.last().unwrap().text.contains("Parse error on line 2"));
    }

    #[test]
    fn build_vision_messages_attaches_image() {
        let msgs = build_vision_messages(DocFormat::Mermaid, &[], "data:image/png;base64,AA");
        assert!(msgs.last().unwrap().image_data_url.is_some());
    }
}
