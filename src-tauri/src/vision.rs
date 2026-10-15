//! 识图的屏幕截屏 + 原生剪贴板写图。
//!
//! **流程**（为什么是"冻结帧"而不是直接在屏幕上框）：
//!   1. `vision_capture_start` 把鼠标所在的那块屏截成一张 PNG 存进内存，
//!      并在它上面开一个无边框、置顶、贴满整屏的 overlay 窗口；
//!   2. overlay 页面把这张图**当成背景**整幅铺开 —— 用户拖出的矩形是在"图"上量，
//!      不是在"屏幕"上量，量完乘一个已知比例（`image.width / css.width`）换回物理像素；
//!      这样 DPI 虚拟化、缩放、多屏坐标偏移全都不用碰。
//!   3. `vision_crop` 用缓存的原图裁剪（**不再截第二次** —— 屏幕上的弹窗、
//!      鼠标光标在第二次截图时已经变了），关掉 overlay，把结果推回主窗口。
//!
//! 取舍（如实记录）：只截**鼠标所在的那块屏**。跨屏一次框选要开 N 个
//! overlay 窗口并在矩形跨越边界时合并，收益配不上复杂度。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use app_ipc::{events, MonitorInfo, VisionFrame, VisionRect};
use base64::Engine as _;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use xcap::Monitor;

use crate::state::AppState;

type R<T> = Result<T, String>;

/// 冻结帧缓存：monitor id → (元信息, 原图)。框选期间有效，收尾即清。
///
/// 内部就是一把 `Mutex`：同一时刻最多一场框选，用 `HashMap` 只是给"换个屏重截"
/// 留个口子。取的时候永远拿"当前那一份"（`iter().next()`），不按 id 找 ——
/// overlay 页面不该知道显示器 id 这种细节。
pub struct Frames(Mutex<HashMap<String, (MonitorInfo, image::RgbaImage)>>);

