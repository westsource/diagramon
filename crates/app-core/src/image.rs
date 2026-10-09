//! 位图导出的纯逻辑：解析前端传来的 `data:` URL。
//!
//! 放在 app-core 而不是命令层，是为了能脱离 GUI 做单元测试（命令层所在的
//! `diagramon` crate 关掉了测试夹具，见 `src-tauri/Cargo.toml` 的说明）。

use app_ipc::{codes, ApiError};

/// 解析 `data:<mime>;base64,<payload>`，返回 (mime, 字节)。
pub fn decode_data_url(data_url: &str) -> Result<(String, Vec<u8>), ApiError> {
    use base64::Engine as _;

    let rest = data_url
        .strip_prefix("data:")
        .ok_or_else(|| ApiError::new(codes::IO, "不是合法的 data URL"))?;
    let (meta, payload) = rest
        .split_once(',')
        .ok_or_else(|| ApiError::new(codes::IO, "data URL 缺少 ,"))?;
    let mime = meta.split(';').next().unwrap_or("image/png").to_string();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| ApiError::new(codes::IO, format!("图片解码失败: {e}")))?;
    Ok((mime, bytes))
}

/// 由 MIME 推断图片扩展名（导出对话框用）。
pub fn extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        _ => "png",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_1PX: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    #[test]
    fn decodes_png_data_url() {
        let (mime, bytes) = decode_data_url(PNG_1PX).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "PNG 魔数");
        assert_eq!(extension_for_mime(&mime), "png");
    }

    #[test]
    fn decodes_jpeg_mime_and_extension() {
        let url = "data:image/jpeg;base64,/9j/4A==";
        let (mime, bytes) = decode_data_url(url).unwrap();
        assert_eq!(mime, "image/jpeg");
        assert_eq!(extension_for_mime(&mime), "jpg");
        assert_eq!(&bytes[..3], &[0xFF, 0xD8, 0xFF]);
    }

    #[test]
    fn rejects_malformed() {
        assert!(decode_data_url("http://example.com/x.png").is_err());
        assert!(decode_data_url("data:image/png;base64").is_err());
        assert!(decode_data_url("data:image/png;base64,!!!not-base64!!!").is_err());
    }
}
