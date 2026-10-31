//! 自动配色的**色系注册表**与**确定性落地**。
//!
//! 为什么色值不由模型给：同一个提示词两次生成，模型给的 hex 每次不同；它还看不见当前
//! 主题，暗色下常写出刺眼的浅底。跨格式更是各写一套（Mermaid `classDef` / DOT
//! `fillcolor` / D2 `style.fill`）。所以这里的约定是：
//!
//!   * **模型只写角色**（`:::lvl-entry` / `palette_role="ext"` / `X.class: decide`），
//!     语义判断是它擅长的，色值不是；
//!   * **色系 = 一个种子色相 + 一条明度/饱和度梯度**，七个角色按固定色相偏移派生。
//!     于是"加一个色系"是在 [`SEEDS`] 里加一行，而不是手抄 36 个 hex；
//!   * **颜色还编码结构**：没有语义特征的节点按它所在的 `subgraph` / `cluster` /
//!     D2 容器分子组上色（色相轮，最多 9 档）。七个角色只覆盖"入口/判断/数据/外部/
//!     异常"这些**语义**，而真实架构图里的绝大多数节点是普通节点 —— 只按角色上色会
//!     出现"一大片同色"，分组才是它们真正的区分维度。
//!   * 落地是**纯函数**（正文进、正文出，不读会话），可以在单测里钉死，也可以被
//!     前端在任何时刻重跑（换色系 = 重新展开，0 次模型调用）。
//!
//! 三个文本格式的落地方式（都能被 `convert` 认，换格式时颜色跟着走）：
//!
//! | 格式 | 怎么写 | 为什么这么写 |
//! |---|---|---|
//! | Mermaid | 文档末尾追加 `classDef lvl-* …` + `class A,B lvl-*` | classDef 是 Mermaid 唯一不给节点加噪音的批量上色方式 |
//! | DOT | 文档末尾追加 `A [fillcolor=…, color=…, fontcolor=…]` | DOT 允许后出现的语句覆盖属性，不必改原文 |
//! | D2 | 文档末尾追加 `A.style.fill: …` | D2 的属性后写者生效；不碰用户已有的 `classes:` 块 |
//!
//! 生成的内容一律用注释包在 `dgm-palette:begin/end` 之间 —— 重跑就是替换这一块，
//! **幂等**，且用户看得见"哪些行是程序加的"。
//!
//! 已知边界（如实写下来，不假装支持）：
//!   * 画布型（drawio / Excalidraw）没有稳定的节点角色，直接拒绝；
//!   * Mermaid 只有 flowchart 能这么上色（序列图/状态图/类图没有 classDef）；
//!   * 色值落进文档后**不跟随主题** —— 换主题要重新点一次配色；
//!   * "已有颜色"只认**真的带颜色**的 `classDef`（或 `style`）：用户把 `classDef` 删了、
//!     节点上的 `:::catalog` 还在，不该被当成"已经有色"而整批跳过。

use app_ipc::{
    FormatId, PaletteApplyRes, PaletteInfo, PaletteLine, PaletteMode, PaletteNode, PaletteProbe,
    PaletteRole, PaletteScan, RoleSwatch,
};
use std::collections::BTreeMap;

use crate::convert;

/* ------------------------------------------------------------------ 注册表 */

/// 六个图表角色。顺序即"从主干到边角"，也是提示词里讲解的顺序。
///
/// 名字会以 `lvl-` 前缀写进文档（`lvl-main`）：既短，又不会跟用户自己的 class 撞。
pub const ROLES: [&str; 7] = ["main", "entry", "decide", "data", "ext", "risk", "note"];

/// 角色类名的前缀。`lvl-main` / `lvl-entry` …
pub const ROLE_PREFIX: &str = "lvl-";

/// 一个色系的种子：色相 + 基础饱和度。**明度不在这里** —— 明度来自统一的梯度，
/// 这样才能保证任何色系在任何角色上都落在同一档对比度上。
struct Seed {
    id: &'static str,
    zh: &'static str,
    en: &'static str,
    hue: f32,
    sat: f32,
}

/// 可选色系。加一种 = 加一行（前端菜单、`app_info`、提示词三处自动跟上）。
///
/// 色相不是随便填的：七个角色里六个有色相，**任意两个必须相隔 >= [`MIN_SEP_HUE`]**，
/// 告警还固定在 [`RISK_HUE`]（暖红）—— 所以梯度会自己挑方向（见 [`ladder`]）。
/// 加色系时先跑 `every_palette_keeps_its_roles_apart`，别靠肉眼选。
///
/// **为什么是 6 个而不是 8 个**（2026-10-30 实测，CIE76）：
/// 角色铺满 210° 色相，每个色系自带一条彩虹，于是两个色系挨得近时"换色系等于没换"——
/// 8 个色系里 青瓷(192°) / 藕紫(258°) 的**同角色**最小 ΔE 只有 2。
/// 去掉 青瓷(192°) 与 靛青(238°) 之后，同角色跨色系的最差 ΔE 是 17、中位 26。
/// 想再加色系？先量"同角色跨色系最小 ΔE >= 15"，别只看主色。
///
/// `tungsten`（钨灰）是特例：饱和度接近 0，角色靠**明度阶梯**分开（打印/线框风）。
const SEEDS: [Seed; 6] = [
    Seed { id: "indigo", zh: "黛蓝", en: "Indigo", hue: 210.0, sat: 0.40 },
    Seed { id: "pine", zh: "松绿", en: "Pine", hue: 168.0, sat: 0.42 },
    Seed { id: "lotus", zh: "藕紫", en: "Lotus", hue: 258.0, sat: 0.34 },
    Seed { id: "olive", zh: "橄榄", en: "Olive", hue: 95.0, sat: 0.40 },
    Seed { id: "ochre", zh: "赭石", en: "Ochre", hue: 42.0, sat: 0.48 },
    Seed { id: "tungsten", zh: "钨灰", en: "Tungsten", hue: 218.0, sat: 0.05 },
];

/// 告警角色的固定色相（与 UI 的 `--err` 同族，跨主题/跨色系都这么红）。
const RISK_HUE: f32 = 6.0;

fn find(id: &str) -> Option<&'static Seed> {
    SEEDS.iter().find(|s| s.id == id)
}

/// 这个 id 是不是合法色系（对外只暴露布尔，`Seed` 不外泄）。
pub fn is_known(id: &str) -> bool {
    find(id).is_some()
}

/// 全部色系 id（设置校验、菜单顺序都吃这一份）。
pub fn ids() -> Vec<&'static str> {
    SEEDS.iter().map(|s| s.id).collect()
}

/// 文档里的角色类名：`lvl-<role>`。
pub fn role_class(role: &str) -> String {
    format!("{ROLE_PREFIX}{role}")
}

/// 反解：`lvl-decide` → `decide`；不是我们的类返回 `None`。
pub fn role_of_class(class: &str) -> Option<&'static str> {
    let tail = class.strip_prefix(ROLE_PREFIX)?;
    ROLES.iter().copied().find(|r| *r == tail)
}

/// 给 `app_info` 的完整清单（亮/暗两套色值都给，前端画色块用）。
pub fn infos() -> Vec<PaletteInfo> {
    SEEDS
        .iter()
        .map(|s| PaletteInfo {
            id: s.id.to_string(),
            name_zh: s.zh.to_string(),
            name_en: s.en.to_string(),
            roles: ROLES
                .iter()
                .map(|r| {
                    let (lf, ls, lt) = swatch(s, r, false);
                    let (df, ds, dt) = swatch(s, r, true);
                    PaletteRole {
                        role: (*r).to_string(),
                        light: RoleSwatch { fill: lf, stroke: ls, text: lt },
                        dark: RoleSwatch { fill: df, stroke: ds, text: dt },
                    }
                })
                .collect(),
            edge_light: edge_swatch(s, false),
            edge_dark: edge_swatch(s, true),
        })
        .collect()
}

/// 色系的中文名（提示词、状态栏、菜单共用）。
pub fn name_zh(id: &str) -> Option<&'static str> {
    find(id).map(|s| s.zh)
}

/// 色系的英文名（英文界面）。
pub fn name_en(id: &str) -> Option<&'static str> {
    find(id).map(|s| s.en)
}

/// 提示词里的配色约定：**模型只写角色，不写色值**。
///
/// 画布型返回 `None`（那边没有角色机制，写进去也没人兑现）。三种文本格式各给一行
/// 可照抄的例子 —— 真实语料证明"给例子"比"讲规则"有效得多。
pub fn prompt_rules(format: FormatId) -> Option<&'static str> {
    match format {
        FormatId::Mermaid => Some(
            "配色由应用按色系落地，你**只标角色、绝不写色值**（不要写 style / classDef / #hex）：\n             - 入口/触发/终止：`A([开始]):::lvl-entry`\n             - 判断/分支：`C{是否通过?}:::lvl-decide`\n             - 数据/存储：`D[(用户库)]:::lvl-data`\n             - 外部系统/异步：`E[外部网关]:::lvl-ext`\n             - 异常/告警：`F[支付失败]:::lvl-risk`\n             - 说明/注释：`G[说明]:::lvl-note`\n             - 其余主链路节点什么都不加（默认 lvl-main）。",
        ),
        FormatId::Dot => Some(
            "配色由应用按色系落地，你**只标角色、绝不写色值**（不要写 fillcolor / color / fontcolor）：\n             在节点属性里写 `palette_role`：`A [shape=ellipse, palette_role=\"entry\"]`。\n             角色取值：main / entry / decide / data / ext / risk / note（其余节点不写即默认 main）。",
        ),
        FormatId::D2 => Some(
            "配色由应用按色系落地，你**只标角色、绝不写色值**（不要写 style.fill / stroke）：\n             用类名标注：`A.class: lvl-entry`（可写多行，分别给不同节点）。\n             角色取值：main / entry / decide / data / ext / risk / note（其余节点不写即默认 main）。",
        ),
        FormatId::Drawio | FormatId::Excalidraw => None,
    }
}

/* ------------------------------------------------------------------ 颜色数学 */

fn hue_norm(h: f32) -> f32 {
    ((h % 360.0) + 360.0) % 360.0
}

fn hue_dist(a: f32, b: f32) -> f32 {
    let d = (hue_norm(a) - hue_norm(b)).abs();
    if d > 180.0 {
        360.0 - d
    } else {
        d
    }
}

/// 非中性色系里任意两个角色色相的最小间隔（度）。
///
/// 低于它就分不清"这是异常还是主链路"。测试与 `ladder()` 共用同一个数 ——
/// 门禁和实现漂开的话，加色系时会出现"测试绿了、图上却糊成一片"。
pub const MIN_SEP_HUE: f32 = 32.0;

/// 一套色系**实际用到**的色相（顺序与 [`ROLES`] 一一对应）。
///
/// 规则（确定性，无随机）：
/// 1. 主干四个角色从种子上按 `35°` 步长展开；
/// 2. 方向由"离告警红最远的那个方向"决定 —— 正向会撞红就整体镜像，
///    于是暖色系（藕紫）也不用挪种子；
/// 3. `ext` 不在固定偏移上，而是从候选里挑第一个"谁也不挨着"的槽位
///    （`seed-45` 在暖色系里正好落在红带上）；
/// 4. `note` 与 `main` 同色相：它靠 6% 的低饱和变成近中性，区分它的是饱和度。
fn ladder(seed: &Seed) -> [f32; 7] {
    if seed.sat < NEUTRAL_SAT {
        // 中性色系：色相不参与区分（见 swatch 的明度阶梯特例）
        return [seed.hue; 7];
    }
    let along = |k: f32| seed.hue + k * HUE_STEP;
    let fwd = [along(0.0), along(1.0), along(2.0), along(3.0)];
    let mirrored = [along(0.0), along(-1.0), along(-2.0), along(-3.0)];
    let clearance = |l: &[f32; 4]| l.iter().map(|h| hue_dist(*h, RISK_HUE)).fold(f32::MAX, f32::min);
    let base = if clearance(&fwd) >= MIN_SEP_HUE { fwd } else { mirrored };

    let mut used: Vec<f32> = base.to_vec();
    used.push(RISK_HUE);
    let ext = [along(-45.0 / HUE_STEP), along(4.0), along(5.0), along(6.0)]
        .into_iter()
        .find(|h| used.iter().all(|u| hue_dist(*h, *u) >= MIN_SEP_HUE))
        .unwrap_or(along(4.0));
    [base[0], base[1], base[2], base[3], ext, RISK_HUE, seed.hue]
}

/// 色相展开的步长（度）。四个主干角色各占一格。
const HUE_STEP: f32 = 35.0;

