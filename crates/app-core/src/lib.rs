//! app-core —— 文档模型、格式注册表与会话状态（三平台共享，无平台依赖）。

pub mod crash;
pub mod document;
pub mod format;
pub mod image;
pub mod session;
pub mod settings;

pub use crash::append as append_crash_log;
pub use document::Document;
pub use format::{spec, spec_by_id, specs, FormatSpec, LayoutOption, Surface};
pub use image::{decode_data_url, extension_for_mime};
pub use session::Session;
pub use settings::{RecentFile, Settings, MAX_RECENT_FILES};
