//! 供应商实现：OpenAI 兼容（含自定义）/ Ollama，**流式**返回。
//!
//! 为什么网络层在 Rust 而不是前端 `fetch`：BYOK 的密钥只允许存在于 Rust 进程内，
//! 前端拿不到它，也就无从泄漏（见 design/ui-proto/index.html §9.1）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Value};

/// 用户填的空闲超时（秒）的下限：更小会把正常的长思考流当成卡死掐掉。
const IDLE_MIN_S: u32 = 15;
/// 上限：半小时。再大就等于没有"卡死检测"了（真卡死也永远等不到结论）。
const IDLE_MAX_S: u32 = 1800;
/// 自动档：Ollama 是本地进程，冷启动加载权重常常 >90s 才吐第一个字节。
const IDLE_AUTO_OLLAMA_S: u64 = 300;
/// 自动档：其余（openai 兼容 / 自定义）——沿用既有的 90s。
const IDLE_AUTO_DEFAULT_S: u64 = 90;

/// 空闲多久算死（客户端侧）：`configured` 是用户在 AI 设置里给这个模型填的秒数（None = 自动）。
///
/// 为什么必须有它：BYOK 直连的用户自己的上游**不发 SSE 心跳**，而常见的合法静默就会超过
/// 旧的固定 90s（本地 Ollama 冷启动加载权重、自建网关排队、长推理模型首帧慢）——
/// 客户端于是先于服务端放弃，且"真卡死"与"只是慢"在 90s 内分不出来。
///
/// 为什么只能在客户端：reqwest 的 `read_timeout` 只能设在 `ClientBuilder` 上、不能按请求
/// 覆盖，所以它决定的是"这次对话用哪个客户端实例"（`AppState::http_for_idle`）。
/// 云网关那条路不归它管：服务端自己发心跳，`gateway_resolved` 解析出的就是默认档。
///
/// 自动档按 provider 分：Ollama 是本地进程，冷启动加载权重常常 >90s 才吐第一个字节（300s）；
/// 其余（openai 兼容 / 自定义）保持既有的 90s。用户填的值钳到 `15..=1800`（超范围也照此
/// 收窄，而不是丢弃整份配置）。
pub fn idle_timeout_for(provider: &str, configured: Option<u32>) -> Duration {
    match configured {
        Some(secs) => Duration::from_secs(secs.clamp(IDLE_MIN_S, IDLE_MAX_S) as u64),
        None if provider == "ollama" => Duration::from_secs(IDLE_AUTO_OLLAMA_S),
        None => Duration::from_secs(IDLE_AUTO_DEFAULT_S),
    }
}

#[derive(Debug, Clone)]
pub struct Resolved {
    /// openai | ollama | custom
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
    /// `None` = **不发送**这个键，交给上游/服务端自己的默认值。
    ///
    /// 云网关必须用 `None`：服务端按"所选候选 × 档位"钳 `max_tokens`
    /// （`min(max(requested, MIN_OUTPUT_TOKENS), ceiling)`），客户端填一个数反而会把
    /// 用户档位允许的长回答截短 —— 它知道 ceiling，我们不知道。
    /// 云网关那条路缺省 = **取满天花板**（`min(候选 max_output, 档位 maxOutputTokens)`）：
    /// 曾经服务端把缺省再压到 4096，于是 member 档的 8192 只兑现一半、正文被切在半句上
    /// （线上实录见 `Finish` 的注释）。
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    /// **客户端**侧的空闲上限：多久收不到一个字节就判定这条流死了（与网关无关 ——
    /// 网关自己的上限是服务端的事）。
    ///
    /// 它存在的唯一理由是 reqwest 的 `read_timeout` **只能**建在 `ClientBuilder` 上、
    /// 不能按请求覆盖，所以它决定"这次对话用哪个客户端实例"：调用方先按这个值取客户端
    /// （`AppState::http_for_idle`），再把它连同客户端一起交给 `stream_chat` / `chat_once`。
    /// 值由 [`idle_timeout_for`] 从模型配置解析而来。
    pub idle_timeout: Duration,
    /// 是否在每个请求上带 `x-opencode-session`（OpenCode Go 要求）。
    pub session_header: bool,
    /// 稳定会话号；`None`/空串时不发。同一对话应始终相同，上游才能命中缓存。
    pub session_id: Option<String>,
}

impl Resolved {
    pub fn is_ollama(&self) -> bool {
        self.provider == "ollama"
    }

    /// 把 base_url 补成具体的 endpoint。
    pub fn endpoint(&self) -> String {
        let base = normalize_base_url(&self.base_url);
        if self.is_ollama() {
            format!("{base}/api/chat")
        } else {
            format!("{base}/chat/completions")
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
    /// 其中有多少是**思考**（reasoning）token。界面用它解释"没有正文"：
    /// 一整轮预算全花在推理上时，`completion_tokens` 很大而正文可以是空的。
    pub reasoning_tokens: Option<u32>,
    /// 这条流**是怎么结束的**。界面据此决定要不要说"上面这句是半截的"（见 `Finish`）。
    pub finish: Finish,
}

/// 流/响应的终态。
///
/// 为什么它不是"锦上添花的一个字段"：`length` 意味着正文**被输出上限切断了**，
/// 而旧实现整包丢掉它 —— 于是"被截断"与"正常收尾"在界面上长得一模一样。
/// 2026-10-18 线上实录（云网关 `mermaid-default`，member 档）：上游 `completion=4096`
/// 里 2866 是思考，剩下 1230 token 的正文切在 `classDef device fill:#D`，客户端只有一个
/// 「5906 tok」徽标，用户的原话是"输出 5906 字后突然中断了，没有任何提示"。
/// 网关那边一直是原样转发 `finish_reason` 的（只改写 `model`），漏的是客户端这一层。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum Finish {
    /// 没拿到任何终态信号：既没见 `finish_reason`，也没见 `[DONE]`（也见 `Interrupted`）。
    #[default]
    Missing,
    /// 上游明说 `stop`：这一轮正常收尾。
    Stop,
    /// 上游明说 `length`：撞上输出上限，**正文是被截断的**。
    Length,
    /// 别的终态（`tool_calls` / `content_filter` / …）：如实记"有终态"，但不替它编意思。
    Other,
    /// 已经收到内容之后连接就断了（读超时、上游掉线、代理掐断）。
    Interrupted,
}

impl Finish {
    /// 进 `ai://done`（事件里是字符串，前端只认已知值，别用 Debug 形态）。
    pub fn as_str(self) -> &'static str {
        match self {
            Finish::Missing => "missing",
            Finish::Stop => "stop",
            Finish::Length => "length",
            Finish::Other => "other",
            Finish::Interrupted => "interrupted",
        }
    }
}

