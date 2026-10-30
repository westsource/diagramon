//! 前后端契约：命令与事件的载荷类型。
//!
//! **这是唯一真源** —— 前端 `ui/js/ipc.js` 只做 `invoke` 包装，不另立一份字段清单；
//! Rust 侧的命令签名必须与本文件逐字段对应。

use serde::{Deserialize, Serialize};

/// 五种格式。`rename_all = "lowercase"` ⇒ 前端拿到 `"mermaid" | "dot" | "d2" | "drawio" | "excalidraw"`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FormatId {
    Mermaid,
    Dot,
    D2,
    Drawio,
    Excalidraw,
}

impl FormatId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mermaid => "mermaid",
            Self::Dot => "dot",
            Self::D2 => "d2",
            Self::Drawio => "drawio",
            Self::Excalidraw => "excalidraw",
        }
    }

    /// 未知扩展名回退 Mermaid（与旧实现一致：不报错，按最常用的处理）。
    pub fn from_ext(ext: &str) -> Self {
        match ext.trim_start_matches('.').to_ascii_lowercase().as_str() {
            "dot" | "gv" => Self::Dot,
            "d2" => Self::D2,
            "drawio" => Self::Drawio,
            "excalidraw" => Self::Excalidraw,
            _ => Self::Mermaid,
        }
    }

    pub fn from_str_opt(s: &str) -> Option<Self> {
        match s {
            "mermaid" => Some(Self::Mermaid),
            "dot" => Some(Self::Dot),
            "d2" => Some(Self::D2),
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
    /// 布局引擎（DOT 六种 / D2 三种 / Mermaid 两种：dagre 内建 + elk 离线包）
    pub layouts: Vec<String>,
    /// 外观模式（目前仅 Mermaid：auto/classic/neo/handDrawn，映射 `initialize({ look })`）
    pub looks: Vec<String>,
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
    /// DOT 布局引擎（Mermaid 复用同一字段存布局选择：dagre / elk）。
    ///
    /// 文档级，但**按文件路径记住**：打开文件时由 `app-core::render_opts` 恢复上次的选择。
    pub layout: Option<String>,
    /// Mermaid 外观模式（classic / neo / handDrawn；None = 跟随默认/设置）。
    /// 与 `layout` 同样按文件路径记住（`render-opts.json`）。
    #[serde(default)]
    pub look: Option<String>,
    /// 这份文档的配色色系（`None` = 跟随设置里的默认；`Some("")` = 这份文档不上自动色）。
    /// 与 `look` / `layout` 同一套：按文件记住，下次打开恢复。
    #[serde(default)]
    pub scheme: Option<String>,
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
    /// 1 起；`None` = 该问题来自无法给出精确列的实现（如旧行扫描器）。
    /// 前端「问题」面板与行内标注只依赖 `line`，列号用于更精确的定位（C3）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
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
            // 侧栏**默认收起**：这是画布为主的编辑器，第一次打开先给足画布；
            // 需要资源管理器时点左侧活动栏的图标或 Ctrl+B。活动栏保留 —— 它是重新打开的入口。
            sidebar: false,
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
    /// autosave：由 **Rust 侧**计时落盘（改正文后经过 `autosave_ms` 就写）。
    /// **默认关闭**：写盘是不可逆的副作用（AI 应用、重命名、批量替换都会改正文），
    /// 默认静默落盘等于替用户按下 Ctrl+S。想要"随手改随手存"的，在设置里显式打开。
    pub autosave: bool,
    pub autosave_ms: u32,
    /// 渲染区域尺寸变化时自动适应视图（等同用户点了一次「适应视图」）。
    /// **默认开**：拖分隔条、开合侧栏 / AI 面板 / 底部面板、切视图模式、缩放窗口之后，
    /// 图不该只露一角或缩成一小团。不想要这个联动就在设置里关掉 ——
    /// 关掉后视口只在「打开/切换文档」与显式「适应视图」时变。
    pub fit_on_resize: bool,
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
            autosave: false,
            autosave_ms: 5000,
            fit_on_resize: true,
            restrict_to_workspace: false,
        }
    }
}

