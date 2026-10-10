//! AI 调用错误。

/// 供应商调用失败。
#[derive(Debug, thiserror::Error)]
pub enum AiError {
    #[error("网络错误: {0}")]
    Network(String),
    #[error("上游返回 {status}: {body}")]
    Upstream { status: u16, body: String },
    #[error("响应格式异常: {0}")]
    Protocol(String),
    #[error("配置不完整: {0}")]
    Config(String),
}

impl AiError {
    /// 稳定错误码，前端据此分支与本地化。
    pub fn code(&self) -> &'static str {
        match self {
            AiError::Network(_) => "ai_network",
            AiError::Upstream { status, .. } => match status {
                401 | 403 => "ai_unauthorized",
                429 => "ai_rate_limited",
                _ => "ai_upstream",
            },
            AiError::Protocol(_) => "ai_protocol",
            AiError::Config(_) => "ai_config",
        }
    }
}
