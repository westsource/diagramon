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

/// 单个文件记住的渲染选项。两项都为 `None` 表示"没记过"。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DocOpts {
    /// Mermaid 外观模式（auto / classic / neo / handDrawn）
    pub look: Option<String>,
    /// 布局引擎（DOT 六种 / D2 三种 / Mermaid 两种）
    pub layout: Option<String>,
}

impl DocOpts {
    pub fn is_empty(&self) -> bool {
        self.look.is_none() && self.layout.is_none()
    }

    /// 按注册表过滤：该格式没有的项一律丢掉（`looks` / `layouts` 为空就等于那一项非法）。
    pub fn sanitized(&self, format: FormatId) -> Self {
        let info = format::info(format);
        Self {
            look: self.look.clone().filter(|v| info.looks.iter().any(|x| x == v)),
            layout: self.layout.clone().filter(|v| info.layouts.iter().any(|x| x == v)),
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
    /// 用过 Mermaid 的 `elk` 布局吗？—— 启动预热 ELK 离线包的**唯一依据**（见 `AppInfo.warm_elk`）。
    ///
    /// 一次下拉选择留下的痕迹，与"每个文件记着什么"同源同文件，所以放这里而不是 `settings`
    /// （settings 是用户偏好，不该被一次布局选择改写）。一旦为真就一直是真：用过 elk 的人
    /// 大概率还会用，而下次提前加载能让首次切换少等约 0.5 秒。
    used_elk: bool,
}

impl Store {
    pub fn len(&self) -> usize {
        self.docs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.docs.is_empty()
    }

    /// 记下"这份文档用了哪个布局"。只有 **Mermaid + elk** 会让启动预热成立 ——
    /// D2 也有同名 `elk`，但那个跑在 D2 自己的 wasm 里，跟这个离线包无关。
    pub fn note_layout(&mut self, format: FormatId, layout: Option<&str>) {
        if format == FormatId::Mermaid && layout == Some("elk") {
            self.used_elk = true;
        }
    }

    /// 启动时要不要在后台预热 Mermaid 的 ELK 离线包（消费者：`ui/js/main.js`）。
    ///
    /// 成本是**一次性且常驻**的（实测：JS 堆 +7.7MB、应用进程工作集 +16MB、加载约 0.5s），
    /// 所以没有依据的人一分不付，只在首次切换时加载（那时布局菜单也会顺手预热）。
    pub fn wants_elk_warmup(&self) -> bool {
        self.used_elk
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
        DocOpts { look: Some(v.into()), layout: None }
    }

    #[test]
    fn round_trips_per_path() {
        let f = tmp("round-trip.json");
        let mut st = Store::default();
        st.set("E:/proj/a.mmd", look("handDrawn"), 1);
        st.set("E:/proj/b.dot", DocOpts { look: None, layout: Some("neato".into()) }, 2);
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
        let mixed = DocOpts { look: Some("neo".into()), layout: Some("nope".into()) }.sanitized(FormatId::Dot);
        assert_eq!(mixed, DocOpts::default());
        let partial = DocOpts { look: Some("neo".into()), layout: Some("neato".into()) }.sanitized(FormatId::Dot);
        assert_eq!(partial, DocOpts { look: None, layout: Some("neato".into()) });
        let mmd = DocOpts { look: Some("handDrawn".into()), layout: Some("elk".into()) }.sanitized(FormatId::Mermaid);
        assert_eq!(mmd, DocOpts { look: Some("handDrawn".into()), layout: Some("elk".into()) });
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
    fn elk_warmup_signal_only_comes_from_mermaid_layouts() {
        let mut st = Store::default();
        assert!(!st.wants_elk_warmup(), "新库不该有预热依据");

        // D2 也叫 elk，但那是 D2 wasm 自己的布局，跟 Mermaid 的离线包无关
        st.note_layout(FormatId::D2, Some("elk"));
        assert!(!st.wants_elk_warmup(), "D2 的 elk 不该让 Mermaid 的离线包预热");
        // Mermaid 的其它布局同理
        st.note_layout(FormatId::Mermaid, Some("dagre"));
        assert!(!st.wants_elk_warmup());
        st.note_layout(FormatId::Mermaid, None);
        assert!(!st.wants_elk_warmup());

        st.note_layout(FormatId::Mermaid, Some("elk"));
        assert!(st.wants_elk_warmup(), "Mermaid 选过 elk 就是依据");
        // 一次就够，且**不会被后来的别的布局抹掉**（用过的人大概率还会用）
        st.note_layout(FormatId::Mermaid, Some("dagre"));
        assert!(st.wants_elk_warmup());

        // 落盘/读回要保住这个信号（它决定了下次启动预不预热）
        let f = tmp("elk-signal.json");
        save(&f, &st).unwrap();
        assert!(load(&f).wants_elk_warmup());
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