/// 一个用户配置的模型供应商（BYOK）：地址 + 密钥 + 该供应商的默认生成参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProvider {
    pub id: String,
    pub name: String,
    /// openai | ollama | custom
    pub provider: String,
    pub base_url: String,
    /// 生成上限。**`None` = 不发这个键**，交给上游按所选模型自己的默认/上限决定。
    ///
    /// 为什么留空是默认：各家上限不同（实测 `[1, 393216]`、`262144`、…），而上游的
    /// `/v1/models` 不回上限，客户端无从知道；填大了严格型上游会直接 400 拒掉整轮
    /// （真机：`Invalid max_tokens value, the valid range of max_tokens is [1, 393216]`），
    /// 填小了宽容型上游会静默截断。所以"不填"才是唯一对每个模型都正确的值。
    #[serde(default)]
    pub max_tokens: Option<u32>,
    pub temperature: f32,
    #[serde(default)]
    pub idle_timeout_s: Option<u32>,
    /// 每个请求带 `x-opencode-session`（OpenCode Go 一类上游需要）。
    ///
    /// 默认为 false；UI 在识别到 `opencode.ai` 时自动勾选。解析模型时还会再按
    /// `base_url` 自动判定一次，保证旧配置不用重新添加也能用。
    #[serde(default)]
    pub session_header: bool,
    #[serde(default)]
    pub has_key: bool,
    #[serde(default)]
    pub key_hint: String,
}

/// 单个 AI 模型配置。`key_hint` 是掩码（如 `sk-…1234`），**密钥本体永不回传前端**。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModel {
    pub id: String,
    /// 指向 `AiPrefs.providers[].id`。旧设置里为空，加载时迁移。
    #[serde(default)]
    pub provider_id: String,
    pub model: String,
    #[serde(default)]
    pub name: String,
    /// 以下是 **v3.8.4 及以前的遗留字段**：只用于把旧设置迁移成供应商。
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: f32,
    #[serde(default)]
    pub idle_timeout_s: Option<u32>,
    #[serde(default)]
    pub has_key: bool,
    #[serde(default)]
    pub key_hint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AiPrefs {
    pub providers: Vec<AiProvider>,
    pub models: Vec<AiModel>,
    pub default_model: String,
    pub vision_notice_accepted: bool,
    pub render_retry: bool,
    /// 「AI 增强转换」总开关。**默认关**：这是显式触发的兜底路径，
    /// 打开后才在转换预览区出现入口（仍要满足"有损或校验失败"且"已配置模型"）。
    pub enhance_enabled: bool,
    /// 增强转换的「外发提示」是否已确认过（只弹一次）。
    pub enhance_notice_seen: bool,
    /// 一次增强最多重试几轮（真实调用上限 = 1 + 该值）。**默认 3**，范围 1–3。
    pub retry_max: u8,
    pub context_from_doc: bool,
    /// 长期记忆总开关。关掉后**请求体与没有记忆时完全一致**（单测钉住这一点）。
    pub memory_enabled: bool,
    /// 自动提取候选记忆。开着时每轮对话后多一次模型调用（真实计费），
    /// 产出的只是 `Pending` 候选、**不注入**，要用户确认才生效。
    pub memory_auto: bool,
    /// 受控工具循环（`crates/ai::agent`）。
    ///
    /// **默认关**：开着时这一轮改走**非流式**多步调用，界面不再逐字流式（改为显示工具活动），
    /// 而且模型每用一次工具就多一次真实计费。这种"拿流式换能力"的取舍必须由用户来定，
    /// 不能默认替他们改掉已有的打字机体验。
    pub tools_enabled: bool,
    /// 意图判定（可选）：Jev / System One 兼容端点。
    pub intent: IntentPrefs,
}

/// 意图判定配置。
///
/// `mode` 是唯一权威：`auto`（默认，会员登录后用官方） / `official` /
/// `custom`（自己的 SystemOne 端点 + 本机密钥） / `off`。
/// `enabled` 是旧版本字段，只在 `mode` 为空时用于迁移（true → custom）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct IntentPrefs {
    pub enabled: bool,
    pub mode: String,
    pub base_url: String,
    pub model: String,
    pub timeout_ms: u32,
    pub high_confidence: f32,
    pub min_confidence: f32,
}