impl Frames {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, (MonitorInfo, image::RgbaImage)>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/* ------------------------------------------------------------------ 显示器 */

fn enumerate() -> R<Vec<(MonitorInfo, Monitor)>> {
    let all = Monitor::all().map_err(|e| format!("枚举显示器失败：{e}"))?;
    let mut out = Vec::new();
    for (i, m) in all.into_iter().enumerate() {
        let id = format!("m{i}");
        let (w, h) = (
            m.width().map_err(|e| e.to_string())?,
            m.height().map_err(|e| e.to_string())?,
        );
        if w == 0 || h == 0 {
            continue;
        }
        let info = MonitorInfo {
            id,
            name: m.name().unwrap_or_else(|_| "Display".into()),
            width: w,
            height: h,
            x: m.x().unwrap_or(0),
            y: m.y().unwrap_or(0),
            scale: m.scale_factor().unwrap_or(1.0) as f32,
            is_primary: m.is_primary().unwrap_or(false),
        };
        out.push((info, m));
    }
    if out.is_empty() {
        return Err("一块可用的屏幕都没找到".into());
    }
    Ok(out)
}

#[tauri::command]
pub fn monitors_list() -> R<Vec<MonitorInfo>> {
    Ok(enumerate()?.into_iter().map(|(i, _)| i).collect())
}

/* ------------------------------------------------------------------ 冻结帧 */

/// 开始一次框选：截下鼠标所在的那块屏，开 overlay。
///
/// **必须是 `async`**：同步命令跑在**主线程**上，而 `WebviewWindowBuilder::build()`
/// 是"把请求丢进事件循环、然后阻塞等结果"（tauri-runtime-wry 的 `create_tao_window`
/// 里就是 `rx.recv()`）—— 主线程自己等自己 ⇒ 死锁。
///
/// 实测症状（2026-10-15 用户报的"点截取屏幕区域识别后整个屏幕变白、也没法截屏"）：
/// overlay 窗口的**空框**出现了（无边框、置顶、铺满整屏），但它上面的 WebView 永远
/// 建不出来 ⇒ 整块屏停在 WebView2 的默认白底上；页面没跑起来 ⇒ 拖拽/Enter/Esc 全无反应，
/// 同时主窗口也失去响应（invoke 永不结算，只能杀进程）。`async` 之后 Tauri 把它扔到
/// 工作线程，主线程空出来处理建窗消息，两个问题一起消失。
#[tauri::command]
pub async fn vision_capture_start(app: AppHandle, state: State<'_, Arc<AppState>>) -> R<()> {
    // 鼠标在哪块屏上，就截哪块 —— 比起"默认主屏"，这更符合"我看着哪块就框哪块"
    let (mx, my) = cursor_pos();
    let all = enumerate()?;
    let picked = all
        .iter()
        .find(|(i, _)| mx >= i.x && mx < i.x + i.width as i32 && my >= i.y && my < i.y + i.height as i32)
        .or_else(|| all.iter().find(|(i, _)| i.is_primary))
        .or_else(|| all.first())
        .ok_or_else(|| "找不到可截取的屏幕".to_string())?;

    let (info, monitor) = (picked.0.clone(), &picked.1);
    let img = monitor.capture_image().map_err(|e| format!("截屏失败：{e}"))?;

    state.vision.lock().insert(info.id.clone(), (info.clone(), img));

    // 开窗失败就别把冻结帧留在缓存里：它已经不是"正在进行的框选"了
    if let Err(e) = open_overlay(&app, &info) {
        state.vision.lock().clear();
        return Err(e);
    }
    Ok(())
}

fn open_overlay(app: &AppHandle, info: &MonitorInfo) -> R<()> {
    // 已开着就先复用（避免连按两次快捷键叠出两个 overlay）
    if let Some(w) = app.get_webview_window("vision-overlay") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    // 物理像素 → 逻辑坐标：窗口必须正好盖满那块屏
    let scale = if info.scale > 0.0 { info.scale } else { 1.0 };
    let mut builder = WebviewWindowBuilder::new(
        app,
        "vision-overlay",
        WebviewUrl::App("capture.html".into()),
    )
    .title("Diagramon 截屏")
    .position(info.x as f64 / scale as f64, info.y as f64 / scale as f64)
    .inner_size(info.width as f64 / scale as f64, info.height as f64 / scale as f64)
    .decorations(false)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .focused(true)
    // 先建不显示、建完再 show：万一 webview 建不出来（见下面的参数坑），
    // 留下的就只是一个**看不见**的孤儿窗口，而不是一块盖满整屏、又关不掉的纯白。
    .visible(false)
    // capture.html 的底色（#101314）。页面首帧之前 WebView2 露的是自己的默认白底 ——
    // 一整屏白闪正是"点一下整个屏幕就白了"里最刺眼的那一下。
    .background_color(tauri::window::Color(0x10, 0x13, 0x14, 0xFF));

    // **必须与主窗口逐字一致**：wry 是"每个 webview 各建一次 WebView2 环境"
    // （wry-0.57 src/webview2/mod.rs::create_environment），而同一个 user data dir 上
    // 第二次建环境时**参数必须完全相同**，否则 CreateCoreWebView2EnvironmentWithOptions
    // 直接回 ERROR_INVALID_STATE(0x8007139F)。自检/调试跑法只给主窗口挂了参数、overlay
    // 没挂 ⇒ overlay 的 webview 永远建不出来（真机实测：报"开框选窗口失败：failed to
    // create webview: WebView2 error: WindowsError(0x8007139F)"）。
    if let Some(args) = crate::debug_browser_args() {
        builder = builder.additional_browser_args(&args);
    }

    let w = builder.build().map_err(|e| format!("开框选窗口失败：{e}"))?;
    let _ = w.show();
    let _ = w.set_focus();
    Ok(())
}

/// 当前鼠标的**物理**像素坐标（与 MonitorInfo.x/y 同一套坐标系）。
#[cfg(windows)]
fn cursor_pos() -> (i32, i32) {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT { x: 0, y: 0 };
    // 失败就落在 (0,0)：主屏总比报错好
    let _ = unsafe { GetCursorPos(&mut p) };
    (p.x, p.y)
}

#[cfg(not(windows))]
fn cursor_pos() -> (i32, i32) {
    (0, 0)
}

/// 把当前冻结帧交给 overlay 页面。
#[tauri::command]
pub fn vision_frame(state: State<'_, Arc<AppState>>) -> R<VisionFrame> {
    let frames = state.vision.lock();
    let (_, (info, img)) = frames.iter().next().ok_or_else(|| "没有正在进行的截屏".to_string())?;
    Ok(VisionFrame {
        monitor: info.clone(),
        data_url: to_data_url(img)?,
    })
}

/// 框选完成：按物理像素从缓存原图裁剪，关 overlay，结果推回主窗口。
#[tauri::command]
pub fn vision_crop(app: AppHandle, state: State<'_, Arc<AppState>>, rect: VisionRect) -> R<()> {
    let crop = {
        let frames = state.vision.lock();
        let Some((_, (_, img))) = frames.iter().next() else {
            return Err("没有正在进行的截屏".into());
        };
        crop_image(img, rect)?
    };
    close_overlay(&app);
    state.vision.lock().clear();
    let _ = app.emit(events::VISION_PICKED, Some(crop));
    Ok(())
}

/// 放弃这次框选。
#[tauri::command]
pub fn vision_cancel(app: AppHandle, state: State<'_, Arc<AppState>>) -> R<()> {
    close_overlay(&app);
    state.vision.lock().clear();
    let _ = app.emit(events::VISION_PICKED, Option::<String>::None);
    Ok(())
}

fn close_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("vision-overlay") {
        let _ = w.close();
    }
}

