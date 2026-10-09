//! 文档模型：一个标签页的正文 + 磁盘身份 + 脏标记。
//!
//! 脏标记按**内容比对**（`body != saved_body`）而不是布尔位，这样
//! 「改了又改回来」不会误报未保存，也与既有客户端一致。

use std::path::{Path, PathBuf};

use app_ipc::{DocFormat, TabState};

/// 一个打开的文档（= 一个标签页）。
#[derive(Debug, Clone)]
pub struct Document {
    id: String,
    path: Option<PathBuf>,
    format: DocFormat,
    body: String,
    /// 上次落盘/载入时的正文，用于计算脏标记。
    saved_body: String,
}

impl Document {
    /// 新建一个未落盘文档，正文取格式默认内容。
    pub fn untitled(id: String, format: DocFormat) -> Self {
        let body = super::format::spec(format).default_content.to_string();
        Self {
            id,
            path: None,
            format,
            saved_body: body.clone(),
            body,
        }
    }

    /// 从磁盘内容构造（`saved == body`，即不脏）。
    pub fn from_file(id: String, path: PathBuf, format: DocFormat, body: String) -> Self {
        Self {
            id,
            path: Some(path),
            format,
            saved_body: body.clone(),
            body,
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn format(&self) -> DocFormat {
        self.format
    }

    pub fn body(&self) -> &str {
        &self.body
    }

    pub fn is_dirty(&self) -> bool {
        self.body != self.saved_body
    }

    /// 替换正文（保持脏标记按内容比对）。
    pub fn set_body(&mut self, body: String) {
        self.body = body;
    }

    /// 保存成功后绑定新路径并清除脏标记。
    pub fn mark_saved(&mut self, path: PathBuf) {
        self.saved_body = self.body.clone();
        self.path = Some(path);
    }

    /// 显示标题：有路径取文件名，否则空串（"未命名"由前端按语言本地化）。
    pub fn title(&self) -> String {
        self.path
            .as_deref()
            .and_then(Path::file_name)
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string()
    }

    /// 生成给前端的标签状态快照。
    pub fn tab_state(&self) -> TabState {
        TabState {
            id: self.id.clone(),
            path: self
                .path
                .as_deref()
                .map(|p| p.to_string_lossy().into_owned()),
            format: self.format,
            title: self.title(),
            dirty: self.is_dirty(),
        }
    }
}