impl Default for IntentPrefs {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: String::new(),
            base_url: "https://opencode.ai/inference/systemone/v1/systemone".into(),
            model: "jev-1.13".into(),
            timeout_ms: 700,
            high_confidence: 0.75,
            min_confidence: 0.55,
        }
    }
}

impl Default for AiPrefs {
    fn default() -> Self {
        Self {
            providers: Vec::new(),
            models: Vec::new(),
            default_model: String::new(),
            vision_notice_accepted: false,
            render_retry: true,
            enhance_enabled: false,
            enhance_notice_seen: false,
            retry_max: 3,
            context_from_doc: true,
            memory_enabled: true,
            memory_auto: true,
            tools_enabled: false,
            intent: IntentPrefs::default(),
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
    /// 用户填的**服务根地址**（如 `https://www.diagramon.com`）；留空 = 云端关闭
    pub base_url: String,
    /// 自动探测出的 API 根（如 `https://www.diagramon.com/v1`）：探测一次缓存一次，
    /// 用户改 base_url 后因前缀不匹配会自动重新探测
    #[serde(default)]
    pub api_base: String,
    /// 本机设备标识（首登生成一次；服务端用它识别会话）
    pub device_id: String,
}

impl Default for CloudPrefs {
    fn default() -> Self {
        // 默认指向官方服务（用户可在设置里改；留空 = 云端整体关闭）
        Self { base_url: "https://www.diagramon.com".into(), api_base: String::new(), device_id: String::new() }
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
    /// 点击关闭按钮时隐藏到系统托盘而不是退出（托盘菜单可恢复 / 真退出）。
    /// 托盘图标常驻创建，不受此项影响；影响的是 CloseRequested 的处置。
    pub close_to_tray: bool,
    pub panels: PanelPrefs,
    pub editor: EditorPrefs,
    pub ai: AiPrefs,
    pub cloud: CloudPrefs,
    /// Mermaid 渲染偏好（目前只有默认外观；布局走文档级 d.layout）
    pub mermaid: MermaidPrefs,
    /// 自动配色的**默认色系**（`""` = 关闭自动上色；文档级选择永远优先）。
    /// 真源在 `app_core::palette`，这里只存 id。
    pub diagram_palette: String,
    /// 资源管理器（工作区树）的视图偏好
    pub explorer: ExplorerPrefs,
    pub recent: Vec<RecentEntry>,
}

/// 资源管理器的排序偏好。**整棵树共用一份**，不按目录各记一套。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ExplorerPrefs {
    /// `name_asc` | `name_desc` | `mtime_desc`（新→旧） | `mtime_asc`（旧→新）
    pub sort: String,
    /// 目录排在文件前面（关掉后按同一把尺子混排）
    pub dirs_first: bool,
}

impl Default for ExplorerPrefs {
    fn default() -> Self {
        Self { sort: "name_asc".into(), dirs_first: true }
    }
}

/// Mermaid 的全局渲染偏好。文档级选择（`d.look` / `d.layout`）永远优先于这里。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MermaidPrefs {
    /// 默认外观：auto | classic | neo | handDrawn（auto = 不干预，用 Mermaid 内建默认）
    pub look: String,
}

impl Default for MermaidPrefs {
    fn default() -> Self {
        Self { look: "auto".into() }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "light".into(),
            density: "normal".into(),
            accent: "pine".into(),
            locale: "zh-CN".into(),
            close_to_tray: false,
            panels: PanelPrefs::default(),
            editor: EditorPrefs::default(),
            ai: AiPrefs::default(),
            cloud: CloudPrefs::default(),
            mermaid: MermaidPrefs::default(),
            // 默认开：模型只管角色、色值由应用按色系落地 —— 用户随时可在预览顶栏换成别的或关掉
            diagram_palette: "pine".into(),
            explorer: ExplorerPrefs::default(),
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
    /// 只读解释：输出纯文本，不产出代码、不提供“应用/写入文档”。
    Explain,
}

/// 一轮前序对话（发给上游的形态）。
///
/// **只带文本**：图片是 dataURL、动辄几百 KB，绝不该在每个后续请求里重复上行
/// （一次识图就会让之后每一轮都背上它）—— 前端在 `historyFor()` 里就已经把它们滤掉了。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiTurn {
    /// `user` | `assistant`（其它值会被 `crates/ai` 归一到 `user`）。
    pub role: String,
    pub text: String,
}

/// 用户附加的**外部文件**（AI 上下文）：拖进对话框、或手填/粘贴全路径。
///
/// 与 `AiChatRequest.context`（**当前图表源码**）分开两个字段是刻意的：
/// 提示词里两者的措辞与用途不同（一个是"要改的图"，一个是"参考资料"），
/// 混进同一个字段会让模型把参考资料当成待重写的正文。判定与上限见
/// `app_core::context_file`（带单测），`file_read_text` 原样把它交给前端。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiContextFile {
    /// 绝对路径（正斜杠），也是去重键
    pub path: String,
    /// 文件名（界面显示用）
    pub name: String,
    pub text: String,
    /// 文件超过读取上限，正文被截断（界面要如实标出来）
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatRequest {
    pub request_id: String,
    pub model_id: String,
    pub intent: AiIntent,
    pub prompt: String,
    /// 当前文档格式（上下文；决定提示词之外的回退与文档归属）
    pub format: FormatId,
    /// 目标生成格式；`None` = 跟随当前文档。
    ///
    /// 与 `format` 分开是必须的：在多格式输出里，当前文档可以是 Mermaid，
    /// 而用户要求生成 DOT/D2 源码 —— 提示词、围栏提取、校验都按这个字段走，
    /// `format` 仍描述上下文。
    #[serde(default)]
    pub output_format: Option<FormatId>,
    /// 当前文档正文（作为上下文；可空）
    pub context: Option<String>,
    /// 附加的外部文件（参考资料；可空）
    #[serde(default)]
    pub files: Vec<AiContextFile>,
    /// `data:image/png;base64,…`（识图；旧字段，保留兼容）。
    pub image_data_url: Option<String>,
    /// 识图对比：一次最多 2 张（服务端上限也是 2）。新字段优先于 `image_data_url`。
    #[serde(default)]
    pub image_data_urls: Vec<String>,
    /// 前序轮次（**不含本轮**的 prompt / context）。
    ///
    /// 轮数与体积的裁剪**在 `crates/ai` 里做**（`fit_history`）—— 那一层带单测，
    /// 前端只负责如实把对话给出来，不各自猜一套策略。
    #[serde(default)]
    pub history: Vec<AiTurn>,
    /// 归因场景（仅网关模型发送 `X-Diagramon-Scene`）。
    #[serde(default)]
    pub scene: Option<String>,
    /// 上一次真实调用的账本 request id（仅网关模型发送 `X-Diagramon-Retry-Of`）。
    #[serde(default)]
    pub retry_of: Option<String>,
}

/// 意图判定请求：只传判定所需的最小状态，不传整篇文档。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntentClassifyRequest {
    pub prompt: String,
    pub has_document: bool,
    pub has_selection: bool,
    pub has_image: bool,
    pub current_intent: AiIntent,
    #[serde(default)]
    pub document_head: Option<String>,
    #[serde(default)]
    pub has_text_files: bool,
    /// 显式覆盖：前端已点滑块时直接返回它，不请求 Jev。
    #[serde(default)]
    pub override_intent: Option<AiIntent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntentClassifyResult {
    pub intent: AiIntent,
    pub confidence: f32,
    pub probabilities: std::collections::BTreeMap<String, f32>,
    pub model: String,
    pub elapsed_ms: u64,
    pub fallback: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

/// 事件名：`ai://delta` / `ai://thinking` / `ai://done` / `ai://failed`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiDelta {
    pub request_id: String,
    pub delta: String,
}
/// 模型的**思考**增量（GLM/DeepSeek/Qwen 这一族的 `reasoning_content`）。
///
/// 与正文分开报是刻意的：思考型模型会先连推几十上百帧思考、正文最后才来 —— 界面要能
/// 在"还没有正文"的那段时间里显示进度，否则用户对着空气等（2026-10-14 的 bug：
/// token 记了 2000+，对话里一个字都没有）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiThinking {
    pub request_id: String,
    pub delta: String,
}

