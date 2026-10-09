//! 应用设置模型与最近文件维护（纯逻辑，无 IO）。
//!
//! 落盘位置由命令层决定（`%APPDATA%/Diagramon/settings.json` 等），这里只管结构、
//! 合并与「最近文件」的去重/截断/失效剔除。

use std::path::Path;

use serde::{Deserialize, Serialize};

/// 最近文件最多保留条数（与既有客户端一致）。
pub const MAX_RECENT_FILES: usize = 10;

/// 一条最近文件记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    /// 绝对路径（打开时即规范化）。
    pub path: String,
    /// 显示名（文件名）；空则前端回退到路径末段。
    #[serde(default)]
    pub title: String,
    /// 最近一次打开时间（Unix 毫秒）。
    #[serde(default)]
    pub opened_at: u64,
}

/// 应用设置。
///
/// `#[serde(default)]` + 未知字段容忍：老版本写的字段、未来版本新增的字段都不会让读取失败
/// （与既有客户端的 `AppSettings` 一样向前/向后兼容）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// 界面语言码（`en-US` / `zh-CN`）；`None` = 首次启动按系统语言探测。
    pub language: Option<String>,
    /// 编辑器占工作区的比例（0.15 ~ 0.85）。
    pub editor_ratio: Option<f64>,
    /// 启动时自动检查更新。
    pub auto_check_update: bool,
    /// 用户选择跳过的版本号。
    pub skip_version: Option<String>,
    /// 最近一次检查更新的时间（Unix 毫秒）。
    pub last_update_check: u64,
    /// 自定义更新清单地址；`None` = 用内置默认。
    pub update_manifest_url: Option<String>,
    /// 最近打开的文件（最新在前）。
    pub recent_files: Vec<RecentFile>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            language: None,
            editor_ratio: None,
            auto_check_update: true,
            skip_version: None,
            last_update_check: 0,
            update_manifest_url: None,
            recent_files: Vec::new(),
        }
    }
}

impl Settings {
    /// 读取；文件缺失或损坏时返回默认值（损坏不该让应用起不来）。
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// 写入（自动建目录、UTF-8 无 BOM）。
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".into());
        std::fs::write(path, text)
    }

    /// 记一条最近文件：同路径去重（按规范化后的路径）、最新在前、超出上限截断。
    pub fn touch_recent(&mut self, path: &str, title: &str, now_ms: u64) {
        let normalized = normalize(path);
        self.recent_files.retain(|r| normalize(&r.path) != normalized);
        self.recent_files.insert(
            0,
            RecentFile {
                path: normalized,
                title: title.to_string(),
                opened_at: now_ms,
            },
        );
        self.recent_files.truncate(MAX_RECENT_FILES);
    }

    /// 剔除已不存在的文件（在读取时调用一次）。
    pub fn prune_recent(&mut self) {
        self.recent_files.retain(|r| Path::new(&r.path).is_file());
    }
}

/// 路径规范化：统一分隔符并去掉尾随分隔符，仅用于**比较**（不改变用户可见路径）。
fn normalize(path: &str) -> String {
    let trimmed = path.trim().replace('\\', "/");
    trimmed.trim_end_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rf(path: &str) -> String {
        path.to_string()
    }

    #[test]
    fn touch_recent_dedupes_and_moves_to_front() {
        let mut s = Settings::default();
        s.touch_recent(&rf("C:/a/x.mmd"), "x.mmd", 1);
        s.touch_recent(&rf("C:/a/y.mmd"), "y.mmd", 2);
        s.touch_recent(&rf("C:/a/x.mmd"), "x.mmd", 3);

        assert_eq!(s.recent_files.len(), 2, "同路径不应产生两条");
        assert_eq!(s.recent_files[0].path, "C:/a/x.mmd", "最近打开的在最前");
        assert_eq!(s.recent_files[0].opened_at, 3, "时间戳应更新");
        assert_eq!(s.recent_files[1].path, "C:/a/y.mmd");
    }

    #[test]
    fn touch_recent_is_separator_insensitive() {
        let mut s = Settings::default();
        s.touch_recent(&rf("C:\\a\\x.mmd"), "x.mmd", 1);
        s.touch_recent(&rf("C:/a/x.mmd"), "x.mmd", 2);
        assert_eq!(s.recent_files.len(), 1);
    }

    #[test]
    fn touch_recent_caps_at_max() {
        let mut s = Settings::default();
        for i in 0..20 {
            s.touch_recent(&format!("C:/a/f{i}.mmd"), "f", i);
        }
        assert_eq!(s.recent_files.len(), MAX_RECENT_FILES);
        assert_eq!(s.recent_files[0].path, "C:/a/f19.mmd");
    }

    #[test]
    fn prune_recent_drops_missing_files() {
        let mut s = Settings::default();
        s.touch_recent(&rf("C:/definitely/not/here.mmd"), "n", 1);
        s.touch_recent(
            &rf(&std::env::current_exe().unwrap().to_string_lossy()),
            "exe",
            2,
        );
        s.prune_recent();
        assert_eq!(s.recent_files.len(), 1, "不存在的文件应被剔除");
        assert!(s.recent_files[0].path.ends_with(".exe"));
    }

    #[test]
    fn roundtrip_and_tolerate_unknown_fields() {
        let dir = std::env::temp_dir().join(format!("dgm-settings-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("settings.json");

        let mut s = Settings {
            language: Some("zh-CN".into()),
            editor_ratio: Some(0.42),
            skip_version: Some("2.0.1".into()),
            ..Default::default()
        };
        s.touch_recent(&rf("C:/a/x.mmd"), "x", 7);
        s.save(&path).unwrap();

        let back = Settings::load(&path);
        assert_eq!(back, s, "往返应逐字段相等");

        // 未知字段不该让读取失败，也不该丢掉已知字段
        std::fs::write(&path, r#"{"language":"en-US","someFutureField":123}"#).unwrap();
        let parsed = Settings::load(&path);
        assert_eq!(parsed.language.as_deref(), Some("en-US"));
        assert!(parsed.auto_check_update, "缺省字段回落到默认值");

        // 损坏内容回落默认值
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(Settings::load(&path), Settings::default());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
