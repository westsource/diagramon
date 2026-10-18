//! Diagramon AI（BYOK）：提示词、供应商与流式对话。
//!
//! 云网关（会员档位、信用点）不在本层：接入时按同一签名再实现一个 provider 即可，
//! 命令层与前端不必改。

pub mod agent;
pub mod prompt;
pub mod provider;

pub use agent::{run, AgentOutcome, Completer, Completion, HttpCompleter, StopReason, Tool, DEFAULT_MAX_STEPS};
pub use prompt::{
    build_messages, build_messages_with_history, extract_code, fit_history, inject_memory,
    memory_extract_user, parse_memory_candidates, system_prompt, HISTORY_MAX_CHARS,
    HISTORY_MAX_TURNS, MEMORY_EXTRACT_MAX, MEMORY_EXTRACT_SYSTEM,
};
pub use provider::{
    build_body, build_body_with_tools, chat_once, normalize_base_url, stream_chat, ChatError, Chunk,
    Finish, Resolved, Usage,
};