/// 事件名：`ai://agent` —— 工具循环里的**一次工具执行**（含结果摘要）。
///
/// 摘要是"给界面看的简述"，不是回给模型的完整结果 —— 完整结果已经进了对话，
/// 重复送到前端只会诱导界面把它渲染成一条助手消息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiAgentStep {
    pub request_id: String,
    /// 第几次工具执行（从 1 起）
    pub step: u32,
    /// 工具名（`read_document` / `format_grammar` / `validate`）
    pub tool: String,
    /// 结果摘要（截断过，界面上显示这一行就够了）
    pub summary: String,
    /// `false` = 工具执行失败（失败也是工具结果，模型会自己纠正，不是整轮失败）
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiDone {
    pub request_id: String,
    pub text: String,
    /// 本次实际使用的模型名（自动选档时由服务端回报，BYOK 下即配置里的 model）
    pub model: String,
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
    /// 其中有多少是思考 token（供应商不报就是 `None`）。界面用它解释"这一轮为什么没有正文"。
    #[serde(default)]
    pub reasoning_tokens: Option<u32>,
    /// "server" = 供应商在流末尾回报的；"none" = 没回报。
    /// **界面据此标注来源**（P3 拍板：两种都留，但别混成一个数，更别把"没有"当 0）。
    #[serde(default)]
    pub usage_source: String,
    /// 这条流**是怎么结束的**：`stop` / `length` / `other` / `missing` / `interrupted`
    /// （见 `ai::Finish`）。
    ///
    /// 空串 = **这条路径不报终态**（工具循环走的是非流式多步，没有"流结束"这回事）。
    /// 界面只对已知值动作：`length` 是"正文被输出上限切断了"，`interrupted` 是"连接中途断了"，
    /// `missing` 是"流结束了但没给结束标记" —— 三种都要如实告诉用户，否则用户看到的是
    /// "输出到一半突然没有下文，也没有任何提示"（2026-10-18 线上实录）。
    #[serde(default)]
    pub finish: String,
    /// 服务端账本行 id（仅网关流式请求有）；前端用它填下一次的 Retry-Of。
    #[serde(default)]
    pub ledger_id: Option<String>,
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

/// 启动信息：版本、平台、格式注册表、护栏阈值、开发开关、可用色系。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub formats: Vec<FormatInfo>,
    pub limits: Limits,
    pub dev: DevFlags,
    /// 自动配色的色系清单（真源在 `app_core::palette`，前端不抄第二份）。
    pub palettes: Vec<PaletteInfo>,
}

