//! AI 供应商实现（BYOK）。
//!
//! 覆盖三家（阶段 3 的 BYOK 范围）：
//! * `openai` —— 官方或任何 OpenAI 兼容后端
//! * `custom` —— 与 openai 同构，但 API Key 可选
//! * `ollama` —— 本地模型，走 `/api/chat`
//!
//! 数据结构（`ModelConfig` / `ChatMessage` / `Provider`）定义在 `app-ipc`（前后端契约），
//! 本 crate 只放行为：端点推导、载荷构造、请求发送、代码提取。
//! 纯逻辑与网络调用分开，前者可单元测试。

pub mod error;
pub mod prompt;

pub use app_ipc::{AiChatMessage as ChatMessage, AiModelConfig as ModelConfig, AiProvider as Provider};
pub use error::AiError;

/// HTTP 客户端类型别名：上层不必直接依赖 `reqwest`。
pub type HttpClient = reqwest::Client;

/// 建一个复用的 HTTP 客户端（连接池共用；超时交给调用方按请求设置）。
pub fn new_client() -> HttpClient {
    reqwest::Client::builder()
        .user_agent(concat!("Diagramon/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_default()
}

/// 清洗后的基地址（不带尾部斜杠与 `/chat/completions` 等尾缀）。
pub fn effective_base_url(config: &ModelConfig) -> String {
    clean_base_url(&config.base_url, config.provider)
}

/// 实际请求的端点。
pub fn endpoint(config: &ModelConfig) -> String {
    let base = effective_base_url(config);
    match config.provider {
        Provider::Ollama => format!("{base}/api/chat"),
        _ => format!("{base}/chat/completions"),
    }
}

/// 清洗用户填写的 Base URL。
///
/// 既有客户端的 `CleanBaseUrl` 语义：去掉尾部空白与斜杠，并把常见的"完整端点"退化成基地址
/// （用户经常直接粘贴 `https://api.openai.com/v1/chat/completions`）。
pub fn clean_base_url(raw: &str, provider: Provider) -> String {
    let mut url = raw.trim().trim_end_matches('/').to_string();

    let suffixes: &[&str] = match provider {
        Provider::Ollama => &["/api/chat", "/api/generate", "/chat/completions"],
        _ => &["/chat/completions", "/v1/chat/completions", "/api/chat"],
    };
    loop {
        let before = url.clone();
        for suffix in suffixes {
            if let Some(stripped) = url.strip_suffix(suffix) {
                url = stripped.trim_end_matches('/').to_string();
            }
        }
        if url == before {
            break;
        }
    }

    if url.is_empty() {
        provider.default_base_url().to_string()
    } else {
        url
    }
}

/// 构造某个供应商的请求体。
pub fn build_payload(config: &ModelConfig, messages: &[ChatMessage]) -> serde_json::Value {
    match config.provider {
        Provider::Ollama => {
            let msgs: Vec<serde_json::Value> = messages
                .iter()
                .map(|m| {
                    let mut obj = serde_json::json!({ "role": m.role, "content": m.text });
                    if let Some(img) = &m.image_data_url {
                        // Ollama 的多模态走 images 字段（纯 base64，不带 data: 前缀）
                        obj["images"] = serde_json::json!([strip_data_url(img)]);
                    }
                    obj
                })
                .collect();
            serde_json::json!({
                "model": config.model_id,
                "messages": msgs,
                "stream": false,
                "options": { "num_predict": config.max_tokens, "temperature": config.temperature },
            })
        }
        _ => {
            let msgs: Vec<serde_json::Value> = messages
                .iter()
                .map(|m| {
                    if let Some(img) = &m.image_data_url {
                        serde_json::json!({
                            "role": m.role,
                            "content": [
                                { "type": "text", "text": m.text },
                                { "type": "image_url", "image_url": { "url": img } },
                            ],
                        })
                    } else {
                        serde_json::json!({ "role": m.role, "content": m.text })
                    }
                })
                .collect();
            serde_json::json!({
                "model": config.model_id,
                "messages": msgs,
                "max_tokens": config.max_tokens,
                "temperature": config.temperature,
                "stream": false,
            })
        }
    }
}

/// 去掉 `data:…;base64,` 前缀。
fn strip_data_url(url: &str) -> &str {
    url.split_once(',').map(|(_, b)| b).unwrap_or(url)
}

/// 从供应商响应里取正文。
pub fn extract_content(provider: Provider, body: &serde_json::Value) -> Option<String> {
    match provider {
        Provider::Ollama => body
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .map(str::to_string),
        _ => body
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .map(str::to_string),
    }
}

/// 发出一次对话请求。
pub async fn chat(
    client: &reqwest::Client,
    config: &ModelConfig,
    api_key: Option<&str>,
    messages: &[ChatMessage],
) -> Result<String, AiError> {
    let payload = build_payload(config, messages);

    let mut req = client.post(endpoint(config)).json(&payload);
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        req = req.bearer_auth(key);
    }

    let resp = req.send().await.map_err(|e| AiError::Network(e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| AiError::Network(e.to_string()))?;

    if !status.is_success() {
        return Err(AiError::Upstream {
            status: status.as_u16(),
            body: summarize(&text),
        });
    }

    let body: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| AiError::Protocol(format!("{e}: {}", summarize(&text))))?;

    extract_content(config.provider, &body)
        .ok_or_else(|| AiError::Protocol(format!("响应中没有内容: {}", summarize(&text))))
}

/// 截断长响应体，避免把整个 HTML 错误页塞进 UI。
fn summarize(text: &str) -> String {
    let t = text.trim();
    if t.chars().count() <= 300 {
        t.to_string()
    } else {
        let head: String = t.chars().take(300).collect();
        format!("{head}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_base_url_strips_paths_and_slashes() {
        let cases = [
            ("https://api.openai.com/v1/", "https://api.openai.com/v1"),
            ("https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1"),
            ("https://x.example/chat/completions", "https://x.example"),
            ("  https://x.example/v1/  ", "https://x.example/v1"),
            ("http://localhost:11434/", "http://localhost:11434"),
        ];
        for (input, want) in cases {
            assert_eq!(clean_base_url(input, Provider::OpenAi), want, "input={input}");
        }
    }

    #[test]
    fn clean_base_url_ollama_and_empty_fallback() {
        assert_eq!(
            clean_base_url("http://localhost:11434/api/chat", Provider::Ollama),
            "http://localhost:11434"
        );
        assert_eq!(clean_base_url("   ", Provider::Ollama), "http://localhost:11434");
        assert_eq!(clean_base_url("", Provider::OpenAi), "https://api.openai.com/v1");
    }

    #[test]
    fn endpoint_depends_on_provider() {
        let openai = ModelConfig {
            provider: Provider::OpenAi,
            base_url: "https://a.example/v1".into(),
            ..Default::default()
        };
        assert_eq!(endpoint(&openai), "https://a.example/v1/chat/completions");

        let ollama = ModelConfig {
            provider: Provider::Ollama,
            base_url: "http://localhost:11434/".into(),
            ..Default::default()
        };
        assert_eq!(endpoint(&ollama), "http://localhost:11434/api/chat");
    }

    #[test]
    fn payload_shapes_match_provider() {
        let msgs = vec![ChatMessage::system("sys"), ChatMessage::user("hi")];

        let openai = build_payload(
            &ModelConfig { provider: Provider::OpenAi, max_tokens: 128, temperature: 0.2, ..Default::default() },
            &msgs,
        );
        assert_eq!(openai["max_tokens"], 128);
        assert_eq!(openai["messages"][0]["role"], "system");
        assert_eq!(openai["stream"], false);

        let ollama = build_payload(
            &ModelConfig { provider: Provider::Ollama, max_tokens: 64, temperature: 0.1, ..Default::default() },
            &msgs,
        );
        assert_eq!(ollama["options"]["num_predict"], 64);
        let temp = ollama["options"]["temperature"].as_f64().expect("temperature 是数字");
        assert!((temp - 0.1).abs() < 1e-6, "temperature={temp}");
    }

    #[test]
    fn vision_payload_carries_image() {
        let msg = ChatMessage::user_with_image("看图", "data:image/png;base64,AAAA");
        let openai = build_payload(&ModelConfig::default(), std::slice::from_ref(&msg));
        assert_eq!(openai["messages"][0]["content"][1]["type"], "image_url");
        assert_eq!(openai["messages"][0]["content"][1]["image_url"]["url"], "data:image/png;base64,AAAA");

        let ollama = build_payload(&ModelConfig { provider: Provider::Ollama, ..Default::default() }, &[msg]);
        assert_eq!(ollama["messages"][0]["images"][0], "AAAA", "Ollama 的 images 不带 data: 前缀");
    }

    #[test]
    fn extract_content_reads_both_shapes() {
        let openai = serde_json::json!({ "choices": [{ "message": { "content": "hi" } }] });
        assert_eq!(extract_content(Provider::OpenAi, &openai).as_deref(), Some("hi"));

        let ollama = serde_json::json!({ "message": { "content": "yo" } });
        assert_eq!(extract_content(Provider::Ollama, &ollama).as_deref(), Some("yo"));

        assert!(extract_content(Provider::OpenAi, &serde_json::json!({})).is_none());
    }
}
