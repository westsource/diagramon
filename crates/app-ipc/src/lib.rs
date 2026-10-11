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
            split_src: 33, // 默认源码窗格占 1/3（拖拽夹在 1/4–1/2）
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
    /// autosave：由 **Rust 侧**计时落盘（改正文后经过 `autosave_ms` 就写）
    pub autosave: bool,
    pub autosave_ms: u32,
    /// 打开工作区后，是否把文件读写限制在工作区内。
    /// 默认关：自由「另存为」到别处是常见需求，开成默认会莫名挡住用户。
    pub restrict_to_workspace: bool,
}

impl Default for EditorPrefs {
    fn default() -> Self {
        Self {
            font_size: 13,
            debounce_ms: 350,
            lint: true,
            per_doc_view: true,
            default_view: ViewMode::Split,
            autosave: true,
            autosave_ms: 5000,
            restrict_to_workspace: false,
        }
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

/// 云网关偏好。`base_url` 为空 = 未配置（界面如实写"未配置"，不伪造状态）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CloudPrefs {
    /// 如 `https://api.diagramon.app/v1`
    pub base_url: String,
    /// 本机设备标识（首登生成一次；服务端用它识别会话）
    pub device_id: String,
}

impl Default for CloudPrefs {
    fn default() -> Self {
        Self { base_url: String::new(), device_id: String::new() }
    }
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
    pub cloud: CloudPrefs,
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
            cloud: CloudPrefs::default(),
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
    /// "server" = 供应商在流末尾回报的；"none" = 没回报。
    /// **界面据此标注来源**（P3 拍板：两种都留，但别混成一个数，更别把"没有"当 0）。
    #[serde(default)]
    pub usage_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiFailed {
    pub request_id: String,
    pub message: String,
}

/// 开发开关：由后端按环境变量如实声明，前端不猜。
///
/// 用途之一是自检：`DIAGRAMON_SELFTEST=1` 时后端把报告路径交出来，
/// 前端跑一遍真实 IPC 断言再落盘（避免"注入时机"这类脆弱玩法）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DevFlags {
    /// `DIAGRAMON_SELFTEST_REPORT`（或数据目录下的默认路径）
    pub selftest_report: Option<String>,
    /// `DIAGRAMON_DEBUG_PORT`，仅记录，便于前端/评测脚本确认
    pub debug_port: Option<u16>,
    /// 是否跑在 mock 后端（仅前端有 mock 时才有意义，后端恒 false）
    pub mock: bool,
}

/// 预览/派生数据的护栏阈值。**数字的真源在 `app-core::guard`**，
/// 前端只比大小、不藏第二份（藏了就会漂移）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Limits {
    pub preview_max_lines: u32,
    pub preview_max_bytes: u32,
}

/// 启动信息：版本、平台、格式注册表、护栏阈值、开发开关。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub formats: Vec<FormatInfo>,
    pub limits: Limits,
    pub dev: DevFlags,
}

/// 事件名常量（与前端 `ipc.on(...)` 逐字对应）。
/* ---------------- 格式转换 ---------------- */

/// 一次转换请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertRequest {
    pub from: FormatId,
    pub to: FormatId,
    pub source: String,
}

/// 一次转换的结果。
///
/// `notes` 不是装饰：转换是**单向有损**的，逐条写明「丢了什么」由界面如实展示，
/// 不静默丢（见路线图的 P2 决策）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertOutcome {
    /// 谁来完成这次转换：`rust` / `drawio` / `excalidraw` / `none`。
    ///
    /// **前端按它分支**，而不是从错误文案里猜引擎 —— 猜字符串一改文案就崩。
    pub engine: String,
    /// 纯 Rust 方向才有正文；引擎方向为空（由承载页产出）。
    pub body: String,
    pub notes: Vec<String>,
}

/* ---------------- 工作区与文件系统 ---------------- */

