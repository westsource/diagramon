//! 云网关响应 → 契约类型的映射。纯函数，无平台依赖。
//!
//! **为什么放 app-core**：装配层（src-tauri）的测试二进制跑不起来（见 Cargo.toml 注释），
//! 而这里恰恰是最需要钉死的地方 —— 服务端是 pydantic 的 camelCase JSON，
//! 字段名一旦漂移（比如 `updatedAt` → `modifiedAt`），客户端会**静默**拿到空串。
//! 下面的测试用例用的是**真实服务端响应的原样片段**（本机起 service 抓的），
//! pydantic 一改字段名，`cargo test` 立刻红。
//!
//! 字段口径的权威来源：`service/app/schemas/__init__.py`（CamelModel 生成 camelCase）。

/// 把用户填的"服务地址"归一化成 **API 根**（自动补 `/v1`）。
///
/// 服务端所有路由都挂在 `/v1` 前缀下（`app.include_router(.., prefix="/v1")`），
/// 但让用户填 `https://host/v1` 太反直觉 —— 填根地址即可，这里统一补；
/// 已带 `/v1` 的不重复（有人从旧配置/文档复制而来）。
pub fn normalize_root(input: &str) -> String {
    input.trim().trim_end_matches('/').to_string()
}

/// 探测候选：官方部署的 API 挂在 `/v1` 下，放第一个；反代直接暴露根路径的
/// 部署放第二个。用户填的地址已带 `/v1` 时不重复。
pub fn api_base_candidates(root: &str) -> Vec<String> {
    let root = normalize_root(root);
    if root.is_empty() {
        return Vec::new();
    }
    if root.ends_with("/v1") {
        return vec![root];
    }
    vec![format!("{root}/v1"), root]
}

/// 首选候选（= 自动探测的第一站）。探测逻辑在 src-tauri/src/cloud.rs。
pub fn normalize_api_base(input: &str) -> String {
    api_base_candidates(input)
        .into_iter()
        .next()
        .unwrap_or_default()
}

use app_ipc::{CloudAccount, CloudAiCredit, CloudDoc, CloudFolder, GatewayModel};

/// 取第一个存在的字符串字段。都不存在 = 空串（**不是**报错 —— 列表项字段可选）。
pub fn str_of(v: &serde_json::Value, keys: &[&str]) -> String {
    for k in keys {
        if let Some(s) = v.get(k).and_then(|x| x.as_str()) {
            return s.to_string();
        }
    }
    String::new()
}

/// 取第一个存在的正整数字段。都不存在 = 0。
pub fn u64_of(v: &serde_json::Value, keys: &[&str]) -> u64 {
    for k in keys {
        if let Some(n) = v.get(k).and_then(|x| x.as_u64()) {
            return n;
        }
    }
    0
}

/// 取第一个存在的有符号整数字段（`depth` 用；取不到 = 0）。
pub fn i64_of(v: &serde_json::Value, keys: &[&str]) -> i64 {
    for k in keys {
        if let Some(n) = v.get(k).and_then(|x| x.as_i64()) {
            return n;
        }
    }
    0
}

/// 取第一个存在的布尔字段。都不存在 = false。
pub fn bool_of(v: &serde_json::Value, keys: &[&str]) -> bool {
    for k in keys {
        if let Some(b) = v.get(k).and_then(|x| x.as_bool()) {
            return b;
        }
    }
    false
}

/// `membership.ai` → AI 权益快照。
///
/// 字段整体缺失、或显式为 `null`（旧服务端）→ `None`。**这不是 `enabled: false`**：
/// "不知道有没有 AI 权益"和"确实没开通"在界面上要能分开，否则老后端会被显示成"未开通"。
pub fn ai_credit_of(membership: &serde_json::Value) -> Option<CloudAiCredit> {
    let ai = membership.get("ai")?;
    if ai.is_null() {
        return None;
    }
    Some(CloudAiCredit {
        enabled: bool_of(ai, &["enabled"]),
        credit_monthly_micros: i64_of(ai, &["creditMonthlyMicros"]),
        credit_used_micros: i64_of(ai, &["creditUsedMicros"]),
        period_start: str_of(ai, &["periodStart"]),
        period_end: str_of(ai, &["periodEnd"]),
    })
}

