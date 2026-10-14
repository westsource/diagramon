//! 云网关客户端：登录、云端文档列表 / 存 / 取 / 删。
//!
//! **令牌永不回前端**：access/refresh 都存凭据库（同 AI 密钥，Windows 上是 DPAPI），
//! 前端只拿账户快照与文档列表。这样"已登录"是一个事实陈述，不是一个可被页面
//! 伪造的状态。
//!
//! 服务端口径（`service/` 仓库，camelCase JSON）：
//!   `POST /auth/login` → `AuthOut{user, tokens, membership}`（`membership` 带存储额度）
//!   `GET  /documents`  → `DocumentListOut{items, hasMore, quota}`
//!   `PUT  /documents/{id}`（**新建与更新同一入口**，`If-Match: 0` = 仅当不存在时创建）
//!   `GET  /documents/{id}` → 内联 content
//!   `DELETE /documents/{id}`
//!   `GET  /folders`    → `FolderListOut{items}`（平铺、不含根）
//!   `POST /folders`    → `FolderOut`（新建**可为空**的目录）
//!   `GET  /ai/models`  → `AiModelListOut{data:[{id, displayName, supportsVision, maxOutput}]}`
//!                        （**按账号权益过滤**；没权益就是 `data: []` + 200，不是 403）
//!   `POST /ai/chat/completions` → OpenAI 兼容 SSE（网关在客户端眼里就是**一个 OpenAI 兼容
//!                        provider**，所以能直接复用 `crates/ai` 的整条流式路径）
//!
//! **令牌续期**：access token 是短命 JWT（服务端默认 30 分钟）。带鉴权的请求收到 401
//! 时用 refresh token 静默换新再重试一次（`authed_send`）；`access_token()` 本身也会在
//! 令牌过期时先续期（覆盖不经过 authed_send 的 AI 网关路径）。服务端口径：
//!   `POST /auth/refresh`（RefreshIn{refreshToken, deviceId}）→ AuthOut，与登录同包络；
//!   **refresh 是轮换制**——每次刷新都吊销旧 refresh token，且重用已吊销的令牌会
//!   吊销整个 family（所有设备登出）⇒ 刷新必须把**新 refreshToken 写回**，
//!   且必须串行（全局锁，见 refresh_tokens）。
//!
//! 全部 `async` + 返回有意义的值（见 commands.rs 的返回值约定）。

use std::sync::Arc;

use serde_json::{json, Value};

use app_core::cloudmap::{
    account_of, doc_of, folder_of, gateway_model_of, jwt_exp_seconds, str_of, u64_of,
    unix_now_seconds,
};
use app_ipc::{
    CloudAccount, CloudDoc, CloudDocBody, CloudDocList, CloudFolder, CloudFolderList, CloudStatus,
    FormatId, GatewayModelList,
};
use tauri::State;

use crate::state::{AppState, CLOUD_ACCESS_KEY, CLOUD_REFRESH_KEY};

type R<T> = Result<T, String>;

const ACCESS_KEY_HEADER: &str = "Authorization";

/// 解析当前应使用的 **API 根**。
///
/// 自动探测（用户要求）：缓存命中（`cloud.api_base` 且仍以当前配置的根开头）直接用；
/// 否则按候选顺序探测 `GET {候选}/config`（公开端点，非 404 = API 在这个前缀下），
/// 命中后持久化到设置，之后不再探测。用户改了 `base_url` 会因前缀不匹配自动重探。
async fn resolve_api_base(state: &AppState) -> R<String> {
    let root = app_core::cloudmap::normalize_root(&state.settings().cloud.base_url);
    if root.is_empty() {
        return Err("云网关未配置：先在 设置 → 云端 里填服务地址".into());
    }
    let cached = state.settings().cloud.api_base.clone();
    if !cached.is_empty() && cached.starts_with(&root) {
        return Ok(cached);
    }
    for cand in app_core::cloudmap::api_base_candidates(&root) {
        let url = format!("{cand}/config");
        let hit = state
            .http
            .get(&url)
            .send()
            .await
            .map(|r| r.status().as_u16() != 404)
            .unwrap_or(false);
        if hit {
            let mut s = state.settings().clone();
            s.cloud.api_base = cand.clone();
            state.persist_settings(&s).map_err(|e| e.to_string())?;
            *state.settings() = s;
            return Ok(cand);
        }
    }
    Err(format!(
        "在 {root} 下没找到 Diagramon API（探测过 /v1 与根路径）——请确认服务地址是否正确"
    ))
}

