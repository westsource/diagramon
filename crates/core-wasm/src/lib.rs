//! 浏览器侧入口：把 `app-core` 的纯逻辑以**一段 JSON 进、一段 JSON 出**的方式暴露给 JS。
//!
//! 不用 wasm-bindgen：本机没有对应 CLI，而这里只需要一个稳定的字节通道。
//! 约定（与 app/js/core.js 一致）：
//!   - `dgm_alloc(len)` 申请输入缓冲；JS 写入后调 `dgm_call(ptr, len)`；
//!   - 返回值是 `(ptr << 32) | len` 的 u64，JS 读出 UTF-8 JSON 后调 `dgm_free_result`；
//!   - 请求形如 `{"op":"convert","from":"mermaid","to":"dot","body":"..."}`，
//!     响应永远是 `{"ok":true,...}` 或 `{"ok":false,"error":"..."}`。
//!
//! 实现细节：响应由 `serde_json::to_string` **直接流式**产出，不再经过 `Value` 中转 ——
//! 在 wasm32 上把 `FormatInfo` 这类结构先转成 `Value` 会触发一次不可复现的 trap，
//! 而流式序列化没有这个问题（2026-11-12 实测）。

use std::alloc::{alloc, dealloc, Layout};
use std::slice;

use app_ipc::FormatId;
use serde_json::to_string;

fn fid(s: &str) -> Result<FormatId, String> {
    match s {
        "mermaid" => Ok(FormatId::Mermaid),
        "dot" => Ok(FormatId::Dot),
        "d2" => Ok(FormatId::D2),
        "drawio" => Ok(FormatId::Drawio),
        "excalidraw" => Ok(FormatId::Excalidraw),
        other => Err(format!("未知格式：{other}")),
    }
}

fn ser<T: serde::Serialize>(v: &T) -> Result<String, String> {
    to_string(v).map_err(|e| e.to_string())
}

/// 把 `{"a":...}` 这样的片段并进统一响应。
fn ok(fields: String) -> String {
    let body = fields.trim();
    if body.len() >= 2 && body.starts_with('{') && body.ends_with('}') {
        format!("{{\"ok\":true,{}", &body[1..])
    } else {
        "{\"ok\":true}".to_string()
    }
}

fn err(e: String) -> String {
    format!("{{\"ok\":false,\"error\":{}}}", to_string(&e).unwrap_or_else(|_| "\"error\"".into()))
}

fn handle(req: &serde_json::Value) -> Result<String, String> {
    let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
    let body = || req.get("body").and_then(|v| v.as_str()).unwrap_or("");
    let fmt = || fid(req.get("format").and_then(|v| v.as_str()).unwrap_or(""));
    match op {
        "platform_info" => Ok(format!(
            "{{\"formats\":{},\"palettes\":{}}}",
            ser(&app_core::format::registry())?,
            ser(&app_core::palette::infos())?
        )),
        "formats" => Ok(format!("{{\"formats\":{}}}", ser(&app_core::format::registry())?)),
        "palettes" => Ok(format!("{{\"palettes\":{}}}", ser(&app_core::palette::infos())?)),
        "default_body" => {
            let f = fmt()?;
            Ok(format!("{{\"body\":{}}}", ser(&app_core::format::default_body(f))?))
        }
        "convert_targets" => {
            let f = fmt()?;
            Ok(format!("{{\"targets\":{}}}", ser(&app_core::format::convert_targets(f))?))
        }
        "issues" => {
            let f = fmt()?;
            Ok(format!("{{\"issues\":{}}}", ser(&app_core::lint::issues(f, body()))?))
        }
        "outline" => {
            let f = fmt()?;
            Ok(format!("{{\"groups\":{}}}", ser(&app_core::outline::outline(f, body()))?))
        }
        "scope" => {
            let f = fmt()?;
            let line = req.get("line").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
            Ok(format!("{{\"scope\":{}}}", ser(&app_core::scope::current_scope(f, body(), line))?))
        }
        "format_body" => {
            let f = fmt()?;
            let out = app_core::formatter::format_body(f, body());
            Ok(format!("{{\"changed\":{},\"body\":{}}}", out.changed, ser(&out.body)?))
        }
        "build_messages" => {
            let format = fid(req.get("format").and_then(|v| v.as_str()).unwrap_or(""))?;
            let intent: app_ipc::AiIntent = serde_json::from_value(
                req.get("intent").cloned().unwrap_or(serde_json::Value::String("generate".into())),
            )
            .map_err(|e| format!("intent 不是合法值：{e}"))?;
            let prompt = req.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
            let context = req.get("context").and_then(|v| v.as_str());
            let images: Vec<String> = serde_json::from_value(req.get("images").cloned().unwrap_or(serde_json::json!([])))
                .map_err(|e| e.to_string())?;
            let history: Vec<app_ipc::AiTurn> = serde_json::from_value(req.get("history").cloned().unwrap_or(serde_json::json!([])))
                .map_err(|e| e.to_string())?;
            let files: Vec<app_ipc::AiContextFile> = serde_json::from_value(req.get("files").cloned().unwrap_or(serde_json::json!([])))
                .map_err(|e| e.to_string())?;
            let msgs = ai_prompt::build_messages_with_history_images(format, intent, prompt, context, &images, &history, &files);
            Ok(format!("{{\"messages\":{}}}", ser(&msgs)?))
        }
        "convert" => {
            let from = fid(req.get("from").and_then(|v| v.as_str()).unwrap_or(""))?;
            let to = fid(req.get("to").and_then(|v| v.as_str()).unwrap_or(""))?;
            let c = app_core::convert::convert(from, to, body())?;
            Ok(format!("{{\"body\":{},\"notes\":{}}}", ser(&c.body)?, ser(&c.notes)?))
        }
        other => Err(format!("未知 op：{other}")),
    }
}

#[no_mangle]
pub extern "C" fn dgm_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    unsafe { alloc(Layout::from_size_align(len, 1).expect("合法布局")) }
}

/// 归还 `dgm_alloc` 的缓冲（JS 拷贝完输入后调用）。
#[no_mangle]
pub extern "C" fn dgm_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    unsafe { dealloc(ptr, Layout::from_size_align(len, 1).expect("合法布局")) }
}

/// 处理一次请求；返回值高 32 位是结果指针、低 32 位是字节数。
#[no_mangle]
pub extern "C" fn dgm_call(ptr: *const u8, len: usize) -> u64 {
    let req: serde_json::Value = if ptr.is_null() || len == 0 {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(unsafe { slice::from_raw_parts(ptr, len) }).unwrap_or(serde_json::Value::Null)
    };
    let out = match handle(&req) {
        Ok(fields) => ok(fields),
        Err(e) => err(e),
    };
    let mut bytes = out.into_bytes();
    let n = bytes.len();
    let p = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ((p as u64) << 32) | n as u64
}

/// 归还 `dgm_call` 的结果缓冲。
#[no_mangle]
pub extern "C" fn dgm_free_result(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    unsafe { drop(Vec::from_raw_parts(ptr, len, len)) }
}
