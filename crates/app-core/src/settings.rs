//! 设置读写与「部分更新」合并。
//!
//! 前端只需要发它改动的字段（`settings_patch`），这里负责与磁盘上的完整设置合并；
//! 数组整体替换（models / recent 就是这样语义），对象递归合并（panels / editor / ai）。

use std::path::Path;

use app_ipc::Settings;
use serde_json::Value;

/// 读设置。文件不存在 → 默认值；文件坏了 → 留一份 `.bak` 再回默认值（不静默丢数据）。
pub fn load(path: &Path) -> Settings {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Settings::default();
    };
    match serde_json::from_str::<Settings>(&text) {
        Ok(s) => s,
        Err(_) => {
            let _ = std::fs::rename(path, path.with_extension("json.bak"));
            Settings::default()
        }
    }
}

/// 原子写：先写 `.tmp` 再 rename，避免断电/崩溃留下半截 JSON。
pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 递归合并：对象逐键合并，其它类型（含数组）整体替换。
pub fn merge_json(base: &mut Value, patch: Value) {
    match (base, patch) {
        (Value::Object(base_map), Value::Object(patch_map)) => {
            for (k, v) in patch_map {
                merge_json(base_map.entry(k).or_insert(Value::Null), v);
            }
        }
        (base_slot, patch_val) => *base_slot = patch_val,
    }
}

/// 把补丁应用到设置上（补丁里的 `null` 会被当成"这个键不变"，
/// 因为前端序列化时容易把 `undefined` 变成 `null`）。
pub fn apply_patch(settings: &mut Settings, patch: Value) -> Result<(), String> {
    let pruned = prune_nulls(patch);
    let mut current = serde_json::to_value(&*settings).map_err(|e| e.to_string())?;
    merge_json(&mut current, pruned);
    *settings = serde_json::from_value(current).map_err(|e| format!("设置字段不合法：{e}"))?;
    Ok(())
}

fn prune_nulls(v: Value) -> Value {
    match v {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k, prune_nulls(v)))
                .collect(),
        ),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use app_ipc::{AiIntent, FormatId, PanelPrefs, ViewMode};
    use serde_json::json;

    #[test]
    fn patch_merges_objects_but_replaces_arrays() {
        let mut s = Settings::default();
        s.panels.sidebar = true;
        s.ai.models.push(app_ipc::AiModel {
            id: "m1".into(),
            provider_id: String::new(),
            model: "qwen".into(),
            name: "本地".into(),
            provider: "ollama".into(),
            base_url: "http://localhost:11434".into(),
            max_tokens: Some(4096),
            temperature: 0.7,
            idle_timeout_s: None,
            has_key: false,
            key_hint: String::new(),
        });

        apply_patch(
            &mut s,
            json!({ "panels": { "ai": false }, "theme": "dark", "ai": { "default_model": "m1" } }),
        )
        .unwrap();

        assert_eq!(s.theme, "dark");
        assert!(!s.panels.ai);
        // 同一层没提到的字段必须原样保留 —— 前端补丁最容易在这出错
        assert!(s.panels.sidebar, "未提及的 panels.sidebar 不该被重置");
        assert_eq!(s.panels.sidebar_w, PanelPrefs::default().sidebar_w);
        assert_eq!(s.ai.default_model, "m1");
        assert_eq!(s.ai.models.len(), 1, "未提及的数组应保留");
    }

    #[test]
    fn null_values_are_ignored_so_js_undefined_does_not_wipe_settings() {
        let mut s = Settings::default();
        s.accent = "lotus".into();
        apply_patch(&mut s, json!({ "accent": null, "theme": null })).unwrap();
        assert_eq!(s.accent, "lotus");
        assert_eq!(s.theme, Settings::default().theme);
    }

    #[test]
    fn invalid_enum_value_is_reported_not_swallowed() {
        let mut s = Settings::default();
        let err = apply_patch(&mut s, json!({ "editor": { "default_view": "sideways" } })).unwrap_err();
        assert!(err.contains("设置字段不合法"), "{err}");
    }

    #[test]
    fn round_trip_through_disk() {
        let dir = std::env::temp_dir().join("diagramon-settings-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("settings.json");

        assert_eq!(load(&file).theme, Settings::default().theme, "文件不存在时应给默认值");

        let mut s = Settings::default();
        s.theme = "dark".into();
        s.density = "compact".into();
        s.locale = "en-US".into();
        s.editor.default_view = ViewMode::Source;
        save(&file, &s).unwrap();

        let back = load(&file);
        assert_eq!(back.theme, "dark");
        assert_eq!(back.density, "compact");
        assert_eq!(back.editor.default_view, ViewMode::Source);
    }

    #[test]
    fn corrupted_file_is_moved_aside_and_defaults_are_used() {
        let dir = std::env::temp_dir().join("diagramon-settings-corrupt");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("settings.json");
        std::fs::write(&file, "{ this is not json").unwrap();

        let s = load(&file);
        assert_eq!(s.theme, Settings::default().theme);
        assert!(dir.join("settings.json.bak").exists(), "坏文件应留档，别静默丢掉");
        assert!(!file.exists());
    }

    #[test]
    fn saved_json_is_human_readable() {
        let dir = std::env::temp_dir().join("diagramon-settings-pretty");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("settings.json");
        save(&file, &Settings::default()).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("\n  "), "设置文件应有人读的缩进");
        assert!(text.contains("\"theme\""));
    }

    #[test]
    fn ai_intent_and_format_deserialise_from_frontend_strings() {
        // 前端发的是小写字符串，契约必须认
        assert_eq!(serde_json::from_value::<AiIntent>(json!("vision")).unwrap(), AiIntent::Vision);
        assert_eq!(serde_json::from_value::<AiIntent>(json!("explain")).unwrap(), AiIntent::Explain);
        assert_eq!(serde_json::from_value::<FormatId>(json!("excalidraw")).unwrap(), FormatId::Excalidraw);
    }
}
