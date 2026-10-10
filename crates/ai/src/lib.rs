//! Diagramon AI（BYOK）：提示词、供应商与流式对话。
//!
//! 云网关（会员档位、信用点）不在本层：接入时按同一签名再实现一个 provider 即可，
//! 命令层与前端不必改。

pub mod prompt;
pub mod provider;

pub use prompt::{build_messages, extract_code, system_prompt};
pub use provider::{build_body, normalize_base_url, stream_chat, ChatError, Resolved, Usage};
