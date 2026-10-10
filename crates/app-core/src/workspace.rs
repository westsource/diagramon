//! 工作区：目录扫描、全库文本搜索、以及"路径不许出工作区"的守卫。
//!
//! 三件事放在一起，是因为它们**共享同一套规则**：哪些目录跳过、哪些扩展名算图表文件、
//! 路径怎么规范化。规则只写在这里一份，扫描与搜索就不会各自漂移。
//!
//! 全是纯函数（`Path` 进、结构出），所以能被单测钉住 —— 这是本模块唯一的价值。

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use app_ipc::{FormatId, SearchDone, SearchHit, SearchRequest, WorkspaceInfo, WorkspaceNode};
use walkdir::WalkDir;

/// 扫描/搜索的文件数上限。撞上就置 `truncated`，**不静默丢**。
pub const MAX_FILES: usize = 4000;
/// 目录深度上限（软链接环、超深目录都在这里挡住）。
pub const MAX_DEPTH: usize = 12;
/// 参与搜索的单文件大小上限；超过就跳过。
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// 一次搜索默认返回的命中上限。
pub const DEFAULT_MAX_HITS: u32 = 500;
/// 命中行在结果里保留的字符数。
const HIT_TEXT_CHARS: usize = 240;

/// 一律跳过的目录名（比较时大小写不敏感）。
pub const SKIP_DIRS: &[&str] = &[
    ".git", ".svn", ".hg", "node_modules", "target", "dist", "build",
    "__pycache__", ".venv", "venv", ".idea", ".vscode", ".cache", "coverage",
];

/// 本应用能打开的扩展名（小写、不带点）。
pub const OPEN_EXTS: &[&str] = &["mmd", "mermaid", "dot", "gv", "drawio", "excalidraw"];

pub fn is_open_ext(ext: &str) -> bool {
    let e = ext.trim_start_matches('.').to_ascii_lowercase();
    OPEN_EXTS.contains(&e.as_str())
}

/// 路径统一成正斜杠字符串（前端只当 id 用，别在两个方向上各转一次）。
pub fn slash(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/* ------------------------------------------------------------------ 扫描 */

#[derive(Default)]
struct Trie {
    dirs: BTreeMap<String, Trie>,
    files: Vec<(String, FormatId)>,
}

impl Trie {
    fn into_nodes(self, base: &Path) -> Vec<WorkspaceNode> {
        let mut out = Vec::with_capacity(self.dirs.len() + self.files.len());
        for (name, sub) in self.dirs {
            let path = base.join(&name);
            out.push(WorkspaceNode {
                name,
                path: slash(&path),
                dir: true,
                format: None,
                children: sub.into_nodes(&path),
            });
        }
        for (name, format) in self.files {
            out.push(WorkspaceNode {
                name: name.clone(),
                path: slash(&base.join(&name)),
                dir: false,
                format: Some(format),
                children: Vec::new(),
            });
        }
        out
    }

    fn dir_count(&self) -> u32 {
        self.dirs.values().map(|d| 1 + d.dir_count()).sum()
    }
}

/// 这个目录项要不要跳过。
fn skip_entry(e: &walkdir::DirEntry) -> bool {
    if e.depth() == 0 {
        return false; // 根目录自己永远不跳
    }
    if !e.file_type().is_dir() {
        return false;
    }
    let name = e.file_name().to_string_lossy();
    name.starts_with('.') || SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(&name))
}

/// 扫一棵树。只收**本应用能打开**的文件；不含图表文件的目录直接不出现
/// （空目录在界面上只是噪音）。
pub fn scan(root: &Path) -> WorkspaceInfo {
    let mut info = WorkspaceInfo {
        root: Some(slash(root)),
        name: root
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| slash(root)),
        ..Default::default()
    };
    if !root.is_dir() {
        return info;
    }

    let mut trie = Trie::default();
    for entry in WalkDir::new(root)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !skip_entry(e))
    {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Some(ext) = path.extension() else { continue };
        if !is_open_ext(&ext.to_string_lossy()) {
            continue;
        }
        if info.file_count as usize >= MAX_FILES {
            info.truncated = true;
            break;
        }
        let rel = path.strip_prefix(root).unwrap_or(path);
        let comps: Vec<String> = rel.iter().map(|c| c.to_string_lossy().into_owned()).collect();
        let Some((file_name, dirs)) = comps.split_last() else { continue };
        let mut node = &mut trie;
        for d in dirs {
            node = node.dirs.entry(d.clone()).or_default();
        }
        node.files.push((
            file_name.clone(),
            FormatId::from_ext(&ext.to_string_lossy()),
        ));
        info.file_count += 1;
    }

    info.dir_count = trie.dir_count();
    info.tree = trie.into_nodes(root);
    info
}