/// 从一帧（或一个非流式响应体）里读出终态。
///
/// OpenAI 兼容：`choices[0].finish_reason`（最后一帧给，`null` 表示"还没结束"）；
/// Ollama：`done` / `done_reason`（老版本只给 `done: true`，那就是正常收尾）。
pub(crate) fn finish_of(v: &Value, ollama: bool) -> Finish {
    if ollama {
        if v.get("done").and_then(|d| d.as_bool()) != Some(true) {
            return Finish::Missing;
        }
        return match v.get("done_reason").and_then(|r| r.as_str()) {
            Some("length") => Finish::Length,
            Some("stop") | None => Finish::Stop,
            Some(_) => Finish::Other,
        };
    }
    match v.pointer("/choices/0/finish_reason").and_then(|r| r.as_str()) {
        None | Some("") => Finish::Missing,
        Some("stop") => Finish::Stop,
        Some("length") => Finish::Length,
        Some(_) => Finish::Other,
    }
}

impl Usage {
    /// 供应商有没有在流里回报用量。
    ///
    /// 没回报时这两个 `Option` 是 `None` —— **界面必须显示"未回报"，不能当 0**，
    /// 否则"本地估算"和"服务端实报"就混成一个数了（P3 拍板）。
    pub fn reported(&self) -> bool {
        self.prompt_tokens.is_some() || self.completion_tokens.is_some()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ChatError {
    #[error("已取消")]
    Cancelled,
    #[error("缺少 API Key：BYOK 需要先在「AI 设置」里填密钥（Ollama 不需要）")]
    MissingKey,
    #[error("网络请求失败：{0}")]
    Network(String),
    /// 流中途断开、且**思考内容已到但正文未生成**。与 `Network` 的关键区别：这一单
    /// 上游已经开始生成（推理 token 大概率已计费），自动重试等于双倍付费 —— 所以
    /// 不能自动重试（调用方见 `Network` 才重试），把"要不要再试"的决定权交给用户。
    /// （真机实录 2026-10-16：改图请求思考流到 6415 字节后连接静默断死，正文一个
    /// 字都没有 —— 原来这条路径报 `Network` 且把已收到的思考一起丢掉。）
    #[error("连接中断：思考内容已收到，但正文还没生成就断开了，请重试")]
    Interrupted,
    #[error("服务返回 {status}：{body}")]
    Http { status: u16, body: String },
    /// 会话已死（云网关续期被服务端拒绝）等**有明确处置**的失败：文案由调用方给，
    /// 不是裸的 HTTP 401 —— 用户该看到"去重新登录"，不是一段错误码。
    #[error("{0}")]
    Session(String),
    #[error("响应格式异常：{0}")]
    Protocol(String),
}

/// 给直连上游用的自有 UA（OpenCode 明确要求别用通用 SDK/HTTP 库名）。
pub const USER_AGENT: &str = concat!("diagramon/", env!("CARGO_PKG_VERSION"));

/// 这个 Base URL 是否指向 OpenCode Go（含其子域）。
///
/// 只做 host 判断，不解析路径：`https://opencode.ai/zen/go/v1`、
/// `https://www.opencode.ai/v1` 都算；自定义反代请用供应商设置里的复选框。
pub fn is_opencode_base(base_url: &str) -> bool {
    let s = base_url.trim().to_ascii_lowercase();
    let rest = s.split("://").nth(1).unwrap_or(&s);
    let host = rest.split('/').next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or(host); // 去掉可能的 userinfo
    let host = host.split(':').next().unwrap_or("");
    host == "opencode.ai" || host.ends_with(".opencode.ai")
}

/// 给请求加上自有 UA / 会话头。只对直连上游生效；云网关由服务端自己生成。
pub(crate) fn apply_identity_parts(
    req: reqwest::RequestBuilder,
    session_header: bool,
    session_id: Option<&str>,
) -> reqwest::RequestBuilder {
    let req = req.header(reqwest::header::USER_AGENT, USER_AGENT);
    match (session_header, session_id) {
        (true, Some(id)) if !id.trim().is_empty() => {
            req.header("x-opencode-session", id.trim())
        }
        _ => req,
    }
}

pub(crate) fn apply_identity(req: reqwest::RequestBuilder, r: &Resolved) -> reqwest::RequestBuilder {
    apply_identity_parts(req, r.session_header, r.session_id.as_deref())
}

/// 用户在 Base URL 里多填的路径要清掉 —— 旧客户端也做这件事，
/// 否则 `/v1/chat/completions` + `/chat/completions` 会拼成 404。
pub fn normalize_base_url(raw: &str) -> String {
    let mut s = raw.trim().trim_end_matches('/').to_string();
    for suffix in ["/chat/completions", "/completions", "/api/chat", "/api/generate"] {
        if let Some(stripped) = s.strip_suffix(suffix) {
            s = stripped.to_string();
            break;
        }
    }
    s.trim_end_matches('/').to_string()
}

/// 拉取供应商的模型列表（BYOK 设置页用）。
///
/// OpenAI 兼容走 `GET {base}/models`；Ollama 走 `GET {base}/api/tags`。
/// **密钥只在本函数内使用，不落盘**；已保存的供应商由命令层从凭据库取。
pub async fn list_models(
    client: &reqwest::Client,
    provider: &str,
    base_url: &str,
    api_key: Option<&str>,
    session_header: bool,
    session_id: Option<&str>,
) -> Result<Vec<String>, ChatError> {
    let base = normalize_base_url(base_url);
    if base.is_empty() {
        return Err(ChatError::Protocol("Base URL 为空".into()));
    }
    let ollama = provider == "ollama";
    if !ollama && api_key.map(str::trim).filter(|s| !s.is_empty()).is_none() {
        return Err(ChatError::MissingKey);
    }
    let url = if ollama { format!("{base}/api/tags") } else { format!("{base}/models") };
    // 模型列表也可能走同一套上游网关：带自有 UA / 可选的会话头（OpenCode 的 /models
    // 目前不强制，但带上无害，且反代可能要求）。
    let mut req = apply_identity_parts(
        client.get(url).timeout(Duration::from_secs(20)),
        session_header,
        session_id,
    );
    if let Some(key) = api_key.map(str::trim).filter(|s| !s.is_empty()) {
        req = req.bearer_auth(key);
    }
    let resp = req.send().await.map_err(|e| ChatError::Network(e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| ChatError::Network(e.to_string()))?;
    if !status.is_success() {
        return Err(ChatError::Http { status: status.as_u16(), body: truncate(&text, 300) });
    }
    let v: Value =
        serde_json::from_str(&text).map_err(|e| ChatError::Protocol(format!("模型列表不是 JSON：{e}")))?;
    let mut ids: Vec<String> = if ollama {
        v["models"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| m["name"].as_str().or_else(|| m["model"].as_str()))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    } else {
        v["data"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| m["id"].as_str())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    ids.retain(|s| !s.trim().is_empty());
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Err(ChatError::Protocol(
            "上游没有返回任何模型（检查 Base URL 是否指向 OpenAI 兼容接口）".into(),
        ));
    }
    Ok(ids)
}

/// 构造请求体（单独抽出来是为了能在没有网络的情况下测）。
///
/// `max_tokens` / `temperature` 为 `None` 时**不放这两个键**（不是放 0）——
/// "没说"与"说了 0"在服务端是两件事：前者用服务端默认，后者会被钳到最小值。
pub fn build_body(r: &Resolved, messages: &[Value], stream: bool) -> Value {
    if r.is_ollama() {
        let mut options = serde_json::Map::new();
        if let Some(t) = r.temperature {
            options.insert("temperature".into(), json!(t));
        }
        if let Some(n) = r.max_tokens {
            options.insert("num_predict".into(), json!(n));
        }
        json!({
            "model": r.model,
            "messages": messages,
            "stream": stream,
            "options": Value::Object(options),
        })
    } else {
        let mut body = serde_json::Map::new();
        body.insert("model".into(), json!(r.model));
        body.insert("messages".into(), json!(messages));
        body.insert("stream".into(), json!(stream));
        if let Some(n) = r.max_tokens {
            body.insert("max_tokens".into(), json!(n));
        }
        if let Some(t) = r.temperature {
            body.insert("temperature".into(), json!(t));
        }
        // 让最后一帧带回 usage：用量面板要用它，否则只能自己数 token。
        //
        // **只在流式时加**：`stream_options` 只对 `stream: true` 有意义，
        // 个别上游在非流式请求里带上它会直接 400 —— 而记忆提取走的正是非流式
        // （`chat_once`）。原来这里无条件插入，那是个埋着的雷。
        if stream {
            body.insert("stream_options".into(), json!({ "include_usage": true }));
        }
        Value::Object(body)
    }
}

/// 在 `build_body` 之上加工具（工具循环那一路用）。
///
/// `tools` 为空时**一个键都不加** —— 不用工具的请求必须与以前逐字节一致。
pub fn build_body_with_tools(r: &Resolved, messages: &[Value], tools: &[Value], stream: bool) -> Value {
    let mut body = build_body(r, messages, stream);
    if tools.is_empty() {
        return body;
    }
    if let Value::Object(map) = &mut body {
        map.insert("tools".into(), Value::Array(tools.to_vec()));
    }
    body
}

/// 上游把"`max_tokens` 超出所选模型上限"写成 400，报文里带一句可解析的范围说明。
/// 取出它给的上限 N；报文里没有这句话（实测 opencode Go 偶尔只回 `{"model":"…"}`）就返回 `None`。
///
/// 为什么靠报文而不是靠本地表：`GET /v1/models` 只回 `id/object/created/owned_by`，
/// 每个模型的真实上限客户端拿不到 —— 而 DeepSeek 官方与 opencode Go 都会回
/// `Invalid max_tokens value, the valid range of max_tokens is [1, 393216]`（实测 2026-10-21）。
/// 上游改措辞就命中不了：那时退化成原来的报错，不会更糟。
pub fn max_tokens_ceiling(err: &ChatError) -> Option<u32> {
    let ChatError::Http { status: 400, body } = err else { return None };
    let at = body.find("valid range of max_tokens is")?;
    let rest = &body[at..];
    let open = rest.find('[')?;
    let close = rest[open..].find(']')? + open;
    // `[1, 393216]` → 取上界
    rest[open + 1..close].split(',').nth(1)?.trim().parse().ok().filter(|n| *n > 0)
}

/// 由一次失败构造"用上游给的上限重发一次"的参数；不是这类失败就 `None`。
///
/// **只能在读到任何增量之前调用**：`stream_chat` 的 400 发生在读流之前，天然满足；
/// 已经出过正文/思考的错误绝不能重发（重复计费，见 [`ChatError::Interrupted`]）。
///
/// 返回的新参数**不回写 settings**：那个值挂在整个供应商上、多个模型共用，
/// 回写会把"先失败的那个模型的上限"变成全家上限（见 `AiProvider::max_tokens`）。
pub fn with_max_tokens_ceiling(r: &Resolved, err: &ChatError) -> Option<Resolved> {
    let ceiling = max_tokens_ceiling(err)?;
    if r.max_tokens == Some(ceiling) {
        return None; // 已经是这个值：重发只会再错一次
    }
    let mut next = r.clone();
    next.max_tokens = Some(ceiling);
    Some(next)
}

/// 流式对话。每收到一段增量就回调一次 `on_delta`（正文与思考分开报）；`cancel` 置位时立刻中止。
///
/// 返回 `(正文, 思考, 用量)` —— 思考单独返回，界面据此在"还没有正文"的那段时间里显示进度，
/// 而不是让用户对着空气等（见 `Chunk` 的说明）。
///
/// `client` 必须与 `r.idle_timeout` 配套：reqwest 的 `read_timeout` 只能在 `ClientBuilder` 上
/// 设，所以"多久没字节算死"这件事是**客户端实例**的属性，调用方要先用
/// `AppState::http_for_idle(r.idle_timeout)` 取到对应实例再进来（见 `Resolved.idle_timeout`）。
pub async fn stream_chat<F>(
    client: &reqwest::Client,
    r: &Resolved,
    messages: Vec<Value>,
    cancel: &AtomicBool,
    mut on_delta: F,
) -> Result<(String, String, Usage), ChatError>
where
    F: FnMut(Chunk),
{
    if !r.is_ollama() && r.api_key.as_deref().unwrap_or("").trim().is_empty() {
        return Err(ChatError::MissingKey);
    }

    let url = r.endpoint();
    let body = build_body(r, &messages, true);
    let req = apply_identity(client.post(&url).json(&body), r);
    // 流式请求**不能继承**客户端的 300s 总超时：思考型模型一条流跑 5 分钟+很正常，
    // 撞上它会被硬掐成"error decoding response body"（真机实录 2026-10-16：改图流
    // 恰在 300s 整断掉，服务端 ai_usage 记 299.9s cancelled）。这里放宽成 30 分钟
    // 兜底——真正的卡死由**按模型解析出的空闲上限**（`Resolved.idle_timeout`，落在调用方
    // 选好的客户端实例上）负责检测，上游持续吐 SSE 心跳注释帧（不算内容但保活连接）的
    // 长思考流也照样能活下来。
    let mut req = req.timeout(std::time::Duration::from_secs(30 * 60));
    if let Some(key) = r.api_key.as_deref() {
        if !key.trim().is_empty() {
            req = req.bearer_auth(key.trim());
        }
    }

    let resp = req.send().await.map_err(|e| ChatError::Network(e.to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(ChatError::Http { status: status.as_u16(), body: truncate(&body, 600) });
    }

    let ollama = r.is_ollama();
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    let mut full = String::new();
    let mut reasoning = String::new();
    let mut usage = Usage::default();
    let mut saw_done = false;

    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(ChatError::Cancelled);
        }
        let chunk = match resp.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                // 已经收到正文后断开：内容照旧交付，但**必须记下"这是断的"** ——
                // 否则界面会把半句话当完整答案（这正是用户看到的"突然中断、没有任何提示"）。
                if !full.is_empty() {
                    if usage.finish == Finish::Missing {
                        usage.finish = Finish::Interrupted;
                    }
                    break;
                }
                // 思考已到、正文未生成：无声成功会让用户看到"想了半天什么都没有"，
                // 自动重试会双倍计费 —— 显式报错，让用户决定要不要再来一次。
                if !reasoning.is_empty() {
                    return Err(ChatError::Interrupted);
                }
                // 一帧都没到：纯连接失败，调用方可安全自动重试一次
                return Err(ChatError::Network(e.to_string()));
            }
        };
        buf.extend_from_slice(&chunk);

        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            let line = line.trim();
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            let payload = if let Some(d) = line.strip_prefix("data:") {
                let d = d.trim();
                if d == "[DONE]" {
                    saw_done = true;
                    continue;
                }
                d.to_string()
            } else if line.starts_with('{') {
                line.to_string() // Ollama 是 NDJSON
            } else {
                continue;
            };

            let Ok(v) = serde_json::from_str::<Value>(&payload) else {
                continue; // 单帧解析失败不该中断整条流
            };

            for chunk in extract_chunks(&v, ollama) {
                match &chunk {
                    Chunk::Text(t) => full.push_str(t),
                    Chunk::Reasoning(t) => reasoning.push_str(t),
                }
                on_delta(chunk);
            }
            merge_usage(&mut usage, &v, ollama);
        }
    }

    if cancel.load(Ordering::Relaxed) {
        return Err(ChatError::Cancelled);
    }
    // 给了 `[DONE]` 但整条流没出现过 `finish_reason`（有的网关省掉它）= 正常收尾。
    // 两者都没有 = `Finish::Missing`：流就这么结束了，**没有说它结束了** —— 界面会提示
    // 用户"可能是半截的"，而不是把这段内容当成完整答案。
    if usage.finish == Finish::Missing && saw_done {
        usage.finish = Finish::Stop;
    }
    Ok((full, reasoning, usage))
}

