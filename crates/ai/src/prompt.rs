//! 提示词与输出提取。
//!
//! 三件事在提示词里必须说清：**目标格式**、**只输出代码**、**当前正文是上下文而不是要重写的东西**。
//! 提取侧则要容错：模型很爱把代码包在 ``` 里再配一段解释，围栏提取失败就退化为"整段当代码"。

use app_ipc::{AiContextFile, AiIntent, AiTurn, FormatId};

/// 提示词版本：随每个请求发 `X-Diagramon-Prompt-Version`，服务端按它聚合通过率/成本。
///
/// **改了任何系统提示词的措辞就升这一版**（版本号不是产品版本，而是提示词快照的编号）——
/// 否则“改完提示词后失败率变没变”永远回答不了。
pub const PROMPT_VERSION: &str = "v4-3.9.0";

fn format_name(id: FormatId) -> &'static str {
    match id {
        FormatId::Mermaid => "Mermaid",
        FormatId::Dot => "Graphviz DOT",
        FormatId::D2 => "D2",
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
        FormatId::D2 => {
            "语法要点（D2 ≠ Mermaid，别混用）：方向写 `direction: right|down|left|up`；\n\
             连线是 `a -> b`（不画箭头写 `a -- b`），标签写在冒号后：`a -> b: 说明`；\n\
             节点标签同样用冒号：`a: 标签`；容器是 `组名: { … }`（可以嵌套，容器内能再写 direction）；\n\
             形状/样式写成属性行：`a.shape: cylinder`、`a.style.fill: \"#f00\"`；\n\
             注释用 `#`；字符串要成对引号。**不要**用 `-->`、`subgraph`、`end`、`%%` 这些 Mermaid 写法。"
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

/// 目标格式的名字与语法要点。给 `format_grammar` 工具用 —— 工具循环里模型能主动
/// 去查"这个格式有什么讲究"，而不是只能靠一次性的系统提示词记着。
pub fn format_hint(id: FormatId) -> String {
    format!("目标格式：{}\n{}", format_name(id), format_rules(id))
}

/// 生成系统提示词。`intent` 决定任务是"从头画"、"看图还原"还是"局部改"。
pub fn system_prompt(format: FormatId, intent: AiIntent) -> String {
    // 解释是**唯一不产代码**的意图：它不进围栏提取，也不该出现“应用”按钮。
    if intent == AiIntent::Explain {
        return format!(
            "你是 Diagramon 的图表助手。用户会给你一份 {} 图表源码，请解释它在表达什么。\n\n\
             输出要求：\n\
             1. 只写 3–8 句自然语言：先说整体在讲什么，再说关键路径与明显的风险/空缺；\n\
             2. **不要输出任何代码块**，不要给修改方案，不要逐字复述源码；\n\
             3. 不要写教程或语法说明。",
            format_name(format)
        );
    }
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
        AiIntent::Explain => unreachable!("Explain 已在函数开头单独返回"),
    };
    format!(
        "{head}\n\n{rules}\n\n输出要求：\n\
         1. 只输出一段可直接粘贴的代码，用 ``` 围栏包起来；\n\
         2. 围栏外面最多一句话说明你改了什么，不要写教程；\n\
         3. 不要解释语法，不要重复贴出用户已经给你的源码。",
        rules = format_rules(format)
    )
}

/// 附加文件的字符预算（**所有文件合计**）。
///
/// 单文件的上限在 `app_core::context_file`（256 KiB）—— 那是"读得动"的上限，
/// 这里是"发得出去"的上限：几份大文件一叠加，小模型的上下文就爆了。超预算的部分不静默丢：
/// 块里会写明还有几个文件没带上。
pub const FILES_MAX_CHARS: usize = 24000;

/// 附件块：**参考资料**的措辞与"当前图表源码"分开，别让模型把参考文件当正文重写。
///
/// 返回 `(块, 没带上的文件数)`；没有可用文件时返回 `None`。
pub fn files_block(files: &[AiContextFile]) -> Option<(String, usize)> {
    let mut out = String::new();
    let mut used = 0usize;
    let mut omitted = 0usize;
    for f in files {
        if f.text.trim().is_empty() {
            continue;
        }
        let header = format!("--- 文件：{}（{}）{}---\n", f.name, f.path, if f.truncated { "［已截断］" } else { "" });
        let body = f.text.trim_end();
        if used + header.chars().count() + body.chars().count() > FILES_MAX_CHARS {
            // 还装得下多少就给多少（按字符截，别把最后一个字切两半）
            let left = FILES_MAX_CHARS.saturating_sub(used + header.chars().count());
            if left < 200 {
                omitted += 1;
                continue;
            }
            let cut: String = body.chars().take(left).collect();
            if out.is_empty() {
                out.push_str("以下是我附加的文件（参考资料，不是要改的图）：\n");
            }
            out.push_str(&header);
            out.push_str(&cut);
            out.push_str("\n（这一份按上下文预算截断）\n\n");
            used = FILES_MAX_CHARS;
            continue;
        }
        if out.is_empty() {
            out.push_str("以下是我附加的文件（参考资料，不是要改的图）：\n");
        }
        out.push_str(&header);
        out.push_str(body);
        out.push_str("\n\n");
        used += header.chars().count() + body.chars().count();
    }
    if out.is_empty() {
        return None;
    }
    if omitted > 0 {
        out.push_str(&format!("（另有 {omitted} 个文件因上下文预算没带上）\n\n"));
    }
    Some((out, omitted))
}

/// 组装发给模型的 messages。
pub fn build_messages(
    format: FormatId,
    intent: AiIntent,
    prompt: &str,
    context: Option<&str>,
    image_data_url: Option<&str>,
    files: &[AiContextFile],
) -> Vec<serde_json::Value> {
    use serde_json::json;

    let mut messages = vec![json!({ "role": "system", "content": system_prompt(format, intent) })];

    let mut user_text = String::new();
    // 附件在前、当前正文在后：模型读到"当前图表源码"时，参考资料已经交代完了
    if let Some((block, _)) = files_block(files) {
        user_text.push_str(&block);
    }
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

/* ------------------------------------------------------------------ 前序轮次 */

/// 最多带几轮前序对话。
///
/// 上限不是"省 token"而已：服务端 `ChatCompletionIn.messages` 有 `max_length=64`
/// 的硬闸，而工具循环每轮要追加约 2 条 —— 不设上限就会在某一步突然收到 400。
pub const HISTORY_MAX_TURNS: usize = 8;

/// 前序对话的**字符**预算（按 `chars()` 计，中文一个算一个）。
///
/// 与轮数上限是两道独立的闸：一句话很长的对话，8 轮也可能撑爆请求体。
pub const HISTORY_MAX_CHARS: usize = 6000;

/// 按预算裁前序轮次：**从最近往前取**，超了就丢更早的（截尾，而不是拒绝整轮）。
///
/// 三条刻意的取舍：
///
/// 1. **返回顺序仍是时间序**（早 → 晚）。上游对消息顺序敏感，倒序会让模型把因果搞反。
/// 2. **最新一轮一定保留**：它是模型马上要接的话。但如果它自己就超预算，**截断它的文本**
///    而不是放行 —— 否则单条超长消息（比如整篇源码）能一个人撑爆请求体。
/// 3. 角色的白名单只有 `user` / `assistant`，其余一律当 `user`。前端的对话数组里还混着
///    `sys` 提示与错误气泡，别让它们以奇怪的角色漏到上游。
pub fn fit_history(history: &[AiTurn], max_turns: usize, max_chars: usize) -> Vec<AiTurn> {
    let mut out: Vec<AiTurn> = Vec::new();
    let mut used = 0usize;
    for turn in history.iter().rev() {
        if out.len() >= max_turns {
            break;
        }
        let mut text = turn.text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        let len = text.chars().count();
        if out.is_empty() {
            if len > max_chars {
                text = text.chars().take(max_chars).collect();
            }
        } else if used + len > max_chars {
            break;
        }
        used += text.chars().count();
        out.push(AiTurn { role: normalize_role(&turn.role), text });
    }
    out.reverse();
    out
}

fn normalize_role(role: &str) -> String {
    if role == "assistant" { "assistant".into() } else { "user".into() }
}

/// 在 `build_messages` 的基础上**插入前序轮次**（位置：system 之后、本轮 user 之前）。
///
/// 为什么不改 `build_messages` 的签名：它已有完整单测，且 BYOK 与云网关两条路共用 ——
/// 加参数会把"没有历史"这个最常见的情形也拖进改动面。这里保持纯加法。
pub fn build_messages_with_history(
    format: FormatId,
    intent: AiIntent,
    prompt: &str,
    context: Option<&str>,
    image_data_url: Option<&str>,
    history: &[AiTurn],
    files: &[AiContextFile],
) -> Vec<serde_json::Value> {
    use serde_json::json;

    let mut messages = build_messages(format, intent, prompt, context, image_data_url, files);
    let fitted = fit_history(history, HISTORY_MAX_TURNS, HISTORY_MAX_CHARS);
    if fitted.is_empty() {
        return messages;
    }

    let mut out: Vec<serde_json::Value> = Vec::with_capacity(messages.len() + fitted.len());
    let mut rest = messages.drain(..);
    if let Some(system) = rest.next() {
        out.push(system); // 系统提示词永远在最前
    }
    for turn in fitted {
        out.push(json!({ "role": turn.role, "content": turn.text }));
    }
    out.extend(rest);
    out
}

/* ------------------------------------------------------------------ 长期记忆 */

/// 把记忆块作为**独立的 system 消息**插在第一条 system 之后。
///
/// 为什么不拼进 `system_prompt()`：那个函数有单测、且 BYOK 与云网关共用；拼进去会让
/// "有记忆"和"没记忆"两种情形挤在同一个函数里，而它们必须能被**独立断言** ——
/// 关掉记忆时请求体要与以前一模一样。
pub fn inject_memory(messages: Vec<serde_json::Value>, block: &str) -> Vec<serde_json::Value> {
    use serde_json::json;

    let block = block.trim();
    if block.is_empty() {
        return messages;
    }
    let mut out = Vec::with_capacity(messages.len() + 1);
    let mut inserted = false;
    for message in messages {
        let is_system = message.get("role").and_then(|r| r.as_str()) == Some("system");
        out.push(message);
        if is_system && !inserted {
            out.push(json!({ "role": "system", "content": block }));
            inserted = true;
        }
    }
    if !inserted {
        out.insert(0, json!({ "role": "system", "content": block }));
    }
    out
}

/// 最多留几条候选。宁缺勿滥：自动提取的价值在于"少而准"，多了就变成噪音清单。
pub const MEMORY_EXTRACT_MAX: usize = 3;

/// 记忆提取的系统指令。
///
/// 三条约束都是刻意的：**只输出 JSON 数组**（好解析）、**最多 3 条**（少而准）、
/// **没东西可记就返回 `[]`**（不让模型为了"有产出"而编）。另外明确排除任务性内容 ——
/// "帮我把这张图改成 LR"是一次性要求，不是长期偏好，把它记下来会污染之后所有请求。
pub const MEMORY_EXTRACT_SYSTEM: &str = "\
你要从一段图表工具的对话里，提取**值得长期记住的用户偏好**。

只提取这三类：
1. 风格偏好（配色、主题、节点形状、默认布局方向、命名习惯）
2. 术语（用户对某个概念/模块的固定叫法）
3. 长期约束（比如「不要用中文标签」「所有图都要带图例」）

**不要提取**：一次性的任务要求（「把这张图改成 LR」）、对某张图的具体修改、
对模型这次回答的评论、任何与长期偏好无关的内容。

输出要求：
- 只输出一个 JSON 数组，元素是**不超过 40 字的短句**，最多 3 条；
- 没有可提取的内容就输出 `[]`；
- 不要输出数组以外的任何文字、不要加代码围栏、不要解释。";

/// 提取调用的 user 内容：把这一轮压成"用户说了什么 + 模型答了什么"。
///
/// 两侧都截断：提取只需要判断"有没有长期偏好"，把整篇源码塞进去既费 token
/// 又会让模型把注意力放到代码细节上。
pub fn memory_extract_user(prompt: &str, reply: &str) -> String {
    let cut = |s: &str, n: usize| -> String {
        let t = s.trim();
        if t.chars().count() <= n {
            t.to_string()
        } else {
            format!("{}…", t.chars().take(n).collect::<String>())
        }
    };
    format!("用户说：{}\n\n模型答：{}", cut(prompt, 600), cut(reply, 1200))
}

/// 从提取回复里抠出候选条目。
///
/// 模型不一定听话，所以**两条路**：先按 JSON 数组解析（去掉可能存在的代码围栏），
/// 失败再退化成按行解析（`- xxx` / `1. xxx`）。都不行就返回空 ——
/// **宁可一条不记，也不要从一段解释文字里猜出半句假的偏好**。
pub fn parse_memory_candidates(text: &str) -> Vec<String> {
    let cleaned = strip_fences(text);
    if let Some(items) = parse_json_array(&cleaned) {
        return dedup(items);
    }
    let mut out: Vec<String> = Vec::new();
    for line in cleaned.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let stripped = t
            .trim_start_matches(['-', '*', '•'])
            .trim_start_matches(|c: char| c.is_ascii_digit())
            .trim_start_matches(['.', ')', '、', ' ']);
        let candidate = stripped.trim();
        if is_meaningless(candidate) {
            continue;
        }
        out.push(candidate.to_string());
    }
    dedup(out)
}

fn strip_fences(text: &str) -> String {
    let mut out = String::new();
    let mut inside: Option<bool> = None;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            // 进出围栏：围栏内的内容照收（模型常把 JSON 包在 ```json 里）
            inside = match inside {
                None => Some(true),
                Some(_) => None,
            };
            continue;
        }
        let _ = inside;
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn parse_json_array(text: &str) -> Option<Vec<String>> {
    let start = text.find('[')?;
    let end = text.rfind(']')?;
    if end <= start {
        return None;
    }
    let slice = &text[start..=end];
    let parsed: Vec<serde_json::Value> = serde_json::from_str(slice).ok()?;
    let mut out = Vec::new();
    for value in parsed {
        if let Some(s) = value.as_str() {
            let t = s.trim();
            if !t.is_empty() && !is_meaningless(t) {
                out.push(t.to_string());
            }
        }
    }
    Some(out)
}

/// "没什么可记的"的各种写法 —— 它们**不是**候选记忆。
///
/// 除了逐字匹配，还要认**整句否定**：模型很爱回「没有需要记住的偏好」「本轮没有可提取的记忆」，
/// 而这类句子一旦被当成候选，用户会在待确认列表里看到一条叫"没有需要记住的偏好"的"记忆"，
/// 确认它就等于每轮都往 prompt 里塞一句废话。
///
/// 反过来要**小心误杀**：句首的"无"经常出现在真偏好里（"无边框节点"、"无限画布"），
/// 所以只有"带否定 + 提到记忆/偏好/可记"才算否定，且长度要像一句答复。
fn is_meaningless(s: &str) -> bool {
    let t = s.trim().trim_matches(['`', '"', '\'']).trim();
    if t.is_empty() || t == "[]" {
        return true;
    }
    if matches!(
        t.to_lowercase().as_str(),
        "无" | "没有" | "暂无" | "none" | "n/a" | "null" | "nothing" | "no preferences" | "无偏好"
    ) {
        return true;
    }
    let negated = t.contains("没有") || t.contains("暂无") || t.contains("不需要") || t.starts_with('无');
    let about_memory = ["偏好", "记住", "记忆", "可记", "可提取", "需要记"]
        .iter()
        .any(|k| t.contains(k));
    negated && about_memory && t.chars().count() <= 30
}

fn dedup(items: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let key = item.trim().to_lowercase();
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(item.trim().to_string());
        if out.len() >= MEMORY_EXTRACT_MAX {
            break;
        }
    }
    out
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
        // D2 没有固定首行（`direction:` 可省），认三样：方向声明、连线、容器块
        FormatId::D2 => {
            body.starts_with("direction:")
                || body.starts_with('{')
                || body.contains("->")
                || body.contains("--")
                || body.lines().any(|l| l.trim_end().ends_with('{'))
        }
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
    fn explain_prompt_forbids_code_blocks() {
        let p = system_prompt(FormatId::Mermaid, AiIntent::Explain);
        assert!(p.contains("不要输出任何代码块"), "解释意图不能要求代码围栏：{p}");
        assert!(!p.contains("用 ``` 围栏包起来"), "解释意图不该复用“只输出代码”的输出要求：{p}");
        assert!(p.contains("3–8 句"), "{p}");
    }

    #[test]
    fn vision_message_carries_image_as_content_array() {
        let m = build_messages(FormatId::Mermaid, AiIntent::Vision, "转成 mermaid", None, Some("data:image/png;base64,AAA"), &[]);
        assert_eq!(m.len(), 2);
        let content = m[1].get("content").unwrap();
        assert!(content.is_array(), "视觉请求的 content 必须是数组");
        assert_eq!(content[1]["type"], "image_url");
    }

    #[test]
    fn context_is_wrapped_in_a_fence_so_the_model_does_not_echo_it() {
        let m = build_messages(FormatId::Mermaid, AiIntent::Review, "加一条失败分支", Some("flowchart TD\n A-->B\n"), None, &[]);
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

    /* ---------------- 前序轮次 ---------------- */

    fn turn(role: &str, text: &str) -> AiTurn {
        AiTurn { role: role.into(), text: text.into() }
    }

    /// 历史必须夹在 **system 之后、本轮 user 之前** —— 放到 system 前面会让系统提示词
    /// 失去"最高优先级"的位置，模型会把它当成上一轮的话。
    #[test]
    fn history_sits_between_system_and_the_current_user_message() {
        let m = build_messages_with_history(
            FormatId::Mermaid,
            AiIntent::Generate,
            "再来一张时序图",
            None,
            None,
            &[turn("user", "先画一张流程图"), turn("assistant", "好，这是流程图")],
            &[],
        );
        assert_eq!(m.len(), 4);
        assert_eq!(m[0]["role"], "system");
        assert_eq!(m[1]["role"], "user");
        assert_eq!(m[1]["content"], "先画一张流程图");
        assert_eq!(m[2]["role"], "assistant");
        assert_eq!(m[3]["role"], "user");
        assert!(m[3]["content"].as_str().unwrap().ends_with("再来一张时序图"));
    }

    /// 没有历史时**必须与 `build_messages` 一模一样**：这是最常见的情形，
    /// 多出任何一条消息都会改变已有行为的成本与结果。
    #[test]
    fn empty_history_is_a_no_op() {
        let a = build_messages(FormatId::Dot, AiIntent::Generate, "画个依赖图", Some("digraph G {}"), None, &[]);
        let b = build_messages_with_history(FormatId::Dot, AiIntent::Generate, "画个依赖图", Some("digraph G {}"), None, &[], &[]);
        assert_eq!(a, b);
    }

    /// 超轮数上限 ⇒ 丢**最早**的，保留最近的；返回仍是时间序。
    #[test]
    fn history_keeps_the_newest_turns_and_stays_in_chronological_order() {
        let all: Vec<AiTurn> = (0..12).map(|i| turn(if i % 2 == 0 { "user" } else { "assistant" }, &format!("第{i}句"))).collect();
        let fitted = fit_history(&all, 4, 100_000);
        assert_eq!(fitted.len(), 4);
        assert_eq!(fitted[0].text, "第8句", "应保留最近 4 条：{fitted:?}");
        assert_eq!(fitted[3].text, "第11句");
    }

    /// 超字符预算同样是截尾，且**最新一轮一定留下**（它是模型马上要接的那句）。
    #[test]
    fn history_truncates_older_turns_by_char_budget_but_never_drops_the_newest() {
        let history = vec![turn("user", &"啊".repeat(50)), turn("assistant", &"噢".repeat(50)), turn("user", &"嗯".repeat(50))];
        let fitted = fit_history(&history, 8, 120);
        assert_eq!(fitted.len(), 2, "50+50 放得下、再加一条就超了：{fitted:?}");
        assert_eq!(fitted.last().unwrap().text, "嗯".repeat(50));
    }

    /// 最新一轮**自己**就超预算时：截断它的文本，而不是放行。
    /// 放行等于"单条消息就能撑爆请求体"，而服务端 `ai_max_body_bytes` 只会给一个
    /// 语义错误的 413。
    #[test]
    fn a_single_oversized_turn_is_truncated_not_passed_through() {
        let huge = "字".repeat(5_000);
        let fitted = fit_history(&[turn("user", &huge)], HISTORY_MAX_TURNS, 100);
        assert_eq!(fitted.len(), 1);
        assert_eq!(fitted[0].text.chars().count(), 100);
    }

    /// 角色白名单：前端的对话数组里混着 `sys` 提示与错误气泡，它们不该以奇怪的角色上行。
    #[test]
    fn unknown_roles_are_normalised_to_user() {
        let fitted = fit_history(&[turn("sys", "渲染失败"), turn("tool", "x"), turn("assistant", "好")], 8, 100_000);
        assert_eq!(fitted[0].role, "user");
        assert_eq!(fitted[1].role, "user");
        assert_eq!(fitted[2].role, "assistant");
    }

    /// 空白轮次不进历史 —— 空气泡（思考型模型没有正文那种）不该占预算。
    #[test]
    fn blank_turns_are_skipped() {
        let fitted = fit_history(&[turn("user", "问"), turn("assistant", "   "), turn("user", "又问")], 8, 100_000);
        assert_eq!(fitted.len(), 2);
        assert_eq!(fitted[1].text, "又问");
    }

    /* ---------------- 长期记忆 ---------------- */

    /// 记忆块必须夹在**第一条 system 之后**：这样它既在系统指令区（模型会当规则看），
    /// 又不会顶掉格式提示词的位置。
    #[test]
    fn memory_block_lands_right_after_the_first_system_message() {
        let base = build_messages(FormatId::Mermaid, AiIntent::Generate, "画个流程", None, None, &[]);
        let with = inject_memory(base, "偏好：配色用暗色");
        assert_eq!(with.len(), 3);
        assert_eq!(with[0]["role"], "system");
        assert!(with[0]["content"].as_str().unwrap().contains("Diagramon"));
        assert_eq!(with[1]["role"], "system");
        assert_eq!(with[1]["content"], "偏好：配色用暗色");
        assert_eq!(with[2]["role"], "user");
    }

    /// 空块 = 原样返回。这条很重要：**关掉记忆时请求体必须与以前一模一样**，
    /// 多出一条空的 system 消息就已经是"不一样"了。
    #[test]
    fn empty_memory_block_changes_nothing() {
        let base = build_messages(FormatId::Dot, AiIntent::Generate, "画个依赖图", Some("digraph G {}"), None, &[]);
        assert_eq!(inject_memory(base.clone(), ""), base);
        assert_eq!(inject_memory(base.clone(), "   \n  "), base);
    }

    /// 记忆与历史同时在场时的相对顺序：system(格式) → system(记忆) → 历史 → 本轮 user。
    #[test]
    fn memory_and_history_stack_in_the_documented_order() {
        let with_hist = build_messages_with_history(
            FormatId::Mermaid,
            AiIntent::Generate,
            "再画一张",
            None,
            None,
            &[turn("user", "先画一张")],
            &[],
        );
        let full = inject_memory(with_hist, "偏好：配色用暗色");
        assert_eq!(full.len(), 4);
        assert_eq!(full[0]["role"], "system");
        assert!(full[0]["content"].as_str().unwrap().contains("Diagramon"), "格式提示词要在最前");
        assert_eq!(full[1]["content"], "偏好：配色用暗色");
        assert_eq!(full[2]["content"], "先画一张");
        assert_eq!(full[3]["role"], "user");
    }

    #[test]
    fn candidates_parse_from_a_plain_json_array() {
        let got = parse_memory_candidates(r#"["配色一律用暗色", "流程图默认 TD 方向"]"#);
        assert_eq!(got, vec!["配色一律用暗色".to_string(), "流程图默认 TD 方向".to_string()]);
    }

    /// 模型很爱把 JSON 包在 ```json 里（真机必现），围栏不能把解析弄崩。
    #[test]
    fn candidates_parse_from_a_fenced_json_array() {
        let got = parse_memory_candidates("```json\n[\"节点不要圆角\"]\n```");
        assert_eq!(got, vec!["节点不要圆角".to_string()]);
    }

    /// `[]` = 没什么可记的 ⇒ 一条都不要。
    #[test]
    fn an_empty_array_yields_nothing() {
        assert!(parse_memory_candidates("[]").is_empty());
        assert!(parse_memory_candidates("```json\n[]\n```").is_empty());
    }

    /// JSON 解析不了时退化成按行读，但**必须滤掉"无 / none"这类答复** ——
    /// 否则模型一句"无"会被记成一条叫"无"的偏好，然后每轮都注入。
    #[test]
    fn line_fallback_skips_meaningless_replies() {
        assert!(parse_memory_candidates("无").is_empty());
        assert!(parse_memory_candidates("None").is_empty());
        assert!(parse_memory_candidates("").is_empty());
        // 整句否定：模型最常给的就是这一句，不能当成候选
        assert!(parse_memory_candidates("没有需要记住的偏好").is_empty());
        assert!(parse_memory_candidates("本轮没有可提取的记忆").is_empty());
        assert!(parse_memory_candidates("- 不需要记住任何偏好").is_empty());

        let got = parse_memory_candidates("- 配色一律用暗色\n- 节点不要圆角");
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], "配色一律用暗色");
    }

    /// 反向：句首的"无"经常出现在**真偏好**里，不能被上面那条启发式误杀。
    #[test]
    fn memory_mentions_are_not_killed_by_the_negation_heuristic() {
        assert_eq!(parse_memory_candidates("无边框节点"), vec!["无边框节点".to_string()]);
        assert_eq!(parse_memory_candidates("无限画布，不要分页"), vec!["无限画布，不要分页".to_string()]);
        assert_eq!(parse_memory_candidates("无向图用 graph"), vec!["无向图用 graph".to_string()]);
    }

    /// 最多 3 条、且去重（大小写与空白差异算同一条）。
    #[test]
    fn candidates_are_capped_and_deduped() {
        let got = parse_memory_candidates(r#"["A","a","B","C","D"]"#);
        assert_eq!(got, vec!["A", "B", "C"]);

        let many = r#"["1","2","3","4","5","6"]"#;
        assert_eq!(parse_memory_candidates(many).len(), MEMORY_EXTRACT_MAX);
    }

    /// 提取的 user 内容要截断：把整篇源码塞进去既费 token 又会把注意力带偏。
    #[test]
    fn extraction_input_is_truncated() {
        let long = "字".repeat(3_000);
        let text = memory_extract_user(&long, &long);
        assert!(text.contains('…'));
        assert!(text.chars().count() < 2_000, "两侧都要截断：{}", text.chars().count());
    }

    /* ---------------- 附件（外部文件） ---------------- */

    fn ctx_file(name: &str, text: &str) -> AiContextFile {
        AiContextFile { path: format!("E:/ref/{name}"), name: name.into(), text: text.into(), truncated: false }
    }

    /// 附件要**带上文件名与路径**，且措辞必须与"当前图表源码"分开 ——
    /// 否则模型会把参考资料当成待重写的正文。
    #[test]
    fn attached_files_are_labelled_as_reference_material() {
        let m = build_messages(
            FormatId::Mermaid,
            AiIntent::Generate,
            "按这份需求画一张",
            Some("flowchart TD\n  A-->B\n"),
            None,
            &[ctx_file("需求.md", "第一步要支持导出 PNG")],
        );
        let user = m.last().unwrap()["content"].as_str().unwrap();
        assert!(user.contains("参考资料"), "{user}");
        assert!(user.contains("需求.md") && user.contains("E:/ref/需求.md"), "{user}");
        assert!(user.contains("第一步要支持导出 PNG"), "{user}");
        assert!(user.contains("当前图表源码"), "{user}");
        assert!(user.ends_with("按这份需求画一张"), "用户这句话要在最后：{user}");
    }

    /// 单个附件超预算：截断并在块里写明（不静默丢），且**不切出半个字**。
    #[test]
    fn a_huge_attachment_is_cut_to_the_budget_with_a_note() {
        let huge = "字".repeat(FILES_MAX_CHARS);
        let (block, omitted) = files_block(&[ctx_file("大.md", &huge)]).unwrap();
        assert_eq!(omitted, 0);
        assert!(block.contains("按上下文预算截断"), "要写明被截断");
        assert!(block.chars().count() < FILES_MAX_CHARS + 200);
        assert!(!block.contains('\u{FFFD}'));
    }

    /// 多个附件合计超预算：后面的**不带**，并写明还有几个 —— 而不是把它们悄悄丢掉。
    #[test]
    fn remaining_attachments_are_reported_when_the_budget_runs_out() {
        let one = "字".repeat(FILES_MAX_CHARS - 100);
        let files = vec![ctx_file("a.md", &one), ctx_file("b.md", &one), ctx_file("c.md", &one)];
        let (block, omitted) = files_block(&files).unwrap();
        assert!(omitted >= 1, "没带上的要计数：{omitted}");
        assert!(block.contains("因上下文预算没带上"), "{block}");
        assert!(!block.contains("--- 文件：c.md"), "放不下的不该硬塞");
    }

    /// 空附件（全空白）不进提示词，且没有附件时**与从前逐字一致**。
    #[test]
    fn blank_attachments_change_nothing() {
        assert!(files_block(&[ctx_file("空.md", "   \n\n")]).is_none());
        assert!(files_block(&[]).is_none());
        let with = build_messages(FormatId::Dot, AiIntent::Generate, "画个依赖图", None, None, &[]);
        let without = build_messages(FormatId::Dot, AiIntent::Generate, "画个依赖图", None, None, &[ctx_file("meta.txt", "  ")]);
        assert_eq!(with, without);
    }
}