async fn access_token(state: &AppState) -> R<String> {
    let token = state
        .creds
        .get(CLOUD_ACCESS_KEY)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "尚未登录云网关".to_string())?;
    // access token 是短命 JWT（默认 30 分钟）。**过期就先续期**——
    // 云网关 AI 那条路不经过 authed_send，全靠这里把"拿令牌"做成"保证拿到能用的令牌"。
    // 续不了不在这里报错：把旧令牌交出去，调用方收到 401 后走各自的处理
    // （authed_send 会再试一次续期，AI 对话则如实报 401）。
    if let Some(exp) = jwt_exp_seconds(&token) {
        if exp <= unix_now_seconds() {
            let _ = refresh_tokens(state).await;
            return state
                .creds
                .get(CLOUD_ACCESS_KEY)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "尚未登录云网关".to_string());
        }
    }
    Ok(token)
}


/**
 * 用 refresh token 换一对新令牌（`POST /auth/refresh`），返回新 access token。
 *
 * 服务端有两条**必须遵守**的口径（见 `service/app/services/auth.py::refresh`）：
 *   - **轮换**：每次刷新都把旧 refresh token 置为已吊销（`revoked_at`），新令牌挂回
 *     同一 family —— 所以**必须把返回的新 refreshToken 存回去**，否则下一次刷新
 *     就在用已吊销的令牌，服务端按"重用"处理 → **吊销整个 family**，
 *     用户在所有设备上被登出。
 *   - **重用检测**：因此并发刷新是危险的（后到的请求会撞上刚被吊销的旧令牌）。
 *     用全局锁串行化，且**拿到锁之后再读一次**凭据库 —— 它可能已被别的线程轮换。
 *
 * 还有一条：refresh **绑定设备**（`deviceId` 与登录时不一致 → DEVICE_MISMATCH），
 * 所以这里带的是登录时持久化的 `cloud.device_id`。
 */
async fn refresh_tokens(state: &AppState) -> R<String> {
    // 跨 .await 持有 ⇒ 必须用 tokio 的异步锁（std MutexGuard 不是 Send，
    // 而 tauri 的 async command 要求 future 是 Send —— 编译器会直接拦下）。
    static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = REFRESH_LOCK.lock().await;

    let refresh = state
        .creds
        .get(CLOUD_REFRESH_KEY)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "登录已过期，请重新登录".to_string())?;
    let device_id = state.settings().cloud.device_id.trim().to_string();
    if device_id.is_empty() {
        return Err("登录已过期，请重新登录".into());
    }
    let body = json!({ "refreshToken": refresh, "deviceId": device_id });
    // 续期请求**自己发**，不经过 call_json/authed_send —— 这不是偷懒：
    // call_json → authed_send → access_token → refresh_tokens 会构成 async 递归环
    // （E0733），而且"续期调用绝不能再触发续期"本来就该是**结构性**的不变量，
    // 不是靠 auth=false 参数在运行时小心维持的。
    let base = resolve_api_base(state).await?;
    let url = format!("{base}/auth/refresh");
    let resp = state
        .http
        .request(reqwest::Method::POST, &url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("连不上云网关（{url}）：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("message")
                    .or_else(|| v.get("detail"))
                    .and_then(|m| m.as_str().map(|s| s.to_string()))
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("云网关 {status}：{detail}"));
    }
    let v = serde_json::from_str::<Value>(&text)
        .map_err(|e| format!("云网关响应不是合法 JSON：{e}"))?;

    let tokens = v.get("tokens").cloned().unwrap_or(Value::Null);
    let access = str_of(&tokens, &["accessToken"]);
    let new_refresh = str_of(&tokens, &["refreshToken"]);
    if access.is_empty() {
        return Err("云网关没有返回新令牌".into());
    }
    state.creds.set(CLOUD_ACCESS_KEY, &access).map_err(|e| e.to_string())?;
    // 新 refresh token **必须**写回（见上面的轮换口径）
    if !new_refresh.is_empty() {
        state.creds.set(CLOUD_REFRESH_KEY, &new_refresh).map_err(|e| e.to_string())?;
    }
    Ok(access)
}