/// 低于这个饱和度的色系按"中性"处理（角色靠明度分，不靠色相）。
const NEUTRAL_SAT: f32 = 0.12;

/// 中性色系里各角色的描边明度（顺序同 [`ROLES`]）。亮色一套、暗色一套：
/// 灰阶没有色相可用，只能靠明度台阶把七个角色拉开，且步长必须肉眼可分。
const GRAY_STROKE_LIGHT: [f32; 7] = [0.44, 0.32, 0.22, 0.58, 0.70, 0.50, 0.82];
const GRAY_STROKE_DARK: [f32; 7] = [0.62, 0.54, 0.46, 0.71, 0.80, 0.50, 0.88];

fn role_sat(seed_sat: f32, role: &str) -> f32 {
    match role {
        "risk" => seed_sat.max(0.58),
        // 说明类压到近中性：它不该抢主链路的注意力
        "note" => 0.06,
        _ => seed_sat,
    }
}

/// 连线的颜色：同一个色系的种子色相，但**压低饱和、暗一档**。
///
/// 线的职责是"结构"，不该跟角色抢注意力 —— 所以只用主色相的一点点倾向，
/// 而不是按源节点的角色染色（那需要按边序号写 `linkStyle`，文档一改就错位）。
fn edge_swatch(seed: &Seed, dark: bool) -> String {
    // 中性色系（钨灰）也给一条近乎无彩的线，保持"线框风"一致
    let s = (seed.sat * 0.45).min(0.30);
    hsl_hex(seed.hue, s, if dark { 0.66 } else { 0.40 })
}

/// 分组色相：按"首次出现顺序"编号的组依次旋转色轮。
///
/// `step` 取自组数（6 组以内保持 60°，组多了自动收窄），并避开固定的告警红 ——
/// 分组是**背景信息**，不能把"这里会出事"的红抢走。
fn group_hue(seed_hue: f32, idx: usize, groups: usize) -> f32 {
    // 色轮最多分 9 档（40° 一档）：22 个 subgraph 也照样能看出"不同块"，
    // 但不会出现 19 个 19° 间隔、肉眼分不开的色相。超出部分按顺序复用。
    let ring = groups.clamp(1, 9);
    let step = 360.0 / ring.max(6) as f32;
    let mut h = seed_hue + step * (idx % ring) as f32;
    let mut guard = 0;
    while hue_dist(h, RISK_HUE) < 26.0 && guard < 12 {
        h += 7.0; // 撞红就整体挪一点，确定性的
        guard += 1;
    }
    h
}

/// 槽位取色：`main/entry/…` 走角色槽位；`g0/g1/…` 走分组色轮。
///
/// 分组的填充比语义角色**再浅一档**：它表达"这是同一块"，不该和"这是异常/判断"抢注意力。
fn slot_swatch(seed: &Seed, slot: &str, dark: bool, groups: usize) -> (String, String, String) {
    let Some(idx) = slot.strip_prefix('g').and_then(|d| d.parse::<usize>().ok()) else {
        return swatch(seed, slot, dark);
    };
    let h = group_hue(seed.hue, idx, groups);
    let s = seed.sat;
    if dark {
        (hsl_hex(h, s * 0.52, 0.26), hsl_hex(h, s, 0.58), hsl_hex(h, s * 0.45, 0.90))
    } else {
        (hsl_hex(h, s * 0.52, 0.89), hsl_hex(h, s, 0.46), hsl_hex(h, s * 0.90, 0.22))
    }
}

/// 一个角色在某个主题下的 (fill, stroke, text)。
///
/// 明度梯度是全局的：亮色 94/50/22、暗色 22/60/90。于是"文字压在填充上"的对比度
/// 在每个色系、每个角色上都成立 —— 这是"自动"的另一半：不是挑好看的，是挑可读的。
fn swatch(seed: &Seed, role: &str, dark: bool) -> (String, String, String) {
    let hues = ladder(seed);
    let idx = ROLES.iter().position(|r| *r == role).unwrap_or(0);
    if seed.sat < NEUTRAL_SAT && role != "risk" {
        // 中性色系：填充恒为极浅/极深的一档，角色差异全在描边上（线框风）
        let l = if dark { GRAY_STROKE_DARK[idx] } else { GRAY_STROKE_LIGHT[idx] };
        let fill_l = if dark { 0.22 } else { 0.95 };
        return (
            hsl_hex(seed.hue, 0.04, fill_l),
            hsl_hex(seed.hue, 0.06, l),
            hsl_hex(seed.hue, 0.02, if dark { 0.90 } else { 0.20 }),
        );
    }
    // 告警永远是那一抹红：中性色系里它是**唯一**有色相的角色
    let h = if role == "risk" { RISK_HUE } else { hues[idx] };
    let s = role_sat(seed.sat, role);
    if dark {
        (hsl_hex(h, s * 0.55, 0.22), hsl_hex(h, s, 0.60), hsl_hex(h, s * 0.50, 0.90))
    } else {
        // 亮色填充曾经是 L94 / S×0.55：七个角色两两 ΔE 只有 1.2（人眼 ~2 以下看不出），
        // 节点身体几乎同色、全靠 1.6px 描边撑着。L88 / S×0.95 之后 ΔE 3.6–5.9，
        // 文字对比度仍有 7:1（可读性没牺牲）。
        (hsl_hex(h, s * 0.95, 0.88), hsl_hex(h, s, 0.50), hsl_hex(h, s * 0.95, 0.22))
    }
}

/// HSL → `#rrggbb`。不引第三方库：这里只需要"可预测"，不需要色彩管理。
fn hsl_hex(h: f32, s: f32, l: f32) -> String {
    let h = hue_norm(h) / 360.0;
    let s = s.clamp(0.0, 1.0);
    let l = l.clamp(0.0, 1.0);
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h * 6.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = match (h * 6.0).floor() as i32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let q = |v: f32| format!("{:02x}", (((v + m) * 255.0).round() as i32).clamp(0, 255));
    format!("#{}{}{}", q(r), q(g), q(b))
}

/* ------------------------------------------------------------------ 角色推断 */

/// 标签关键词 → 角色。确定性、可解释（用户看得懂为什么这个节点是红的）。
const RISK_WORDS: [&str; 8] = ["异常", "错误", "失败", "告警", "超时", "error", "fail", "alert"];
const ENTRY_WORDS: [&str; 8] = ["开始", "入口", "触发", "启动", "结束", "start", "begin", "end"];
// 「校验」不进这个词表：它同样出现在普通处理节点上（真实语料里"校验请求"多半是个方框），
// 拿它判断"是不是分支"会把主链路染成判断色。判断只认问号与明确的判断词。
const DECIDE_WORDS: [&str; 5] = ["是否", "判断", "?", "？", "if "];
const EXT_WORDS: [&str; 10] = [
    "外部", "第三方", "异步", "队列", "缓存", "网关", "external", "async", "queue", "cache",
];
/// 「数据/存储」：库表、持久化。与"外部系统"分开 —— 一类是你自己的数据，一类是别人的服务。
const DATA_WORDS: [&str; 8] = ["数据库", "库表", "存储", "归档", "database", "storage", "sql", "db"];

fn role_from_label(label: &str) -> Option<&'static str> {
    let l = label.to_lowercase();
    let hit = |words: &[&str]| words.iter().any(|w| l.contains(w));
    if hit(&RISK_WORDS) {
        return Some("risk");
    }
    if hit(&DECIDE_WORDS) {
        return Some("decide");
    }
    if hit(&DATA_WORDS) {
        return Some("data");
    }
    if hit(&EXT_WORDS) {
        return Some("ext");
    }
    if hit(&ENTRY_WORDS) {
        return Some("entry");
    }
    None
}

fn role_from_shape(shape: &str) -> Option<&'static str> {
    match shape {
        "diamond" | "hexagon" | "mdiamond" => Some("decide"),
        // 圆柱 / 3D 盒 / 子程序框 = 库表、存储
        "cylinder" | "box3d" | "subroutine" | "sql_table" | "package" => Some("data"),
        "queue" | "cloud" | "person" | "component" => Some("ext"),
        "stadium" | "circle" | "doublecircle" | "oval" => Some("entry"),
        "note" => Some("note"),
        _ => None,
    }
}


/// DOT 里**显式写出来**的 shape 才有意义：Graphviz 默认所有节点都是 ellipse，
/// 把"没写 shape"当成入口节点会让整张图全变入口色。
fn role_from_dot_shape(shape: &str) -> Option<&'static str> {
    match shape.to_ascii_lowercase().as_str() {
        "diamond" | "mdiamond" => Some("decide"),
        "cylinder" | "box3d" => Some("data"),
        "component" => Some("ext"),
        "doublecircle" | "circle" | "oval" => Some("entry"),
        "note" => Some("note"),
        _ => None,
    }
}

fn role_from_d2_shape(shape: &str) -> Option<&'static str> {
    match shape.to_ascii_lowercase().replace(' ', "_").as_str() {
        "diamond" | "hexagon" => Some("decide"),
        "cylinder" | "sql_table" | "package" => Some("data"),
        "queue" | "cloud" | "person" => Some("ext"),
        "oval" | "circle" => Some("entry"),
        "note" => Some("note"),
        _ => None,
    }
}

/* ------------------------------------------------------------------ 入口 */

/// 按色系重排一份正文。**纯函数**：不读会话、不改文档，调用方决定写不写回。
pub fn apply(
    body: &str,
    format: FormatId,
    palette_id: &str,
    dark: bool,
    edges: bool,
    mode: PaletteMode,
) -> Result<PaletteApplyRes, String> {
    let seed = find(palette_id)
        .ok_or_else(|| format!("没有这个色系：「{palette_id}」（可选：{}）", ids().join(" / ")))?;
    match format {
        FormatId::Mermaid => apply_mermaid(body, seed, dark, edges, mode),
        FormatId::Dot => apply_dot(body, seed, dark, edges, mode),
        FormatId::D2 => apply_d2(body, seed, dark, edges, mode),
        FormatId::Drawio | FormatId::Excalidraw => Err(
            "画布型格式没有稳定的节点角色，自动配色只在 Mermaid / DOT / D2 上生效"
                .to_string(),
        ),
    }
}

/// 清除配色：把程序生成的那一段**整块**删掉。
///
/// 与「关闭自动配色」的区别：那个只是不再上色，已经写进文档的 `classDef` 会一直留着；
/// 这里是真正把它拿掉。手写样式/用户自己的 class **一个都不碰** —— 我们只删自己标记块里的行。
///
/// 画布型没有我们的块，返回"没变"（不是错误：在画布型上点清除本来就该是空操作）。
pub fn clear(body: &str, format: FormatId) -> PaletteApplyRes {
    let (begin, end) = match format {
        FormatId::Mermaid => ("%% dgm-palette:begin", "%% dgm-palette:end"),
        FormatId::Dot => ("// dgm-palette:begin", "// dgm-palette:end"),
        FormatId::D2 => ("# dgm-palette:begin", "# dgm-palette:end"),
        FormatId::Drawio | FormatId::Excalidraw => {
            return PaletteApplyRes {
                body: body.to_string(),
                changed: false,
                applied: 0,
                skipped: 0,
                styles_removed: 0,
            }
        }
    };
    let (out, removed) = strip_block(body, begin, end);
    PaletteApplyRes {
        changed: removed && out != body,
        body: if removed { out } else { body.to_string() },
        applied: 0,
        skipped: 0,
        styles_removed: 0,
    }
}

/* ------------------------------------------------------------------ 检测 */

/// 文件里那块色系标记属于哪个色系。
///
/// 新块第一行带 `id=<id>`；老块（3.11.3/3.11.4 早期）只有中文名，按名字反向匹配 ——
/// 兼容它们不是洁癖：用户盘上已经有那种文件了。
pub fn block_palette(body: &str, format: FormatId) -> Option<String> {
    let marker = match format {
        FormatId::Mermaid => "%% dgm-palette:begin",
        FormatId::Dot => "// dgm-palette:begin",
        FormatId::D2 => "# dgm-palette:begin",
        FormatId::Drawio | FormatId::Excalidraw => return None,
    };
    let line = body.lines().find(|l| l.trim_start().starts_with(marker))?;
    if let Some(rest) = line.split("id=").nth(1) {
        let id: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if is_known(&id) {
            return Some(id);
        }
    }
    // 老块：靠中文名反查
    SEEDS.iter().find(|s| line.contains(s.zh)).map(|s| s.id.to_string())
}

