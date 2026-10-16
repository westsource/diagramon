//! 供应商实现：OpenAI 兼容（含自定义）/ Ollama，**流式**返回。
//!
//! 为什么网络层在 Rust 而不是前端 `fetch`：BYOK 的密钥只允许存在于 Rust 进程内，
//! 前端拿不到它，也就无从泄漏（见 design/ui-proto/index.html §9.1）。

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct Resolved {
    /// openai | ollama | custom
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
    /// `None` = **不发送**这个键，交给上游/服务端自己的默认值。
    ///
    /// 云网关必须用 `None`：服务端按"所选候选 × 档位"钳 `max_tokens`
    /// （`min(max(requested, MIN_OUTPUT_TOKENS), ceiling)`），客户端填一个数反而会把
    /// 用户档位允许的长回答截短 —— 它知道 ceiling，我们不知道。
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

impl Resolved {
    pub fn is_ollama(&self) -> bool {
        self.provider == "ollama"
    }

    /// 把 base_url 补成具体的 endpoint。
    pub fn endpoint(&self) -> String {
        let base = normalize_base_url(&self.base_url);
        if self.is_ollama() {
            format!("{base}/api/chat")
        } else {
            format!("{base}/chat/completions")
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
    /// 其中有多少是**思考**（reasoning）token。界面用它解释"没有正文"：
    /// 一整轮预算全花在推理上时，`completion_tokens` 很大而正文可以是空的。
    pub reasoning_tokens: Option<u32>,
}

impl Usage {
    /// 供应商有没有在流里回报用量。
    ///
    /// 没回报时这两个 `Option` 是 `None` —— **界面必须显示"未回报"，不能当 0**，
    /// 否则"本地估算"和"服务端实报"就混成一个数了（P3 拍板）。
    pub fn reported(&self) -> bool {
        self.prompt_tokens.is_some() || self.completion_tokens.is_some()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ChatError {
    #[error("已取消")]
    Cancelled,
    #[error("缺少 API Key：BYOK 需要先在「AI 设置」里填密钥（Ollama 不需要）")]
    MissingKey,
    #[error("网络请求失败：{0}")]
    Network(String),
    #[error("服务返回 {status}：{body}")]
    Http { status: u16, body: String },
    /// 会话已死（云网关续期被服务端拒绝）等**有明确处置**的失败：文案由调用方给，
    /// 不是裸的 HTTP 401 —— 用户该看到"去重新登录"，不是一段错误码。
    #[error("{0}")]
    Session(String),
    #[error("响应格式异常：{0}")]
    Protocol(String),
}

/// 用户在 Base URL 里多填的路径要清掉 —— 旧客户端也做这件事，
/// 否则 `/v1/chat/completions` + `/chat/completions` 会拼成 404。
pub fn normalize_base_url(raw: &str) -> String {
    let mut s = raw.trim().trim_end_matches('/').to_string();
    for suffix in ["/chat/completions", "/completions", "/api/chat", "/api/generate"] {
        if let Some(stripped) = s.strip_suffix(suffix) {
            s = stripped.to_string();
            break;
        }
    }
    s.trim_end_matches('/').to_string()
}

/// 构造请求体（单独抽出来是为了能在没有网络的情况下测）。
///
/// `max_tokens` / `temperature` 为 `None` 时**不放这两个键**（不是放 0）——
/// "没说"与"说了 0"在服务端是两件事：前者用服务端默认，后者会被钳到最小值。
pub fn build_body(r: &Resolved, messages: &[Value], stream: bool) -> Value {
    if r.is_ollama() {
        let mut options = serde_json::Map::new();
        if let Some(t) = r.temperature {
            options.insert("temperature".into(), json!(t));
        }
        if let Some(n) = r.max_tokens {
            options.insert("num_predict".into(), json!(n));
        }
        json!({
            "model": r.model,
            "messages": messages,
            "stream": stream,
            "options": Value::Object(options),
        })
    } else {
        let mut body = serde_json::Map::new();
        body.insert("model".into(), json!(r.model));
        body.insert("messages".into(), json!(messages));
        body.insert("stream".into(), json!(stream));
        if let Some(n) = r.max_tokens {
            body.insert("max_tokens".into(), json!(n));
        }
        if let Some(t) = r.temperature {
            body.insert("temperature".into(), json!(t));
        }
        // 让最后一帧带回 usage：用量面板要用它，否则只能自己数 token。
        //
        // **只在流式时加**：`stream_options` 只对 `stream: true` 有意义，
        // 个别上游在非流式请求里带上它会直接 400 —— 而记忆提取走的正是非流式
        // （`chat_once`）。原来这里无条件插入，那是个埋着的雷。
        if stream {
            body.insert("stream_options".into(), json!({ "include_usage": true }));
        }
        Value::Object(body)
    }
}

/// 在 `build_body` 之上加工具（工具循环那一路用）。
///
/// `tools` 为空时**一个键都不加** —— 不用工具的请求必须与以前逐字节一致。
pub fn build_body_with_tools(r: &Resolved, messages: &[Value], tools: &[Value], stream: bool) -> Value {
    let mut body = build_body(r, messages, stream);
    if tools.is_empty() {
        return body;
    }
    if let Value::Object(map) = &mut body {
        map.insert("tools".into(), Value::Array(tools.to_vec()));
    }
    body
}

/// 流式对话。每收到一段增量就回调一次 `on_delta`（正文与思考分开报）；`cancel` 置位时立刻中止。
///
/// 返回 `(正文, 思考, 用量)` —— 思考单独返回，界面据此在"还没有正文"的那段时间里显示进度，
/// 而不是让用户对着空气等（见 `Chunk` 的说明）。
pub async fn stream_chat<F>(
    client: &reqwest::Client,
    r: &Resolved,
    messages: Vec<Value>,
    cancel: &AtomicBool,
    mut on_delta: F,
) -> Result<(String, String, Usage), ChatError>
where
    F: FnMut(Chunk),
{
    if !r.is_ollama() && r.api_key.as_deref().unwrap_or("").trim().is_empty() {
        return Err(ChatError::MissingKey);
    }

    let url = r.endpoint();
    let body = build_body(r, &messages, true);
    let mut req = client.post(&url).json(&body);
    if let Some(key) = r.api_key.as_deref() {
        if !key.trim().is_empty() {
            req = req.bearer_auth(key.trim());
        }
    }

    let resp = req.send().await.map_err(|e| ChatError::Network(e.to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(ChatError::Http { status: status.as_u16(), body: truncate(&body, 600) });
    }

    let ollama = r.is_ollama();
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    let mut full = String::new();
    let mut reasoning = String::new();
    let mut usage = Usage::default();

    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(ChatError::Cancelled);
        }
        let chunk = match resp.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                // 已经收到内容后断开：不算失败，把已有的交出去
                if full.is_empty() {
                    return Err(ChatError::Network(e.to_string()));
                }
                break;
            }
        };
        buf.extend_from_slice(&chunk);

        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            let line = line.trim();
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            let payload = if let Some(d) = line.strip_prefix("data:") {
                let d = d.trim();
                if d == "[DONE]" {
                    continue;
                }
                d.to_string()
            } else if line.starts_with('{') {
                line.to_string() // Ollama 是 NDJSON
            } else {
                continue;
            };

            let Ok(v) = serde_json::from_str::<Value>(&payload) else {
                continue; // 单帧解析失败不该中断整条流
            };

            for chunk in extract_chunks(&v, ollama) {
                match &chunk {
                    Chunk::Text(t) => full.push_str(t),
                    Chunk::Reasoning(t) => reasoning.push_str(t),
                }
                on_delta(chunk);
            }
            merge_usage(&mut usage, &v, ollama);
        }
    }

    if cancel.load(Ordering::Relaxed) {
        return Err(ChatError::Cancelled);
    }
    Ok((full, reasoning, usage))
}

/// 流里的一小段增量：模型**正文**，或它的**思考**。
///
/// 为什么必须分开（2026-10-14 用户实测的 bug）：思考型模型（GLM / DeepSeek / Qwen 这一族）
/// 把整段推理放在 `delta.reasoning_content` 里逐帧推，正文要等推理结束才来 —— 而原来的
/// `extract_delta` 只认 `delta.content`，于是一整轮"有 token、没有正文"的调用在界面上
/// **一个字都不显示**：token 记了 2000+，对话里空白（真机抓包：`mermaid-reasoning` 连推
/// 104 帧全是 reasoning_content，客户端全部丢掉）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Chunk {
    Text(String),
    Reasoning(String),
}

