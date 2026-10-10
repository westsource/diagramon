//! 预览护栏：超大文档不该默默把 WASM 引擎拖死。
//!
//! mermaid / graphviz 的渲染是 **O(节点数) 的 WASM 计算 + 一次性 SVG 字符串**，
//! 万行图的代价不是"慢一点"而是"整页卡死几秒到几十秒"。护栏的做法不是"禁止"，
//! 而是**先问一句**：给出提示与"仍要渲染"的入口 —— 决定权在用户，代价也要说清。
//!
//! 纯函数 + 单测；阈值放这里（不散落在前端），因为 lint/大纲将来也要用同一把尺子。

/// 单文档触发护栏的行数。
pub const MAX_LINES: usize = 5_000;
/// 单文档触发护栏的字节数。
pub const MAX_BYTES: usize = 400 * 1024;

/// 阈值交给前端（app_info.limits）—— 数字只在这里一份。
pub fn limits() -> app_ipc::Limits {
    app_ipc::Limits {
        preview_max_lines: MAX_LINES as u32,
        preview_max_bytes: MAX_BYTES as u32,
    }
}

/// 该不该先问一句。返回 `Some(原因)` = 建议先确认，`None` = 放心渲染。
pub fn preview_guard(body: &str) -> Option<String> {
    let lines = body.split('\n').count();
    let bytes = body.len();
    if lines > MAX_LINES {
        return Some(format!("行数 {lines} 超过 {MAX_LINES}"));
    }
    if bytes > MAX_BYTES {
        return Some(format!("大小 {} KB 超过 {} KB", bytes / 1024, MAX_BYTES / 1024));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_documents_are_never_guarded() {
        assert_eq!(preview_guard("flowchart TD\n    A-->B\n"), None);
        let big: String = (0..MAX_LINES - 1).map(|i| format!("a{i}\n")).collect();
        assert_eq!(preview_guard(&big), None, "压着线的要放行");
    }

    #[test]
    fn too_many_lines_is_guarded_with_a_reason() {
        let big: String = (0..MAX_LINES + 1).map(|i| format!("a{i}\n")).collect();
        let why = preview_guard(&big).expect("超行数要拦");
        assert!(why.contains("行数"), "原因要说人话：{why}");
    }

    #[test]
    fn too_many_bytes_is_guarded_with_a_reason() {
        let big = "x".repeat(MAX_BYTES + 1);
        let why = preview_guard(&big).expect("超大小要拦");
        assert!(why.contains("KB"), "原因要说人话：{why}");
    }

    #[test]
    fn few_lines_but_huge_line_is_still_guarded() {
        // 一行 500KB：按行数看很小，按字节看必须拦
        let big = format!("{}\n", "x".repeat(MAX_BYTES + 1));
        assert!(preview_guard(&big).is_some());
    }
}