/**
 * 发一次**带鉴权**的请求；收到 401 时用 refresh token 静默续期，再试一次。
 *
 * 返回原始的 (status, body) —— **错误语义由调用方解释**：call_json 管 JSON
 * 错误体，cloud_doc_save 要把 409 响应里的 contentHash/updatedAt 原样透传给
 * 前端（那是"云端已被别的设备改过"的冲突现场），所以这里不做任何包装。
 *
 * 续期失败（没有 refresh token / 服务端拒绝）就把一句用户能懂的话交出去，
 * 不再重试 —— 服务端已经明确说了"这个会话续不下去"。
 */
async fn authed_send(
    state: &AppState,
    method: reqwest::Method,
    url: &str,
    body: Option<&Value>,
    extra_headers: &[(&str, String)],
) -> R<(reqwest::StatusCode, String)> {
    let mut token = Some(access_token(state).await?);
    let mut refreshed = false;
    loop {
        let mut req = state.http.request(method.clone(), url);
        if let Some(t) = &token {
            req = req.header(ACCESS_KEY_HEADER, format!("Bearer {t}"));
        }
        for (k, v) in extra_headers {
            req = req.header(*k, v);
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| format!("连不上云网关（{url}）：{e}"))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        // 401 = access token 过期/被吊销。只重试一次：续期成功就用新令牌重发；
        // 续不下去说明 refresh token 也死了，重试只会得到同样的 401。
        if status.as_u16() == 401 && !refreshed {
            refreshed = true;
            match refresh_tokens(state).await {
                Ok(t) => {
                    token = Some(t);
                    continue;
                }
                Err(_) => return Err("登录已过期，请重新登录（活动栏「账户」）".into()),
            }
        }
        return Ok((status, text));
    }
}

/// 一个 HTTP 调用的统一出口：状态码 / 网络 / 协议错误都变成**能看懂的一句话**。
async fn call_json(
    state: &AppState,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    auth: bool,
) -> R<Value> {
    let base = resolve_api_base(state).await?;
    let url = format!("{base}{path}");
    let (status, text) = if auth {
        // 带鉴权的走 authed_send：401 会先静默续期一次
        authed_send(state, method, &url, body.as_ref(), &[]).await?
    } else {
        // 不带鉴权的（登录 / 续期 / 登出）原样发 —— 续期调用绝不能再走续期路径
        let mut req = state.http.request(method, &url);
        if let Some(b) = &body {
            req = req.json(b);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| format!("连不上云网关（{url}）：{e}"))?;
        (resp.status(), resp.text().await.unwrap_or_default())
    };
    if !status.is_success() {
        // 服务端的错误体带 code/message；取不到就把状态码原样交出来
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("message")
                    .or_else(|| v.get("detail"))
                    .and_then(|m| m.as_str().map(|s| s.to_string()))
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("云网关 {status}：{detail}"));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str::<Value>(&text).map_err(|e| format!("云网关响应不是合法 JSON：{e}"))
}

/* ------------------------------------------------------------------ 命令 */