/// 流里的一小段增量：模型**正文**，或它的**思考**。
///
/// 为什么必须分开（2026-10-14 用户实测的 bug）：思考型模型（GLM / DeepSeek / Qwen 这一族）
/// 把整段推理放在 `delta.reasoning_content` 里逐帧推，正文要等推理结束才来 —— 而原来的
/// `extract_delta` 只认 `delta.content`，于是一整轮"有 token、没有正文"的调用在界面上
/// **一个字都不显示**：token 记了 2000+，对话里空白（真机抓包：`mermaid-reasoning` 连推
/// 104 帧全是 reasoning_content，客户端全部丢掉）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Chunk {
    Text(String),
    Reasoning(String),
}

/// 把一个增量字段（字符串 / 数组两种形态）取成纯文本。
///
/// 数组形态是 OpenAI 多模态的分段写法：`[{"type":"text","text":"…"}]` —— 只认字符串的
/// 实现遇到它会静默丢帧，同样是"有 token、没字"。
pub(crate) fn text_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => {
            let mut out = String::new();
            for p in parts {
                if let Some(s) = p.get("text").and_then(|t| t.as_str()) {
                    out.push_str(s);
                }
            }
            out
        }
        _ => String::new(),
    }
}

/// 一帧里能取出的所有增量（一般 0–1 个：首帧只有 role，末帧只有 usage）。
fn extract_chunks(v: &Value, ollama: bool) -> Vec<Chunk> {
    let mut out = Vec::new();
    let mut push = |kind: fn(String) -> Chunk, text: String| {
        if !text.is_empty() {
            out.push(kind(text));
        }
    };

    if ollama {
        if let Some(m) = v.get("message") {
            push(Chunk::Text, text_of(m.get("content")));
            // Ollama 的思考字段叫 thinking（新版才有）
            push(Chunk::Reasoning, text_of(m.get("thinking")));
        }
        return out;
    }

    let Some(choice) = v.get("choices").and_then(|c| c.as_array()).and_then(|a| a.first()) else {
        return out;
    };
    match choice.get("delta") {
        Some(d) => {
            push(Chunk::Text, text_of(d.get("content")));
            // `reasoning_content` 是 DeepSeek/GLM/Qwen 这一族的写法；`reasoning`/`thinking`
            // 是别的网关的别名，一起认。
            let r = d
                .get("reasoning_content")
                .or_else(|| d.get("reasoning"))
                .or_else(|| d.get("thinking"));
            push(Chunk::Reasoning, text_of(r));
        }
        // 没有 delta 的整包帧（网关把非流式的 message 塞进流里）——当作正文收下，
        // 否则这一轮又是"有 token、没字"。
        None => push(Chunk::Text, text_of(choice.pointer("/message/content"))),
    }
    out
}

