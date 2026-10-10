//! 位图裁剪与 PNG 编码 —— 纯函数，无平台依赖。
//!
//! 为什么放 `app-core`：这些是**算法**（坐标夹取、像素搬移、字节编码），
//! 不是平台调用。而装配层（src-tauri）的测试二进制链上 tauri/wry 之后
//! 启动即 `STATUS_ENTRYPOINT_NOT_FOUND`（WebView2 的 DLL 不在 deps 目录旁），
//! 根本跑不起来 —— 所以凡是想被单测钉住的，都必须下沉到这一层。

use image::RgbaImage;

/// 按物理像素裁剪。矩形越界就**夹到图内**，不是报错 ——
/// overlay 上的量测与真实像素之间有舍入，别让 1px 的偏差变成一次失败。
pub fn crop(img: &RgbaImage, x: u32, y: u32, w: u32, h: u32) -> Option<RgbaImage> {
    if w == 0 || h == 0 {
        return None; // 空选区是调用方的 bug，如实退回去
    }
    let (iw, ih) = (img.width(), img.height());
    if iw == 0 || ih == 0 {
        return None;
    }
    let x = x.min(iw.saturating_sub(1));
    let y = y.min(ih.saturating_sub(1));
    let w = w.min(iw.saturating_sub(x));
    let h = h.min(ih.saturating_sub(y));
    Some(image::imageops::crop_imm(img, x, y, w, h).to_image())
}

/// RGBA → PNG 的 base64（带 dataURL 前缀，前端 `<img>` 直接能用）。
pub fn png_data_url(img: &RgbaImage) -> Result<String, String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败：{e}"))?;
    use base64::Engine as _;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(buf.get_ref())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_pixel(w, h, image::Rgba([10u8, 20, 30, 255]))
    }

    #[test]
    fn crop_keeps_the_requested_size_when_it_fits() {
        let img = solid(100, 80);
        let out = crop(&img, 10, 10, 20, 15).expect("正常矩形");
        assert_eq!((out.width(), out.height()), (20, 15));
    }

    #[test]
    fn crop_clamps_to_the_image_instead_of_panicking() {
        let img = solid(100, 80);
        let out = crop(&img, 500, 500, 10, 10).expect("越界要夹取，不是失败");
        assert_eq!((out.width(), out.height()), (1, 1), "500,500 越界后只剩右下角 1×1");
    }

    #[test]
    fn crop_clamps_size_when_it_runs_past_the_edge() {
        let img = solid(100, 80);
        let out = crop(&img, 90, 70, 50, 50).expect("部分越界");
        assert_eq!((out.width(), out.height()), (10, 10), "伸出图外的部分被夹掉");
    }

    #[test]
    fn empty_rect_is_rejected_not_silently_zeroed() {
        let img = solid(10, 10);
        assert!(crop(&img, 0, 0, 0, 0).is_none(), "空选区要退回去");
        assert!(crop(&img, 0, 0, 5, 0).is_none());
    }

    #[test]
    fn png_round_trip_preserves_pixels_and_alpha() {
        let img = solid(4, 4);
        let png = png_data_url(&img).unwrap();
        assert!(png.starts_with("data:image/png;base64,"), "必须带前缀，前端直接能用");
        let b64 = png.rsplit(',').next().unwrap();
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        let back = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!(back.get_pixel(0, 0).0, [10, 20, 30, 255]);
    }
}