/// 登录。成功后 access/refresh 进凭据库，返回**账户快照**（不含令牌）。
#[tauri::command]
pub async fn cloud_login(
    state: State<'_, Arc<AppState>>,
    email: String,
    password: String,
) -> R<CloudAccount> {
    // base_url 的检查在 call_json 里做（登录也要先有一个网关地址）
    // 设备标识：首登生成一次并持久化，服务端用它识别这台机器的会话
    let device_id = {
        let s = state.settings();
        if s.cloud.device_id.trim().is_empty() {
            None
        } else {
            Some(s.cloud.device_id.clone())
        }
    };
    let device_id = match device_id {
        Some(id) => id,
        None => {
            // 首登生成一次并持久化。**直接改结构体字段，不手写 JSON 补丁** ——
            // 2026-10-15 的 bug 就是这么来的：这里曾经 `apply_patch(json!({"cloud":
            // {"deviceId": id}}))`，而 settings.json 的字段是 `device_id`（snake_case），
            // 补丁键对不上就被 `apply_patch` 当未知键**静默忽略** ⇒ device_id 永远是空的
            // ⇒ 30 分钟后 access token 一过期就续不了（`/auth/refresh` 绑定设备，
            // 空 deviceId → DEVICE_MISMATCH）⇒ 用户看到的是"登录过，下次启动还是未登录"。
            // 走类型化赋值就不可能再写错键名。
            let id = uuid::Uuid::new_v4().simple().to_string();
            let mut s = state.settings().clone();
            s.cloud.device_id = id.clone();
            state.persist_settings(&s)?;
            *state.settings() = s;
            id
        }
    };

    let body = json!({
        "email": email.trim(),
        "password": password,
        "device": {
            "deviceId": device_id,
            "name": "Diagramon",
            "os": std::env::consts::OS,
            "appVersion": env!("CARGO_PKG_VERSION"),
        }
    });
    let v = call_json(state.inner(), reqwest::Method::POST, "/auth/login", Some(body), false).await?;

    let tokens = v.get("tokens").cloned().unwrap_or(Value::Null);
    let access = str_of(&tokens, &["accessToken"]);
    let refresh = str_of(&tokens, &["refreshToken"]);
    if access.is_empty() {
        return Err("云网关没有返回令牌".into());
    }
    state
        .creds
        .set(CLOUD_ACCESS_KEY, &access)
        .map_err(|e| e.to_string())?;
    if !refresh.is_empty() {
        state
            .creds
            .set(CLOUD_REFRESH_KEY, &refresh)
            .map_err(|e| e.to_string())?;
    }

    Ok(account_of(&v))
}

/// 退出登录。
///
/// 服务端的 `/auth/logout` 靠请求体里的 **refreshToken** 吊销整个会话族 ——
/// 不带它就是个幂等空操作（联调实测：logout 后 access token 仍活到过期）。
/// access token 本身是短命 JWT（默认 30 分钟），服务端不吊销，这是标准 JWT 语义。
///
/// 吊销失败不拦着清本地令牌 —— 用户要的是"退出"，不是"服务端确认退出"。
#[tauri::command]
pub async fn cloud_logout(state: State<'_, Arc<AppState>>) -> R<bool> {
    let refresh = state.creds.get(CLOUD_REFRESH_KEY).map_err(|e| e.to_string())?;
    if let Some(rt) = refresh {
        let body = json!({ "refreshToken": rt });
        let _ = call_json(state.inner(), reqwest::Method::POST, "/auth/logout", Some(body), false).await;
    }
    state.creds.delete(CLOUD_ACCESS_KEY).map_err(|e| e.to_string())?;
    state.creds.delete(CLOUD_REFRESH_KEY).map_err(|e| e.to_string())?;
    Ok(true)
}

/// 云端状态。登录着就去 `/auth/me` 拿一份新的账户快照（顺手校验令牌还有效）。
#[tauri::command]
pub async fn cloud_status(state: State<'_, Arc<AppState>>) -> R<CloudStatus> {
    let base = resolve_api_base(state.inner()).await?;
    let signed_in = state
        .creds
        .get(CLOUD_ACCESS_KEY)
        .map_err(|e| e.to_string())?
        .is_some();
    let account = if signed_in {
        match call_json(state.inner(), reqwest::Method::GET, "/auth/me", None, true).await {
            Ok(v) => Some(account_of(&v)),
            // 令牌失效是很常见的（过期/换密码）：如实报"掉线了"，别假装还登录着
            Err(_) => None,
        }
    } else {
        None
    };
    let signed_in = account.is_some();
    Ok(CloudStatus { signed_in, base_url: base, account })
}