/// `AuthOut`（login / me 的统一包络）→ 账户快照。**令牌不在这里**（客户端不解析它）。
pub fn account_of(v: &serde_json::Value) -> CloudAccount {
    let user = v.get("user").cloned().unwrap_or(serde_json::Value::Null);
    let membership = v.get("membership").cloned().unwrap_or(serde_json::Value::Null);
    CloudAccount {
        email: str_of(&user, &["email"]),
        display_name: str_of(&user, &["displayName", "name"]),
        role: str_of(&user, &["role"]),
        plan_name: str_of(&membership, &["planName"]),
        used_bytes: u64_of(&membership, &["usedBytes"]),
        quota_bytes: u64_of(&membership, &["quotaBytes"]),
        ai: ai_credit_of(&membership),
    }
}

/// `DocumentListItem` / `DocumentPutOut` → 列表项。`version` 是乐观锁要带回的。
pub fn doc_of(v: &serde_json::Value) -> CloudDoc {
    CloudDoc {
        id: str_of(v, &["id"]),
        name: str_of(v, &["name"]),
        path: str_of(v, &["path"]),
        format: app_ipc::FormatId::from_str_opt(&str_of(v, &["format"]))
            .unwrap_or(app_ipc::FormatId::Mermaid),
        size: u64_of(v, &["size"]),
        updated_at: str_of(v, &["updatedAt"]),
        version: u64_of(v, &["version"]),
    }
}

/// `FolderOut` → 目录节点。
///
/// `documentCount` / `hasChildren` 两个都要：只看文档数，会把"有子目录但自己没文档"
/// 的目录显示成空目录（树里就会少一截）。
pub fn folder_of(v: &serde_json::Value) -> CloudFolder {
    CloudFolder {
        path: str_of(v, &["path"]),
        name: str_of(v, &["name"]),
        depth: i64_of(v, &["depth"]),
        document_count: u64_of(v, &["documentCount"]),
        has_children: bool_of(v, &["hasChildren"]),
        is_explicit: bool_of(v, &["isExplicit"]),
    }
}