/// 把一个增量字段（字符串 / 数组两种形态）取成纯文本。
///
/// 数组形态是 OpenAI 多模态的分段写法：`[{"type":"text","text":"…"}]` —— 只认字符串的
/// 实现遇到它会静默丢帧，同样是"有 token、没字"。
pub(crate) fn text_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => {
            let mut out = String::new();
            for p in parts {
                if let Some(s) = p.get("text").and_then(|t| t.as_str()) {
                    out.push_str(s);
                }
            }
            out
        }
        _ => String::new(),
    }
}

/// 一帧里能取出的所有增量（一般 0–1 个：首帧只有 role，末帧只有 usage）。
fn extract_chunks(v: &Value, ollama: bool) -> Vec<Chunk> {
    let mut out = Vec::new();
    let mut push = |kind: fn(String) -> Chunk, text: String| {
        if !text.is_empty() {
            out.push(kind(text));
        }
    };

    if ollama {
        if let Some(m) = v.get("message") {
            push(Chunk::Text, text_of(m.get("content")));
            // Ollama 的思考字段叫 thinking（新版才有）
            push(Chunk::Reasoning, text_of(m.get("thinking")));
        }
        return out;
    }

    let Some(choice) = v.get("choices").and_then(|c| c.as_array()).and_then(|a| a.first()) else {
        return out;
    };
    match choice.get("delta") {
        Some(d) => {
            push(Chunk::Text, text_of(d.get("content")));
            // `reasoning_content` 是 DeepSeek/GLM/Qwen 这一族的写法；`reasoning`/`thinking`
            // 是别的网关的别名，一起认。
            let r = d
                .get("reasoning_content")
                .or_else(|| d.get("reasoning"))
                .or_else(|| d.get("thinking"));
            push(Chunk::Reasoning, text_of(r));
        }
        // 没有 delta 的整包帧（网关把非流式的 message 塞进流里）——当作正文收下，
        // 否则这一轮又是"有 token、没字"。
        None => push(Chunk::Text, text_of(choice.pointer("/message/content"))),
    }
    out
}