/// 探测：已经烘焙过就照它，否则按图的内容挑一个。
pub fn probe(body: &str, format: FormatId) -> PaletteProbe {
    if matches!(format, FormatId::Drawio | FormatId::Excalidraw) {
        return PaletteProbe::default();
    }
    if let Some(baked) = block_palette(body, format) {
        return PaletteProbe { baked: Some(baked), suggested: None, why: None };
    }
    let (id, why) = suggest(body, format).unwrap_or(("pine", "default"));
    PaletteProbe {
        baked: None,
        suggested: Some(id.to_string()),
        why: Some(why.to_string()),
    }
}

/// "这份图适合哪个色系"——**本地、确定、可解释**，不发请求。
///
/// 依据只有两类信号（都不猜语义，只看图里已经有的东西）：
///   1. 角色占比：数据/存储多 → 黛蓝；异常多 → 赭石；外部接口多 → 橄榄；
///   2. 标签词表：界面/页面/交互 → 藕紫；其余落到品牌松绿。
/// 钨灰不参与自动选择：它是"线框/打印"档，自动挑过去会让人以为图坏了。
fn suggest(body: &str, format: FormatId) -> Option<(&'static str, &'static str)> {
    let (role_counts, text) = collect_signals(body, format)?;
    let total: usize = role_counts.values().sum();
    if total == 0 {
        return None;
    }
    let share = |r: &str| role_counts.get(r).copied().unwrap_or(0) as f32 / total as f32;
    if share("data") >= 0.30 {
        return Some(("indigo", "data"));
    }
    if share("risk") >= 0.15 {
        return Some(("ochre", "risk"));
    }
    if share("ext") >= 0.30 {
        return Some(("olive", "ext"));
    }
    let lower = text.to_lowercase();
    const UI_WORDS: [&str; 6] = ["页面", "界面", "按钮", "交互", "screen", "ui"];
    if UI_WORDS.iter().any(|w| lower.contains(w)) {
        return Some(("lotus", "ui"));
    }
    Some(("pine", "default"))
}

/// 取"角色分布 + 全部标签文本"（三种格式各走自己的扫描器；画布型没有信号）。
fn collect_signals(
    body: &str,
    format: FormatId,
) -> Option<(std::collections::BTreeMap<String, usize>, String)> {
    use std::collections::BTreeMap;
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut text = String::new();
    match format {
        FormatId::Mermaid => {
            let facts = convert::flow_facts(body).ok()?;
            for n in &facts.nodes {
                let role = n
                    .classes
                    .iter()
                    .find_map(|c| role_of_class(c))
                    .or_else(|| role_from_shape(&n.shape.key()))
                    .or_else(|| n.label.as_deref().and_then(role_from_label))
                    .unwrap_or("main");
                *counts.entry(role.to_string()).or_default() += 1;
                if let Some(l) = &n.label {
                    text.push_str(l);
                    text.push(' ');
                }
            }
        }
        FormatId::Dot => {
            for n in dot_nodes(body) {
                let role = dot_role(&n).unwrap_or("main");
                *counts.entry(role.to_string()).or_default() += 1;
                if let Some(l) = n.attrs.get("label") {
                    text.push_str(l);
                    text.push(' ');
                }
            }
        }
        FormatId::D2 => {
            for n in d2_nodes(body).nodes {
                let role = n
                    .role
                    .or_else(|| n.shape.as_deref().and_then(role_from_d2_shape))
                    .unwrap_or("main");
                *counts.entry(role.to_string()).or_default() += 1;
                if let Some(l) = &n.label {
                    text.push_str(l);
                    text.push(' ');
                }
            }
        }
        FormatId::Drawio | FormatId::Excalidraw => return None,
    }
    Some((counts, text))
}

/* ------------------------------------------------------------------ 源码标注 */

/// 源码窗格的"行 → 角色"标注：这一行上有哪些节点、各会被染成什么色。
///
/// 为什么由后端算：角色是**推断**出来的（显式标记 > 形状 > 标签词 > 分组 > 主链路），
/// 前端再写一份就是第二套规则；而且"这个节点会不会被上色"还取决于它有没有手写颜色，
/// 只有展开器自己知道。这里直接复用 `apply` 的判定（`plan` + 同样的入参），
/// 所以标出来的颜色**必然**等于真渲染出来的颜色 —— 连分组色轮也是同一份计算。
///
/// 返回按行号升序；同一行多个节点按出现顺序。
pub fn annotate(body: &str, format: FormatId, dark: bool) -> Vec<PaletteLine> {
    let (base, _) = match format {
        FormatId::Mermaid => strip_block(body, "%% dgm-palette:begin", "%% dgm-palette:end"),
        FormatId::Dot => strip_block(body, "// dgm-palette:begin", "// dgm-palette:end"),
        FormatId::D2 => strip_block(body, "# dgm-palette:begin", "# dgm-palette:end"),
        FormatId::Drawio | FormatId::Excalidraw => return Vec::new(),
    };

    // 节点：(id, 行号, 显式角色, 是否已有颜色, 标签, 形状, 分组)
    let mut nodes: Vec<(
        String,
        u32,
        Option<&'static str>,
        bool,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = Vec::new();
    match format {
        FormatId::Mermaid => match convert::flow_facts(&base) {
            Ok(facts) => {
                for n in &facts.nodes {
                    let explicit = n.classes.iter().find_map(|c| role_of_class(c));
                    let colored = n.styled
                        || n
                            .classes
                            .iter()
                            .any(|c| !c.starts_with(ROLE_PREFIX) && facts.colored_classes.contains(c));
                    nodes.push((
                        n.id.clone(),
                        n.line,
                        explicit,
                        colored,
                        n.label.clone(),
                        Some(n.shape.key().to_string()),
                        n.group.clone(),
                    ));
                }
            }
            Err(_) => return Vec::new(), // 解析不了就没有标注（预览那边也会报错）
        },
        FormatId::Dot => {
            for n in dot_nodes(&base) {
                nodes.push((
                    n.id.clone(),
                    n.line,
                    dot_role(&n),
                    dot_is_colored(&n),
                    n.attrs.get("label").cloned(),
                    n.attrs.get("shape").cloned(),
                    n.group.clone(),
                ));
            }
        }
        FormatId::D2 => {
            for n in d2_nodes(&base).nodes {
                let explicit = n
                    .role
                    .or_else(|| n.shape.as_deref().and_then(role_from_d2_shape));
                nodes.push((
                    n.id.clone(),
                    n.line,
                    explicit,
                    n.has_fill,
                    n.label.clone(),
                    None,
                    n.group.clone(),
                ));
            }
        }
        FormatId::Drawio | FormatId::Excalidraw => return Vec::new(),
    }

    // 与 `apply` 用同一套判定：被跳过的（已有颜色）不在 `by_slot` 里
    let (by_slot, _) = plan(
        nodes
            .iter()
            .map(|(id, _, explicit, colored, label, shape, group)| {
                (
                    id.clone(),
                    *explicit,
                    *colored,
                    label.clone(),
                    shape.as_deref(),
                    group.clone(),
                )
            }),
        PaletteMode::OnlyUncolored,
    );
    let groups = by_slot.keys().filter(|k| k.starts_with('g')).count().max(1);
    // 与 `apply` 同源：文档里已有我们那块就按块里的色系，没有就按建议色系
    let auto = block_palette(&base, format)
        .or_else(|| suggest(&base, format).map(|(id, _)| id.to_string()))
        .unwrap_or_else(|| "pine".to_string());
    let seed = find(&auto).unwrap_or_else(|| find("pine").expect("pine 一定存在"));
    let mut slot_of: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    let mut colors: std::collections::HashMap<&str, (String, String, String)> =
        std::collections::HashMap::new();
    for (slot, ids) in &by_slot {
        let c = slot_swatch(seed, slot, dark, groups);
        for id in ids {
            slot_of.insert(id.as_str(), slot);
            colors.insert(id.as_str(), c.clone());
        }
    }

    // 按行分组（行号 0 = 解析器没记到行，跳过）
    let mut lines: BTreeMap<u32, Vec<PaletteNode>> = BTreeMap::new();
    for (id, line, ..) in &nodes {
        if *line == 0 {
            continue;
        }
        let c = colors.get(id.as_str());
        lines.entry(*line).or_default().push(PaletteNode {
            id: id.clone(),
            role: slot_of.get(id.as_str()).map(|r| r.to_string()),
            fill: c.map(|c| c.0.clone()),
            stroke: c.map(|c| c.1.clone()),
        });
    }
    lines
        .into_iter()
        .map(|(line, nodes)| PaletteLine { line, nodes })
        .collect()
}

/* ------------------------------------------------------------------ 清洗前的体检 */

/// 我们那块**之外**还剩多少处颜色痕迹。
///
/// 为什么需要它：`clear()` 只删自己生成的那一段。用户手写的 `style`、模型自己加的
/// `fillcolor`、从别处粘来的配色，它一概不碰（也就清不掉）。于是"点「无」之后图还是花的"
/// —— 这个函数回答"还剩几处"，有模型时再交给模型去删。
pub fn color_traces(body: &str, format: FormatId) -> usize {
    let (base, _) = match format {
        FormatId::Mermaid => strip_block(body, "%% dgm-palette:begin", "%% dgm-palette:end"),
        FormatId::Dot => strip_block(body, "// dgm-palette:begin", "// dgm-palette:end"),
        FormatId::D2 => strip_block(body, "# dgm-palette:begin", "# dgm-palette:end"),
        FormatId::Drawio | FormatId::Excalidraw => (body.to_string(), false),
    };
    let mut n = 0usize;
    for line in base.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("//") || t.starts_with('#') || t.starts_with("%%") {
            continue; // 注释不算（我们自己的块已经被剥掉了）
        }
        let hit = match format {
            FormatId::Mermaid => {
                (t.starts_with("style ") || t.starts_with("classDef ") || t.starts_with("linkStyle"))
                    && (t.contains("fill:") || t.contains("stroke:") || t.contains("color:"))
            }
            FormatId::Dot => {
                t.contains("fillcolor")
                    || t.contains("fontcolor")
                    || t.contains("bgcolor")
                    || t.contains("color=")
            }
            FormatId::D2 => {
                t.contains("style.fill")
                    || t.contains("style.stroke")
                    || t.contains("style.font-color")
            }
            FormatId::Drawio | FormatId::Excalidraw => false,
        };
        if hit {
            n += 1;
        }
    }
    n
}

/// 结构签名：节点 id（排序去重）+ 边数。
///
/// 只用来回答一个问题：「模型清洗完，结构还是原来那张图吗？」
/// 颜色不在里面 —— 这正是我们要允许它变化的部分。
pub fn structure_sig(body: &str, format: FormatId) -> Option<String> {
    let (base, _) = match format {
        FormatId::Mermaid => strip_block(body, "%% dgm-palette:begin", "%% dgm-palette:end"),
        FormatId::Dot => strip_block(body, "// dgm-palette:begin", "// dgm-palette:end"),
        FormatId::D2 => strip_block(body, "# dgm-palette:begin", "# dgm-palette:end"),
        FormatId::Drawio | FormatId::Excalidraw => return None,
    };
    let mut ids: Vec<String> = match format {
        FormatId::Mermaid => convert::flow_facts(&base).ok()?.nodes.into_iter().map(|n| n.id).collect(),
        FormatId::Dot => dot_nodes(&base).into_iter().map(|n| n.id).collect(),
        FormatId::D2 => d2_nodes(&base).nodes.into_iter().map(|n| n.id).collect(),
        FormatId::Drawio | FormatId::Excalidraw => return None,
    };
    ids.sort();
    ids.dedup();
    Some(ids.join(","))
}

/// 体检：还剩多少处颜色痕迹 + 结构签名。
pub fn scan(body: &str, format: FormatId) -> PaletteScan {
    PaletteScan { traces: color_traces(body, format), sig: structure_sig(body, format) }
}