/* ------------------------------------------------------------------ 搜索 */

enum Matcher {
    /// 字面量；`ci` = 大小写不敏感
    Literal { needle: String, ci: bool },
    Regex(regex::Regex),
}

impl Matcher {
    fn build(query: &str, regex: bool, case_sensitive: bool) -> Result<Self, String> {
        if regex {
            regex::RegexBuilder::new(query)
                .case_insensitive(!case_sensitive)
                .build()
                .map(Self::Regex)
                .map_err(|e| e.to_string())
        } else if case_sensitive {
            Ok(Self::Literal { needle: query.to_string(), ci: false })
        } else {
            Ok(Self::Literal { needle: query.to_lowercase(), ci: true })
        }
    }

    /// 命中位置的 **0 起字符下标**（不是字节下标 —— 中文一行一个字，字节会错位）。
    fn find(&self, line: &str) -> Option<usize> {
        match self {
            Self::Literal { needle, ci } => {
                if needle.is_empty() {
                    return None;
                }
                let idx = if *ci {
                    line.to_lowercase().find(needle)?
                } else {
                    line.find(needle.as_str())?
                };
                // 小写化可能改变字节长度（极少数语言），取"到该字节为止的字符数"仍是对齐的
                Some(line[..idx.min(line.len())].chars().count())
            }
            Self::Regex(re) => re.find(line).map(|m| line[..m.start()].chars().count()),
        }
    }
}

/// 全库搜索。命中**逐条回调**（调用方负责推事件），大仓库也不阻塞界面。
///
/// 回调返回 `false` = 停（用户按了取消）；`done` 如实报已找到多少。
pub fn search<F: FnMut(SearchHit) -> bool>(root: &Path, req: &SearchRequest, mut on_hit: F) -> SearchDone {
    let mut done = SearchDone {
        request_id: req.request_id.clone(),
        total: 0,
        files: 0,
        truncated: false,
        error: None,
    };
    let query = req.query.as_str();
    if query.trim().is_empty() {
        return done; // 空查询 = 空结果，不当错误
    }
    let matcher = match Matcher::build(query, req.regex, req.case_sensitive) {
        Ok(m) => m,
        Err(e) => {
            done.error = Some(e);
            return done;
        }
    };
    if !root.is_dir() {
        return done;
    }
    let limit = if req.max_results == 0 {
        DEFAULT_MAX_HITS
    } else {
        req.max_results
    } as usize;

    'files: for entry in WalkDir::new(root)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !skip_entry(e))
    {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Some(ext) = path.extension() else { continue };
        if !is_open_ext(&ext.to_string_lossy()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        let name = entry.file_name().to_string_lossy().into_owned();
        let format = FormatId::from_ext(&ext.to_string_lossy());
        let mut file_hits = 0u32;

        for (i, line) in text.split('\n').enumerate() {
            let Some(col) = matcher.find(line) else { continue };
            done.total += 1;
            file_hits += 1;
            let keep_going = on_hit(SearchHit {
                path: slash(path),
                name: name.clone(),
                format,
                line: (i + 1) as u32,
                column: (col + 1) as u32,
                text: clip(line.trim_end_matches('\r'), HIT_TEXT_CHARS),
            });
            if done.total as usize >= limit {
                done.truncated = true;
                done.files += 1;
                break 'files;
            }
            if !keep_going {
                // 用户取消：已找到的照报，剩下的不找了
                done.files += 1;
                break 'files;
            }
        }
        if file_hits > 0 {
            done.files += 1;
        }
    }
    done
}

fn clip(s: &str, max_chars: usize) -> String {
    let mut out: String = s.chars().take(max_chars).collect();
    if s.chars().count() > max_chars {
        out.push('…');
    }
    out
}

/* ------------------------------------------------------------------ 文件事件去抖 */

/// 文件系统事件的语义（与具体监视库解耦：notify 的 `EventKind` 在装配层映射过来）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawKind {
    Created,
    Modified,
    Removed,
    /// 说不清（`Any` / `Other`）—— 当"改过"处理
    Other,
}