fn merge_usage(usage: &mut Usage, v: &Value, ollama: bool) {
    if ollama {
        if let Some(n) = v.get("prompt_eval_count").and_then(|x| x.as_u64()) {
            usage.prompt_tokens = Some(n as u32);
        }
        if let Some(n) = v.get("eval_count").and_then(|x| x.as_u64()) {
            usage.completion_tokens = Some(n as u32);
        }
        return;
    }
    if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
        if let Some(n) = u.get("prompt_tokens").and_then(|x| x.as_u64()) {
            usage.prompt_tokens = Some(n as u32);
        }
        if let Some(n) = u.get("completion_tokens").and_then(|x| x.as_u64()) {
            usage.completion_tokens = Some(n as u32);
        }
        // 思考占了多少 token（OpenAI 系：completion_tokens_details.reasoning_tokens）。
        // 界面用它解释"为什么没有正文"：一整轮预算全花在思考上时，正文可以是空的。
        if let Some(n) = u
            .pointer("/completion_tokens_details/reasoning_tokens")
            .or_else(|| u.get("reasoning_tokens"))
            .and_then(|x| x.as_u64())
        {
            usage.reasoning_tokens = Some(n as u32);
        }
    }
}

pub(crate) fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}…")
    }
}

/// 非流式一次性对话。**只给内部辅助调用用**（当前就是记忆提取）。
///
/// 为什么不复用 `stream_chat`：提取只关心最后那段文本，流式还得自己拼装；
/// 而非流式能直接从响应里读 `usage`，成本口径更准。
pub async fn chat_once(
    client: &reqwest::Client,
    r: &Resolved,
    messages: Vec<Value>,
) -> Result<(String, Usage), ChatError> {
    if !r.is_ollama() && r.api_key.as_deref().unwrap_or("").trim().is_empty() {
        return Err(ChatError::MissingKey);
    }

    let url = r.endpoint();
    let body = build_body(r, &messages, false);
    let mut req = client.post(&url).json(&body);
    if let Some(key) = r.api_key.as_deref() {
        if !key.trim().is_empty() {
            req = req.bearer_auth(key.trim());
        }
    }

    let resp = req.send().await.map_err(|e| ChatError::Network(e.to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(ChatError::Http { status: status.as_u16(), body: truncate(&body, 600) });
    }
    let payload: Value = resp.json().await.map_err(|e| ChatError::Protocol(e.to_string()))?;

    let ollama = r.is_ollama();
    let content = if ollama {
        payload.pointer("/message/content")
    } else {
        payload.pointer("/choices/0/message/content")
    };
    let text = text_of(content);

    let mut usage = Usage::default();
    merge_usage(&mut usage, &payload, ollama);
    Ok((text, usage))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn openai() -> Resolved {
        Resolved {
            provider: "openai".into(),
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-4o".into(),
            api_key: Some("sk-x".into()),
            max_tokens: Some(4096),
            temperature: Some(0.7),
        }
    }

    #[test]
    fn base_url_normalisation_strips_pasted_endpoint_paths() {
        assert_eq!(normalize_base_url("https://api.openai.com/v1/"), "https://api.openai.com/v1");
        assert_eq!(normalize_base_url("https://api.openai.com/v1/chat/completions"), "https://api.openai.com/v1");
        assert_eq!(normalize_base_url("http://localhost:11434/api/chat"), "http://localhost:11434");
        assert_eq!(normalize_base_url("  https://x.y/v1/completions  "), "https://x.y/v1");
    }

    #[test]
    fn endpoints_are_built_per_provider() {
        assert_eq!(openai().endpoint(), "https://api.openai.com/v1/chat/completions");
        let mut o = openai();
        o.provider = "ollama".into();
        o.base_url = "http://localhost:11434".into();
        assert_eq!(o.endpoint(), "http://localhost:11434/api/chat");
    }

    #[test]
    fn openai_body_asks_for_usage_and_forces_stream() {
        let body = build_body(&openai(), &[json!({"role":"user","content":"hi"})], true);
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["model"], "gpt-4o");
    }

    /// 非流式**不能**带 `stream_options`：它只对 `stream: true` 有意义，
    /// 个别上游在非流式请求里带上会直接 400 —— 而记忆提取（`chat_once`）走的正是非流式。
    #[test]
    fn nonstream_body_omits_stream_options() {
        let body = build_body(&openai(), &[json!({"role":"user","content":"hi"})], false);
        assert_eq!(body["stream"], false);
        assert!(body.get("stream_options").is_none(), "非流式不该带 stream_options：{body}");
    }

    #[test]
    fn ollama_body_uses_its_own_options_shape() {
        let mut r = openai();
        r.provider = "ollama".into();
        let body = build_body(&r, &[], true);
        assert!(body.get("options").is_some(), "Ollama 用 options，不是顶层 max_tokens");
        assert_eq!(body["options"]["num_predict"], 4096);
        assert!(body.get("stream_options").is_none());
    }

    /// 云网关那条路：`max_tokens`/`temperature` 为 `None` 时**键都不出现**。
    /// 放 0 或放客户端自己猜的值都会改变服务端的钳制结果（见 `Resolved.max_tokens` 注释）。
    #[test]
    fn none_knobs_are_omitted_entirely_not_zeroed() {
        let r = Resolved { max_tokens: None, temperature: None, ..openai() };
        let body = build_body(&r, &[json!({"role":"user","content":"hi"})], true);
        assert!(body.get("max_tokens").is_none(), "不该出现 max_tokens: {body}");
        assert!(body.get("temperature").is_none(), "不该出现 temperature: {body}");
        // 该带的还得带
        assert_eq!(body["model"], "gpt-4o");
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
    }

    #[test]
    fn ollama_options_omit_missing_knobs_too() {
        let r = Resolved { provider: "ollama".into(), max_tokens: None, temperature: None, ..openai() };
        let body = build_body(&r, &[], true);
        assert_eq!(body["options"], json!({}), "options 里不该出现 temperature/num_predict");
    }

    #[test]
    fn openai_delta_extraction_reads_choices_delta_content() {
        let v = json!({"choices":[{"delta":{"content":"你好"}}]});
        assert_eq!(extract_chunks(&v, false), vec![Chunk::Text("你好".into())]);
        // 只有 role 的首帧没有 content，不该产出空回调
        let v = json!({"choices":[{"delta":{"role":"assistant"}}]});
        assert!(extract_chunks(&v, false).is_empty());
    }

    /// 真机抓包（2026-10-14，云网关 `mermaid-reasoning`）：整条流 104 帧全是
    /// `delta.reasoning_content`，一个 `content` 都没有。改之前这些帧被**全部丢掉** ——
    /// 用户那边就是"消耗了 2000+ token，对话里一个字都没有"。
    #[test]
    fn reasoning_content_frames_are_kept() {
        // 这两帧是从真流里抄下来的原样 JSON
        let v: Value = serde_json::from_str(
            r#"{"id":"e405a780806d23d3f0428d693ee0bef3","object":"chat.completion.chunk","created":1791985709,"model":"mermaid-reasoning","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"用户想要暗色配色"},"finish_reason":null}]}"#,
        )
        .unwrap();
        assert_eq!(extract_chunks(&v, false), vec![Chunk::Reasoning("用户想要暗色配色".into())]);

        let v: Value = serde_json::from_str(
            r#"{"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"50f,stroke:#f"},"finish_reason":null}]}"#,
        )
        .unwrap();
        assert_eq!(extract_chunks(&v, false), vec![Chunk::Reasoning("50f,stroke:#f".into())]);

        // 别名（别的网关叫 reasoning / thinking）也认
        for key in ["reasoning", "thinking"] {
            let v = json!({"choices":[{"delta":{key:"想一下"}}]});
            assert_eq!(extract_chunks(&v, false), vec![Chunk::Reasoning("想一下".into())], "{key}");
        }
    }

    /// 正文以**分段数组**给出的形态（OpenAI 多模态写法）：只认字符串的实现会静默丢帧 ——
    /// 同样是"有 token、没字"。
    #[test]
    fn content_as_parts_array_is_joined() {
        let v = json!({"choices":[{"delta":{"content":[{"type":"text","text":"第一段"},{"type":"text","text":"第二段"}]}}]});
        assert_eq!(extract_chunks(&v, false), vec![Chunk::Text("第一段第二段".into())]);
    }

    /// 没有 `delta`、直接给整包 `message` 的帧（有的网关把非流式响应塞进流里）。
    #[test]
    fn whole_message_frame_without_delta_counts_as_text() {
        let v = json!({"choices":[{"message":{"role":"assistant","content":"整包正文"}}]});
        assert_eq!(extract_chunks(&v, false), vec![Chunk::Text("整包正文".into())]);
        // 有 delta 的帧就不能再看 message（否则正文会被算两遍）
        let v = json!({"choices":[{"delta":{"content":"增量"},"message":{"content":"整包"}}]});
        assert_eq!(extract_chunks(&v, false), vec![Chunk::Text("增量".into())]);
    }

    #[test]
    fn ollama_delta_extraction_reads_message_content() {
        let v = json!({"message":{"role":"assistant","content":"部分"},"done":false});
        assert_eq!(extract_chunks(&v, true), vec![Chunk::Text("部分".into())]);
        let v = json!({"message":{"role":"assistant","thinking":"先想"},"done":false});
        assert_eq!(extract_chunks(&v, true), vec![Chunk::Reasoning("先想".into())]);
    }

    #[test]
    fn usage_is_merged_from_the_final_frame() {
        let mut u = Usage::default();
        merge_usage(&mut u, &json!({"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}), false);
        assert_eq!(u.prompt_tokens, Some(11));
        assert_eq!(u.completion_tokens, Some(7));
        assert_eq!(u.reasoning_tokens, None);

        let mut o = Usage::default();
        merge_usage(&mut o, &json!({"done":true,"prompt_eval_count":5,"eval_count":9}), true);
        assert_eq!(o.prompt_tokens, Some(5));
        assert_eq!(o.completion_tokens, Some(9));
    }

    /// 思考 token 单独计：界面用它解释"为什么这一轮没有正文"（预算全花在推理上）。
    #[test]
    fn reasoning_tokens_are_read_from_completion_details() {
        let mut u = Usage::default();
        merge_usage(
            &mut u,
            &json!({"choices":[],"usage":{"prompt_tokens":137,"completion_tokens":2140,
                    "completion_tokens_details":{"reasoning_tokens":2088}}}),
            false,
        );
        assert_eq!(u.prompt_tokens, Some(137));
        assert_eq!(u.completion_tokens, Some(2140));
        assert_eq!(u.reasoning_tokens, Some(2088));
    }

    #[test]
    fn missing_key_is_a_distinct_error_for_openai_but_not_for_ollama() {
        let mut r = openai();
        r.api_key = None;
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let client = reqwest::Client::new();
        let cancel = AtomicBool::new(false);
        let err = rt
            .block_on(stream_chat(&client, &r, vec![], &cancel, |_| {}))
            .unwrap_err();
        assert!(matches!(err, ChatError::MissingKey), "{err:?}");
    }
}
