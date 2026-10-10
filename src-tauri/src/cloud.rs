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
//!
//! 全部 `async` + 返回有意义的值（见 commands.rs 的返回值约定）。

use std::sync::Arc;

use serde_json::{json, Value};

use app_core::cloudmap::{account_of, doc_of, str_of, u64_of};
use app_ipc::{CloudAccount, CloudDoc, CloudDocBody, CloudDocList, CloudStatus, FormatId};
use tauri::State;

use crate::state::{AppState, CLOUD_ACCESS_KEY, CLOUD_REFRESH_KEY};

type R<T> = Result<T, String>;

const ACCESS_KEY_HEADER: &str = "Authorization";

fn base_url(state: &AppState) -> R<String> {
    let url = state.settings().cloud.base_url.trim().trim_end_matches('/').to_string();
    if url.is_empty() {
        return Err("云网关未配置：先在 设置 → 云端 里填服务地址".into());
    }
    Ok(url)
}

async fn access_token(state: &AppState) -> R<String> {
    state
        .creds
        .get(CLOUD_ACCESS_KEY)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "尚未登录云网关".into())
}

/// 一个 HTTP 调用的统一出口：状态码 / 网络 / 协议错误都变成**能看懂的一句话**。
async fn call_json(
    state: &AppState,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    auth: bool,
) -> R<Value> {
    let base = base_url(state)?;
    let url = format!("{base}{path}");
    let mut req = state.http.request(method, &url);
    if auth {
        let token = access_token(state).await?;
        req = req.header(ACCESS_KEY_HEADER, format!("Bearer {token}"));
    }
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("连不上云网关（{url}）：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
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
            let id = uuid::Uuid::new_v4().simple().to_string();
            let patch = json!({ "cloud": { "deviceId": id } });
            let mut s = state.settings().clone();
            app_core::settings::apply_patch(&mut s, patch)?;
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
    let base = base_url(state.inner())?;
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

/// 存一份文档到云端（新建与更新同一入口；`id` 为空 = 由本机生成新 id）。
///
/// `version` 是**乐观锁**：新建传 0（`If-Match: 0` = 仅当不存在时创建）；
/// 更新必须带上次存/取时拿到的版本号 —— 服务端 `If-Match` **省略 = 仅当不存在时创建**，
/// 省略会直接 409（联调实测踩过）。409 的响应体带 `contentHash/updatedAt`，
/// 原样透传给前端，让用户知道"云端已被别的设备改过"。
///
/// 返回服务端分配的 id 与新版本号，前端要记下来供下次保存用。
#[tauri::command]
pub async fn cloud_doc_save(
    state: State<'_, Arc<AppState>>,
    id: String,
    version: u64,
    name: String,
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
    });
    let base = base_url(state.inner())?;
    let url = format!("{base}/documents/{doc_id}");
    let token = access_token(state.inner()).await?;
    let resp = state
        .http
        .request(reqwest::Method::PUT, &url)
        .header(ACCESS_KEY_HEADER, format!("Bearer {token}"))
        .header("If-Match", version.to_string())
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("连不上云网关（{url}）：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
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