impl RawKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Modified | Self::Other => "modified",
            Self::Removed => "removed",
        }
    }
}

/// 去抖窗口里，同一条路径可能来好几个事件。合并规则：
/// - 新建后马上写入 ⇒ 仍然是"新建"（否则界面会说"改了个新文件"，别扭）
/// - 删掉又建出来 ⇒ 是"新建"（覆盖写：Windows 上 rename 就长这样）
pub fn merge_kind(prev: Option<&str>, next: &str) -> &'static str {
    match (prev, next) {
        (Some("created"), "modified") => "created",
        (Some("removed"), "created") => "created",
        (_, "created") => "created",
        (_, "removed") => "removed",
        _ => "modified",
    }
}

/* ------------------------------------------------------------------ 路径守卫 */
/// 把一个**用户输入的名字或相对路径**安全地落到工作区根下。
///
/// 拒绝：绝对路径、盘符/UNC 前缀、`..`。这是 fs scope 在应用层的落点 ——
/// 由工作区界面发起的写操作只能落在这里，逃不出去。
///
/// 注意范围：**只**管"我们替用户拼路径"的那条路（新建/重命名/删除）。
/// 「另存为」的路径来自系统对话框，那是用户本人的授权，不走这里。
pub fn resolve_in_root(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim();
    if rel.is_empty() {
        return Err("名称为空".into());
    }
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err("不接受绝对路径".into());
    }
    for c in p.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err("路径里不允许出现 .. 或盘符".into()),
        }
    }
    Ok(root.join(p))
}

