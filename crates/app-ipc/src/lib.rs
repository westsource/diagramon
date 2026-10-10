//! 前后端契约（命令与事件载荷）。
//!
//! 本 crate 是三平台与外置前端共享的**唯一**契约层：Rust 侧 `tauri::command`
//! 的入参/返回值与前端 `invoke()` 的类型在这里定义，避免两侧各写一份。

use serde::{Deserialize, Serialize};

/// 编辑器支持的四种格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocFormat {
    /// Mermaid（`.mmd` / `.mermaid`）
    Mermaid,
    /// Graphviz DOT（`.dot` / `.gv`）
    Dot,
    /// drawio（`.drawio`）
    Drawio,
    /// Excalidraw（`.excalidraw`）
    Excalidraw,
}

impl DocFormat {
    pub const ALL: [DocFormat; 4] = [
        DocFormat::Mermaid,
        DocFormat::Dot,
        DocFormat::Drawio,
        DocFormat::Excalidraw,
    ];

    /// 稳定标识（用于前端分支与设置持久化）。
    pub fn id(self) -> &'static str {
        match self {
            DocFormat::Mermaid => "mermaid",
            DocFormat::Dot => "dot",
            DocFormat::Drawio => "drawio",
            DocFormat::Excalidraw => "excalidraw",
        }
    }

    /// 新建文档时写入磁盘的默认扩展名（不含点）。
    pub fn default_extension(self) -> &'static str {
        match self {
            DocFormat::Mermaid => "mmd",
            DocFormat::Dot => "dot",
            DocFormat::Drawio => "drawio",
            DocFormat::Excalidraw => "excalidraw",
        }
    }

    /// 该格式可识别的扩展名（小写，不含点）。
    pub fn extensions(self) -> &'static [&'static str] {
        match self {
            DocFormat::Mermaid => &["mmd", "mermaid"],
            DocFormat::Dot => &["dot", "gv"],
            DocFormat::Drawio => &["drawio"],
            DocFormat::Excalidraw => &["excalidraw"],
        }
    }

    /// 由扩展名识别格式；无法识别返回 `None`。
    pub fn from_extension(ext: &str) -> Option<Self> {
        let ext = ext.to_ascii_lowercase();
        DocFormat::ALL
            .into_iter()
            .find(|f| f.extensions().contains(&ext.as_str()))
    }

    /// 由文件路径识别格式；**无法识别时回退 Mermaid**（与既有客户端行为一致）。
    pub fn from_path(path: &std::path::Path) -> Self {
        path.extension()
            .and_then(|e| e.to_str())
            .and_then(DocFormat::from_extension)
            .unwrap_or(DocFormat::Mermaid)
    }

    /// 是否为"文本即文件正文"的格式（Mermaid/DOT）；画布格式由自有编辑器承载。
    pub fn is_text(self) -> bool {
        matches!(self, DocFormat::Mermaid | DocFormat::Dot)
    }
}

impl std::fmt::Display for DocFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.id())
    }
}

/// 传给前端的标签页状态（正文另经 `read_document` 按需取，避免大文件随状态全量推送）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabState {
    pub id: String,
    /// 磁盘路径；未落盘的新文档为 `None`。
    pub path: Option<String>,
    pub format: DocFormat,
    /// 标题（文件名或"未命名"）。
    pub title: String,
    pub dirty: bool,
}

/// `open_paths` / `open_dialog` 的结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    pub tab: TabState,
    pub body: String,
}

/// 应用与运行时信息（用于关于对话框与诊断）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub platform: String,
    /// 自定义协议 origin（诊断用；三平台不同）。
    pub origin: String,
}

/// 一个格式的元数据快照（供前端构建菜单与界面分支，避免前端再写一份格式清单）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatInfo {
    pub id: String,
    pub default_extension: String,
    pub extensions: Vec<String>,
    /// `textWithPreview` | `embeddedApp`
    pub surface: String,
    pub supports_ai_assistant: bool,
    pub supports_graph_import: bool,
    pub layout_options: Vec<LayoutOptionDto>,
}

