//! 资产服务：把自定义协议 URL 路径映射到随包资产文件。
//!
//! 四个挂载点在《迁移方案 v1.2》§7.4 与既有实现一致：
//! `/drawio/`、`/excalidraw/`、`/graphviz/`、`/mermaid/`；其余路径落到前端产物目录
//! （外壳页 `/index.html`、`/app.js`…），从而**外壳与资产同源**，离线守卫只需管一个 origin。

use std::path::{Path, PathBuf};

/// 一个资产挂载点。
pub const MOUNTS: [&str; 4] = ["drawio", "excalidraw", "graphviz", "mermaid"];

/// 资源根集合。
#[derive(Debug, Clone)]
pub struct AssetRoots {
    /// 前端产物目录（`index.html` 与打包后的 JS/CSS）。根路径 `/` 映射到 `index.html`。
    pub ui: PathBuf,
    /// 完整的旧仓库工作树（`client/`）：`tools/{drawio,excalidraw,graphviz}` + `Assets/mermaid.min.js`。
    /// 开发期直接复用已拉取的资产，避免在新分支重复拉取。
    pub legacy_client: Option<PathBuf>,
    /// 随包资产根（`assets/`）：其下按挂载点建同名子目录。发布形态使用。
    pub packaged: Option<PathBuf>,
}

impl AssetRoots {
    /// 探测可用根：优先环境变量，其次从行程可执行文件向上找仓库布局。
    ///
    /// * `DIAGRAMON_ASSETS_DIR` → 随包资产根（含 `drawio/` 等子目录）
    /// * `DIAGRAMON_CLIENT_DIR` → 旧仓库工作树
    pub fn detect(ui: PathBuf) -> Self {
        let packaged = dir_with_subdirs(std::env::var_os("DIAGRAMON_ASSETS_DIR").map(PathBuf::from))
            .or_else(|| dir_with_subdirs(Some(ui.join("../assets"))))
            .or_else(|| dir_with_subdirs(Some(ui.join("assets"))));

        let legacy_client = std::env::var_os("DIAGRAMON_CLIENT_DIR")
            .map(PathBuf::from)
            .filter(|p| p.join("tools/graphviz/graphviz.js").is_file())
            .or_else(|| search_ancestors(&ui, "client"));

        Self {
            ui,
            legacy_client,
            packaged,
        }
    }

    /// 某个挂载点的磁盘目录（随包优先，缺则退回旧仓库工作树）。
    pub fn mount_dir(&self, mount: &str) -> Option<PathBuf> {
        if let Some(p) = &self.packaged {
            let d = p.join(mount);
            if d.is_dir() {
                return Some(d);
            }
        }
        let c = self.legacy_client.as_ref()?;
        let d = match mount {
            // 旧仓库里 Mermaid 直接放在 Assets/ 下（`mermaid.min.js`）。
            "mermaid" => c.join("Assets"),
            other => c.join("tools").join(other),
        };
        d.is_dir().then_some(d)
    }
}

/// 若目录存在且至少含一个挂载点子目录，则认作资产根。
fn dir_with_subdirs(dir: Option<PathBuf>) -> Option<PathBuf> {
    let dir = dir?;
    if dir.is_dir() && MOUNTS.iter().any(|m| dir.join(m).is_dir()) {
        Some(dir)
    } else {
        None
    }
}

/// 从 `start` 起逐级向上查找名为 `name` 且形如资产树的目录。
fn search_ancestors(start: &Path, name: &str) -> Option<PathBuf> {
    let mut cur = Some(start);
    while let Some(dir) = cur {
        let cand = dir.join(name);
        if cand.join("tools/graphviz/graphviz.js").is_file() {
            return Some(cand);
        }
        cur = dir.parent();
    }
    None
}

/// URL 路径 → 磁盘文件。返回 `None` 表示 404。
///
/// 路径已做百分号解码；`..` 段被拒绝（防目录穿越）。
pub fn resolve(roots: &AssetRoots, url_path: &str) -> Option<PathBuf> {
    let decoded = percent_encoding::percent_decode_str(url_path.trim_start_matches('/'))
        .decode_utf8()
        .ok()?
        .into_owned();

    if decoded.split('/').any(|seg| seg == "..") {
        return None;
    }

    let mut segs = decoded.splitn(2, '/');
    let first = segs.next().unwrap_or("");
    let rest = segs.next().unwrap_or("");

    let (dir, rel) = if MOUNTS.contains(&first) {
        (roots.mount_dir(first)?, rest.to_string())
    } else {
        (roots.ui.clone(), decoded.clone())
    };

    let rel = if rel.is_empty() { "index.html" } else { &rel };
    let candidate = dir.join(rel);
    candidate.is_file().then_some(candidate)
}

/// 由扩展名推断 MIME（`text/html` 等）；未知回退 `application/octet-stream`。
pub fn mime_for(path: &Path) -> String {
    mime_guess::from_path(path)
        .first_or_octet_stream()
        .essence_str()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 搭一棵临时资产树：`<root>/{ui,packaged}/…`。
    fn fixture(tag: &str) -> (PathBuf, AssetRoots) {
        let root = std::env::temp_dir().join(format!("dgm-assets-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let ui = root.join("ui");
        let packaged = root.join("packaged");
        std::fs::create_dir_all(&ui).unwrap();
        std::fs::create_dir_all(packaged.join("drawio")).unwrap();
        std::fs::write(ui.join("index.html"), b"<html></html>").unwrap();
        std::fs::write(ui.join("app.js"), b"console.log(1)").unwrap();
        std::fs::write(packaged.join("drawio/index.html"), b"<mxfile/>").unwrap();
        (
            root.clone(),
            AssetRoots {
                ui,
                legacy_client: None,
                packaged: Some(packaged),
            },
        )
    }

    #[test]
    fn root_maps_to_ui_index() {
        let (root, r) = fixture("root");
        assert_eq!(resolve(&r, "/").unwrap(), r.ui.join("index.html"));
        assert_eq!(resolve(&r, "/app.js").unwrap(), r.ui.join("app.js"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn mount_prefix_wins_over_ui() {
        let (root, r) = fixture("mount");
        let got = resolve(&r, "/drawio/index.html").unwrap();
        assert!(got.ends_with("packaged/drawio/index.html"), "got {got:?}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_traversal_and_missing() {
        let (root, r) = fixture("safe");
        assert!(resolve(&r, "/../secret").is_none());
        assert!(resolve(&r, "/drawio/../../secret").is_none());
        assert!(resolve(&r, "/nope.js").is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn percent_decoding() {
        let (root, r) = fixture("pct");
        std::fs::write(r.ui.join("a b.js"), b"x").unwrap();
        assert!(resolve(&r, "/a%20b.js").is_some());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn mime_by_extension() {
        assert_eq!(mime_for(Path::new("x.html")), "text/html");
        assert_eq!(mime_for(Path::new("x.js")), "text/javascript");
        assert_eq!(mime_for(Path::new("x.woff2")), "font/woff2");
        assert_eq!(mime_for(Path::new("x.unknownext")), "application/octet-stream");
    }
}
