//! 云网关响应 → 契约类型的映射。纯函数，无平台依赖。
//!
//! **为什么放 app-core**：装配层（src-tauri）的测试二进制跑不起来（见 Cargo.toml 注释），
//! 而这里恰恰是最需要钉死的地方 —— 服务端是 pydantic 的 camelCase JSON，
//! 字段名一旦漂移（比如 `updatedAt` → `modifiedAt`），客户端会**静默**拿到空串。
//! 下面的测试用例用的是**真实服务端响应的原样片段**（本机起 service 抓的），
//! pydantic 一改字段名，`cargo test` 立刻红。
//!
//! 字段口径的权威来源：`service/app/schemas/__init__.py`（CamelModel 生成 camelCase）。

use app_ipc::{CloudAccount, CloudDoc};

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
}
