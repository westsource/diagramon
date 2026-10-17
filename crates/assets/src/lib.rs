//! 资产服务：把自定义协议 URL 路径映射到磁盘上的文件。
//!
//! **为什么整个应用都走自定义协议**（而不是只用它供资产）：
//! 外壳页与四个承载页（drawio / Excalidraw / graphviz / mermaid）因此**同源**，
//! 于是 iframe 通信不受跨源限制，离线守卫也只需管一个 origin。
//! Windows 上 origin 是 `http://dgm.localhost/`，其它平台是 `dgm://localhost/`
//! （见 `src-tauri` 的 `webview_url`）。
//!
//! 挂载点沿用 dev2.0 的四个：`/drawio/`、`/excalidraw/`、`/graphviz/`、`/mermaid/`；
//! 其余路径落到前端产物目录（`/` → `index.html`），从而外壳与资产同源。

use std::path::{Path, PathBuf};

/// 一个资产挂载点。落在这些前缀下的请求会去挂载目录取，而不是前端产物目录。
pub const MOUNTS: [&str; 4] = ["drawio", "excalidraw", "graphviz", "mermaid"];

/// 各挂载点的入口文件。判断"这个目录像不像源工作树"只看入口在不在 ——
/// 空壳目录（仓库根下曾有 `Assets/{drawio,…}/` 这种）不能被当成资产在位的证据。
const MOUNT_ENTRY: [(&str, &str); 4] = [
    ("drawio", "index.html"),
    ("excalidraw", "index.html"),
    ("graphviz", "graphviz.js"),
    ("mermaid", "mermaid.min.js"),
];

/// 资源根集合。
#[derive(Debug, Clone)]
pub struct AssetRoots {
    /// 前端产物目录（`index.html` 与 js/css）。根路径 `/` 映射到 `index.html`。
    pub ui: PathBuf,
    /// 源工作树**根**：其下 `tools/<挂载点>/` 就是取资产脚本的产物（四个挂载点全在里面）。
    ///
    /// 开发期直接复用已经拉好的那份，避免在仓库里多存一份 98MB。
    /// 发布形态靠 `packaged`，不依赖它。
    pub source_tree: Option<PathBuf>,
    /// 随包资产根：其下按挂载点建同名子目录（`assets/drawio/` …）。
    pub packaged: Option<PathBuf>,
}

impl AssetRoots {
    /// 探测可用根：环境变量优先，其次从 `ui` 目录向上找仓库布局。
    ///
    /// * `DIAGRAMON_ASSETS_DIR` → 随包资产根（含 `drawio/` 等子目录）
    /// * `DIAGRAMON_SOURCE_TREE` → 源工作树**根**（其下有 `tools/<挂载点>/`）
    ///
    /// 向上找的判据是"某层祖先的 `tools/<挂载点>/<入口>` 存在"，不再按目录名猜。
    /// （2026-10-17 之前这里找的是旧客户端仓库 `client/`；那个仓库已删除，
    /// 现在唯一的工作树就是 `client2/tools/`。宁可 `source_tree` 为 `None`
    /// —— 请求照常 404、原因写在日志里 —— 也不要静默指到一份停更的副本。）
    pub fn detect(ui: PathBuf) -> Self {
        let packaged = dir_with_subdirs(std::env::var_os("DIAGRAMON_ASSETS_DIR").map(PathBuf::from))
            .or_else(|| dir_with_subdirs(Some(ui.join("../assets"))))
            .or_else(|| dir_with_subdirs(Some(ui.join("assets"))));

        let source_tree = std::env::var_os("DIAGRAMON_SOURCE_TREE")
            .map(PathBuf::from)
            .filter(|p| has_tools_layout(p))
            .or_else(|| find_tools_ancestor(&ui));

        Self {
            ui,
            source_tree,
            packaged,
        }
    }

    /// 某个挂载点的磁盘目录：随包优先，缺则退回源工作树。
    pub fn mount_dir(&self, mount: &str) -> Option<PathBuf> {
        if let Some(p) = &self.packaged {
            let d = p.join(mount);
            if d.is_dir() {
                return Some(d);
            }
        }
        let c = self.source_tree.as_ref()?;
        // 四个挂载点在源工作树里布局一致：`tools/<挂载点>/`。
        // （旧仓库把 mermaid 单独放在 `Assets/` 下，那个特例随 `client/` 一起删了。）
        let d = c.join("tools").join(mount);
        d.is_dir().then_some(d)
    }
}