/* ---------------- 自动配色（图表配色，不是 UI 强调色） ---------------- */

/// 某个角色在一种底色主题下的三件颜色。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleSwatch {
    pub fill: String,
    pub stroke: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaletteRole {
    /// main | entry | decide | ext | risk | note
    pub role: String,
    /// 亮色阶（浅底 + 深描边/文字）
    pub light: RoleSwatch,
    /// 暗色阶（深底 + 亮描边/文字）
    pub dark: RoleSwatch,
}

/// 一个色系。名字中英各一份 —— 页面/菜单/提示词都直接用这里的叫法，不再各写一份。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaletteInfo {
    pub id: String,
    pub name_zh: String,
    pub name_en: String,
    pub roles: Vec<PaletteRole>,
    /// 这个色系的连线颜色（亮 / 暗）。线只借一点色相倾向，不按角色染。
    pub edge_light: String,
    pub edge_dark: String,
}

/// 重着色的范围。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaletteMode {
    /// 只给"还没上色"的节点上色（手选过颜色的节点一个都不动）
    OnlyUncolored,
    /// 整篇重排：手写的 `style` / 已有填充色会被覆盖（调用方必须先跟用户确认）
    All,
}

/// 一次确定性的配色展开：**纯函数入参**，不读也不改会话。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaletteApplyReq {
    pub body: String,
    pub format: FormatId,
    /// 色系 id（`app_core::palette::find` 校验）
    pub palette: String,
    /// 当前是不是暗色主题：色值会**落进文档**，之后切主题不会重算，所以这里选一次色阶
    pub dark: bool,
    pub mode: PaletteMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaletteApplyRes {
    pub body: String,
    /// 正文是否真的变了（没变时调用方不该写回文档，免得平白弄脏）
    pub changed: bool,
    /// 上了色的节点数
    pub applied: usize,
    /// 因为已有颜色被跳过的节点数（只有「仅未着色」会跳过）
    pub skipped: usize,
    /// 整篇重排时删掉的手写 `style` 语句条数
    pub styles_removed: usize,
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
    /// 最后修改时间（Unix 毫秒）。
    ///
    /// 文件取自身 mtime；目录取**子树里最新**的 mtime —— 目录自己的 mtime 只反映
    /// 直接子项的增删，不代表内容改过。取不到（权限 / 时钟异常）时是 `None`，
    /// 前端照实按"未知"处理，不拿 0 冒充 1970。
    #[serde(default)]
    pub mtime: Option<u64>,
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

/// 套餐里的 AI 权益快照（服务端 `membership.ai`）。额度是**整数微信用点**（1e-6）。
///
/// 服务端刻意给"总额度 + 已用"而不是"剩余" —— 充值是加在总额度上的，所以
/// `月度 - 已用` 得到的剩余**在任何时候都成立**（充值不会让"已用"变成负数）。
/// 周期字段给出来是为了让界面能说"周期至 X 重置"，而不是自己猜下月 1 日。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CloudAiCredit {
    pub enabled: bool,
    pub credit_monthly_micros: i64,
    pub credit_used_micros: i64,
    /// 本周期起（ISO 串，原样透传，客户端不做算术）
    pub period_start: String,
    /// 本周期止（ISO 串）
    pub period_end: String,
}

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
    /// 套餐里的 AI 权益。**旧服务端不带这个字段时为 `None`** —— 界面要能区分
    /// "不知道"和"确实没开通"，所以是 Option 而不是 `enabled: false`。
    #[serde(default)]
    pub ai: Option<CloudAiCredit>,
}

