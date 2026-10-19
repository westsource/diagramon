//! 把**外部文件**读成 AI 上下文（拖进对话框 / 手填全路径）。
//!
//! 三件事在这里一次收口（命令层只转发）：
//!
//! * **上限**：单文件 256 KiB。超了就按**字符边界**截断并置 `truncated` —— 界面会如实
//!   标出来，而不是悄悄少给一段，也不是把 50 MB 的 CSV 整个塞进提示词（提示词那边还有
//!   一层总量预算，见 `crates/ai::prompt::FILES_MAX_CHARS`）。
//! * **只收文本**：UTF-8 解不开、或开头就带 NUL 字节（二进制）的一律明确报错，
//!   不把乱码当上下文发出去。
//! * 目录、不存在的路径同样明确报错（"点了没反应"最难排查）。
//!
//! **不做扩展名白名单**：路径是用户自己指定的，用途只是"给模型看"，
//! 白名单只会让 `.conf` / `.log` / 无扩展名的文件被莫名拦住（写入侧才需要白名单，见
//! `commands.rs::EXPORT_EXTS`）。

use std::path::Path;

use app_ipc::AiContextFile;

/// 单个文件的读取上限。超过就截断（`truncated = true`）。
pub const MAX_BYTES: usize = 256 * 1024;

/// 二进制嗅探窗口：只看开头这一段有没有 NUL。
const SNIFF_BYTES: usize = 8 * 1024;

/// 读一个文件作为上下文。
pub fn read(path: &Path) -> Result<AiContextFile, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读不到这个文件：{e}"))?;
    if meta.is_dir() {
        return Err("这是一个目录，不是文件".into());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("读不到这个文件：{e}"))?;
    if bytes.iter().take(SNIFF_BYTES).any(|b| *b == 0) {
        return Err("这不是文本文件（开头就有 NUL 字节）".into());
    }

    let truncated = bytes.len() > MAX_BYTES;
    let slice = &bytes[..bytes.len().min(MAX_BYTES)];
    let text = match std::str::from_utf8(slice) {
        Ok(s) => s.to_string(),
        // 截断点落在半个多字节字符上：取已校验的那一段（这时才允许"末尾不完整"）
        Err(e)
            if truncated && e.error_len().is_none() && e.valid_up_to() + 3 >= slice.len() =>
        {
            std::str::from_utf8(&slice[..e.valid_up_to()])
                .map_err(|_| "不是 UTF-8 文本文件".to_string())?
                .to_string()
        }
        Err(_) => return Err("不是 UTF-8 文本文件（GBK 等编码请先转成 UTF-8）".into()),
    };

    Ok(AiContextFile {
        // 路径统一成正斜杠：身份/去重只认这一种写法（与工作区、文档路径同一口径）
        path: path.to_string_lossy().replace('\\', "/"),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
        text,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("diagramon-context-file-test");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn reads_a_utf8_file_with_name_and_slashes() {
        let f = tmp("需求 说明.md");
        std::fs::write(&f, "# 需求\n\n用 mermaid 画登录流程\n").unwrap();
        let out = read(&f).unwrap();
        assert_eq!(out.name, "需求 说明.md");
        assert_eq!(out.text, "# 需求\n\n用 mermaid 画登录流程\n");
        assert!(!out.truncated);
        assert!(!out.path.contains('\\'), "路径统一成正斜杠：{}", out.path);
    }

    #[test]
    fn oversized_files_are_truncated_on_a_char_boundary() {
        let f = tmp("big.md");
        // 每个汉字 3 字节：正好让第 MAX_BYTES 个字节切在一个汉字中间
        let body = "中".repeat(MAX_BYTES / 3 + 5);
        std::fs::write(&f, &body).unwrap();
        let out = read(&f).unwrap();
        assert!(out.truncated, "超过上限要标出来");
        assert!(out.text.len() <= MAX_BYTES);
        assert!(out.text.chars().all(|c| c == '中'), "截断只能落在字符边界上：{:?}", out.text.chars().last());
        assert!(!out.text.contains('\u{FFFD}'), "不能出现替换字符");
    }

    #[test]
    fn binary_files_are_rejected() {
        let f = tmp("blob.bin");
        std::fs::write(&f, [0x50, 0x4b, 0x03, 0x04, 0x00, 0x11, 0x22]).unwrap();
        let err = read(&f).unwrap_err();
        assert!(err.contains("NUL"), "{err}");
    }

    #[test]
    fn invalid_utf8_is_rejected_with_a_hint() {
        let f = tmp("gbk.txt");
        std::fs::write(&f, [0xd6, 0xd0, 0xce, 0xc4]).unwrap(); // "中文" 的 GBK 编码
        let err = read(&f).unwrap_err();
        assert!(err.contains("UTF-8"), "{err}");
    }

    #[test]
    fn directories_and_missing_paths_are_rejected() {
        let dir = std::env::temp_dir().join("diagramon-context-file-test");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(read(&dir).unwrap_err().contains("目录"));
        assert!(read(&tmp("never-written.md")).unwrap_err().contains("读不到"));
    }

    #[test]
    fn empty_files_are_fine() {
        let f = tmp("empty.md");
        std::fs::write(&f, "").unwrap();
        let out = read(&f).unwrap();
        assert!(out.text.is_empty() && !out.truncated);
    }
}
