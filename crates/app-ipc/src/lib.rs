//! 前后端契约：命令与事件的载荷类型。
//!
//! **这是唯一真源** —— 前端 `ui/js/ipc.js` 只做 `invoke` 包装，不另立一份字段清单；
//! Rust 侧的命令签名必须与本文件逐字段对应。

use serde::{Deserialize, Serialize};

/// 四种格式。`rename_all = "lowercase"` ⇒ 前端拿到 `"mermaid" | "dot" | "drawio" | "excalidraw"`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FormatId {
    Mermaid,
    Dot,
    Drawio,
    Excalidraw,
}

impl FormatId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mermaid => "mermaid",
            Self::Dot => "dot",
            Self::Drawio => "drawio",
            Self::Excalidraw => "excalidraw",
        }
    }

    /// 未知扩展名回退 Mermaid（与旧实现一致：不报错，按最常用的处理）。
    pub fn from_ext(ext: &str) -> Self {
        match ext.trim_start_matches('.').to_ascii_lowercase().as_str() {
            "dot" | "gv" => Self::Dot,
            "drawio" => Self::Drawio,
            "excalidraw" => Self::Excalidraw,
            _ => Self::Mermaid,
        }
    }

    pub fn from_str_opt(s: &str) -> Option<Self> {
        match s {
            "mermaid" => Some(Self::Mermaid),
            "dot" => Some(Self::Dot),
            "drawio" => Some(Self::Drawio),
            "excalidraw" => Some(Self::Excalidraw),
            _ => None,
        }
    }
}

/// 承载方式：文本型可分屏，画布型"画布即编辑器"。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Surface {
    Text,
    Canvas,
}

/// 视图模式：仅源码 / 分屏 / 仅预览（后者即隐藏源码窗口）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewMode {
    Source,
    Split,
    Preview,
}

impl ViewMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Source => "source",
            Self::Split => "split",
            Self::Preview => "preview",
        }
    }
}

/// 格式能力位：UI 上出现什么控件，全由这里决定，不在前端写死。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormatInfo {
    pub id: FormatId,
    pub name: String,
    pub short: String,
    pub exts: Vec<String>,
    pub surface: Surface,
    /// 是否支持 源码/分屏/预览 三态（drawio / Excalidraw 为 false）
    pub split_view: bool,
    /// 是否支持 AI 直出（画布型经 Mermaid 转换间接产出）
    pub ai: bool,
    /// 可作为转换源的目标格式
    pub convert_to: Vec<FormatId>,
    /// 布局引擎（仅 DOT）
    pub layouts: Vec<String>,
    /// 一句话说明，用于新建对话框与 tooltip
    pub note: String,
    /// 新建文档的默认正文
    pub default_body: String,
}

/// 打开/新建的文档。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Doc {
    pub id: String,
    /// `None` = 未保存到磁盘
    pub path: Option<String>,
    pub name: String,
    pub format: FormatId,
    pub body: String,
    pub dirty: bool,
    pub view_mode: ViewMode,
    pub caret_line: u32,
    pub caret_col: u32,
    /// DOT 布局引擎
    pub layout: Option<String>,
}

/// 会话：打开的文档与当前活动文档。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub docs: Vec<Doc>,
    pub active: Option<String>,
}

/// 语法问题（问题面板 + 源码行内标注）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Issue {
    pub severity: Severity,
    /// 1 起
    pub line: u32,
    pub message: String,
    pub hint: String,
}

/// 大纲：分组 + 行号可跳转的条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutlineRow {
    pub name: String,
    /// node | edge | cluster | element
    pub kind: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutlineGroup {
    pub title: String,
    pub rows: Vec<OutlineRow>,
}

