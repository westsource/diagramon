//! Diagramon 核心逻辑：格式注册表、文档与会话、语法校验、大纲、作用域、设置合并。
//!
//! 这一层**不碰窗口、不碰平台差异**：文件 IO 在 `src-tauri` 的命令层，凭据在 `platform`。
//! 因此它可以被 `cargo test` 直接覆盖（各模块尾部都有 `#[cfg(test)]`）。

pub mod cloudmap;
pub mod conversations;
pub mod convert;
pub mod document;
pub mod format;
pub mod guard;
pub mod lint;
pub mod memory;
pub mod outline;
pub mod pixels;
pub mod recovery;
pub mod scope;
pub mod session;
pub mod settings;
pub mod workspace;

pub use session::{Entry, Session};