/// `GET /v1/ai/models` 的一项（`AiModelOut`）→ 网关模型。
///
/// 字段名是 camelCase（服务端 pydantic 的别名），`maxOutput` 可能缺省（候选没填就是 0）。
pub fn gateway_model_of(v: &serde_json::Value) -> GatewayModel {
    GatewayModel {
        id: str_of(v, &["id"]),
        // 老服务端/空显示名时退回别名 —— 下拉里显示空白行等于这一项点了没反应
        display_name: {
            let n = str_of(v, &["displayName", "display_name"]);
            if n.is_empty() {
                str_of(v, &["id"])
            } else {
                n
            }
        },
        supports_vision: bool_of(v, &["supportsVision", "supports_vision"]),
        max_output: u64_of(v, &["maxOutput", "max_output"]) as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    /// 本机起 service 后 `POST /v1/auth/login` 的**原样片段**（只留映射用得到的分支）。
    const LOGIN_RESPONSE: &str = r#"{
      "user": {"id": "9f1c...", "email": "dev3-e2e@example.com", "phone": null,
               "displayName": "dev3-e2e", "role": "user", "status": "active",
               "emailVerifiedAt": "2026-10-10T23:36:00+00:00", "createdAt": "2026-10-10T23:35:00+00:00"},
      "tokens": {"accessToken": "tok", "expiresIn": 1800, "refreshToken": "r", "refreshExpiresAt": "2026-10-11T23:35:00+00:00"},
      "membership": {"planId": "member", "planName": "会员", "isMember": true, "cloudStorage": true,
                     "expiresAt": null, "quotaBytes": 104857600, "usedBytes": 0,
                     "ai": {"enabled": false, "creditMonthlyMicros": 0, "creditUsedMicros": 0,
                            "periodStart": "2026-10-01T00:00:00+00:00", "periodEnd": "2026-11-01T00:00:00+00:00"}},
      "serverTime": "2026-10-10T23:40:00+00:00"
    }"#;

    /// `GET /v1/documents` 的列表项原样片段。
    const LIST_ITEM: &str = r#"{
      "id": "5f0e2a5c-0000-0000-0000-000000000000", "name": "登录流程.mmd", "path": "",
      "vaultId": "00000000-0000-0000-0000-000000000001", "format": "mermaid",
      "payloadKind": "text", "size": 62, "version": 2,
      "contentHash": "abc", "createdAt": "2026-10-10T23:38:00+00:00",
      "updatedAt": "2026-10-10T23:39:00+00:00"
    }"#;

    /// `PUT /v1/documents/{id}`（新建，201）的原样片段。
    const PUT_RESPONSE: &str = r#"{
      "id": "5f0e2a5c-0000-0000-0000-000000000000", "version": 1,
      "contentHash": "abc", "size": 40,
      "updatedAt": "2026-10-10T23:38:00+00:00",
      "quota": {"usedBytes": 40, "quotaBytes": 104857600},
      "path": "", "vaultId": "00000000-0000-0000-0000-000000000001"
    }"#;

    #[test]
    fn login_response_maps_to_the_account_snapshot() {
        let v: serde_json::Value = serde_json::from_str(LOGIN_RESPONSE).unwrap();
        let a = account_of(&v);
        assert_eq!(a.email, "dev3-e2e@example.com");
        assert_eq!(a.display_name, "dev3-e2e", "取 displayName 不是 name");
        assert_eq!(a.role, "user");
        assert_eq!(a.plan_name, "会员", "取 membership.planName");
        assert_eq!(a.used_bytes, 0);
        assert_eq!(a.quota_bytes, 104857600);
    }

    /// 会员套餐带 AI 权益（`membership.ai.enabled = true`）的原样片段。
    const MEMBERSHIP_WITH_AI: &str = r#"{
      "planId": "member", "planName": "会员", "isMember": true, "cloudStorage": true,
      "expiresAt": "2026-12-31T00:00:00+00:00", "quotaBytes": 1073741824, "usedBytes": 13631488,
      "ai": {"enabled": true, "creditMonthlyMicros": 20000000, "creditUsedMicros": 3200000,
             "periodStart": "2026-10-01T00:00:00+00:00", "periodEnd": "2026-11-01T00:00:00+00:00"}
    }"#;

    #[test]
    fn membership_ai_is_mapped_when_the_plan_has_it() {
        let v = json!({ "user": { "email": "a@b.c" },
                        "membership": serde_json::from_str::<serde_json::Value>(MEMBERSHIP_WITH_AI).unwrap() });
        let a = account_of(&v);
        let ai = a.ai.expect("带 ai 字段的套餐必须映射出权益");
        assert!(ai.enabled);
        assert_eq!(ai.credit_monthly_micros, 20_000_000, "20000000 微信用点 = 20 点");
        assert_eq!(ai.credit_used_micros, 3_200_000, "3200000 微信用点 = 3.2 点");
        assert_eq!(ai.period_end, "2026-11-01T00:00:00+00:00", "周期要给出来，界面才能说'至 X 重置'");
    }

    #[test]
    fn free_plan_reports_ai_disabled_not_unknown() {
        // 服务端 free 套餐也会给 ai 块（enabled=false）—— 那是"确实没开通"
        let v: serde_json::Value = serde_json::from_str(LOGIN_RESPONSE).unwrap();
        let ai = account_of(&v).ai.expect("LOGIN_RESPONSE 里带 ai 块");
        assert!(!ai.enabled, "免费套餐是 enabled=false，但仍是一份已知的权益快照");
    }

    #[test]
    fn missing_ai_block_is_unknown_not_disabled() {
        // 旧服务端不带 ai 字段 ⇒ None（不知道），**不能**当成 enabled:false（没开通）——
        // 否则老后端会被界面显示成"未开通"，那是在说谎。
        let v = json!({"user": {"email": "a@b.c"}, "membership": {"planName": "Free"}});
        assert!(account_of(&v).ai.is_none());
        // 显式 null 同理
        let v2 = json!({"user": {"email": "a@b.c"}, "membership": {"planName": "Free", "ai": null}});
        assert!(account_of(&v2).ai.is_none());
    }

    #[test]
    fn list_item_maps_with_the_version_for_optimistic_locking() {
        let v: serde_json::Value = serde_json::from_str(LIST_ITEM).unwrap();
        let d = doc_of(&v);
        assert_eq!(d.name, "登录流程.mmd");
        assert_eq!(d.format, app_ipc::FormatId::Mermaid);
        assert_eq!(d.version, 2, "版本号是乐观锁的命根子，丢了就永远 409");
        assert_eq!(d.updated_at, "2026-10-10T23:39:00+00:00");
    }

    #[test]
    fn put_response_maps_the_new_version_back() {
        let v: serde_json::Value = serde_json::from_str(PUT_RESPONSE).unwrap();
        let d = doc_of(&v);
        assert_eq!(d.version, 1, "新建回来是版本 1，下次保存带它");
        assert_eq!(d.path, "", "PUT 响应的 path 是空串（根目录）");
    }

    #[test]
    fn missing_fields_become_empty_not_errors() {
        // 列表项字段是可选的：漂移时宁可拿到空串，也不要 panic
        let d = doc_of(&json!({"id": "x"}));
        assert_eq!(d.name, "");
        assert_eq!(d.size, 0);
        assert_eq!(d.version, 0);
        assert_eq!(d.format, app_ipc::FormatId::Mermaid, "不认识的 format 落回 mermaid");
    }

    #[test]
    fn null_membership_does_not_panic() {
        let a = account_of(&json!({"user": null, "membership": null}));
        assert_eq!(a.email, "");
        assert_eq!(a.quota_bytes, 0);
    }

    /// `GET /v1/folders` 的一项原样片段（含"有子目录但自己没文档"那种）。
    const FOLDER_ITEM: &str = r#"{
      "path": "架构/后端", "name": "后端", "depth": 1,
      "documentCount": 2, "hasChildren": true, "isExplicit": true
    }"#;

    #[test]
    fn folder_item_maps_path_name_and_counts() {
        let v: serde_json::Value = serde_json::from_str(FOLDER_ITEM).unwrap();
        let f = folder_of(&v);
        assert_eq!(f.path, "架构/后端");
        assert_eq!(f.name, "后端", "末段名，不含父路径");
        assert_eq!(f.depth, 1);
        assert_eq!(f.document_count, 2);
        assert!(f.has_children, "有子目录必须带出来，否则树少一截");
        assert!(f.is_explicit);
    }

    #[test]
    fn empty_folder_is_distinguishable_from_missing_children() {
        // 空目录：文档 0 + 无子目录 —— 界面靠这两个值把它标成「空」
        let f = folder_of(&json!({"path": "归档", "name": "归档", "depth": 0,
                                  "documentCount": 0, "hasChildren": false, "isExplicit": true}));
        assert_eq!(f.document_count, 0);
        assert!(!f.has_children);
        // 而"有子目录、自己没文档"的目录不能长得一样
        let g = folder_of(&json!({"path": "架构", "name": "架构", "depth": 0,
                                  "documentCount": 0, "hasChildren": true, "isExplicit": false}));
        assert_eq!(g.document_count, 0);
        assert!(g.has_children);
    }

    #[test]
    fn folder_missing_fields_are_empty_not_errors() {
        let f = folder_of(&json!({"path": "x"}));
        assert_eq!(f.name, "");
        assert_eq!(f.depth, 0);
        assert_eq!(f.document_count, 0);
        assert!(!f.has_children);
        assert!(!f.is_explicit);
    }
}