/// 云端状态。`base_url` 为空 = 用户还没配网关地址。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CloudStatus {
    pub signed_in: bool,
    pub base_url: String,
    pub account: Option<CloudAccount>,
}

/// 前端 id 前缀：`gw:<别名>` = **云网关模型**，其余 = 本地 BYOK 模型。
///
/// 为什么用前缀而不是加一个 `kind` 字段：模型 id 是**一个**用户偏好（`ai.default_model`），
/// 加字段就得在每个"当前模型是谁"的地方同时比对两个值，而分流点其实只有一个
/// （Rust 侧 `resolve_target`）。前缀把所有下游都变成"看 id 前缀"一件事。
pub const GATEWAY_MODEL_PREFIX: &str = "gw:";

/// 云网关的一个**可用模型别名**（`GET /v1/ai/models` 的一项）。
///
/// 这是服务端按账号权益过滤后的结果 —— **无 AI 权益就是空列表**（服务端 200 + `data: []`，
/// 不是 403），所以"空"只说明"当前账号没有可用别名"，不说明"服务挂了"。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct GatewayModel {
    /// 别名（也是请求体里 `model` 的取值）
    pub id: String,
    pub display_name: String,
    pub supports_vision: bool,
    /// 该候选的输出上限（服务端还会按所选候选与档位再钳一次）
    pub max_output: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct GatewayModelList {
    pub items: Vec<GatewayModel>,
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

/// 云端目录节点（`GET /v1/folders` 的一项，**平铺**返回、按 path 排序、不含根）。
///
/// 服务端口径（`FolderOut`）：`document_count` 是**该目录直属**文档数，
/// `has_children` 表明还有下级 —— 两者缺一不可：只有 `document_count` 会把
/// "有子目录但自己没文档" 的目录显示成空目录。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CloudFolder {
    /// 库内相对路径（`""` = 根；根由客户端补，服务端不返回）
    pub path: String,
    /// 末段名（不含父路径）
    pub name: String,
    /// 段数 - 1，顶层为 0（仅作渲染缩进参考）
    pub depth: i64,
    /// 直属文档数
    pub document_count: u64,
    /// 是否还有子目录
    pub has_children: bool,
    /// 是显式建的目录（vs 由文档路径隐含出来的）
    pub is_explicit: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CloudFolderList {
    pub items: Vec<CloudFolder>,
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

/* ---------------- AI 会话持久化 ---------------- */

/// 一条持久化的对话轮次。
///
/// **只落文本**：图片（dataURL）永不落盘 —— 客户端对外承诺的是"图片只在内存、
/// 不落盘"，会话持久化不该把这句话变成谎话。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationTurn {
    /// `user` | `assistant`
    pub role: String,
    pub text: String,
    /// 毫秒时间戳（跨页签还原展示顺序用）
    #[serde(default)]
    pub at: i64,
    /// 该轮实际使用的模型名（assistant 才有；用户轮为空）
    #[serde(default)]
    pub model: String,
    /// prompt + completion（供应商没回报就是 0，**不是"零消耗"**）
    #[serde(default)]
    pub tokens: u32,
    /// 这一轮的意图：`generate` | `vision` | `review` | `explain`。
    ///
    /// 早期把意图存在 `tab` 里（当时确实是页签）；现在只写 `intent`。
    /// `alias = "tab"` 让旧会话文件原样读得进来，下一次保存就迁移成新字段。
    #[serde(default, alias = "tab")]
    pub intent: String,
    /// 这一轮的**思考原文**（思考型模型的 `reasoning_content`；没有就是空串）。
    ///
    /// 落盘的理由：3.5.3 起思考块可折叠（`ai.think.*`），但推理只活在内存里 ——
    /// 重启后还原的轮次连块都没有，"随时点开重读"就成了空话，而推理是**真实计费**的产出。
    /// 只落文本这条规矩（图片 dataURL 永不落盘）不涉及思考：它是文本。
    ///
    /// 旧文件没有这个字段 → 空串（`serde(default)`），所以升级不会让历史会话读不出来。
    #[serde(default)]
    pub thinking: String,
}

/// 一份文档的会话。`doc_key` 是**路径的 SHA256 前 16 位**（见 `app-core::conversations`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Conversation {
    pub doc_key: String,
    /// 落盘时该文档的路径（便于人工排查；不参与身份计算）
    pub path: String,
    pub turns: Vec<ConversationTurn>,
    pub updated_at: i64,
}