/// 云文档列表。
#[tauri::command]
pub async fn cloud_docs_list(state: State<'_, Arc<AppState>>) -> R<CloudDocList> {
    let v = call_json(state.inner(), reqwest::Method::GET, "/documents?limit=100", None, true).await?;
    let mut items = Vec::new();
    if let Some(arr) = v.get("items").and_then(|x| x.as_array()) {
        for it in arr {
            items.push(doc_of(it));
        }
    }
    let quota = v.get("quota").cloned().unwrap_or(Value::Null);
    Ok(CloudDocList {
        has_more: v.get("hasMore").and_then(|x| x.as_bool()).unwrap_or(false),
        used_bytes: u64_of(&quota, &["usedBytes"]),
        quota_bytes: u64_of(&quota, &["quotaBytes"]),
        items,
    })
}

/// 云端目录全集（`GET /v1/folders`）—— 平铺返回，**不含根**（根由前端补）。
///
/// 为什么必须有它：`cloud_docs_list` 只在文档项里带 `path`，**空目录根本不会出现**，
/// 树就建不起来（缺一层、空目录看不见）。服务端的 folders 路由是"显式目录 ∪ 文档路径隐含的目录"，
/// 正是建树需要的那份全集。
#[tauri::command]
pub async fn cloud_folders(state: State<'_, Arc<AppState>>) -> R<CloudFolderList> {
    let v = call_json(state.inner(), reqwest::Method::GET, "/folders", None, true).await?;
    let mut items = Vec::new();
    if let Some(arr) = v.get("items").and_then(|x| x.as_array()) {
        for it in arr {
            items.push(folder_of(it));
        }
    }
    Ok(CloudFolderList { items })
}

/// 新建目录（**可以是空的**）。路径已存在（显式或文档隐含）→ 服务端 409 `name_taken`。
///
/// 错误原样透传（`call_json` 已把服务端 message 摘出来）—— 客户端不复刻服务端的路径规则。
#[tauri::command]
pub async fn cloud_folder_create(state: State<'_, Arc<AppState>>, path: String) -> R<CloudFolder> {
    let body = json!({ "path": path.trim() });
    let v = call_json(state.inner(), reqwest::Method::POST, "/folders", Some(body), true).await?;
    // 新建时目标目录必然为空（建之前它不在目录全集里），服务端也这么回；仍以响应为准
    Ok(folder_of(&v))
}

/// 存一份文档到云端（新建与更新同一入口；`id` 为空 = 由本机生成新 id）。
///
/// `version` 是**乐观锁**：新建传 0（`If-Match: 0` = 仅当不存在时创建）；
/// 更新必须带上次存/取时拿到的版本号 —— 服务端 `If-Match` **省略 = 仅当不存在时创建**，
/// 省略会直接 409（联调实测踩过）。409 的响应体带 `contentHash/updatedAt`，
/// 原样透传给前端，让用户知道"云端已被别的设备改过"。
///
/// `path` 是目标目录（`""` = 根）：服务端口径是 **null/省略 = 原地不动**，
/// 所以这里始终显式给值 —— 前端"保存到云端"选了哪个目录就落到哪个目录。
///
/// 返回服务端分配的 id 与新版本号，前端要记下来供下次保存用。
#[tauri::command]
pub async fn cloud_doc_save(
    state: State<'_, Arc<AppState>>,
    id: String,
    version: u64,
    name: String,
    path: String,
    format: String,
    body: String,
) -> R<CloudDoc> {
    let doc_id = if id.trim().is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        id.trim().to_string()
    };
    let payload = json!({
        "name": name,
        "format": format,
        "payloadKind": "text",
        "content": body,
        "size": body.len(),
        "path": path.trim(),
    });
    let base = resolve_api_base(state.inner()).await?;
    let url = format!("{base}/documents/{doc_id}");
    // 走 authed_send：401 会先静默续期再重试。**错误格式保持原样** ——
    // 409 的响应体带 contentHash/updatedAt，前端靠它提示"云端已被别的设备改过"，
    // 所以这里不能用 call_json（它会把错误体归约成一句 message）。
    let (status, text) = authed_send(
        state.inner(),
        reqwest::Method::PUT,
        &url,
        Some(&payload),
        &[("If-Match", version.to_string())],
    )
    .await?;
    if !status.is_success() {
        return Err(format!("云网关 {status}：{}", text.chars().take(300).collect::<String>()));
    }
    let v = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
    let saved_id = {
        let got = str_of(&v, &["id"]);
        if got.is_empty() { doc_id.clone() } else { got }
    };
    Ok(CloudDoc {
        id: saved_id,
        name,
        path: str_of(&v, &["path"]),
        format: FormatId::from_str_opt(&format).unwrap_or(FormatId::Mermaid),
        size: body.len() as u64,
        updated_at: str_of(&v, &["updatedAt"]),
        version: u64_of(&v, &["version"]),
    })
}

