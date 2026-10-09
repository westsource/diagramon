//! 崩溃日志：把未处理异常/panic 追加写入 `<cache>/crash.log`。
//!
//! 与既有客户端同语义（`%LOCALAPPDATA%/Diagramon/crash.log`）。抽成纯函数是为了
//! 能脱离 GUI 做单元测试（真实 panic 无法在测试里稳定触发）。

use std::io::Write;
use std::path::{Path, PathBuf};

/// 追加一行到 `<dir>/crash.log`（目录不存在则创建）。返回日志文件路径。
pub fn append(dir: &Path, message: &str) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("crash.log");
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
    writeln!(file, "{message}")?;
    Ok(path)
}

/// 当前 Unix 秒；日志前缀用（避免引入时间库）。
pub fn unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 组装一条崩溃日志行。
pub fn format_entry(message: &str) -> String {
    format!("[unix {}] {message}", unix_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_creates_dir_and_accumulates() {
        let dir = std::env::temp_dir().join(format!("dgm-crash-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let path = append(&dir, "[unix 1] first").unwrap();
        assert!(path.ends_with("crash.log"));
        append(&dir, "[unix 2] second").unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("first") && text.contains("second"), "应追加而不是覆盖");
        assert_eq!(text.lines().count(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn format_entry_has_timestamp_prefix() {
        let line = format_entry("boom");
        assert!(line.starts_with("[unix "), "{line}");
        assert!(line.ends_with("boom"));
    }
}