#[cfg(test)]
mod normalize_tests {
    use super::normalize_api_base;

    #[test]
    fn bare_host_gets_v1() {
        assert_eq!(normalize_api_base("https://www.diagramon.com"), "https://www.diagramon.com/v1");
    }

    #[test]
    fn trailing_slash_and_spaces_trimmed() {
        assert_eq!(normalize_api_base("  https://x.com/  "), "https://x.com/v1");
    }

    #[test]
    fn existing_v1_not_duplicated() {
        assert_eq!(normalize_api_base("https://x.com/v1"), "https://x.com/v1");
        assert_eq!(normalize_api_base("https://x.com/v1/"), "https://x.com/v1");
    }

    #[test]
    fn empty_stays_empty() {
        assert_eq!(normalize_api_base("   "), "");
    }
}

#[cfg(test)]
mod gateway_tests {
    use super::*;
    use serde_json::json;

    /// `GET /v1/ai/models` 的真实响应片段（`AiModelListOut`，字段是 camelCase 别名）。
    #[test]
    fn gateway_models_map_from_the_service_response() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"data":[
              {"id":"glm-5.2","displayName":"GLM-5.2","supportsVision":true,"maxOutput":8192},
              {"id":"qwen3-max","displayName":"Qwen3 Max","supportsVision":false,"maxOutput":4096}
            ]}"#,
        )
        .unwrap();
        let items: Vec<_> = v["data"].as_array().unwrap().iter().map(gateway_model_of).collect();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "glm-5.2");
        assert_eq!(items[0].display_name, "GLM-5.2");
        assert!(items[0].supports_vision);
        assert_eq!(items[0].max_output, 8192);
        assert!(!items[1].supports_vision);
        assert_eq!(items[1].max_output, 4096);
    }

    /// 缺显示名时退回别名：下拉里一行空白 = 用户点了也不知道点了什么。
    /// 缺 `maxOutput`/`supportsVision` 也必须能映射（老服务端可能不带这两个键）。
    #[test]
    fn gateway_model_falls_back_to_alias_and_tolerates_missing_keys() {
        let m = gateway_model_of(&json!({"id": "glm-5.2"}));
        assert_eq!(m.display_name, "glm-5.2");
        assert!(!m.supports_vision);
        assert_eq!(m.max_output, 0);
    }

    /// 无权益时服务端回 `data: []`（200，不是 403）—— 映射层不该 panic，也确实一个都不出。
    #[test]
    fn empty_gateway_list_is_not_an_error() {
        let v: serde_json::Value = serde_json::from_str(r#"{"data":[]}"#).unwrap();
        let items: Vec<_> = v["data"].as_array().unwrap().iter().map(gateway_model_of).collect();
        assert!(items.is_empty());
    }
}

#[cfg(test)]
mod candidates_tests {
    use super::api_base_candidates;

    #[test]
    fn v1_first_root_second() {
        assert_eq!(
            api_base_candidates("https://x.com"),
            vec!["https://x.com/v1", "https://x.com"]
        );
    }

    #[test]
    fn dedup_when_v1_given() {
        assert_eq!(api_base_candidates("https://x.com/v1"), vec!["https://x.com/v1"]);
        assert_eq!(api_base_candidates("https://x.com/v1/"), vec!["https://x.com/v1"]);
    }

    #[test]
    fn empty_root_no_candidates() {
        assert!(api_base_candidates("   ").is_empty());
    }
}