/// 取一份云文档的正文。
#[tauri::command]
pub async fn cloud_doc_open(state: State<'_, Arc<AppState>>, id: String) -> R<CloudDocBody> {
    let v = call_json(
        state.inner(),
        reqwest::Method::GET,
        &format!("/documents/{}", id.trim()),
        None,
        true,
    )
    .await?;
    Ok(CloudDocBody {
        id: str_of(&v, &["id"]),
        name: str_of(&v, &["name"]),
        format: FormatId::from_str_opt(&str_of(&v, &["format"])).unwrap_or(FormatId::Mermaid),
        body: str_of(&v, &["content"]),
        version: u64_of(&v, &["version"]),
    })
}

#[tauri::command]
pub async fn cloud_doc_delete(state: State<'_, Arc<AppState>>, id: String) -> R<bool> {
    call_json(
        state.inner(),
        reqwest::Method::DELETE,
        &format!("/documents/{}", id.trim()),
        None,
        true,
    )
    .await?;
    Ok(true)
}

/* --------------------------------------------------------------- 云网关 AI */

/// 云网关的**可用模型别名**（`GET /v1/ai/models`）。
///
/// 登录后才有；无 AI 权益时服务端回 `200 + data: []`（**不是 403**），
/// 所以空列表是**正常结果**，前端要按"当前账号没有可用别名"呈现，而不是报错。
#[tauri::command]
pub async fn ai_gateway_models(state: State<'_, Arc<AppState>>) -> R<GatewayModelList> {
    let v = call_json(state.inner(), reqwest::Method::GET, "/ai/models", None, true).await?;
    let mut items = Vec::new();
    if let Some(arr) = v.get("data").and_then(|x| x.as_array()) {
        for it in arr {
            items.push(gateway_model_of(it));
        }
    }
    Ok(GatewayModelList { items })
}

/// 把网关**别名**解析成一次对话所需的 `Resolved`。
///
/// 这里每个参数都是**推导**出来的，用户没填过任何一项：
///   - `base_url` = `{api_base}/ai`；`endpoint()` 再补 `/chat/completions`，
///     与服务端权威路径 `/v1/ai/chat/completions` 对上（客户端填到 `…/v1/ai` 就够）；
///   - `api_key` = **当前 access token，现取现用**：短命 JWT（默认 30 分钟）、
///     不落进设置、不进前端（同 BYOK 密钥的规矩）；
///   - `max_tokens` / `temperature` 一律 `None`：服务端按"所选候选 × 档位"自己钳，
///     客户端填数只会把档位允许的长回答截短（见 `ai::Resolved` 的注释）。
pub async fn gateway_resolved(state: &AppState, alias: &str) -> R<ai::Resolved> {
    let alias = alias.trim();
    if alias.is_empty() {
        return Err("云网关模型别名为空".into());
    }
    let base = resolve_api_base(state).await?;
    let token = access_token(state).await?;
    Ok(ai::Resolved {
        provider: "openai".into(),
        base_url: format!("{base}/ai"),
        model: alias.to_string(),
        api_key: Some(token),
        max_tokens: None,
        temperature: None,
    })
}
