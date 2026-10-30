//! 按**文件路径**记住渲染选项（外观 look / 布局 layout），下次打开这个文件接着用上次那份。
//!
//! 文档级的 `d.look` / `d.layout` 只活在会话内存里：关掉标签页、重启应用就回到默认。
//! 这里把它们按路径落一份盘，`doc_open_paths` 打开时再恢复 —— 也就是
//! 「给某个文件选了显示样式与布局，下次打开它还是这两个」。
//!
//! 身份用 `conversations::doc_key`（路径规范化 → SHA256 前 16 位）：路径规范化（大小写、
//! 斜杠方向）只有那一份规则，不会在这里再漂一次。
//!
//! 与 `settings` / `conversations` 同一套规矩：
//!   * 文件坏了 → 留一份 `.bak` 再回默认，**不静默丢**用户内容；
//!   * 原子写（先 `.tmp` 再 rename），崩溃不会留下半截 JSON；
//!   * 条数上限 [`MAX_DOCS`]，超了按 `at` 淘汰最旧的 —— 这份文件是"记住上次的选择"，
//!     丢掉任何一条最多回到默认，不丢用户内容。
//!
//! 值一律过 [`DocOpts::sanitized`]：注册表（`format::info`）是合法值的唯一真源，
//! 手改过的磁盘文件也不该把非法值灌进文档。

use std::collections::BTreeMap;
use std::path::Path;

use app_ipc::FormatId;
use serde::{Deserialize, Serialize};

use crate::conversations;
use crate::format;

/// 记录条数上限：一条几十字节，500 条约几十 KB。
pub const MAX_DOCS: usize = 500;

/// 单个文件记住的渲染选项。三项都为 `None` 表示"没记过"。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DocOpts {
    /// Mermaid 外观模式（auto / classic / neo / handDrawn）
    pub look: Option<String>,
    /// 布局引擎（DOT 六种 / D2 三种 / Mermaid 两种）
    pub layout: Option<String>,
    /// 自动配色的色系 id（`Some("")` = 这个文件明确不上自动色）
    pub scheme: Option<String>,
}

impl DocOpts {
    pub fn is_empty(&self) -> bool {
        self.look.is_none() && self.layout.is_none() && self.scheme.is_none()
    }