/// 收集"这批节点各自是什么角色"，并把要不要跳过一起算出来。
///
/// 返回 (角色 → 节点列表, 跳过的个数)。**顺序稳定**（BTreeMap + 文档顺序），
/// 这样同一份文档两次展开产出的字节完全一致 —— 幂等是靠这个成立的。
fn plan<'a>(
    nodes: impl IntoIterator<Item = (String, Option<&'static str>, bool, Option<String>, Option<&'a str>, Option<String>)>,
    mode: PaletteMode,
) -> (BTreeMap<String, Vec<String>>, usize) {
    let nodes: Vec<_> = nodes.into_iter().collect();
    // 分组按**首次出现顺序**编号：同一份文档重跑得到同一套编号（幂等的前提）
    let mut group_idx: BTreeMap<String, usize> = BTreeMap::new();
    for (_, _, _, _, _, group) in &nodes {
        if let Some(g) = group {
            let n = group_idx.len();
            group_idx.entry(g.clone()).or_insert(n);
        }
    }
    let mut by_slot: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut skipped = 0usize;
    for (id, explicit, colored, label, shape, group) in nodes {
        if mode == PaletteMode::OnlyUncolored && colored && explicit.is_none() {
            skipped += 1;
            continue;
        }
        // 优先级：显式角色 > 形状/标签推断 > 分组 > 主链路
        let role = explicit
            .or_else(|| shape.and_then(role_from_shape))
            .or_else(|| label.as_deref().and_then(role_from_label));
        let slot = match role {
            Some(r) => r.to_string(),
            None => match group.and_then(|g| group_idx.get(&g).copied()) {
                Some(i) => format!("g{i}"),
                None => "main".to_string(),
            },
        };
        by_slot.entry(slot).or_default().push(id);
    }
    (by_slot, skipped)
}

fn strip_block<'a>(body: &'a str, begin: &str, end: &str) -> (String, bool) {
    if !body.contains(begin) {
        return (body.to_string(), false);
    }
    let mut out = String::with_capacity(body.len());
    let mut inside = false;
    let mut removed = false;
    for line in body.lines() {
        let t = line.trim();
        if !inside && t.starts_with(begin) {
            inside = true;
            removed = true;
            continue;
        }
        if inside {
            if t.starts_with(end) || t.contains(end) {
                inside = false;
            }
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    // 去掉块被删掉后尾部多出来的空行（只留一个换行收尾）
    while out.ends_with("\n\n") {
        out.pop();
    }
    (out, removed)
}


/* ------------------------------------------------------------------ Mermaid */

fn apply_mermaid(
    body: &str,
    seed: &Seed,
    dark: bool,
    edges: bool,
    mode: PaletteMode,
) -> Result<PaletteApplyRes, String> {
    // **先剥掉自己上次生成的块再扫描**：块里有 `linkStyle` 与 `class …`，
    // 让它们参与"这份图现在长什么样"的判断会把幂等性弄坏（换色系时还会读到自己写的类）。
    let (base, _) = strip_block(body, "%% dgm-palette:begin", "%% dgm-palette:end");
    let facts = convert::flow_facts(&base)?;
    if facts.nodes.is_empty() {
        return Ok(PaletteApplyRes { body: body.to_string(), changed: false, applied: 0, skipped: 0, styles_removed: 0 });
    }
    let items = facts.nodes.iter().map(|n| {
        let explicit = n.classes.iter().find_map(|c| role_of_class(c));
        // "已有颜色"必须是**真的带颜色**：删掉 classDef 之后残留的 `:::catalog` 不该拦配色
        // （以前只要"有类就算有颜色"，把你清过的图又悄悄跳掉八成节点）。
        let colored = n.styled
            || n
                .classes
                .iter()
                .any(|c| !c.starts_with(ROLE_PREFIX) && facts.colored_classes.contains(c));
        (
            n.id.clone(),
            explicit,
            colored,
            n.label.clone(),
            Some(n.shape.key()),
            n.group.clone(),
        )
    });
    let (by_slot, skipped) = plan(items, mode);

    let mut out = base;
    let mut styles_removed = 0usize;
    if mode == PaletteMode::All {
        let colored_ids: Vec<&String> = by_slot.values().flatten().collect();
        let (next, dropped) = drop_style_statements(&out, &colored_ids);
        out = next;
        styles_removed = dropped;
    }

    let mut block = String::from("%% dgm-palette:begin id=");
    block.push_str(seed.id);
    block.push_str("（Diagramon 自动配色 · ");
    block.push_str(seed.zh);
    block.push_str(if dark { " · 暗色" } else { " · 亮色" });
    block.push_str("）\n");
    let groups = by_slot.keys().filter(|k| k.starts_with('g')).count().max(1);
    let mut applied = 0usize;
    for (slot, ids) in &by_slot {
        let (fill, stroke, text) = slot_swatch(seed, slot, dark, groups);
        block.push_str(&format!(
            "classDef {} fill:{fill},stroke:{stroke},color:{text}\n",
            role_class(slot)
        ));
        applied += ids.len();
        block.push_str(&format!("class {} {}\n", ids.join(","), role_class(slot)));
    }
    // 连线统一跟随色系。**用 init 指令而不是 `linkStyle default`**：后者只改 `stroke`，
    // 箭头（marker）仍是主题的 #333，肉眼能看到"线是灰绿、箭头是深灰"的错位；
    // `themeVariables.lineColor` 把线和箭头一起换掉（mermaid 12 实测两种位置都生效）。
    if edges {
        let line = edge_swatch(seed, dark);
        block.push_str(&format!(
            "%%{{init: {{'themeVariables': {{'lineColor': '{line}'}}}}}}%%\n"
        ));
    }
    block.push_str("%% dgm-palette:end\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&block);

    Ok(PaletteApplyRes { changed: out != body, body: out, applied, skipped, styles_removed })
}

/// 删掉 `style <id> …` 语句（只针对这批节点）。返回 (新正文, 删了几条)。
///
/// 为什么必须删：Mermaid 里 `style` 的优先级**高于** `classDef`，不删的话"整篇重排"
/// 对这类节点等于没生效。
fn drop_style_statements(body: &str, ids: &[&String]) -> (String, usize) {
    let mut out = String::with_capacity(body.len());
    let mut dropped = 0usize;
    for line in body.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("style ") {
            let target = rest.split_whitespace().next().unwrap_or("");
            if ids.iter().any(|id| id.as_str() == target) {
                dropped += 1;
                continue;
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    (out, dropped)
}

/* ------------------------------------------------------------------ DOT */

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct DotNode {
    id: String,
    /// 首次出现的行号（1 基），给源码窗格的"行 → 角色"标注用
    line: u32,
    /// 所属 cluster（`subgraph cluster_x {` 的最内层）
    group: Option<String>,
    /// 合并后的属性（后出现的覆盖前面的）
    attrs: BTreeMap<String, String>,
}

/// 扫出 DOT 里的节点与属性。
///
/// 只认我们需要的：节点 id、属性表。**边**上的属性会被跳过（DOT 里 `A -> B [x]` 的
/// `[x]` 属于边不属于节点，误当节点属性会让我们错误地判断"这个节点已经有颜色了"）。
fn dot_nodes(body: &str) -> Vec<DotNode> {
    let src = strip_dot_comments(body);
    let chars: Vec<char> = src.chars().collect();
    let mut out: Vec<DotNode> = Vec::new();
    let mut i = 0usize;
    let mut in_edge = false; // 当前语句是边（属性归边）
    // `subgraph cluster_x { … }` 的嵌套栈：节点归属取最内层
    let mut groups: Vec<String> = Vec::new();
    let mut pending_group: Option<String> = None; // 刚读到 subgraph 后面的名字，等 `{` 确认
    let mut expect_subgraph = false;
    let mut line: u32 = 1; // 扫描到第几行（`\n` 自增）
    let mut skip_next_atom = false; // `digraph G` / `subgraph cluster_x`：下一个原子不是节点
    let mut skip_next_bracket = false; // `node [shape=…]` / `edge [...]`：默认属性
    let mut expect_value = false; // 刚读过 `key=`

    while i < chars.len() {
        let c = chars[i];
        if c == '\n' {
            line += 1;
            in_edge = false;
            // `subgraph` 后面必须紧跟名字再跟 `{`；换行/分号就说明那里没有名字
            expect_subgraph = false;
            pending_group = None;
            i += 1;
            continue;
        }
        if c == '{' {
            in_edge = false;
            // 匿名子图（`subgraph { … }`）没有名字：不能把里面第一个节点当成组名
            expect_subgraph = false;
            if let Some(g) = pending_group.take() {
                groups.push(g);
            }
            i += 1;
            continue;
        }
        if c == '}' {
            in_edge = false;
            groups.pop();
            i += 1;
            continue;
        }
        if c == ';' {
            in_edge = false;
            expect_subgraph = false;
            pending_group = None;
            i += 1;
            continue;
        }
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '[' {
            let (attrs_text, next) = read_bracket(&chars, i);
            if !skip_next_bracket && !in_edge {
                if let Some(last) = out.last_mut() {
                    merge_dot_attrs(&mut last.attrs, &attrs_text);
                }
            }
            skip_next_bracket = false;
            i = next;
            continue;
        }
        if c == '-' && i + 1 < chars.len() && (chars[i + 1] == '>' || chars[i + 1] == '-') {
            // `->` / `--`，可能带 `dir=back` 之类的方括号前缀，这里只在链内翻转状态
            i += 2;
            in_edge = true;
            continue;
        }
        if c == '=' {
            i += 1;
            continue;
        }
        // 读一个原子（裸标识符或引号串）
        if c == '"' {
            let (text, next) = read_quoted(&chars, i);
            i = next;
            if expect_value {
                expect_value = false;
                continue;
            }
            if skip_next_atom {
                skip_next_atom = false;
                continue;
            }
            push_dot_node(&mut out, &text, line, groups.last().map(|s| s.as_str()));
            continue;
        }
        let (atom, next) = read_bare(&chars, i);
        if atom.is_empty() {
            i += 1;
            continue;
        }
        i = next;
        // 往前看：`key=` 是属性赋值，不是节点
        let mut k = i;
        while k < chars.len() && chars[k].is_whitespace() {
            k += 1;
        }
        if k < chars.len() && chars[k] == '=' {
            expect_value = true;
            continue;
        }
        if expect_value {
            expect_value = false;
            continue;
        }
        let lower = atom.to_ascii_lowercase();
        if expect_subgraph {
            expect_subgraph = false;
            pending_group = Some(atom.clone());
            continue;
        }
        match lower.as_str() {
            "digraph" | "strict" => {
                skip_next_atom = true;
                continue;
            }
            "subgraph" => {
                expect_subgraph = true;
                continue;
            }
            "graph" | "node" | "edge" => {
                // `graph [..]` / `node [..]`：默认属性，别挂到上一个节点上
                skip_next_bracket = true;
                continue;
            }
            _ => {}
        }
        if skip_next_atom {
            skip_next_atom = false;
            continue;
        }
        push_dot_node(&mut out, &atom, line, groups.last().map(|s| s.as_str()));
    }
    out
}

fn push_dot_node(out: &mut Vec<DotNode>, id: &str, line: u32, group: Option<&str>) {
    if let Some(n) = out.iter_mut().find(|n| n.id == id) {
        let _ = n; // 已存在：属性后面再合并
        return;
    }
    out.push(DotNode { id: id.to_string(), line, group: group.map(str::to_string), attrs: BTreeMap::new() });
}

fn read_quoted(chars: &[char], start: usize) -> (String, usize) {
    let mut i = start + 1;
    let mut s = String::new();
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            s.push(chars[i + 1]);
            i += 2;
            continue;
        }
        if c == '"' {
            return (s, i + 1);
        }
        s.push(c);
        i += 1;
    }
    (s, i)
}

fn read_bare(chars: &[char], start: usize) -> (String, usize) {
    let mut i = start;
    let mut s = String::new();
    while i < chars.len() {
        let c = chars[i];
        let ok = c.is_alphanumeric() || c == '_' || c == '.' || (!c.is_ascii() && !c.is_whitespace());
        if !ok {
            break;
        }
        s.push(c);
        i += 1;
    }
    (s, i)
}

/// 读一个方括号属性表（支持嵌套与引号），返回 (内容, 下一个位置)。
fn read_bracket(chars: &[char], start: usize) -> (String, usize) {
    let mut i = start;
    let mut depth = 0usize;
    let mut s = String::new();
    let mut quote: Option<char> = None;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if c == '\\' {
                i += 1;
            } else if c == q {
                quote = None;
            }
            s.push(c);
            i += 1;
            continue;
        }
        match c {
            '"' => {
                quote = Some('"');
                s.push(c);
            }
            '[' => {
                depth += 1;
                if depth > 1 {
                    s.push(c);
                }
            }
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return (s, i + 1);
                }
                s.push(c);
            }
            _ => s.push(c),
        }
        i += 1;
    }
    (s, i)
}

fn merge_dot_attrs(into: &mut BTreeMap<String, String>, attrs_text: &str) {
    for (k, v) in split_dot_attrs(attrs_text) {
        into.insert(k, v);
    }
}