/// `root/tools/<挂载点>/<入口>` 里**有任一个**存在 → 认为这是可用的源工作树。
fn has_tools_layout(root: &Path) -> bool {
    MOUNT_ENTRY
        .iter()
        .any(|(m, e)| root.join("tools").join(m).join(e).is_file())
}

/// 从 `start` 起逐级向上找最近的、`tools/<挂载点>` 已有产物的祖先目录。
fn find_tools_ancestor(start: &Path) -> Option<PathBuf> {
    let mut cur = Some(start);
    while let Some(dir) = cur {
        if has_tools_layout(dir) {
            return Some(dir.to_path_buf());
        }
        cur = dir.parent();
    }
    None
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

/// URL 路径 → 磁盘文件。返回 `None` 表示 404。
///
/// 路径已做百分号解码；含 `..` 段一律拒绝（防目录穿越）。
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
///
/// WebView 对这个很敏感：`.js` 给错 MIME 会被按 `text/plain` 拒绝执行。
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
                source_tree: None,
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

    /// 挂载点目录里的相对路径（子目录）也要能取到 —— drawio 的资源全在 `js/`、`styles/` 下。
    #[test]
    fn nested_path_inside_a_mount() {
        let (root, r) = fixture("nested");
        let p = r.packaged.as_ref().unwrap().join("drawio/js/App.js");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"// app").unwrap();
        assert_eq!(resolve(&r, "/drawio/js/App.js").unwrap(), p);
        let _ = std::fs::remove_dir_all(root);
    }

    /// 挂载点根（`/drawio`，无尾斜杠）要落到该挂载点的 index.html，而不是前端产物。
    #[test]
    fn bare_mount_falls_back_to_its_index() {
        let (root, r) = fixture("bare");
        let got = resolve(&r, "/drawio").unwrap();
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

    /// 源工作树缺 `packaged` 时的回退：四个挂载点一律去 `tools/<挂载点>/`。
    #[test]
    fn source_tree_fallback_uses_tools_subdirs() {
        let root = std::env::temp_dir().join(format!("dgm-assets-src-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = root.join("repo");
        std::fs::create_dir_all(src.join("tools/mermaid")).unwrap();
        std::fs::create_dir_all(src.join("tools/graphviz")).unwrap();
        std::fs::write(src.join("tools/mermaid/mermaid.min.js"), b"// mermaid").unwrap();
        std::fs::write(src.join("tools/graphviz/graphviz.js"), b"// gv").unwrap();

        let roots = AssetRoots {
            ui: root.join("ui"),
            source_tree: Some(src.clone()),
            packaged: None,
        };
        assert_eq!(roots.mount_dir("mermaid").unwrap(), src.join("tools/mermaid"));
        assert_eq!(roots.mount_dir("graphviz").unwrap(), src.join("tools/graphviz"));
        assert!(roots.mount_dir("drawio").is_none(), "没拉过的挂载点应为 None");
        let _ = std::fs::remove_dir_all(root);
    }

    /// 向上找源工作树：从 `ui` 出发要能认出 `repo/tools/<挂载点>`，并且**只认入口文件**——
    /// 空壳目录（`Assets/{drawio,…}/` 那种历史遗留）不算数。
    #[test]
    fn finds_tools_root_by_walking_up() {
        let root = std::env::temp_dir().join(format!("dgm-assets-walk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let ui = repo.join("ui");
        std::fs::create_dir_all(&ui).unwrap();
        std::fs::create_dir_all(repo.join("tools/drawio")).unwrap();
        std::fs::write(repo.join("tools/drawio/index.html"), b"<html></html>").unwrap();

        assert_eq!(find_tools_ancestor(&ui).unwrap(), repo);
        // 只有空壳目录时不算
        std::fs::remove_file(repo.join("tools/drawio/index.html")).unwrap();
        assert!(find_tools_ancestor(&ui).is_none(), "空壳目录不能当成资产在位");
        let _ = std::fs::remove_dir_all(root);
    }
}