/// 会话列表用的轻量元数据（`<key>.meta.json`）。与 `Conversation` 分离：列表只读它
/// （思考原文落盘后单份会话可能几十上百 KB，列表不该解析全文）。
///
/// meta 与实体同目录、同前缀：手动删掉实体不会留下指不回去的索引。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvMeta {
    pub key: String,
    /// 空 = 草稿（文档还没保存）
    #[serde(default)]
    pub path: String,
    /// 文档名，或「未命名草稿」
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub format: String,
    pub turns: u32,
    pub updated_at: i64,
    /// 首条用户提问的前 120 字（列表摘要用；不存全文，也不拿来检索正文）
    #[serde(default)]
    pub first_prompt: String,
    #[serde(default)]
    pub last_model: String,
    /// **由 `conversation_list` 现算、不落盘**：path 非空但那个文件已经不在了
    #[serde(default)]
    pub missing: bool,
    /// **由 `conversation_list` 现算、不落盘**：草稿还在草稿仓里（= 那个标签页还开着）
    #[serde(default)]
    pub live_draft: bool,
}

/* ---------------- AI 长期记忆 ---------------- */

/// 记忆作用域。风格偏好多半是全局的；术语多半只对某一份文档有意义。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryScope {
    Global,
    Doc,
}

/// 记忆条目的状态。
///
/// **`Pending` 不注入 prompt** —— 这是"自动提取低摩擦"与"不静默污染"之间的取舍点：
/// 让用户逐条手写就没人会用；让模型写的东西直接生效，一条错的记忆会静默降质之后所有输出。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryState {
    Confirmed,
    Pending,
}

/// 一条记忆。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: String,
    /// 一句话，越短越好（每次请求都会带上）
    pub text: String,
    pub scope: MemoryScope,
    /// `scope == Doc` 时的文档身份（路径 SHA256 前 16 位）；`Global` 时为空
    #[serde(default)]
    pub doc: String,
    pub state: MemoryState,
    /// `user`（手写/确认过的）| `auto`（模型提取的候选）
    #[serde(default)]
    pub source: String,
    /// 停用后仍保留但**不注入**（比删除温和：用户可能只是想暂时关掉）
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 毫秒时间戳（超限时按"最近"截断）
    #[serde(default)]
    pub at: i64,
}

fn default_true() -> bool {
    true
}

/// 记忆列表 + 当前文档身份（前端据此标出 `doc` 作用域是哪一份）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryList {
    pub items: Vec<MemoryEntry>,
    /// 当前文档的稳定身份；空 = 当前文档没有身份（未保存）
    pub doc: String,
}