fn split_dot_attrs(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut push = |chunk: &str| {
        let t = chunk.trim();
        if t.is_empty() {
            return;
        }
        match t.split_once('=') {
            Some((k, v)) => out.push((
                k.trim().trim_matches('"').to_ascii_lowercase(),
                v.trim().trim_matches('"').to_string(),
            )),
            None => out.push((t.trim_matches('"').to_ascii_lowercase(), "true".into())),
        }
    };
    for c in text.chars() {
        if let Some(q) = quote {
            cur.push(c);
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => {
                quote = Some(c);
                cur.push(c);
            }
            ',' | ';' => {
                push(&cur);
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    push(&cur);
    out
}

fn strip_dot_comments(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' {
            // 引号串原样抄（里面的 // 不是注释）
            out.push(c);
            while let Some(c2) = chars.next() {
                out.push(c2);
                if c2 == '\\' {
                    if let Some(c3) = chars.next() {
                        out.push(c3);
                    }
                    continue;
                }
                if c2 == '"' {
                    break;
                }
            }
            continue;
        }
        if c == '/' && chars.peek() == Some(&'/') {
            for c2 in chars.by_ref() {
                if c2 == '\n' {
                    out.push('\n');
                    break;
                }
            }
            continue;
        }
        if c == '#' {
            for c2 in chars.by_ref() {
                if c2 == '\n' {
                    out.push('\n');
                    break;
                }
            }
            continue;
        }
        if c == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut prev = '\0';
            for c2 in chars.by_ref() {
                if prev == '*' && c2 == '/' {
                    break;
                }
                prev = c2;
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn dot_role(node: &DotNode) -> Option<&'static str> {
    if let Some(raw) = node.attrs.get("palette_role") {
        let r = raw.trim();
        let r = r.strip_prefix(ROLE_PREFIX).unwrap_or(r);
        if let Some(known) = ROLES.iter().copied().find(|k| *k == r) {
            return Some(known);
        }
    }
    if let Some(shape) = node.attrs.get("shape") {
        if let Some(role) = role_from_dot_shape(shape) {
            return Some(role);
        }
    }
    node.attrs.get("label").and_then(|l| role_from_label(l))
}

fn dot_is_colored(node: &DotNode) -> bool {
    node.attrs.contains_key("fillcolor") || node.attrs.contains_key("bgcolor")
}

fn apply_dot(
    body: &str,
    seed: &Seed,
    dark: bool,
    edges: bool,
    mode: PaletteMode,
) -> Result<PaletteApplyRes, String> {
    // 同 Mermaid：先剥块再扫描，否则上一轮写进去的 fillcolor 会被当成"用户已有颜色"，
    // 于是换色系时（only_uncolored）一个节点都不动 —— 看起来像"点了没反应"。
    let (base, _) = strip_block(body, "// dgm-palette:begin", "// dgm-palette:end");
    let nodes = dot_nodes(&base);
    if nodes.is_empty() {
        return Ok(PaletteApplyRes { body: body.to_string(), changed: false, applied: 0, skipped: 0, styles_removed: 0 });
    }
    let items = nodes.iter().map(|n| {
        (
            n.id.clone(),
            dot_role(n),
            dot_is_colored(n),
            n.attrs.get("label").cloned(),
            n.attrs.get("shape").map(|v| v.as_str()),
            n.group.clone(),
        )
    });
    let (by_slot, skipped) = plan(items, mode);

    // DOT 不用删任何东西：后出现的属性语句会覆盖先前的，所以"整篇重排"就是追加。
    // （Mermaid 的 `style` 语句优先级高于 classDef，那边才必须删。）
    let mut out = base;
    let styles_removed = 0usize;

    let mut block = String::from("  // dgm-palette:begin id=");
    block.push_str(seed.id);
    block.push_str("（Diagramon 自动配色 · ");
    block.push_str(seed.zh);
    block.push_str(if dark { " · 暗色" } else { " · 亮色" });
    block.push_str("）\n");
    let mut applied = 0usize;
    let by_id: BTreeMap<&str, &DotNode> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let groups = by_slot.keys().filter(|k| k.starts_with('g')).count().max(1);
    for (slot, ids) in &by_slot {
        let (fill, stroke, text) = slot_swatch(seed, slot, dark, groups);
        for id in ids {
            applied += 1;
            // 节点自己的 style 要保住（`rounded` / `dashed`…），只补一个 filled
            let mut styles: Vec<String> = by_id
                .get(id.as_str())
                .and_then(|n| n.attrs.get("style"))
                .map(|s| {
                    s.split(',')
                        .map(|x| x.trim().to_string())
                        .filter(|x| !x.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            if !styles.iter().any(|s| s == "filled") {
                styles.insert(0, "filled".into());
            }
            block.push_str(&format!(
                "  {} [fillcolor=\"{fill}\", color=\"{stroke}\", fontcolor=\"{text}\", style=\"{}\"];\n",
                crate::convert::dot_id(id),
                styles.join(",")
            ));
        }
    }
    if edges {
        block.push_str(&format!("  edge [color=\"{}\"];\n", edge_swatch(seed, dark)));
    }
    block.push_str("  // dgm-palette:end\n");
    if applied == 0 {
        return Ok(PaletteApplyRes { body: body.to_string(), changed: false, applied: 0, skipped, styles_removed });
    }
    // 追加在 digraph 的收尾大括号之前（追加在文件末尾会被 Graphviz 当成语法错误）
    match out.rfind('}') {
        Some(pos) => out.insert_str(pos, &block),
        None => {
            if !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&block);
        }
    }
    Ok(PaletteApplyRes { changed: out != body, body: out, applied, skipped, styles_removed })
}

/* ------------------------------------------------------------------ D2 */

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct D2Node {
    id: String,
    /// 首次出现的行号（1 基）
    line: u32,
    /// 所属容器（D2 的 `组名: { … }`，取最内层）
    group: Option<String>,
    role: Option<&'static str>,
    shape: Option<String>,
    label: Option<String>,
    has_fill: bool,
}

/// D2 的扫描结果：节点 + 边（边的两端要保持顺序，才好写 `(a -> b).style.stroke`）。
#[derive(Debug, Default)]
struct D2Scan {
    nodes: Vec<D2Node>,
    edges: Vec<(String, String)>,
}

fn d2_nodes(body: &str) -> D2Scan {
    let mut out: Vec<D2Node> = Vec::new();
    let mut edges: Vec<(String, String)> = Vec::new();
    // 首次见到就记下行号（同一节点后面再出现不改）
    let mut groups: Vec<String> = Vec::new();
    let touch = |out: &mut Vec<D2Node>, id: &str, line: u32, group: Option<&str>| -> usize {
        if let Some(i) = out.iter().position(|n| n.id == id) {
            return i;
        }
        out.push(D2Node {
            id: id.to_string(),
            line,
            group: group.map(str::to_string),
            ..Default::default()
        });
        out.len() - 1
    };
    for (idx, raw) in body.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line == "}" {
            groups.pop();
            continue;
        }
        if line.ends_with('{') {
            // `组名: {` / `组名 {` → 这是一个容器
            let name = line.trim_end_matches('{').trim().trim_end_matches(':').trim().trim_matches('"');
            if !name.is_empty() {
                groups.push(name.to_string());
            }
            continue;
        }
        // 只认 `左: 右` 这一种形态；没有冒号的行（`a -> b`）只登记端点
        let (lhs, rhs) = match line.split_once(':') {
            Some((l, r)) => (l.trim(), r.trim()),
            None => {
                let path = split_d2_path(line);
                for seg in &path {
                    touch(&mut out, seg, (idx + 1) as u32, groups.last().map(|s| s.as_str()));
                }
                for w in path.windows(2) {
                    edges.push((w[0].clone(), w[1].clone()));
                }
                continue;
            }
        };
        // 逐条边的样式：`(a -> b).style.stroke: …`（用户手写或我们生成的形态）
        if let Some(inner) = lhs.strip_prefix('(').and_then(|r| r.split(')').next()) {
            let path = split_d2_path(inner);
            for seg in &path {
                touch(&mut out, seg, (idx + 1) as u32, groups.last().map(|s| s.as_str()));
            }
            for w in path.windows(2) {
                edges.push((w[0].clone(), w[1].clone()));
            }
            continue;
        }
        if lhs.contains("->") || lhs.contains("--") {
            // 边：两端都是节点，冒号右边是**边标签**，别当成节点标签
            let path = split_d2_path(lhs);
            for seg in &path {
                touch(&mut out, seg, (idx + 1) as u32, groups.last().map(|s| s.as_str()));
            }
            for w in path.windows(2) {
                edges.push((w[0].clone(), w[1].clone()));
            }
            continue;
        }
        // 属性行：`a.b.style.fill: "#fff"`
        if let Some((path, key)) = split_d2_attr(lhs) {
            let i = touch(&mut out, &path, (idx + 1) as u32, groups.last().map(|s| s.as_str()));
            match key.as_str() {
                "shape" => out[i].shape = Some(rhs.trim_matches('"').to_string()),
                "label" => out[i].label = Some(rhs.trim_matches('"').to_string()),
                "class" => {
                    let r = rhs.trim().trim_matches('"');
                    let r = r.strip_prefix(ROLE_PREFIX).unwrap_or(r);
                    if let Some(known) = ROLES.iter().copied().find(|k| *k == r) {
                        out[i].role = Some(known);
                    }
                }
                "style.fill" => out[i].has_fill = true,
                _ => {}
            }
            continue;
        }
        // 顶层指令不是节点（`direction: right` / `vars: {...}` / `title: …`）
        const DIRECTIVES: [&str; 7] =
            ["direction", "vars", "style", "classes", "title", "near", "label"];
        if DIRECTIVES.contains(&lhs) {
            continue;
        }
        // 纯声明：`a: 标签`
        let i = touch(&mut out, lhs, (idx + 1) as u32, groups.last().map(|s| s.as_str()));
        if !rhs.is_empty() && !rhs.starts_with('{') {
            out[i].label = Some(rhs.trim_matches('"').to_string());
        }
    }
    D2Scan { nodes: out, edges }
}

fn split_d2_path(text: &str) -> Vec<String> {
    text.split("->")
        .flat_map(|s| s.split("--"))
        .map(|s| s.trim().trim_matches('"').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// `a.b.style.fill` → (`a.b`, `style.fill`)；`a.b`（普通节点路径）→ None。
fn split_d2_attr(lhs: &str) -> Option<(String, String)> {
    let (path, key) = lhs.rsplit_once('.')?;
    const ATTRS: [&str; 6] = ["shape", "label", "class", "style", "icon", "link"];
    if ATTRS.contains(&key) || key.starts_with("style.") || matches!(key, "fill" | "stroke" | "font-color") {
        if key == "fill" || key == "stroke" || key == "font-color" {
            // `a.style.fill` 才会被 rsplit 成 (`a.style`, `fill`) —— 补回 style. 前缀
            return Some((path.trim_end_matches(".style").to_string(), format!("style.{key}")));
        }
        return Some((path.to_string(), key.to_string()));
    }
    None
}

fn apply_d2(
    body: &str,
    seed: &Seed,
    dark: bool,
    edges: bool,
    mode: PaletteMode,
) -> Result<PaletteApplyRes, String> {
    // 同上面两个格式：先剥块再扫描（自己写的 `a.style.fill` / `(a -> b).style.stroke` 不算"用户已有"）
    let (base, _) = strip_block(body, "# dgm-palette:begin", "# dgm-palette:end");
    let scan = d2_nodes(&base);
    let nodes = &scan.nodes;
    if nodes.is_empty() {
        return Ok(PaletteApplyRes { body: body.to_string(), changed: false, applied: 0, skipped: 0, styles_removed: 0 });
    }
    let items = nodes.iter().map(|n| {
        let explicit = n
            .role
            .or_else(|| n.shape.as_deref().and_then(role_from_d2_shape));
        (
            n.id.clone(),
            explicit,
            n.has_fill,
            n.label.clone(),
            None,
            n.group.clone(),
        )
    });
    let (by_slot, skipped) = plan(items, mode);

    let mut out = base;
    let mut block = String::from("# dgm-palette:begin id=");
    block.push_str(seed.id);
    block.push_str("（Diagramon 自动配色 · ");
    block.push_str(seed.zh);
    block.push_str(if dark { " · 暗色" } else { " · 亮色" });
    block.push_str("）\n");
    let mut applied = 0usize;
    let groups = by_slot.keys().filter(|k| k.starts_with('g')).count().max(1);
    for (slot, ids) in &by_slot {
        let (fill, stroke, text) = slot_swatch(seed, slot, dark, groups);
        for id in ids {
            applied += 1;
            block.push_str(&format!("{id}.style.fill: \"{fill}\"\n"));
            block.push_str(&format!("{id}.style.stroke: \"{stroke}\"\n"));
            block.push_str(&format!("{id}.style.font-color: \"{text}\"\n"));
        }
    }
    // 连线：D2 没有"全局边样式"，只能逐条写（`(a -> b).style.stroke`）。
    // 端点是扫描时按文档顺序记下的，重跑同序，所以幂等。
    if edges {
        let line = edge_swatch(seed, dark);
        for (from, to) in &scan.edges {
            block.push_str(&format!("({from} -> {to}).style.stroke: \"{line}\"\n"));
        }
    }
    block.push_str("# dgm-palette:end\n");
    if applied == 0 {
        return Ok(PaletteApplyRes { body: body.to_string(), changed: false, applied: 0, skipped, styles_removed: 0 });
    }
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&block);
    Ok(PaletteApplyRes { changed: out != body, body: out, applied, skipped, styles_removed: 0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 绝大多数用例只关心节点配色：默认"连线跟随"。
    fn paint(
        body: &str,
        format: FormatId,
        palette: &str,
        dark: bool,
        mode: PaletteMode,
    ) -> Result<PaletteApplyRes, String> {
        apply(body, format, palette, dark, true, mode)
    }

    // 色相间隔门禁与实现共用 `MIN_SEP_HUE`（两处各写一个数迟早漂开）。

    fn mermaid_flow() -> String {
        concat!(
            "flowchart TD\n",
            "    A([开始]) --> B[校验请求]\n",
            "    B --> C{是否通过?}\n",
            "    C -- 是 --> D[写库]\n",
            "    C -- 否 --> E[外部网关]\n",
            "    D --> F[结束]\n",
        )
        .to_string()
    }

    #[test]
    fn hsl_ladder_hits_the_expected_corners() {
        assert_eq!(hsl_hex(0.0, 0.0, 1.0), "#ffffff");
        assert_eq!(hsl_hex(0.0, 0.0, 0.0), "#000000");
        assert_eq!(hsl_hex(0.0, 1.0, 0.5), "#ff0000");
        assert_eq!(hsl_hex(120.0, 1.0, 0.5), "#00ff00");
        assert_eq!(hsl_hex(240.0, 1.0, 0.5), "#0000ff");
    }

    #[test]
    fn every_palette_has_six_distinct_roles_in_both_themes() {
        for seed in &SEEDS {
            for dark in [false, true] {
                let mut fills = Vec::new();
                for role in ROLES {
                    let (fill, stroke, text) = swatch(seed, role, dark);
                    assert!(fill.starts_with('#') && fill.len() == 7, "{}/{} fill={fill}", seed.id, role);
                    assert_ne!(fill, stroke, "{}/{} 填充与描边同色", seed.id, role);
                    assert_ne!(fill, text, "{}/{} 填充与文字同色", seed.id, role);
                    fills.push(fill);
                }
                let mut uniq = fills.clone();
                uniq.sort();
                uniq.dedup();
                let want = if seed.sat < NEUTRAL_SAT { 1 } else { ROLES.len() };
                assert!(
                    uniq.len() >= want,
                    "{}（dark={dark}）角色填充色撞了：{fills:?}",
                    seed.id
                );
            }
        }
    }

    #[test]
    fn every_palette_keeps_its_roles_apart() {
        // 这是**加色系的门禁**：任意两个角色（除 note，它靠饱和度而不是色相区分）
        // 必须相隔 MIN_SEP_HUE；中性色系（钨灰）走明度阶梯，单独在下面验。
        for seed in &SEEDS {
            if seed.sat < NEUTRAL_SAT {
                continue;
            }
            let hues = ladder(seed);
            let picked: Vec<(&&str, f32)> = ROLES
                .iter()
                .zip(hues.iter())
                .filter(|(r, _)| **r != "note")
                .map(|(r, h)| (r, *h))
                .collect();
            for (i, (ra, ha)) in picked.iter().enumerate() {
                for (rb, hb) in picked.iter().skip(i + 1) {
                    assert!(
                        hue_dist(*ha, *hb) >= MIN_SEP_HUE - 1.0,
                        "{} 的 {ra}（{ha}）与 {rb}（{hb}）色相分不开",
                        seed.id
                    );
                }
            }
        }
    }

    #[test]
    fn neutral_palette_separates_roles_by_lightness() {
        let seed = find("tungsten").expect("钨灰必须存在");
        assert!(seed.sat < NEUTRAL_SAT);
        for dark in [false, true] {
            let strokes: Vec<String> =
                ROLES.iter().map(|r| swatch(seed, r, dark).1).collect();
            let mut uniq = strokes.clone();
            uniq.sort();
            uniq.dedup();
            assert_eq!(uniq.len(), ROLES.len(), "钨灰的描边必须两两不同：{strokes:?}");
            // 告警仍是彩色 —— 线框风里唯一"会喊"的那个角色
            assert_ne!(strokes[5], swatch(seed, "main", dark).1);
        }
    }

    #[test]
    fn role_table_and_gray_ladders_stay_in_sync() {
        assert_eq!(ROLES.len(), 7);
        assert_eq!(GRAY_STROKE_LIGHT.len(), ROLES.len());
        assert_eq!(GRAY_STROKE_DARK.len(), ROLES.len());
        assert_eq!(ladder(find("pine").unwrap()).len(), ROLES.len());
    }

    #[test]
    fn prompt_rules_name_every_role_and_only_for_text_formats() {
        for f in [FormatId::Mermaid, FormatId::Dot, FormatId::D2] {
            let rules = prompt_rules(f).unwrap_or_else(|| panic!("{f:?} 应有配色约定"));
            for role in ROLES {
                assert!(rules.contains(role), "{f:?} 的配色约定漏了角色 {role}");
            }
            assert!(rules.contains("色值"), "{f:?} 必须明说「不要写色值」");
        }
        // 画布型没有角色机制：返回 None，调用方就不注入（模型不会写出没人兑现的标记）
        assert!(prompt_rules(FormatId::Drawio).is_none());
        assert!(prompt_rules(FormatId::Excalidraw).is_none());
    }

    #[test]
    fn ids_and_role_names_round_trip() {
        assert_eq!(role_class("decide"), "lvl-decide");
        assert_eq!(role_of_class("lvl-decide"), Some("decide"));
        assert_eq!(role_of_class("decide"), None, "没有前缀的不是我们的类");
        assert_eq!(role_of_class("lvl-nope"), None);
        assert_eq!(ids().len(), SEEDS.len());
        assert!(find("graphite").is_none(), "石墨是 UI 强调色，不是图表色系");
        assert!(find("coral").is_none(), "珊瑚落在告警红带里，已换成橄榄");
        assert!(find("pine").is_some());
    }

    #[test]
    fn infos_cover_every_palette_and_role() {
        let all = infos();
        assert_eq!(all.len(), SEEDS.len());
        for p in &all {
            assert_eq!(p.roles.len(), ROLES.len());
            assert!(!p.name_zh.is_empty() && !p.name_en.is_empty());
            assert!(p.roles.iter().all(|r| r.light.fill.starts_with('#') && r.dark.fill.starts_with('#')));
            assert!(p.edge_light.starts_with('#') && p.edge_dark.starts_with('#'));
            assert_ne!(p.edge_light, p.roles[0].light.stroke, "线色不该与节点描边同色");
        }
    }

    #[test]
    fn mermaid_gets_one_classdef_per_used_slot_and_a_class_per_node() {
        let res = paint(&mermaid_flow(), FormatId::Mermaid, "pine", false, PaletteMode::All).unwrap();
        assert!(res.changed);
        // 只写"这一份文档真的用到的槽位"：不再无脑铺满七个角色（分组槽位是按文档算的，
        // 铺满七个反而看不出哪些是分组色）
        for slot in ["entry", "decide", "ext", "main"] {
            assert!(res.body.contains(&format!("classDef lvl-{slot} fill:#")), "缺 {slot} 的 classDef");
        }
        assert!(!res.body.contains("classDef lvl-note"), "没有 note 节点就不该写它的 classDef");
        assert!(!res.body.contains("classDef lvl-data"));
        // 形状/标签推断：A 是体育场形（入口），C 是菱形（判断），E 标签里有"外部"
        // A 体育场形 = 入口；F 的标签是「结束」也是入口；C 的标签含 "?"
        assert!(res.body.contains("class A,F lvl-entry"), "{}", res.body);
        assert!(res.body.contains("class C lvl-decide"), "{}", res.body);
        assert!(res.body.contains("class E lvl-ext"), "E 的标签里有「外部」：\n{}", res.body);
        assert!(res.body.contains("class B,D lvl-main"), "剩下的走主链路：\n{}", res.body);
    }

    #[test]
    fn dangling_class_def_does_not_block_coloring() {
        // 用户"清掉手写配色"最自然的做法就是删 `classDef` 行，节点上的 `:::catalog` 还在。
        // 以前只要"有类"就算有颜色，这批节点会被整批跳过（实测 80%）。
        let body = "flowchart TD\n    A[开始]:::catalog --> B[写库]:::catalog\n";
        let res = paint(body, FormatId::Mermaid, "pine", false, PaletteMode::OnlyUncolored).unwrap();
        assert_eq!(res.skipped, 0, "没有 classDef 的类名不构成颜色：\n{}", res.body);
        assert_eq!(res.applied, 2);

        // 真的定义了颜色才拦
        let colored = "flowchart TD\n    A[开始]:::catalog --> B[写库]\n    classDef catalog fill:#f00\n";
        let res = paint(colored, FormatId::Mermaid, "pine", false, PaletteMode::OnlyUncolored).unwrap();
        assert_eq!((res.applied, res.skipped), (1, 1));
    }

    #[test]
    fn subgraph_members_share_a_group_slot() {
        let body = concat!(
            "flowchart TD\n",
            "    subgraph L_A [接入层]\n",
            "        A1[甲] --> A2[乙]\n",
            "    end\n",
            "    subgraph L_B [业务层]\n",
            "        B1[丙] --> B2[丁]\n",
            "    end\n",
            "    A2 --> B1\n",
        );
        let res = paint(body, FormatId::Mermaid, "pine", false, PaletteMode::All).unwrap();
        // 两个组 + 四个节点：组内同槽位、组间不同槽位
        assert!(res.body.contains("class A1,A2 lvl-g"), "接入层要同槽：\n{}", res.body);
        assert!(res.body.contains("class B1,B2 lvl-g"), "业务层要同槽：\n{}", res.body);
        let defs: Vec<&str> = res
            .body
            .lines()
            .filter(|l| l.starts_with("classDef lvl-g"))
            .collect();
        assert_eq!(defs.len(), 2, "两组两个分组槽位：\n{}", res.body);
        assert_ne!(defs[0], defs[1], "不同组必须不同色");
    }

    #[test]
    fn annotate_hands_out_colors_for_every_painted_node() {
        // 前端不再自己查角色表：有槽位的节点必须带回 fill/stroke，
        // 否则源码窗格的色块会退化成空框（而它正是"看得见配色"的全部意义）。
        let body = concat!(
            "flowchart TD\n",
            "    subgraph L_A [接入层]\n",
            "        A1[甲] --> A2[乙]\n",
            "    end\n",
            "    B[丙]:::lvl-risk\n",
        );
        let lines = annotate(body, FormatId::Mermaid, false);
        let nodes: Vec<_> = lines.iter().flat_map(|l| l.nodes.iter()).collect();
        assert!(!nodes.is_empty());
        for n in &nodes {
            assert!(n.role.is_some(), "{} 应该有槽位", n.id);
            let fill = n.fill.as_deref().unwrap_or("");
            let stroke = n.stroke.as_deref().unwrap_or("");
            assert!(fill.starts_with('#') && fill.len() == 7, "{} 没有填充色：{fill:?}", n.id);
            assert!(stroke.starts_with('#'), "{} 没有描边色", n.id);
        }
        let fill_of = |id: &str| nodes.iter().find(|n| n.id == id).and_then(|n| n.fill.clone());
        assert_eq!(fill_of("A1"), fill_of("A2"), "同组同色");
        assert_ne!(fill_of("A1"), fill_of("B"), "分组色与语义角色不同槽");
        // 暗色必须真的换一套（否则"跟随主题"是假的）
        let dark = annotate(body, FormatId::Mermaid, true);
        let dark_fill = dark.iter().flat_map(|l| l.nodes.iter()).find(|n| n.id == "A1").and_then(|n| n.fill.clone());
        assert_ne!(fill_of("A1"), dark_fill);
    }

    #[test]
    fn dot_clusters_share_a_group_slot() {
        let body = concat!(
            "digraph G {\n",
            "  subgraph cluster_a {\n",
            "    A [label=\"甲\"];\n",
            "    B [label=\"乙\"];\n",
            "  }\n",
            "  subgraph cluster_b {\n",
            "    C [label=\"丙\"];\n",
            "  }\n",
            "}\n",
        );
        let res = paint(body, FormatId::Dot, "pine", false, PaletteMode::All).unwrap();
        let slot_of = |id: &str| -> String {
            res.body
                .lines()
                .find(|l| l.trim_start().starts_with(&format!("{id} [")) && l.contains("fillcolor="))
                .and_then(|l| l.split("fillcolor=\"").nth(1))
                .map(|x| x.chars().take(7).collect())
                .unwrap_or_default()
        };
        assert_eq!(slot_of("A"), slot_of("B"), "同一个 cluster 同色：\n{}", res.body);
        assert_ne!(slot_of("A"), slot_of("C"), "不同 cluster 不同色：\n{}", res.body);
    }

    #[test]
    fn d2_containers_share_a_group_slot() {
        let body = concat!(
            "组一: {\n",
            "  a: 甲\n",
            "  b: 乙\n",
            "}\n",
            "组二: {\n",
            "  c: 丙\n",
            "}\n",
        );
        let res = paint(body, FormatId::D2, "pine", false, PaletteMode::All).unwrap();
        let fill_of = |id: &str| -> String {
            res.body
                .lines()
                .find(|l| l.starts_with(&format!("{id}.style.fill:")))
                .map(|l| l.split('"').nth(1).unwrap_or("").to_string())
                .unwrap_or_default()
        };
        assert_eq!(fill_of("a"), fill_of("b"), "同一容器同色：\n{}", res.body);
        assert_ne!(fill_of("a"), fill_of("c"), "不同容器不同色：\n{}", res.body);
    }

    #[test]
    fn explicit_role_beats_group() {
        let body = concat!(
            "flowchart TD\n",
            "    subgraph L_A [接入层]\n",
            "        A1[甲] --> A2[乙]:::lvl-risk\n",
            "    end\n",
        );
        let res = paint(body, FormatId::Mermaid, "pine", false, PaletteMode::All).unwrap();
        assert!(res.body.contains("class A2 lvl-risk"), "语义角色优先于分组：\n{}", res.body);
        assert!(res.body.contains("class A1 lvl-g"), "{}", res.body);
    }

    #[test]
    fn group_color_ring_caps_at_nine() {
        // 22 个 subgraph 不能变成 19 个 19° 间隔的色相：超过 9 组按顺序复用
        assert_eq!(group_hue(150.0, 0, 22), group_hue(150.0, 9, 22));
        assert_ne!(group_hue(150.0, 0, 22), group_hue(150.0, 1, 22));
        // 少组时保持 60°（6 组以内）
        let d = (group_hue(150.0, 1, 4) - group_hue(150.0, 0, 4)).rem_euclid(360.0);
        assert!((d - 60.0).abs() < 0.01, "4 组应 60° 一档，实际 {d}");
    }

    #[test]
    fn mermaid_apply_is_idempotent() {
        let once = paint(&mermaid_flow(), FormatId::Mermaid, "pine", false, PaletteMode::All).unwrap();
        let twice = paint(&once.body, FormatId::Mermaid, "pine", false, PaletteMode::All).unwrap();
        assert_eq!(twice.body, once.body, "重跑必须逐字节一致（否则点两次就多一块）");
        assert!(!twice.changed);
    }

    #[test]
    fn switching_palette_only_changes_colors_not_node_roles() {
        let pine = paint(&mermaid_flow(), FormatId::Mermaid, "pine", false, PaletteMode::All).unwrap();
        let lotus = paint(&pine.body, FormatId::Mermaid, "lotus", false, PaletteMode::All).unwrap();
        assert!(lotus.changed);
        let classes = |s: &str| -> Vec<String> {
            s.lines().filter(|l| l.trim_start().starts_with("class ")).map(|l| l.trim().to_string()).collect()
        };
        assert_eq!(classes(&pine.body), classes(&lotus.body), "换色系不该改角色分配");
        assert_ne!(pine.body, lotus.body);
        let (pine_main, _, _) = swatch(find("pine").unwrap(), "main", false);
        let (lotus_main, _, _) = swatch(find("lotus").unwrap(), "main", false);
        assert_ne!(pine_main, lotus_main);
        assert!(!lotus.body.contains(&pine_main), "旧色值应被替换干净");
        assert!(lotus.body.contains(&lotus_main), "新色值必须已经落进去");
    }

    #[test]
    fn dark_theme_uses_a_different_ladder() {
        let light = paint(&mermaid_flow(), FormatId::Mermaid, "pine", false, PaletteMode::All).unwrap();
        let dark = paint(&mermaid_flow(), FormatId::Mermaid, "pine", true, PaletteMode::All).unwrap();
        assert!(light.body.contains("亮色"));
        assert!(dark.body.contains("暗色"));
        // 暗色阶的填充明显更深
        let fill_of = |s: &str| -> String {
            s.lines()
                .find(|l| l.contains("classDef lvl-main"))
                .and_then(|l| l.split("fill:#").nth(1))
                .map(|x| x.chars().take(6).collect())
                .unwrap_or_default()
        };
        let lum = |hex: &str| -> u32 { u32::from_str_radix(hex, 16).unwrap_or(0) };
        assert!(lum(&fill_of(&dark.body)) < lum(&fill_of(&light.body)), "暗色填充应更深");
    }

    #[test]
    fn only_uncolored_skips_hand_picked_colors() {
        let body = "flowchart TD\n    A[开始]\n    style A fill:#f00\n    B[结束]\n".to_string();
        let res = paint(&body, FormatId::Mermaid, "pine", false, PaletteMode::OnlyUncolored).unwrap();
        assert_eq!((res.applied, res.skipped), (1, 1), "A 被跳过、B 上色");
        // A 被跳过 ⇒ 不在任何 class 语句里；B 在
        let class_lines: Vec<&str> = res.body.lines().filter(|l| l.trim_start().starts_with("class ")).collect();
        assert!(class_lines.iter().all(|l| !l.contains("A")), "{class_lines:?}");
        assert!(class_lines.iter().any(|l| l.contains("B")));
        // 手写的 style 一个字都不动
        assert!(res.body.contains("style A fill:#f00"));
    }

    #[test]
    fn all_mode_removes_the_inline_style_that_would_win() {
        let body = "flowchart TD\n    A[开始]\n    style A fill:#f00\n".to_string();
        let res = paint(&body, FormatId::Mermaid, "pine", false, PaletteMode::All).unwrap();
        assert!(!res.body.contains("style A fill:#f00"), "整篇重排必须删掉覆盖用的 style");
        assert!(res.body.contains("class A lvl-entry"));
        assert_eq!(res.styles_removed, 1, "被覆盖的 style 必须删掉并如实计数");
    }

    #[test]
    fn mermaid_refuses_non_flowchart() {
        let err = paint("sequenceDiagram\n A->>B: hi\n", FormatId::Mermaid, "pine", false, PaletteMode::All)
            .unwrap_err();
        assert!(err.contains("flowchart"), "{err}");
    }

    #[test]
    fn dot_nodes_are_appended_inside_the_graph_and_keep_their_style() {
        let body = "\
digraph G {
    rankdir=LR;
    A [shape=box, style=\"rounded\"];
    A -> B;
    B [shape=diamond, label=\"是否通过?\"];
    C [label=\"外部网关\"];
}
";
        let res = paint(body, FormatId::Dot, "indigo", false, PaletteMode::OnlyUncolored).unwrap();
        assert!(res.changed);
        // 追加在收尾大括号之前
        let end = res.body.rfind('}').unwrap();
        assert!(res.body[..end].contains("dgm-palette:end"), "块必须在 digraph 内");
        assert!(res.body.contains("fillcolor=\"#"));
        assert!(res.body.contains("A [fillcolor=") && res.body.contains("style=\"filled,rounded\""));
        assert!(res.body.contains("B [fillcolor="), "菱形 → decide，也要上色");
        assert!(res.body.contains("C [fillcolor="), "C 的标签是「外部网关」→ ext");
    }

    #[test]
    fn dot_apply_is_idempotent_and_skips_explicit_fills() {
        let body = "digraph G {\n  A [fillcolor=\"#123456\"];\n  B [shape=diamond];\n}\n";
        let once = paint(body, FormatId::Dot, "pine", false, PaletteMode::OnlyUncolored).unwrap();
        assert_eq!(once.skipped, 1, "A 已有 fillcolor，跳过它");
        assert!(!once.body.contains("A [fillcolor=\"#") || once.body.contains("#123456"));
        let twice = paint(&once.body, FormatId::Dot, "pine", false, PaletteMode::OnlyUncolored).unwrap();
        assert_eq!(twice.body, once.body);
    }

    #[test]
    fn d2_roles_come_from_class_shape_and_label() {
        let body = "\
direction: right
a: 开始
b.shape: diamond
c: 外部网关
a -> b
b -> c
";
        let res = paint(body, FormatId::D2, "ochre", true, PaletteMode::OnlyUncolored).unwrap();
        assert!(res.changed);
        assert!(res.body.contains("b.style.fill:"));
        assert!(res.body.contains("dgm-palette:end"));
        assert_eq!(res.applied, 3);
    }

    #[test]
    fn d2_apply_is_idempotent() {
        let body = "a -> b\nb: 外部\n";
        let once = paint(body, FormatId::D2, "pine", false, PaletteMode::All).unwrap();
        let twice = paint(&once.body, FormatId::D2, "pine", false, PaletteMode::All).unwrap();
        assert_eq!(twice.body, once.body);
        assert!(!twice.changed);
    }

    #[test]
    fn edges_take_the_palette_but_stay_quiet() {
        // 线是"结构"，只借一点色系倾向：三种格式各有一条统一定义
        let m = paint(&mermaid_flow(), FormatId::Mermaid, "pine", false, PaletteMode::All).unwrap();
        assert!(m.body.contains("'lineColor': '#"), "{}", m.body);
        let d = paint("digraph G {\n  A -> B;\n}\n", FormatId::Dot, "pine", false, PaletteMode::All).unwrap();
        assert!(d.body.contains("edge [color=\"#"), "{}", d.body);
        let t = paint("a -> b\n", FormatId::D2, "pine", false, PaletteMode::All).unwrap();
        assert!(t.body.contains("(a -> b).style.stroke: \"#"), "{}", t.body);

        // 换色系 ⇒ 线色跟着换
        let line = |s: &str| {
            s.lines().find(|l| l.contains("lineColor")).unwrap_or("").trim().to_string()
        };
        let m2 = paint(&m.body, FormatId::Mermaid, "lotus", false, PaletteMode::All).unwrap();
        assert_ne!(line(&m.body), line(&m2.body), "线色没跟着色系走");

        // 线色要比节点描边更淡（饱和度压低），否则 5 条以上边会抢注意力
        let edge_hex = line(&m.body)
            .split("lineColor': '")
            .nth(1)
            .and_then(|r| r.split('\'').next())
            .unwrap_or("")
            .to_string();
        let (_, main_stroke, _) = swatch(find("pine").unwrap(), "main", false);
        assert_ne!(edge_hex, main_stroke, "线色不该与节点描边同色");
        let sat = |hex: &str| {
            let rgb: Vec<f32> = (1..).step_by(2).take(3)
                .map(|k| u8::from_str_radix(&hex[k..k + 2], 16).unwrap_or(0) as f32 / 255.0)
                .collect();
            let mx = rgb.iter().cloned().fold(0.0f32, f32::max);
            let mn = rgb.iter().cloned().fold(1.0f32, f32::min);
            if mx <= 0.0 { 0.0 } else { (mx - mn) / mx }
        };
        assert!(sat(&edge_hex) < sat(&main_stroke), "线色 {edge_hex} 应比节点描边 {main_stroke} 更淡");
    }

    /// 关键回归：上一轮**自己写进去的**填充/类名，不能被当成"用户已有颜色"。
    ///
    /// 曾经三个格式都在"剥自己那块"之前扫描，于是第二次换色系时：
    /// DOT 看到自己写的 fillcolor → 跳过全部节点；D2 看到自己写的 style.fill → 同样跳过；
    /// 用户看到的是"点了没反应"。
    #[test]
    fn switching_palette_in_only_uncolored_mode_recolors_our_own_output() {
        let cases: [(FormatId, &str); 3] = [
            (FormatId::Mermaid, "flowchart TD\n    A([开始]) --> B[写库]\n"),
            (FormatId::Dot, "digraph G {\n  A -> B;\n}\n"),
            (FormatId::D2, "a -> b\n"),
        ];
        for (fmt, body) in cases {
            let first = paint(body, fmt, "pine", false, PaletteMode::OnlyUncolored).unwrap();
            assert!(first.changed, "{fmt:?} 第一次应当上色");
            let second = paint(&first.body, fmt, "lotus", false, PaletteMode::OnlyUncolored).unwrap();
            assert!(second.changed, "{fmt:?} 换色系后应当变色（不是跳过全部节点）");
            assert_eq!(second.skipped, 0, "{fmt:?} 不该把上一轮自己的输出当成用户颜色");
            let (fill, _, _) = swatch(find("lotus").unwrap(), "main", false);
            assert!(second.body.contains(&fill), "{fmt:?} 没写进新色值：{}", second.body);
        }
    }

    #[test]
    fn edges_can_be_turned_off() {
        // 关掉时：节点照常上色，但一个线色都不写（三种格式各自验证）
        let m = apply(&mermaid_flow(), FormatId::Mermaid, "pine", false, false, PaletteMode::All).unwrap();
        assert!(m.body.contains("classDef lvl-main fill:#"), "节点色仍要在");
        assert!(!m.body.contains("lineColor"), "不该再写线色：{}", m.body);

        let d = apply("digraph G {\n  A -> B;\n}\n", FormatId::Dot, "pine", false, false, PaletteMode::All).unwrap();
        assert!(d.body.contains("fillcolor=\"#"));
        assert!(!d.body.contains("edge [color="), "{}", d.body);

        let t = apply("a -> b\n", FormatId::D2, "pine", false, false, PaletteMode::All).unwrap();
        assert!(t.body.contains("a.style.fill:"));
        assert!(!t.body.contains(".style.stroke: \"#5"), "不该写线色：{}", t.body);
    }

    #[test]
    fn turning_edges_back_on_adds_them_without_touching_node_colors() {
        let off = apply(&mermaid_flow(), FormatId::Mermaid, "pine", false, false, PaletteMode::All).unwrap();
        let on = apply(&off.body, FormatId::Mermaid, "pine", false, true, PaletteMode::All).unwrap();
        assert!(on.body.contains("lineColor"), "{}", on.body);
        // 节点色那几行不变（只多了线色一行）
        let defs = |s: &str| -> Vec<String> {
            s.lines().filter(|l| l.starts_with("classDef")).map(|l| l.to_string()).collect()
        };
        assert_eq!(defs(&off.body), defs(&on.body));
    }

    #[test]
    fn clear_removes_only_what_we_generated() {
        let body = "flowchart TD\n    A([开始]) --> B[写库]\n    style B fill:#f00\n";
        let painted = paint(body, FormatId::Mermaid, "pine", false, PaletteMode::OnlyUncolored).unwrap();
        assert!(painted.body.contains("dgm-palette:begin"));
        let cleared = clear(&painted.body, FormatId::Mermaid);
        assert!(cleared.changed);
        assert!(!cleared.body.contains("classDef"), "我们的块必须整块消失：{}", cleared.body);
        assert!(!cleared.body.contains("dgm-palette"), "{}", cleared.body);
        assert!(cleared.body.contains("style B fill:#f00"), "手写样式一个都不能碰");
        // 再清一次：没东西可删，如实报"没变"
        let again = clear(&cleared.body, FormatId::Mermaid);
        assert!(!again.changed);
        assert_eq!(again.body, cleared.body);
    }

    #[test]
    fn clear_covers_all_three_formats_and_ignores_canvas() {
        for (fmt, body) in [
            (FormatId::Mermaid, "flowchart TD\n    A --> B\n"),
            (FormatId::Dot, "digraph G {\n  A -> B;\n}\n"),
            (FormatId::D2, "a -> b\n"),
        ] {
            let painted = paint(body, fmt, "pine", false, PaletteMode::All).unwrap();
            let cleared = clear(&painted.body, fmt);
            assert!(cleared.changed, "{fmt:?} 应能清掉");
            assert!(!cleared.body.contains("dgm-palette"), "{fmt:?}: {}", cleared.body);
        }
        // 画布型本来就没什么可清：返回"没变"，不报错
        let c = clear("{}", FormatId::Drawio);
        assert!(!c.changed);
        assert_eq!(c.body, "{}");
    }

    #[test]
    fn probe_reads_back_the_baked_palette() {
        let painted = paint(&mermaid_flow(), FormatId::Mermaid, "lotus", false, PaletteMode::All).unwrap();
        let p = probe(&painted.body, FormatId::Mermaid);
        assert_eq!(p.baked.as_deref(), Some("lotus"), "块头里的 id 要能读回来");
        assert!(p.suggested.is_none(), "已经烘焙过就别再建议别的");
    }

    #[test]
    fn probe_resolves_legacy_blocks_without_id() {
        // 3.11.3/3.11.4 早期生成的块只有中文名，没有 id=
        let body = "flowchart TD\n    A --> B\n%% dgm-palette:begin（Diagramon 自动配色 · 藕紫 · 亮色）\n%% dgm-palette:end\n";
        assert_eq!(probe(body, FormatId::Mermaid).baked.as_deref(), Some("lotus"));
    }

    #[test]
    fn probe_suggests_by_what_the_diagram_is_made_of() {
        // 数据/存储占多数 → 黛蓝
        let data = "flowchart TD\n    A[(用户库)] --> B[(订单库)]\n    B --> C[(日志库)]\n    C --> D[写库]\n";
        assert_eq!(probe(data, FormatId::Mermaid).suggested.as_deref(), Some("indigo"));
        // 异常占 15% 以上 → 赭石
        let risky = "flowchart TD\n    A[调用] --> B[支付失败]\n    B --> C[超时]\n    C --> D[写入]\n";
        assert_eq!(probe(risky, FormatId::Mermaid).suggested.as_deref(), Some("ochre"));
        // 界面词 → 藕紫
        let ui = "flowchart TD\n    A[登录页面] --> B[按钮点击]\n";
        assert_eq!(probe(ui, FormatId::Mermaid).suggested.as_deref(), Some("lotus"));
        // 什么都没看出来 → 品牌松绿
        let plain = "flowchart TD\n    A --> B\n";
        assert_eq!(probe(plain, FormatId::Mermaid).suggested.as_deref(), Some("pine"));
        // 自动挑色永远不挑钨灰（线框档，挑过去会让人以为图坏了）
        for body in [data, risky, ui, plain, mermaid_flow().as_str()] {
            assert_ne!(probe(body, FormatId::Mermaid).suggested.as_deref(), Some("tungsten"));
        }
    }

    #[test]
    fn annotate_maps_lines_to_the_roles_apply_would_use() {
        let body = concat!(
            "flowchart TD\n",
            "    A([开始]):::lvl-entry --> B{是否通过?}\n",
            "    B --> C[(用户库)]\n",
            "    C --> D[发送通知]\n",
            "    style D fill:#f00\n",
        );
        let lines = annotate(body, FormatId::Mermaid, false);
        let at = |n: u32| -> Vec<(String, Option<String>)> {
            lines
                .iter()
                .find(|l| l.line == n)
                .map(|l| l.nodes.iter().map(|x| (x.id.clone(), x.role.clone())).collect())
                .unwrap_or_default()
        };
        // 每个节点只在**首次出现的那行**标一次（否则同一节点在每条边上都重复标色）
        assert_eq!(at(2), vec![("A".into(), Some("entry".into())), ("B".into(), Some("decide".into()))]);
        assert_eq!(at(3), vec![("C".into(), Some("data".into()))]);
        // D 带手写颜色 → 不会上色，标注成 None（源码里画虚框"保持原样"）
        assert_eq!(at(4), vec![("D".into(), None)]);
        // `style` 行没有节点 → 不出现
        assert!(lines.iter().all(|l| l.line != 5), "style 行不该有标注");
    }

    #[test]
    fn annotate_covers_dot_and_d2_and_ignores_canvas() {
        let dot = annotate("digraph G {\n  A [shape=diamond];\n  B [fillcolor=red];\n}", FormatId::Dot, false);
        assert_eq!(dot[0].line, 2);
        assert_eq!(dot[0].nodes[0].role.as_deref(), Some("decide"));
        assert!(dot.iter().any(|l| l.nodes.iter().any(|n| n.id == "B" && n.role.is_none())));

        let d2 = annotate("a: 开始\nb.shape: diamond\n", FormatId::D2, false);
        assert!(d2.iter().any(|l| l.line == 1 && l.nodes[0].role.as_deref() == Some("entry")));
        assert!(annotate("{}", FormatId::Drawio, false).is_empty());
    }

    #[test]
    fn color_traces_counts_what_clear_cannot_remove() {
        let body = "flowchart TD\n    A[开始] --> B[写库]\n    style A fill:#f00\n    classDef x fill:#0f0\n";
        assert_eq!(color_traces(body, FormatId::Mermaid), 2);
        // 我们自己的块不算"痕迹"（它本来就是 clear 负责的部分）
        let painted = paint(body, FormatId::Mermaid, "pine", false, PaletteMode::OnlyUncolored).unwrap();
        assert_eq!(color_traces(&painted.body, FormatId::Mermaid), 2);
        // 清完之后痕迹条数不变（我们的块没了，手写的还在）
        let cleared = clear(&painted.body, FormatId::Mermaid);
        assert_eq!(color_traces(&cleared.body, FormatId::Mermaid), 2);
        // DOT / D2 各自的关键字
        assert_eq!(color_traces("digraph G {\n A [fillcolor=red];\n}\n", FormatId::Dot), 1);
        assert_eq!(color_traces("a.style.fill: \"#fff\"\n", FormatId::D2), 1);
        // 注释里的颜色不算
        assert_eq!(color_traces("# style.fill: red\n", FormatId::D2), 0);
    }

    #[test]
    fn structure_sig_ignores_colors_but_catches_structure_changes() {
        let a = "flowchart TD\n    A --> B\n    B --> C\n";
        let colored = paint(a, FormatId::Mermaid, "pine", false, PaletteMode::All).unwrap();
        assert_eq!(
            structure_sig(a, FormatId::Mermaid),
            structure_sig(&colored.body, FormatId::Mermaid),
            "上色不该改变结构签名"
        );
        let restructured = "flowchart TD\n    A --> B\n    B --> D\n";
        assert_ne!(
            structure_sig(a, FormatId::Mermaid),
            structure_sig(restructured, FormatId::Mermaid),
            "换了节点就必须报出来（AI 清洗时靠它拒绝改坏图）"
        );
    }

    #[test]
    fn scan_reports_traces_and_signature_together() {
        let body = "flowchart TD\n    A --> B\n    style A fill:#f00\n";
        let s = scan(body, FormatId::Mermaid);
        assert_eq!(s.traces, 1);
        assert_eq!(s.sig.as_deref(), Some("A,B"));
    }

    #[test]
    fn probe_is_empty_for_canvas_formats() {
        let p = probe("<mxfile/>", FormatId::Drawio);
        assert!(p.baked.is_none() && p.suggested.is_none());
    }

    #[test]
    fn canvas_formats_are_rejected_with_a_reason() {
        for f in [FormatId::Drawio, FormatId::Excalidraw] {
            let err = paint("<mxfile/>", f, "pine", false, PaletteMode::All).unwrap_err();
            assert!(err.contains("画布型"), "{err}");
        }
    }

    #[test]
    fn unknown_palette_is_a_loud_error() {
        let err = paint("flowchart TD\n A\n", FormatId::Mermaid, "nope", false, PaletteMode::All).unwrap_err();
        assert!(err.contains("nope") && err.contains("pine"), "{err}");
    }

    #[test]
    fn dots_in_labels_do_not_create_phantom_nodes() {
        // 属性里的值不能当成节点（`rankdir=LR` / `label="a.b"`）
        let nodes = dot_nodes("digraph G {\n rankdir=LR;\n A [label=\"a.b\"];\n A -> B;\n}\n");
        let ids: Vec<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, vec!["A", "B"], "{ids:?}");
    }

    #[test]
    fn edge_attributes_are_not_mistaken_for_node_attributes() {
        let nodes = dot_nodes("digraph G {\n A -> B [style=dashed];\n B [shape=diamond];\n}\n");
        let b = nodes.iter().find(|n| n.id == "B").unwrap();
        assert_eq!(b.attrs.get("style").map(String::as_str), None, "边的 style 不该挂到 B 上");
        assert_eq!(b.attrs.get("shape").map(String::as_str), Some("diamond"));
    }
}