/// `target` 是否落在 `root` 之内。按组件规范化比较（不要求文件已存在），
/// Windows 上大小写不敏感。
pub fn inside(root: &Path, target: &Path) -> bool {
    fn norm(p: &Path) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for c in p.components() {
            match c {
                Component::RootDir => out.push("/".into()),
                Component::Prefix(pfx) => {
                    out.push(pfx.as_os_str().to_string_lossy().to_lowercase())
                }
                Component::CurDir => {}
                Component::ParentDir => {
                    // 已经到根就不再退：`/..` == `/`
                    if out.len() > 1 {
                        out.pop();
                    }
                }
                Component::Normal(s) => out.push(s.to_string_lossy().to_lowercase()),
            }
        }
        out
    }
    let r = norm(root);
    let t = norm(target);
    t.len() >= r.len() && r.iter().zip(t.iter()).all(|(a, b)| a == b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 造一棵测试树。每个测试用独立目录名，避免并行互踩。
    fn fixture(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("diagramon-ws-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("flows")).unwrap();
        fs::create_dir_all(dir.join("arch/deep")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(dir.join("empty")).unwrap();
        fs::write(dir.join("flows/login.mmd"), "flowchart TD\n    A-->login\n").unwrap();
        fs::write(dir.join("flows/pay.DOT"), "digraph G { a -> b }\n").unwrap();
        fs::write(dir.join("arch/deep/topo.drawio"), "<mxfile/>\n").unwrap();
        fs::write(dir.join("README.md"), "# not a diagram\n").unwrap();
        fs::write(dir.join("notes.txt"), "hello\n").unwrap();
        fs::write(dir.join(".git/config"), "login\n").unwrap();
        fs::write(dir.join("node_modules/pkg/x.mmd"), "login\n").unwrap();
        dir
    }

    fn req(q: &str) -> SearchRequest {
        SearchRequest {
            request_id: "t".into(),
            query: q.into(),
            regex: false,
            case_sensitive: false,
            max_results: 0,
        }
    }

    #[test]
    fn scan_keeps_only_diagram_files_and_prunes_empty_dirs() {
        let dir = fixture("scan");
        let info = scan(&dir);
        assert_eq!(info.file_count, 3, "只有 3 个图表文件");
        assert!(!info.truncated);
        let names: Vec<String> = flatten(&info.tree).into_iter().filter_map(|n| (!n.dir).then_some(n.name)).collect();
        assert!(names.contains(&"login.mmd".to_string()));
        assert!(names.contains(&"pay.DOT".to_string()), "大写扩展名也要认");
        assert!(names.contains(&"topo.drawio".to_string()));
        assert!(!names.contains(&"README.md".to_string()), ".md 不是本应用的格式");
        let dirs: Vec<String> = flatten(&info.tree).into_iter().filter(|n| n.dir).map(|n| n.name).collect();
        assert!(!dirs.contains(&"empty".to_string()), "不含图表文件的目录不该出现");
        assert_eq!(info.dir_count, 3, "flows / arch / arch-deep");
        assert_eq!(info.name, format!("diagramon-ws-scan"));
    }

    #[test]
    fn scan_skips_vcs_and_dependency_dirs() {
        let dir = fixture("skip");
        let info = scan(&dir);
        let paths: Vec<String> = flatten(&info.tree).into_iter().map(|n| n.path).collect();
        assert!(!paths.iter().any(|p| p.contains("/.git/")), "不该进 .git");
        assert!(!paths.iter().any(|p| p.contains("/node_modules/")), "不该进 node_modules");
    }

    #[test]
    fn scan_of_missing_dir_is_empty_not_panic() {
        let info = scan(Path::new("E:/definitely/not/here"));
        assert_eq!(info.file_count, 0);
        assert!(info.tree.is_empty());
    }

    #[test]
    fn search_is_case_insensitive_by_default_and_reports_char_column() {
        let dir = fixture("s1");
        let mut hits = Vec::new();
        let done = search(&dir, &req("LOGIN"), &mut |h| {
            hits.push(h);
            true
        });
        assert_eq!(done.total, 1, "只有登录流程那个文件命中");
        assert_eq!(hits[0].name, "login.mmd");
        assert_eq!(hits[0].line, 2, "命中在第二行的 A-->login");
        assert_eq!(hits[0].column, 9, "login 在第 9 个字符处");
        assert_eq!(done.error, None);
    }

    #[test]
    fn search_column_counts_characters_not_bytes() {
        let dir = std::env::temp_dir().join("diagramon-ws-s2");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("cn.mmd"), "flowchart TD\n    开始 --> 目标\n").unwrap();
        let mut hits = Vec::new();
        search(&dir, &req("目标"), &mut |h| {
            hits.push(h);
            true
        });
        assert_eq!(hits.len(), 1);
        // "    开始 --> 目标"：目标 落在第 12 个字符处（1 起）。
        // 若按字节算会得到 16（中文一个字 3 字节）—— 那就是错的列号。
        assert_eq!(hits[0].column, 12, "列号必须是字符数，不是字节数");
    }

    #[test]
    fn search_case_sensitive_flag_is_honoured() {
        let dir = fixture("s3");
        let mut r = req("LOGIN");
        r.case_sensitive = true;
        let mut n = 0;
        search(&dir, &r, |_| {
            n += 1;
            true
        });
        assert_eq!(n, 0, "区分大小写时 LOGIN 不该命中 login");
        let mut r2 = req("login");
        r2.case_sensitive = true;
        let mut n2 = 0;
        search(&dir, &r2, |_| {
            n2 += 1;
            true
        });
        assert_eq!(n2, 1);
    }

    #[test]
    fn search_regex_works_and_bad_regex_is_reported_not_swallowed() {
        let dir = fixture("s4");
        let mut r = req(r"l\w+in");
        r.regex = true;
        let mut n = 0;
        let done = search(&dir, &r, |_| {
            n += 1;
            true
        });
        assert_eq!(n, 1);
        assert_eq!(done.error, None);

        let mut bad = req("a(b");
        bad.regex = true;
        let done = search(&dir, &bad, |_| true);
        assert!(done.error.is_some(), "正则写错要如实报错，不能当成没命中");
        assert_eq!(done.total, 0);
    }

    #[test]
    fn search_truncates_at_max_results_and_says_so() {
        let dir = std::env::temp_dir().join("diagramon-ws-s5");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let body: String = (0..50).map(|i| format!("hit {i}\n")).collect();
        fs::write(dir.join("many.mmd"), body).unwrap();
        let mut r = req("hit");
        r.max_results = 10;
        let mut n = 0;
        let done = search(&dir, &r, |_| {
            n += 1;
            true
        });
        assert_eq!(n, 10);
        assert!(done.truncated, "截断了就要说出来");
        assert_eq!(done.files, 1);
    }

    #[test]
    fn search_reports_progress_per_file() {
        let dir = fixture("s6");
        let mut r = req("a");
        r.regex = true;
        r.max_results = 0;
        let done = search(&dir, &r, |_| true);
        assert!(done.files >= 2, "至少 login.mmd 与 topo.drawio 命中");
    }

    #[test]
    fn empty_query_yields_nothing_and_no_error() {
        let dir = fixture("s7");
        let mut n = 0;
        let done = search(&dir, &req("   "), |_| {
            n += 1;
            true
        });
        assert_eq!(n, 0);
        assert_eq!(done.error, None, "空查询不是错误");
    }

    #[test]
    fn cancel_stops_the_walk_but_keeps_what_was_found() {
        let dir = std::env::temp_dir().join("diagramon-ws-s8");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let body: String = (0..40).map(|i| format!("hit {i}\n")).collect();
        fs::write(dir.join("many.mmd"), body).unwrap();
        let mut n = 0;
        let done = search(&dir, &req("hit"), |_| {
            n += 1;
            n < 3 // 第三次命中后喊停
        });
        assert_eq!(n, 3, "回调返回 false 后不该再找");
        assert_eq!(done.total, 3);
        assert!(!done.truncated, "取消不是截断，别混成一个说法");
    }

    #[test]
    fn clip_keeps_short_lines_verbatim() {
        assert_eq!(clip("abc", 10), "abc");
        assert_eq!(clip("abcdef", 3), "abc…");
    }

    /* ---- 文件事件去抖 ---- */

    #[test]
    fn merge_kind_collapses_create_then_write_into_created() {
        assert_eq!(merge_kind(None, "created"), "created");
        assert_eq!(merge_kind(Some("created"), "modified"), "created");
        assert_eq!(merge_kind(Some("removed"), "created"), "created", "覆盖写应报新建");
        assert_eq!(merge_kind(Some("modified"), "modified"), "modified");
        assert_eq!(merge_kind(None, "removed"), "removed");
        assert_eq!(merge_kind(Some("created"), "modified"), "created");
    }

    #[test]
    fn raw_kind_strings_match_the_contract() {
        assert_eq!(RawKind::Created.as_str(), "created");
        assert_eq!(RawKind::Removed.as_str(), "removed");
        assert_eq!(RawKind::Other.as_str(), "modified", "说不清就当改过，不静默丢");
    }

    /* ---- 路径守卫 ---- */

    #[test]
    fn resolve_in_root_accepts_relative_and_nested() {
        let root = Path::new("/ws");
        assert_eq!(resolve_in_root(root, "a.mmd").unwrap(), Path::new("/ws/a.mmd"));
        assert_eq!(resolve_in_root(root, "sub/b.mmd").unwrap(), Path::new("/ws/sub/b.mmd"));
    }

    #[test]
    fn resolve_in_root_rejects_traversal_and_absolute() {
        let root = Path::new("/ws");
        assert!(resolve_in_root(root, "../evil.mmd").is_err(), ".. 必须拒");
        assert!(resolve_in_root(root, "sub/../../evil.mmd").is_err());
        assert!(resolve_in_root(root, "   ").is_err());
        #[cfg(windows)]
        assert!(resolve_in_root(root, "C:/Windows/x.mmd").is_err(), "绝对路径必须拒");
        #[cfg(not(windows))]
        assert!(resolve_in_root(root, "/etc/passwd").is_err(), "绝对路径必须拒");
    }

    #[test]
    fn inside_distinguishes_nested_from_sibling_and_traversal() {
        let root = Path::new("/ws/proj");
        assert!(inside(root, Path::new("/ws/proj/a.mmd")));
        assert!(inside(root, Path::new("/ws/proj/sub/deep/a.mmd")));
        assert!(!inside(root, Path::new("/ws/other/a.mmd")), "兄弟目录不算在内");
        assert!(!inside(root, Path::new("/ws/proj/../other/a.mmd")), "回溯出去不算在内");
        assert!(inside(root, root), "根自己算在内");
    }

    /// 把树摊平成列表，断言时好写。
    fn flatten(nodes: &[WorkspaceNode]) -> Vec<WorkspaceNode> {
        let mut out = Vec::new();
        for n in nodes {
            out.push(n.clone());
            out.extend(flatten(&n.children));
        }
        out
    }
}
