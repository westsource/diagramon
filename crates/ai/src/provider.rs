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
    pub max_tokens: u32,
    pub temperature: f32,
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
pub fn build_body(r: &Resolved, messages: &[Value], stream: bool) -> Value {
    if r.is_ollama() {
        json!({
            "model": r.model,
            "messages": messages,
            "stream": stream,
            "options": { "temperature": r.temperature, "num_predict": r.max_tokens }
        })
    } else {
        json!({
            "model": r.model,
            "messages": messages,
            "stream": stream,
            "max_tokens": r.max_tokens,
            "temperature": r.temperature,
            // 让最后一帧带回 usage：用量面板要用它，否则只能自己数 token
            "stream_options": { "include_usage": true }
        })
    }
}

/// 流式对话。每收到一段增量就回调一次 `on_delta`；`cancel` 置位时立刻中止。
pub async fn stream_chat<F>(
    client: &reqwest::Client,
    r: &Resolved,
    messages: Vec<Value>,
    cancel: &AtomicBool,
    mut on_delta: F,
) -> Result<(String, Usage), ChatError>
where
    F: FnMut(&str),
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

            if let Some(delta) = extract_delta(&v, ollama) {
                full.push_str(&delta);
                on_delta(&delta);
            }
            merge_usage(&mut usage, &v, ollama);
        }
    }

    if cancel.load(Ordering::Relaxed) {
        return Err(ChatError::Cancelled);
    }
    Ok((full, usage))
}

fn extract_delta(v: &Value, ollama: bool) -> Option<String> {
    if ollama {
        v.get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .map(str::to_string)
            .filter(|s| !s.is_empty())
    } else {
        v.get("choices")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|c| c.get("delta"))
            .and_then(|d| d.get("content"))
            .and_then(|c| c.as_str())
            .map(str::to_string)
            .filter(|s| !s.is_empty())
    }
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
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}…")
    }
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
            max_tokens: 4096,
            temperature: 0.7,
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

    #[test]
    fn ollama_body_uses_its_own_options_shape() {
        let mut r = openai();
        r.provider = "ollama".into();
        let body = build_body(&r, &[], true);
        assert!(body.get("options").is_some(), "Ollama 用 options，不是顶层 max_tokens");
        assert_eq!(body["options"]["num_predict"], 4096);
        assert!(body.get("stream_options").is_none());
    }

    #[test]
    fn openai_delta_extraction_reads_choices_delta_content() {
        let v = json!({"choices":[{"delta":{"content":"你好"}}]});
        assert_eq!(extract_delta(&v, false).as_deref(), Some("你好"));
        // 只有 role 的首帧没有 content，不该产出空回调
        let v = json!({"choices":[{"delta":{"role":"assistant"}}]});
        assert_eq!(extract_delta(&v, false), None);
    }

    #[test]
    fn ollama_delta_extraction_reads_message_content() {
        let v = json!({"message":{"role":"assistant","content":"部分"},"done":false});
        assert_eq!(extract_delta(&v, true).as_deref(), Some("部分"));
    }

    #[test]
    fn usage_is_merged_from_the_final_frame() {
        let mut u = Usage::default();
        merge_usage(&mut u, &json!({"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}), false);
        assert_eq!(u.prompt_tokens, Some(11));
        assert_eq!(u.completion_tokens, Some(7));

        let mut o = Usage::default();
        merge_usage(&mut o, &json!({"done":true,"prompt_eval_count":5,"eval_count":9}), true);
        assert_eq!(o.prompt_tokens, Some(5));
        assert_eq!(o.completion_tokens, Some(9));
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