fn merge_usage(usage: &mut Usage, v: &Value, ollama: bool) {
    // 终态每帧都试着读一次：它出现在**最后一帧**（OpenAI 兼容那一帧的 `delta` 是空的，
    // 只有 `finish_reason`）。漏了它，"被截断"与"正常收尾"就没法区分（见 `Finish`）。
    let finish = finish_of(v, ollama);
    if finish != Finish::Missing {
        usage.finish = finish;
    }
    if ollama {
        if let Some(n) = v.get("prompt_eval_count").and_then(|x| x.as_u64()) {
            usage.prompt_tokens = Some(n as u32);
        }
        if let Some(n) = v.get("eval_count").and_then(|x| x.as_u64()) {
            usage.completion_tokens = Some(n as u32);
        }
        return;
    }
    if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
        if let Some(n) = u.get("prompt_tokens").and_then(|x| x.as_u64()) {
            usage.prompt_tokens = Some(n as u32);
        }
        if let Some(n) = u.get("completion_tokens").and_then(|x| x.as_u64()) {
            usage.completion_tokens = Some(n as u32);
        }
        // 思考占了多少 token（OpenAI 系：completion_tokens_details.reasoning_tokens）。
        // 界面用它解释"为什么没有正文"：一整轮预算全花在思考上时，正文可以是空的。
        if let Some(n) = u
            .pointer("/completion_tokens_details/reasoning_tokens")
            .or_else(|| u.get("reasoning_tokens"))
            .and_then(|x| x.as_u64())
        {
            usage.reasoning_tokens = Some(n as u32);
        }
    }
}

