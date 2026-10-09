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