/// 工作区树的一个节点。目录带 `children`，文件不带。
///
/// `format` 只对文件有意义（界面据此画那个格式色点），目录恒为 `None`。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceNode {
    pub name: String,
    /// 一律正斜杠的绝对路径。前端只当 id 用，不自己拼。
    pub path: String,
    pub dir: bool,
    #[serde(default)]
    pub format: Option<FormatId>,
    #[serde(default)]
    pub children: Vec<WorkspaceNode>,
}

/// 一次工作区扫描的结果。`root` 为 `None` = 没有打开工作区。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceInfo {
    pub root: Option<String>,
    /// 根目录的显示名（取自最后一段路径）
    pub name: String,
    pub tree: Vec<WorkspaceNode>,
    /// 撞上扫描上限 ⇒ 树不完整。**如实报**，界面要写出来。
    pub truncated: bool,
    pub file_count: u32,
    pub dir_count: u32,
}

/// 一次全库搜索的请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchRequest {
    pub request_id: String,
    pub query: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    /// 0 = 用默认上限
    #[serde(default)]
    pub max_results: u32,
}

/// 一条命中。结果按 `search://hit` 逐条推进来（大仓库不阻塞界面）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    pub format: FormatId,
    /// 1 起
    pub line: u32,
    /// 1 起，按**字符**计（中文一个算一个，别用字节）
    pub column: u32,
    /// 命中所在行的原文（去尾换行，超长截断）
    pub text: String,
}

/// 搜索收尾。`error` 非空 = 没跑（正则写错了之类），不是"没命中"。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchDone {
    pub request_id: String,
    pub total: u32,
    pub files: u32,
    /// 撞上命中上限
    pub truncated: bool,
    pub error: Option<String>,
}

/// 外部文件变动（watcher 去抖后）。
///
/// `doc_id` 非空 = 这个文件正开着；`conflicts` = 开着**且本地有未保存改动**，
/// 界面必须问用户，不能直接覆盖。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsChange {
    pub path: String,
    /// created | modified | removed | dir
    pub kind: String,
    #[serde(default)]
    pub doc_id: Option<String>,
    #[serde(default)]
    pub conflicts: bool,
}

/// 单实例转交：第二个进程把命令行里的文件交给已在跑的实例。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct OpenPathsEvent {
    pub paths: Vec<String>,
}

/* ---------------- 识图截屏 / 原生剪贴板 ---------------- */

/// 一块屏幕。`x/y` 是虚拟桌面里的**逻辑**坐标，`width/height` 是**物理**像素
/// —— 两者不等是常态（缩放 150% 时 logical 1000 = physical 1500），
/// 混用一次 DPI 就崩，所以字段名写死，不许前端自己换算。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorInfo {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub scale: f32,
    pub is_primary: bool,
}

/// 一次"冻结帧"：把屏幕定格成一张图，供 overlay 上框选。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisionFrame {
    pub monitor: MonitorInfo,
    /// PNG dataURL。只在本进程内存里，不落盘。
    pub data_url: String,
}

/// 框选结果：**物理像素**，相对被截的那块屏。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct VisionRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/* ---------------- 云网关 ---------------- */

/// 登录后的账户快照。**令牌永不回前端**（存凭据库，同 AI 密钥）。
///
/// 存储额度三个数都是**服务端给的**，本地不推算、不伪造 —— 未登录就显示未登录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudAccount {
    pub email: String,
    pub display_name: String,
    pub role: String,
    pub plan_name: String,
    pub used_bytes: u64,
    pub quota_bytes: u64,
}

/// 云端状态。`base_url` 为空 = 用户还没配网关地址。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CloudStatus {
    pub signed_in: bool,
    pub base_url: String,
    pub account: Option<CloudAccount>,
}

/// 云文档列表项。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudDoc {
    pub id: String,
    pub name: String,
    /// 服务端的目录路径（`""` = 根）
    pub path: String,
    pub format: FormatId,
    pub size: u64,
    pub updated_at: String,
    /// 乐观锁版本号：下次保存原样带回（`If-Match`）。新建是 0。
    #[serde(default)]
    pub version: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CloudDocList {
    pub items: Vec<CloudDoc>,
    pub has_more: bool,
    pub used_bytes: u64,
    pub quota_bytes: u64,
}