pub(crate) fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}…")
    }
}

/// 非流式一次性对话。**只给内部辅助调用用**（当前就是记忆提取）。
///
/// 为什么不复用 `stream_chat`：提取只关心最后那段文本，流式还得自己拼装；
/// 而非流式能直接从响应里读 `usage`，成本口径更准。
pub async fn chat_once(
    client: &reqwest::Client,
    r: &Resolved,
    messages: Vec<Value>,
) -> Result<(String, Usage), ChatError> {
    if !r.is_ollama() && r.api_key.as_deref().unwrap_or("").trim().is_empty() {
        return Err(ChatError::MissingKey);
    }

    let url = r.endpoint();
    let body = build_body(r, &messages, false);
    let mut req = apply_identity(client.post(&url).json(&body), r);
    if let Some(key) = r.api_key.as_deref() {
        if !key.trim().is_empty() {
            req = req.bearer_auth(key.trim());
        }
    }

    let resp = req.send().await.map_err(|e| ChatError::Network(e.to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(ChatError::Http { status: status.as_u16(), body: truncate(&body, 600) });
    }
    let payload: Value = resp.json().await.map_err(|e| ChatError::Protocol(e.to_string()))?;

    let ollama = r.is_ollama();
    let content = if ollama {
        payload.pointer("/message/content")
    } else {
        payload.pointer("/choices/0/message/content")
    };
    let text = text_of(content);

    let mut usage = Usage::default();
    merge_usage(&mut usage, &payload, ollama);
    Ok((text, usage))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn openai() -> Resolved {
        Resolved {
            provider: "openai".into(),
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-4o".into(),
            api_key: Some("sk-x".into()),
            max_tokens: Some(4096),
            temperature: Some(0.7),
            idle_timeout: idle_timeout_for("openai", None),
            session_header: false,
            session_id: None,
        }
    }

    #[test]
    fn idle_timeout_auto_depends_on_provider() {
        // 自动档：本地 Ollama 冷启动常常 >90s 才出第一个字节，其余沿用既有的 90s
        assert_eq!(idle_timeout_for("ollama", None), Duration::from_secs(300));
        assert_eq!(idle_timeout_for("openai", None), Duration::from_secs(90));
        // 用户填了就用他的（在范围内原样）
        assert_eq!(idle_timeout_for("ollama", Some(45)), Duration::from_secs(45));
    }

    #[test]
    fn idle_timeout_clamps_out_of_range_values() {
        assert_eq!(idle_timeout_for("openai", Some(1)), Duration::from_secs(15));
        assert_eq!(idle_timeout_for("openai", Some(99_999)), Duration::from_secs(1800));
        assert_eq!(idle_timeout_for("custom", Some(0)), Duration::from_secs(15));
    }

    #[test]
    fn base_url_normalisation_strips_pasted_endpoint_paths() {
        assert_eq!(normalize_base_url("https://api.openai.com/v1/"), "https://api.openai.com/v1");
        assert_eq!(normalize_base_url("https://api.openai.com/v1/chat/completions"), "https://api.openai.com/v1");
        assert_eq!(normalize_base_url("http://localhost:11434/api/chat"), "http://localhost:11434");
        assert_eq!(normalize_base_url("  https://x.y/v1/completions  "), "https://x.y/v1");
    }

    #[test]
    fn endpoints_are_built_per_provider() {
        assert_eq!(openai().endpoint(), "https://api.openai.com/v1/chat/completions");
        let mut o = openai();
        o.provider = "ollama".into();
        o.base_url = "http://localhost:11434".into();
        assert_eq!(o.endpoint(), "http://localhost:11434/api/chat");
    }

    #[test]
    fn openai_body_asks_for_usage_and_forces_stream() {
        let body = build_body(&openai(), &[json!({"role":"user","content":"hi"})], true);
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["model"], "gpt-4o");
    }

    /// 非流式**不能**带 `stream_options`：它只对 `stream: true` 有意义，
    /// 个别上游在非流式请求里带上会直接 400 —— 而记忆提取（`chat_once`）走的正是非流式。
    #[test]
    fn nonstream_body_omits_stream_options() {
        let body = build_body(&openai(), &[json!({"role":"user","content":"hi"})], false);
        assert_eq!(body["stream"], false);
        assert!(body.get("stream_options").is_none(), "非流式不该带 stream_options：{body}");
    }

    #[test]
    fn ollama_body_uses_its_own_options_shape() {
        let mut r = openai();
        r.provider = "ollama".into();
        let body = build_body(&r, &[], true);
        assert!(body.get("options").is_some(), "Ollama 用 options，不是顶层 max_tokens");
        assert_eq!(body["options"]["num_predict"], 4096);
        assert!(body.get("stream_options").is_none());
    }

    /// 云网关那条路：`max_tokens`/`temperature` 为 `None` 时**键都不出现**。
    /// 放 0 或放客户端自己猜的值都会改变服务端的钳制结果（见 `Resolved.max_tokens` 注释）。
    #[test]
    fn none_knobs_are_omitted_entirely_not_zeroed() {
        let r = Resolved { max_tokens: None, temperature: None, ..openai() };
        let body = build_body(&r, &[json!({"role":"user","content":"hi"})], true);
        assert!(body.get("max_tokens").is_none(), "不该出现 max_tokens: {body}");
        assert!(body.get("temperature").is_none(), "不该出现 temperature: {body}");
        // 该带的还得带
        assert_eq!(body["model"], "gpt-4o");
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
    }

    #[test]
    fn ollama_options_omit_missing_knobs_too() {
        let r = Resolved { provider: "ollama".into(), max_tokens: None, temperature: None, ..openai() };
        let body = build_body(&r, &[], true);
        assert_eq!(body["options"], json!({}), "options 里不该出现 temperature/num_predict");
    }

    #[test]
    fn openai_delta_extraction_reads_choices_delta_content() {
        let v = json!({"choices":[{"delta":{"content":"你好"}}]});
        assert_eq!(extract_chunks(&v, false), vec![Chunk::Text("你好".into())]);
        // 只有 role 的首帧没有 content，不该产出空回调
        let v = json!({"choices":[{"delta":{"role":"assistant"}}]});
        assert!(extract_chunks(&v, false).is_empty());
    }

    /// 真机抓包（2026-10-14，云网关 `mermaid-reasoning`）：整条流 104 帧全是
    /// `delta.reasoning_content`，一个 `content` 都没有。改之前这些帧被**全部丢掉** ——
    /// 用户那边就是"消耗了 2000+ token，对话里一个字都没有"。
    #[test]
    fn reasoning_content_frames_are_kept() {
        // 这两帧是从真流里抄下来的原样 JSON
        let v: Value = serde_json::from_str(
            r#"{"id":"e405a780806d23d3f0428d693ee0bef3","object":"chat.completion.chunk","created":1791985709,"model":"mermaid-reasoning","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"用户想要暗色配色"},"finish_reason":null}]}"#,
        )
        .unwrap();
        assert_eq!(extract_chunks(&v, false), vec![Chunk::Reasoning("用户想要暗色配色".into())]);

        let v: Value = serde_json::from_str(
            r#"{"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"50f,stroke:#f"},"finish_reason":null}]}"#,
        )
        .unwrap();
        assert_eq!(extract_chunks(&v, false), vec![Chunk::Reasoning("50f,stroke:#f".into())]);

        // 别名（别的网关叫 reasoning / thinking）也认
        for key in ["reasoning", "thinking"] {
            let v = json!({"choices":[{"delta":{key:"想一下"}}]});
            assert_eq!(extract_chunks(&v, false), vec![Chunk::Reasoning("想一下".into())], "{key}");
        }
    }

    /// 正文以**分段数组**给出的形态（OpenAI 多模态写法）：只认字符串的实现会静默丢帧 ——
    /// 同样是"有 token、没字"。
    #[test]
    fn content_as_parts_array_is_joined() {
        let v = json!({"choices":[{"delta":{"content":[{"type":"text","text":"第一段"},{"type":"text","text":"第二段"}]}}]});
        assert_eq!(extract_chunks(&v, false), vec![Chunk::Text("第一段第二段".into())]);
    }

    /// 没有 `delta`、直接给整包 `message` 的帧（有的网关把非流式响应塞进流里）。
    #[test]
    fn whole_message_frame_without_delta_counts_as_text() {
        let v = json!({"choices":[{"message":{"role":"assistant","content":"整包正文"}}]});
        assert_eq!(extract_chunks(&v, false), vec![Chunk::Text("整包正文".into())]);
        // 有 delta 的帧就不能再看 message（否则正文会被算两遍）
        let v = json!({"choices":[{"delta":{"content":"增量"},"message":{"content":"整包"}}]});
        assert_eq!(extract_chunks(&v, false), vec![Chunk::Text("增量".into())]);
    }

    #[test]
    fn ollama_delta_extraction_reads_message_content() {
        let v = json!({"message":{"role":"assistant","content":"部分"},"done":false});
        assert_eq!(extract_chunks(&v, true), vec![Chunk::Text("部分".into())]);
        let v = json!({"message":{"role":"assistant","thinking":"先想"},"done":false});
        assert_eq!(extract_chunks(&v, true), vec![Chunk::Reasoning("先想".into())]);
    }

    #[test]
    fn usage_is_merged_from_the_final_frame() {
        let mut u = Usage::default();
        merge_usage(&mut u, &json!({"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}), false);
        assert_eq!(u.prompt_tokens, Some(11));
        assert_eq!(u.completion_tokens, Some(7));
        assert_eq!(u.reasoning_tokens, None);

        let mut o = Usage::default();
        merge_usage(&mut o, &json!({"done":true,"prompt_eval_count":5,"eval_count":9}), true);
        assert_eq!(o.prompt_tokens, Some(5));
        assert_eq!(o.completion_tokens, Some(9));
    }

    /// 思考 token 单独计：界面用它解释"为什么这一轮没有正文"（预算全花在推理上）。
    #[test]
    fn reasoning_tokens_are_read_from_completion_details() {
        let mut u = Usage::default();
        merge_usage(
            &mut u,
            &json!({"choices":[],"usage":{"prompt_tokens":137,"completion_tokens":2140,
                    "completion_tokens_details":{"reasoning_tokens":2088}}}),
            false,
        );
        assert_eq!(u.prompt_tokens, Some(137));
        assert_eq!(u.completion_tokens, Some(2140));
        assert_eq!(u.reasoning_tokens, Some(2088));
    }

    #[test]
    fn missing_key_is_a_distinct_error_for_openai_but_not_for_ollama() {
        let mut r = openai();
        r.api_key = None;
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let client = reqwest::Client::new();
        let cancel = AtomicBool::new(false);
        let err = rt
            .block_on(stream_chat(&client, &r, vec![], &cancel, |_| {}))
            .unwrap_err();
        assert!(matches!(err, ChatError::MissingKey), "{err:?}");
    }

    /// 终态解析：`length` 必须被认出来（它是"正文被截断"的唯一凭据）。
    #[test]
    fn finish_reason_is_read_from_the_terminal_frame() {
        // 正常收尾
        assert_eq!(finish_of(&json!({"choices":[{"delta":{},"finish_reason":"stop"}]}), false), Finish::Stop);
        // **被输出上限截断** —— 2026-10-18 线上那次就是它
        assert_eq!(finish_of(&json!({"choices":[{"delta":{},"finish_reason":"length"}]}), false), Finish::Length);
        // 别的终态：如实记"有终态"，不替它编意思
        assert_eq!(finish_of(&json!({"choices":[{"delta":{},"finish_reason":"content_filter"}]}), false), Finish::Other);
        // 中途帧（`finish_reason: null`）与缺字段都不算终态
        assert_eq!(finish_of(&json!({"choices":[{"delta":{"content":"你"},"finish_reason":null}]}), false), Finish::Missing);
        assert_eq!(finish_of(&json!({"choices":[{"delta":{"content":"你"}}]}), false), Finish::Missing);
        assert_eq!(finish_of(&json!({"usage":{"prompt_tokens":1}}), false), Finish::Missing);
        // Ollama：`done:true` 才算收尾，`done_reason` 区分正常/截断
        assert_eq!(finish_of(&json!({"message":{"content":"x"},"done":false}), true), Finish::Missing);
        assert_eq!(finish_of(&json!({"done":true}), true), Finish::Stop);
        assert_eq!(finish_of(&json!({"done":true,"done_reason":"length"}), true), Finish::Length);
    }

    /// 终态要**累积进 `Usage`**：界面拿到的 `ai://done.finish` 就是它。
    #[test]
    fn merge_usage_carries_the_finish_reason() {
        let mut u = Usage::default();
        merge_usage(&mut u, &json!({"choices":[{"delta":{"content":"半句"},"finish_reason":null}]}), false);
        assert_eq!(u.finish, Finish::Missing, "中途帧不该被当成终态");
        merge_usage(
            &mut u,
            &json!({"choices":[{"delta":{},"finish_reason":"length"}],
                    "usage":{"prompt_tokens":1810,"completion_tokens":4096,
                    "completion_tokens_details":{"reasoning_tokens":2866}}}),
            false,
        );
        assert_eq!(u.finish, Finish::Length);
        assert_eq!(u.completion_tokens, Some(4096));
    }

    /// 一个只回固定字节的极小 HTTP/1.1 服务端（标准库 TCP —— 不为测试引 tokio 的 net 特性）。
    ///
    /// 两种收场方式，对应真机上两种完全不同的现象：
    /// - 不写 `Content-Length` + 关连接 = HTTP/1.1 的**正常 EOF**（"流结束了，但没说它结束了"）；
    /// - 声明一个**大于实际发出的** `Content-Length` 再关连接 = 传输**错误**
    ///   （上游/代理在响应中途把连接掐了，客户端会拿到 `error decoding response body`）。
    /// `hold_ms` > 0 时先吐字节、停一会儿再关 —— 保证"断之前客户端已经收到了正文"。
    fn sse_server(body: &'static str, hold_ms: u64) -> String {
        sse_server_with(body, hold_ms, false)
    }

    fn sse_server_with(body: &'static str, hold_ms: u64, truncated: bool) -> String {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = [0u8; 4096];
                let _ = std::io::Read::read(&mut s, &mut buf); // 读完请求头就走
                let head = if truncated {
                    // 说了 64KB，实际只发这么多 —— 之后关连接就是"承诺没兑现"
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n",
                        body.len() + 65536
                    )
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n".to_string()
                };
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(body.as_bytes());
                let _ = s.flush();
                if hold_ms > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(hold_ms));
                }
                drop(s); // 关连接
            }
        });
        format!("http://{addr}/v1")
    }

    fn run_stream(base_url: String) -> Result<(String, Usage), ChatError> {
        let r = Resolved { base_url, ..openai() };
        // `enable_all`：reqwest 的连接超时走 tokio 的 timer，只有 "rt" 的运行时里没有它。
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(stream_chat(&reqwest::Client::new(), &r, vec![], &AtomicBool::new(false), |_| {}))
            .map(|(text, _reasoning, usage)| (text, usage))
    }

    /// 真流（真网络 + 真解析）：三种收尾必须**分得开** —— 这正是用户看不到差别的那三种。
    #[test]
    fn real_stream_distinguishes_stop_length_and_missing() {
        // ① 正常收尾：`finish_reason=stop` + `[DONE]`
        let url = sse_server(
            "data: {\"choices\":[{\"delta\":{\"content\":\"完整正文\"},\"finish_reason\":null}]}\n\n\
             data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":4}}\n\n\
             data: [DONE]\n\n",
            0,
        );
        let (text, u) = run_stream(url).unwrap();
        assert_eq!(text, "完整正文");
        assert_eq!(u.finish, Finish::Stop);
        assert_eq!(u.prompt_tokens, Some(11));

        // ② 撞输出上限：`finish_reason=length` —— 线上那次的原形
        let url = sse_server(
            "data: {\"choices\":[{\"delta\":{\"content\":\"classDef device fill:#D\"},\"finish_reason\":null}]}\n\n\
             data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}],\"usage\":{\"prompt_tokens\":1810,\"completion_tokens\":4096,\"completion_tokens_details\":{\"reasoning_tokens\":2866}}}\n\n\
             data: [DONE]\n\n",
            0,
        );
        let (text, u) = run_stream(url).unwrap();
        assert_eq!(text, "classDef device fill:#D");
        assert_eq!(u.finish, Finish::Length);
        assert_eq!(u.reasoning_tokens, Some(2866));

        // ③ 流**就这么结束了**：既没 `finish_reason` 也没 `[DONE]`（网关在上游超时后就是这样
        //    收场的：不补 [DONE]、不发错误帧）。必须记成"没有结束标记"，不能当正常收尾。
        let url = sse_server("data: {\"choices\":[{\"delta\":{\"content\":\"突然没了\"},\"finish_reason\":null}]}\n\n", 0);
        let (text, u) = run_stream(url).unwrap();
        assert_eq!(text, "突然没了");
        assert_eq!(u.finish, Finish::Missing);

        // ④ 只给 `[DONE]`、没给 `finish_reason`（有的网关省掉它）：那是正常收尾
        let url = sse_server(
            "data: {\"choices\":[{\"delta\":{\"content\":\"好\"},\"finish_reason\":null}]}\n\n\
             data: [DONE]\n\n",
            0,
        );
        let (text, u) = run_stream(url).unwrap();
        assert_eq!(text, "好");
        assert_eq!(u.finish, Finish::Stop);
    }

    /// 收到正文之后连接断掉：内容照旧交付，但**必须标成 `interrupted`** ——
    /// 以前这一路是 `break`（当成成功），界面因此把半句话当完整答案。
    #[test]
    fn a_connection_that_dies_mid_answer_is_marked_interrupted() {
        let url = sse_server_with(
            "data: {\"choices\":[{\"delta\":{\"content\":\"前半句\"},\"finish_reason\":null}]}\n\n",
            300,
            true,
        );
        let (text, u) = run_stream(url).unwrap();
        assert_eq!(text, "前半句", "已经收到的正文不能丢");
        assert_eq!(u.finish, Finish::Interrupted);
    }

    /// 上游超限报文的真实形态（2026-10-21 实测：opencode Go 与 DeepSeek 官方都是这句）。
    #[test]
    fn max_tokens_ceiling_reads_the_real_upstream_message() {
        let err = ChatError::Http {
            status: 400,
            body: "{\"error\":{\"param\":null,\"type\":\"invalid_request_error\",\"code\":\"invalid_request_error\",\"message\":\"Upstream request failed: [invalid_request_error] Invalid max_tokens value, the valid range of max_tokens is [1, 393216] (request_id: 0a5a9336-7888-4593-b6e2-169b5e54041a)\"}}".into(),
        };
        assert_eq!(max_tokens_ceiling(&err), Some(393216));
    }

    /// 没有范围说明就别猜：opencode Go 实测**偶尔只回模型名**，那时必须老实放弃。
    #[test]
    fn max_tokens_ceiling_gives_up_without_a_range() {
        let bare = ChatError::Http { status: 400, body: "{\"model\":\"deepseek-v4.1-flash\"}".into() };
        assert_eq!(max_tokens_ceiling(&bare), None);
        let other = ChatError::Http { status: 400, body: "{\"error\":{\"message\":\"bad request\"}}".into() };
        assert_eq!(max_tokens_ceiling(&other), None);
        // 非 400、非 HTTP 的失败一律不碰（503 是端点不可用，改参数没用）
        let srv = ChatError::Http { status: 503, body: "valid range of max_tokens is [1, 8]".into() };
        assert_eq!(max_tokens_ceiling(&srv), None);
        assert_eq!(max_tokens_ceiling(&ChatError::Cancelled), None);
    }

    /// 自愈只准改 `max_tokens`；已经等于上限时不重发（重发只会再错一次）。
    #[test]
    fn with_max_tokens_ceiling_rewrites_only_max_tokens() {
        let err = ChatError::Http {
            status: 400,
            body: "Invalid max_tokens value, the valid range of max_tokens is [1, 393216]".into(),
        };
        let r = openai(); // max_tokens: Some(4096)
        let fixed = with_max_tokens_ceiling(&r, &err).unwrap();
        assert_eq!(fixed.max_tokens, Some(393216));
        assert_eq!(r.max_tokens, Some(4096), "原参数不该被就地改掉");
        assert_eq!(fixed.model, r.model);
        assert_eq!(fixed.base_url, r.base_url);
        assert_eq!(fixed.session_id, r.session_id);
        assert_eq!(fixed.idle_timeout, r.idle_timeout);

        let already = Resolved { max_tokens: Some(393216), ..openai() };
        assert!(with_max_tokens_ceiling(&already, &err).is_none());
        let blank = Resolved { max_tokens: None, ..openai() };
        assert_eq!(with_max_tokens_ceiling(&blank, &err).unwrap().max_tokens, Some(393216));
        let bare = ChatError::Http { status: 400, body: "{\"model\":\"x\"}".into() };
        assert!(with_max_tokens_ceiling(&openai(), &bare).is_none());
    }

    /// 自愈后的请求体真带上了新上限（不是只改了结构体）。
    #[test]
    fn healed_parameters_change_the_request_body() {
        let err = ChatError::Http {
            status: 400,
            body: "the valid range of max_tokens is [1, 393216]".into(),
        };
        let fixed = with_max_tokens_ceiling(&openai(), &err).unwrap();
        assert_eq!(build_body(&fixed, &[], true)["max_tokens"], 393216);
    }

    #[test]
    fn opencode_base_detection_is_host_based() {
        assert!(is_opencode_base("https://opencode.ai/zen/go/v1"));
        assert!(is_opencode_base("https://www.opencode.ai/v1"));
        assert!(is_opencode_base("http://opencode.ai:8080/v1"));
        assert!(!is_opencode_base("https://api.openai.com/v1"));
        assert!(!is_opencode_base("https://opencode.ai.example.com/v1"));
        assert!(!is_opencode_base(""));
    }

    /// 只回固定 JSON/SSE 的极小服务端，同时把收到的请求头留下来。
    fn capture_server(
        body: &'static str,
        content_type: &'static str,
    ) -> (String, std::sync::Arc<std::sync::Mutex<String>>) {
        use std::io::{Read, Write};
        use std::sync::{Arc, Mutex};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(String::new()));
        let sink = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = [0u8; 8192];
                let n = Read::read(&mut s, &mut buf).unwrap_or(0);
                *sink.lock().unwrap() = String::from_utf8_lossy(&buf[..n]).to_string();
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(body.as_bytes());
                let _ = s.flush();
            }
        });
        (format!("http://{addr}"), seen)
    }

    #[test]
    fn opencode_session_header_is_sent_only_when_enabled() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (base, seen) = capture_server("{\"data\":[{\"id\":\"m1\"}]}", "application/json");
        let ids = rt
            .block_on(list_models(
                &reqwest::Client::new(),
                "openai",
                &base,
                Some("sk-x"),
                true,
                Some("sid-1"),
            ))
            .unwrap();
        assert_eq!(ids, vec!["m1"]);
        let req = seen.lock().unwrap().to_ascii_lowercase();
        assert!(req.contains("x-opencode-session: sid-1"), "{req}");
        assert!(req.contains("user-agent: diagramon/"), "{req}");

        let (base2, seen2) = capture_server("{\"data\":[{\"id\":\"m2\"}]}", "application/json");
        rt.block_on(list_models(
            &reqwest::Client::new(), "openai", &base2, Some("sk-x"), false, Some("sid-1"),
        ))
        .unwrap();
        let req2 = seen2.lock().unwrap().to_ascii_lowercase();
        assert!(!req2.contains("x-opencode-session"), "{req2}");
    }

    #[test]
    fn stream_chat_carries_the_session_header() {
        let (base, seen) = capture_server(
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n\
             data: [DONE]\n\n",
            "text/event-stream",
        );
        let r = Resolved {
            base_url: base,
            session_header: true,
            session_id: Some("sid-2".into()),
            ..openai()
        };
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (text, _reasoning, _usage) = rt
            .block_on(stream_chat(&reqwest::Client::new(), &r, vec![], &AtomicBool::new(false), |_| {}))
            .unwrap();
        assert_eq!(text, "ok");
        let req = seen.lock().unwrap().to_ascii_lowercase();
        assert!(req.contains("x-opencode-session: sid-2"), "{req}");
    }
}