/* ---------------- 设置 ---------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PanelPrefs {
    pub activitybar: bool,
    pub sidebar: bool,
    pub sidebar_view: String,
    pub ai: bool,
    pub bottom: bool,
    pub bottom_tab: String,
    pub sidebar_w: u32,
    pub ai_w: u32,
    pub panel_h: u32,
    pub split_src: u32,
}

impl Default for PanelPrefs {
    fn default() -> Self {
        Self {
            activitybar: true,
            sidebar: true,
            sidebar_view: "explorer".into(),
            ai: true,
            bottom: true,
            bottom_tab: "problems".into(),
            sidebar_w: 236,
            ai_w: 344,
            panel_h: 168,
            split_src: 46,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct EditorPrefs {
    pub font_size: u32,
    pub debounce_ms: u32,
    pub lint: bool,
    pub per_doc_view: bool,
    pub default_view: ViewMode,
}

impl Default for EditorPrefs {
    fn default() -> Self {
        Self { font_size: 13, debounce_ms: 350, lint: true, per_doc_view: true, default_view: ViewMode::Split }
    }
}

/// 单个 AI 模型配置。`key_hint` 是掩码（如 `sk-…1234`），**密钥本体永不回传前端**。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModel {
    pub id: String,
    pub name: String,
    /// openai | ollama | custom
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub max_tokens: u32,
    pub temperature: f32,
    /// 由 Rust 依凭据库**现算**后下发；前端回传时允许省略
    #[serde(default)]
    pub has_key: bool,
    /// 掩码（`sk-…1234`）；同上，前端回传时允许省略
    #[serde(default)]
    pub key_hint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AiPrefs {
    pub models: Vec<AiModel>,
    pub default_model: String,
    pub vision_notice_accepted: bool,
    pub render_retry: bool,
    pub context_from_doc: bool,
}

impl Default for AiPrefs {
    fn default() -> Self {
        Self {
            models: Vec::new(),
            default_model: String::new(),
            vision_notice_accepted: false,
            render_retry: true,
            context_from_doc: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentEntry {
    pub path: String,
    pub name: String,
    pub format: FormatId,
    pub opened_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// light | dark | auto
    pub theme: String,
    /// compact | normal | roomy
    pub density: String,
    /// pine | indigo | lotus | ochre | graphite
    pub accent: String,
    /// zh-CN | en-US
    pub locale: String,
    pub panels: PanelPrefs,
    pub editor: EditorPrefs,
    pub ai: AiPrefs,
    pub recent: Vec<RecentEntry>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "light".into(),
            density: "normal".into(),
            accent: "pine".into(),
            locale: "zh-CN".into(),
            panels: PanelPrefs::default(),
            editor: EditorPrefs::default(),
            ai: AiPrefs::default(),
            recent: Vec::new(),
        }
    }
}

/* ---------------- AI 请求与流 ---------------- */

/// 意图：生成 / 识图 / 改图。决定系统提示词与是否必须视觉档。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiIntent {
    Generate,
    Vision,
    Review,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatRequest {
    pub request_id: String,
    pub model_id: String,
    pub intent: AiIntent,
    pub prompt: String,
    /// 当前格式（决定提示词与代码围栏提取）
    pub format: FormatId,
    /// 当前文档正文（作为上下文；可空）
    pub context: Option<String>,
    /// `data:image/png;base64,…`（识图）
    pub image_data_url: Option<String>,
}

/// 事件名：`ai://delta` / `ai://done` / `ai://failed`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiDelta {
    pub request_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiDone {
    pub request_id: String,
    pub text: String,
    /// 本次实际使用的模型名（自动选档时由服务端回报，BYOK 下即配置里的 model）
    pub model: String,
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiFailed {
    pub request_id: String,
    pub message: String,
}

/// 启动信息：版本、平台、格式注册表。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub formats: Vec<FormatInfo>,
}

/// 事件名常量（与前端 `ipc.on(...)` 逐字对应）。
pub mod events {
    pub const AI_DELTA: &str = "ai://delta";
    pub const AI_DONE: &str = "ai://done";
    pub const AI_FAILED: &str = "ai://failed";
}

/// 命令名常量（与 `ui/js/ipc.js` 逐字对应，避免两侧拼错字符串）。
pub mod commands {
    pub const APP_INFO: &str = "app_info";
    pub const SETTINGS_GET: &str = "settings_get";
    pub const SETTINGS_PATCH: &str = "settings_patch";
    pub const SESSION_GET: &str = "session_get";
    pub const DOC_NEW: &str = "doc_new";
    pub const DOC_OPEN_PATHS: &str = "doc_open_paths";
    pub const DOC_SAVE: &str = "doc_save";
    pub const DOC_SAVE_AS: &str = "doc_save_as";
    pub const DOC_CLOSE: &str = "doc_close";
    pub const DOC_ACTIVATE: &str = "doc_activate";
    pub const DOC_SET_BODY: &str = "doc_set_body";
    pub const DOC_SET_CARET: &str = "doc_set_caret";
    pub const DOC_SET_VIEW_MODE: &str = "doc_set_view_mode";
    pub const DOC_SET_LAYOUT: &str = "doc_set_layout";
    pub const DOC_ISSUES: &str = "doc_issues";
    pub const DOC_OUTLINE: &str = "doc_outline";
    pub const DOC_SCOPE: &str = "doc_scope";
    pub const EXPORT_WRITE: &str = "export_write";
    pub const CRED_SET: &str = "cred_set";
    pub const CRED_DELETE: &str = "cred_delete";
    pub const AI_CHAT: &str = "ai_chat";
    pub const AI_CANCEL: &str = "ai_cancel";
}