/* ------------------------------------------------------------------ 像素工具 */

fn crop_image(img: &image::RgbaImage, rect: VisionRect) -> R<String> {
    let out = app_core::pixels::crop(img, rect.x, rect.y, rect.w, rect.h)
        .ok_or_else(|| "框选区域是空的".to_string())?;
    app_core::pixels::png_data_url(&out)
}

fn to_data_url(img: &image::RgbaImage) -> R<String> {
    app_core::pixels::png_data_url(img)
}

/* ------------------------------------------------------------------ 剪贴板 */

/// 把一张 PNG（dataURL 或裸 base64）写进**系统剪贴板**。
///
/// 为什么不用 `navigator.clipboard.write`：WebView2 各版本行为不一致，
/// 有的后台窗口直接拒写。arboard 走 win32 剪贴板，稳定且不依赖页面焦点。
///
/// 为什么是 `async`：剪贴板要拿全局锁，别的进程占着时**可能等很久** ——
/// 放在主线程上会把整个事件循环拖住，所有 invoke 响应跟着停摆。
#[tauri::command]
pub async fn clip_write_image(base64: String) -> R<bool> {
    let payload = match base64.split_once(",") {
        Some((head, tail)) if head.starts_with("data:") => tail.to_string(),
        _ => base64,
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("图片数据不是合法 base64：{e}"))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("图片解码失败：{e}"))?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();

    let mut clip = arboard::Clipboard::new().map_err(|e| format!("剪贴板打不开：{e}"))?;
    let data = arboard::ImageData {
        width: w as usize,
        height: h as usize,
        bytes: std::borrow::Cow::Owned(rgba.into_raw()),
    };
    // 剪贴板是全局单例：剪贴板管理器 / 输入法 / 其它常驻工具会**毫秒级**地短暂占住它，
    // 单次尝试会撞 "held by another party"（2026-10-13 自检两次连败都是它）。
    // 小步重试 ~1.5s：占用都是瞬时的，重试基本必成；持续打不开再如实报错。
    let mut last_err = String::new();
    for attempt in 0..10 {
        match clip.set_image(data.clone()) {
            Ok(()) => return Ok(true),
            Err(e) => {
                last_err = format!("写剪贴板失败：{e}");
                if attempt < 9 {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                }
            }
        }
    }
    Err(last_err)
}

/// 读回剪贴板里的图（自检用：写进去再读出来，比对尺寸）。
#[tauri::command]
pub async fn clip_read_image() -> R<(u32, u32)> {
    let mut clip = arboard::Clipboard::new().map_err(|e| format!("剪贴板打不开：{e}"))?;
    let img = clip.get_image().map_err(|e| format!("读剪贴板失败：{e}"))?;
    Ok((img.width as u32, img.height as u32))
}