/// 开发开关的环境变量名（前后端与文档统一引用，别各写一份字符串）。
pub const ENV_SELFTEST: &str = "DIAGRAMON_SELFTEST";
pub const ENV_SELFTEST_REPORT: &str = "DIAGRAMON_SELFTEST_REPORT";
pub const ENV_DEBUG_PORT: &str = "DIAGRAMON_DEBUG_PORT";

pub mod events {
    pub const AI_DELTA: &str = "ai://delta";
    /// 模型的思考增量（与正文分开，见 `AiThinking`）
    pub const AI_THINKING: &str = "ai://thinking";
    pub const AI_DONE: &str = "ai://done";
    pub const AI_FAILED: &str = "ai://failed";
    /// 工具循环里的一次工具执行（载荷 `AiAgentStep`）
    pub const AI_AGENT: &str = "ai://agent";
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
    pub const DOC_SET_LOOK: &str = "doc_set_look";
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
    pub const AI_MODEL_KEY_SET: &str = "ai_model_key_set";
    pub const AI_MODEL_KEY_DELETE: &str = "ai_model_key_delete";
    pub const AI_PROVIDER_MODELS: &str = "ai_provider_models";
    pub const AI_PROVIDER_KEY_SET: &str = "ai_provider_key_set";
    pub const AI_PROVIDER_KEY_DELETE: &str = "ai_provider_key_delete";
    pub const CONVERT_TEXT: &str = "convert_text";
    pub const AI_CHAT: &str = "ai_chat";
    pub const AI_CANCEL: &str = "ai_cancel";
    /// 受控工具循环（非流式多步；请求体与 `AiChatRequest` 相同）
    pub const AI_AGENT_RUN: &str = "ai_agent_run";
    pub const MONITORS_LIST: &str = "monitors_list";
    pub const VISION_FRAME: &str = "vision_frame";
    pub const VISION_CROP: &str = "vision_crop";
    pub const VISION_CANCEL: &str = "vision_cancel";
    pub const CLIP_WRITE_IMAGE: &str = "clip_write_image";
    pub const CLOUD_LOGIN: &str = "cloud_login";
    pub const CLOUD_LOGOUT: &str = "cloud_logout";
    pub const CLOUD_STATUS: &str = "cloud_status";
    pub const CLOUD_DOCS_LIST: &str = "cloud_docs_list";
    pub const CLOUD_FOLDERS: &str = "cloud_folders";
    pub const CLOUD_FOLDER_CREATE: &str = "cloud_folder_create";
    pub const CLOUD_DOC_SAVE: &str = "cloud_doc_save";
    pub const CLOUD_DOC_OPEN: &str = "cloud_doc_open";
    pub const CLOUD_DOC_DELETE: &str = "cloud_doc_delete";
    /// 云网关**可用模型别名**（登录后才有；无 AI 权益时为空列表）
    pub const AI_GATEWAY_MODELS: &str = "ai_gateway_models";
    /// 会话持久化：读 / 存 / 清（按文档身份，见 `Conversation`）
    pub const CONVERSATION_LOAD: &str = "conversation_load";
    pub const CONVERSATION_SAVE: &str = "conversation_save";
    pub const CONVERSATION_CLEAR: &str = "conversation_clear";
    /// 长期记忆：列 / 存（含新增与编辑）/ 删 / 清空全部 / 自动提取候选
    pub const AI_MEMORY_LIST: &str = "ai_memory_list";
    pub const AI_MEMORY_SAVE: &str = "ai_memory_save";
    pub const AI_MEMORY_DELETE: &str = "ai_memory_delete";
    pub const AI_MEMORY_CLEAR: &str = "ai_memory_clear";
    pub const AI_MEMORY_EXTRACT: &str = "ai_memory_extract";
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 自动保存**默认关闭**：写盘是不可逆副作用，不能替用户按 Ctrl+S。
    /// 想改回默认开的人请先想清楚"AI 应用/批量替换后静默改写磁盘"这个后果。
    #[test]
    fn autosave_is_off_by_default() {
        assert!(!EditorPrefs::default().autosave);
        assert!(!Settings::default().editor.autosave);
    }
}