    /// 按注册表过滤：该格式没有的项一律丢掉（`looks` / `layouts` 为空就等于那一项非法）。
    pub fn sanitized(&self, format: FormatId) -> Self {
        let info = format::info(format);
        Self {
            look: self.look.clone().filter(|v| info.looks.iter().any(|x| x == v)),
            layout: self.layout.clone().filter(|v| info.layouts.iter().any(|x| x == v)),
            // 色系不是"某格式专有"的东西，但画布型不吃自动配色：存了也没用，直接丢
            scheme: self
                .scheme
                .clone()
                .filter(|v| v.is_empty() || (info.surface == app_ipc::Surface::Text && crate::palette::is_known(v))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Record {
    /// 原路径：只为人肉排查（身份是键，不靠它算）
    path: String,
    /// 最后一次改动时刻（ms）：淘汰最旧的用
    at: i64,
    #[serde(default)]
    opts: DocOpts,
}

/// 全部文件的渲染选项。键 = `conversations::doc_key(path)`。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Store {
    docs: BTreeMap<String, Record>,
}

impl Store {
    pub fn len(&self) -> usize {
        self.docs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.docs.is_empty()
    }

    /// 某路径记着的选项（没记过 → `None`）。
    ///
    /// **没有做 `sanitized`**：调用方（命令层）拿的是"这个文件当初选的什么"，
    /// 该由它按该文件此刻的格式过滤 —— 文件改了扩展名时格式会变。
    pub fn get(&self, path: &str) -> Option<&DocOpts> {
        self.docs.get(&conversations::doc_key(path)).map(|r| &r.opts)
    }

    /// 记下某路径的选项，并带上时刻（`at` 由调用方给：便于单测钉淘汰顺序）。
    /// 两项都空 ⇒ **删掉**这条，不留空壳。
    pub fn set(&mut self, path: &str, opts: DocOpts, at: i64) {
        let key = conversations::doc_key(path);
        if opts.is_empty() {
            self.docs.remove(&key);
            return;
        }
        self.docs.insert(key, Record { path: path.to_string(), at, opts });
        self.evict();
    }

    /// 删掉某路径的记录（另存为之后旧路径不该留着）。返回是否真删掉了东西。
    pub fn forget(&mut self, path: &str) -> bool {
        self.docs.remove(&conversations::doc_key(path)).is_some()
    }

    /// 超上限时按 `at` 淘汰最旧的几条。
    ///
    /// 这个 while 是必须的：磁盘上的文件可能是被手工塞大的（或者 `MAX_DOCS` 被调小过），
    /// 只淘汰一条会留一群超额的。撞上同 `at` 时按键序淘汰，仍然是确定的。
    fn evict(&mut self) {
        while self.docs.len() > MAX_DOCS {
            let Some(oldest) = self
                .docs
                .iter()
                .min_by(|a, b| a.1.at.cmp(&b.1.at).then_with(|| a.0.cmp(b.0)))
                .map(|(k, _)| k.clone())
            else {
                return;
            };
            self.docs.remove(&oldest);
        }
    }
}

/// 读。文件不存在 → 空；文件坏了 → 留一份 `.bak` 再回空（与 `settings::load` 同规矩）。
pub fn load(file: &Path) -> Store {
    let Ok(text) = std::fs::read_to_string(file) else {
        return Store::default();
    };
    match serde_json::from_str::<Store>(&text) {
        Ok(s) => s,
        Err(_) => {
            let _ = std::fs::rename(file, file.with_extension("json.bak"));
            Store::default()
        }
    }
}

/// 原子写：先写 `.tmp` 再 rename。
pub fn save(file: &Path, store: &Store) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("diagramon-render-opts-test");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn look(v: &str) -> DocOpts {
        DocOpts { look: Some(v.into()), ..Default::default() }
    }

    #[test]
    fn round_trips_per_path() {
        let f = tmp("round-trip.json");
        let mut st = Store::default();
        st.set("E:/proj/a.mmd", look("handDrawn"), 1);
        st.set("E:/proj/b.dot", DocOpts { layout: Some("neato".into()), ..Default::default() }, 2);
        save(&f, &st).unwrap();

        let back = load(&f);
        assert_eq!(back.len(), 2);
        assert_eq!(back.get("E:/proj/a.mmd"), Some(&look("handDrawn")));
        assert_eq!(back.get("E:/proj/b.dot").and_then(|o| o.layout.clone()).as_deref(), Some("neato"));
        assert_eq!(back.get("E:/proj/c.mmd"), None, "没记过的文件不能凭空有值");
    }

    #[test]
    fn path_identity_ignores_case_and_slash_style() {
        let mut st = Store::default();
        st.set("E:/Proj/A.MMD", look("neo"), 1);
        assert_eq!(st.len(), 1);
        assert_eq!(st.get("e:\\proj\\a.mmd"), Some(&look("neo")), "同一个文件只该有一条记录");
        st.set("E:\\proj\\A.mmd", look("classic"), 2);
        assert_eq!(st.len(), 1, "换个写法写同一条，不应多出一条");
        assert_eq!(st.get("E:/proj/a.mmd"), Some(&look("classic")));
    }

    #[test]
    fn sanitize_drops_values_the_registry_does_not_have() {
        // DOT 没有外观模式；"nope" 不是任何格式的布局
        let mixed = DocOpts { look: Some("neo".into()), layout: Some("nope".into()), ..Default::default() }.sanitized(FormatId::Dot);
        assert_eq!(mixed, DocOpts::default());
        let partial = DocOpts { look: Some("neo".into()), layout: Some("neato".into()), ..Default::default() }.sanitized(FormatId::Dot);
        assert_eq!(partial, DocOpts { layout: Some("neato".into()), ..Default::default() });
        let mmd = DocOpts { look: Some("handDrawn".into()), layout: Some("elk".into()), ..Default::default() }.sanitized(FormatId::Mermaid);
        assert_eq!(mmd, DocOpts { look: Some("handDrawn".into()), layout: Some("elk".into()), ..Default::default() });
    }

    #[test]
    fn empty_opts_delete_the_record_instead_of_leaving_a_shell() {
        let mut st = Store::default();
        st.set("E:/a.mmd", look("neo"), 1);
        st.set("E:/a.mmd", DocOpts::default(), 2);
        assert!(st.is_empty(), "两项都没了就该删掉这条");
        assert_eq!(st.get("E:/a.mmd"), None);
    }

    #[test]
    fn over_the_cap_evicts_the_oldest() {
        let mut st = Store::default();
        for i in 0..(MAX_DOCS as i64 + 3) {
            st.set(&format!("E:/f{i}.mmd"), look("neo"), i);
        }
        assert_eq!(st.len(), MAX_DOCS);
        assert_eq!(st.get("E:/f0.mmd"), None, "最旧的先走");
        assert!(st.get(&format!("E:/f{}.mmd", MAX_DOCS + 2)).is_some(), "刚写的必须在");
    }

    #[test]
    fn forget_drops_only_that_path() {
        let mut st = Store::default();
        st.set("E:/a.mmd", look("neo"), 1);
        st.set("E:/b.mmd", look("neo"), 2);
        assert!(st.forget("E:/a.mmd"));
        assert!(!st.forget("E:/a.mmd"), "删第二次是 no-op");
        assert_eq!(st.get("E:/a.mmd"), None);
        assert!(st.get("E:/b.mmd").is_some());
    }

    #[test]
    fn broken_file_is_kept_as_bak_and_reads_as_empty() {
        let f = tmp("broken.json");
        std::fs::write(&f, "{ this is not json").unwrap();
        let st = load(&f);
        assert!(st.is_empty());
        assert!(f.with_extension("json.bak").exists(), "坏文件要留一份 .bak，不静默删");
        assert!(load(&tmp("never-written.json")).is_empty(), "文件不存在就是空的");
    }
}