/// 取回一份云文档：前端据此开新标签页。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudDocBody {
    pub id: String,
    pub name: String,
    pub format: FormatId,
    pub body: String,
    pub version: u64,
}

/// 开发开关的环境变量名（前后端与文档统一引用，别各写一份字符串）。
pub const ENV_SELFTEST: &str = "DIAGRAMON_SELFTEST";
pub const ENV_SELFTEST_REPORT: &str = "DIAGRAMON_SELFTEST_REPORT";
pub const ENV_DEBUG_PORT: &str = "DIAGRAMON_DEBUG_PORT";

pub mod events {
    pub const AI_DELTA: &str = "ai://delta";
    pub const AI_DONE: &str = "ai://done";
    pub const AI_FAILED: &str = "ai://failed";
    /// 工作区文件被改动（批量 `Vec<FsChange>`）
    pub const FS_CHANGED: &str = "fs://changed";
    /// 搜索逐条命中
    pub const SEARCH_HIT: &str = "search://hit";
    /// 搜索收尾
    pub const SEARCH_DONE: &str = "search://done";
    /// 单实例转交进来的文件
    pub const OPEN_PATHS: &str = "open://paths";
    /// autosave 落了盘（载荷 `Doc`）
    pub const DOC_AUTOSAVED: &str = "doc://autosaved";
    /// 识图框选完成（载荷 `String` dataURL；取消时是 `null`）
    pub const VISION_PICKED: &str = "vision://picked";
    /// 云端状态变化（载荷 `CloudStatus`）
    pub const CLOUD_CHANGED: &str = "cloud://changed";
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
    pub const DOC_RELOAD: &str = "doc_reload";
    pub const DOC_ISSUES: &str = "doc_issues";
    pub const DOC_OUTLINE: &str = "doc_outline";
    pub const DOC_SCOPE: &str = "doc_scope";
    pub const WORKSPACE_OPEN: &str = "workspace_open";
    pub const WORKSPACE_GET: &str = "workspace_get";
    pub const WORKSPACE_CLOSE: &str = "workspace_close";
    pub const WORKSPACE_NEW_FILE: &str = "workspace_new_file";
    pub const WORKSPACE_RENAME: &str = "workspace_rename";
    pub const WORKSPACE_DELETE: &str = "workspace_delete";
    pub const SEARCH_RUN: &str = "search_run";
    pub const SEARCH_CANCEL: &str = "search_cancel";
    /// 同步版搜索：只给自检/诊断用（正常路径走 `search_run` 的事件流）
    pub const SEARCH_ONCE: &str = "search_once";
    pub const EXPORT_WRITE: &str = "export_write";
    pub const CRED_SET: &str = "cred_set";
    pub const CRED_DELETE: &str = "cred_delete";
    pub const CONVERT_TEXT: &str = "convert_text";
    pub const AI_CHAT: &str = "ai_chat";
    pub const AI_CANCEL: &str = "ai_cancel";
    pub const MONITORS_LIST: &str = "monitors_list";
    pub const VISION_FRAME: &str = "vision_frame";
    pub const VISION_CROP: &str = "vision_crop";
    pub const VISION_CANCEL: &str = "vision_cancel";
    pub const CLIP_WRITE_IMAGE: &str = "clip_write_image";
    pub const CLOUD_LOGIN: &str = "cloud_login";
    pub const CLOUD_LOGOUT: &str = "cloud_logout";
    pub const CLOUD_STATUS: &str = "cloud_status";
    pub const CLOUD_DOCS_LIST: &str = "cloud_docs_list";
    pub const CLOUD_DOC_SAVE: &str = "cloud_doc_save";
    pub const CLOUD_DOC_OPEN: &str = "cloud_doc_open";
    pub const CLOUD_DOC_DELETE: &str = "cloud_doc_delete";
}