/// 布局引擎选项（目前仅 DOT）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutOptionDto {
    pub id: String,
    pub label: String,
    pub is_default: bool,
}

/// 凭据读写请求（AI 供应商 API Key 等）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRecord {
    /// 逻辑键，例如 `ai.<model-id>`。
    pub key: String,
    pub value: String,
}

/// AI 供应商。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    OpenAi,
    Custom,
    Ollama,
}

impl AiProvider {
    pub fn default_base_url(self) -> &'static str {
        match self {
            AiProvider::OpenAi | AiProvider::Custom => "https://api.openai.com/v1",
            AiProvider::Ollama => "http://localhost:11434",
        }
    }

    /// API Key 是否必填（自建网关与本地模型可以不带）。
    pub fn requires_key(self) -> bool {
        matches!(self, AiProvider::OpenAi)
    }
}

/// 一个模型配置。**不含 API Key** —— 密钥只经平台凭据库存取。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelConfig {
    pub id: String,
    pub name: String,
    pub provider: AiProvider,
    /// 用户填写的地址（可能带尾部端点路径，发送前清洗）。
    pub base_url: String,
    pub model_id: String,
    pub max_tokens: u32,
    pub temperature: f32,
}

impl Default for AiModelConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            provider: AiProvider::OpenAi,
            base_url: AiProvider::OpenAi.default_base_url().to_string(),
            model_id: "gpt-4o-mini".to_string(),
            max_tokens: 4096,
            temperature: 0.7,
        }
    }
}

/// 对话消息。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessage {
    /// `system` / `user` / `assistant`
    pub role: String,
    pub text: String,
    /// 图片（data URL）；仅视觉请求使用。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_data_url: Option<String>,
}

impl AiChatMessage {
    pub fn system(text: impl Into<String>) -> Self {
        Self { role: "system".into(), text: text.into(), image_data_url: None }
    }
    pub fn user(text: impl Into<String>) -> Self {
        Self { role: "user".into(), text: text.into(), image_data_url: None }
    }
    pub fn user_with_image(text: impl Into<String>, image: impl Into<String>) -> Self {
        Self { role: "user".into(), text: text.into(), image_data_url: Some(image.into()) }
    }
    pub fn assistant(text: impl Into<String>) -> Self {
        Self { role: "assistant".into(), text: text.into(), image_data_url: None }
    }
}

/// AI 相关设置（随 `settings.json` 落盘；密钥不在这里）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    pub models: Vec<AiModelConfig>,
    pub selected_model_id: Option<String>,
    /// 对话历史目录；`None` = 应用数据目录下的 `Conversations`。
    pub conversation_storage_path: Option<String>,
    /// 渲染失败后自动回修一次。
    pub render_feedback_retry: bool,
    /// 识图首次上传告知已确认。
    pub vision_notice_accepted: bool,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            models: Vec::new(),
            selected_model_id: None,
            conversation_storage_path: None,
            render_feedback_retry: true,
            vision_notice_accepted: false,
        }
    }
}

/// 对话读写请求（按文档稳定身份寻址）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRecord {
    /// 稳定身份键（本地路径的 SHA256）。
    pub key: String,
    pub messages: Vec<AiChatMessage>,
}

/// 前端需要的 AI 状态快照（模型列表 + 哪些模型已有密钥 + 若干开关）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStateSnapshot {
    pub models: Vec<AiModelConfig>,
    pub selected_model_id: Option<String>,
    /// 已在系统凭据库里配置了 API Key 的模型 id。
    pub models_with_key: Vec<String>,
    pub render_feedback_retry: bool,
    pub vision_notice_accepted: bool,
    pub conversation_storage_path: Option<String>,
}

/// 统一错误载荷（`invoke` 的 `Err` 侧）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    /// 稳定错误码，前端据此决定提示文案与分支。
    pub code: String,
    pub message: String,
}

impl ApiError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

/// 稳定错误码。
pub mod codes {
    pub const IO: &str = "io";
    pub const NOT_FOUND: &str = "not_found";
    pub const INVALID_TAB: &str = "invalid_tab";
    pub const ENCODING: &str = "encoding";
    pub const CREDENTIAL: &str = "credential";
}
