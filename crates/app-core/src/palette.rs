//! 自动配色的**色系注册表**与**确定性落地**。
//!
//! 为什么色值不由模型给：同一个提示词两次生成，模型给的 hex 每次不同；它还看不见当前
//! 主题，暗色下常写出刺眼的浅底。跨格式更是各写一套（Mermaid `classDef` / DOT
//! `fillcolor` / D2 `style.fill`）。所以这里的约定是：
//!
//!   * **模型只写角色**（`:::lvl-entry` / `palette_role="ext"` / `X.class: decide`），
//!     语义判断是它擅长的，色值不是；
//!   * **色系 = 一个种子色相 + 一条明度/饱和度梯度**，六个角色按固定色相偏移派生。
//!     于是"加一个色系"是在 [`SEEDS`] 里加一行，而不是手抄 36 个 hex；
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
//!   * 色值落进文档后**不跟随主题** —— 换主题要重新点一次配色。

use app_ipc::{FormatId, PaletteApplyRes, PaletteInfo, PaletteMode, PaletteRole, RoleSwatch};
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
    Seed { id: "pine", zh: "松绿", en: "Pine", hue: 168.0, sat: 0.42 },
    Seed { id: "indigo", zh: "黛蓝", en: "Indigo", hue: 210.0, sat: 0.40 },
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
    mode: PaletteMode,
) -> Result<PaletteApplyRes, String> {
    let seed = find(palette_id)
        .ok_or_else(|| format!("没有这个色系：「{palette_id}」（可选：{}）", ids().join(" / ")))?;
    match format {
        FormatId::Mermaid => apply_mermaid(body, seed, dark, mode),
        FormatId::Dot => apply_dot(body, seed, dark, mode),
        FormatId::D2 => apply_d2(body, seed, dark, mode),
        FormatId::Drawio | FormatId::Excalidraw => Err(
            "画布型格式没有稳定的节点角色，自动配色只在 Mermaid / DOT / D2 上生效"
                .to_string(),
        ),
    }
}

/// 收集"这批节点各自是什么角色"，并把要不要跳过一起算出来。
///
/// 返回 (角色 → 节点列表, 跳过的个数)。**顺序稳定**（BTreeMap + 文档顺序），
/// 这样同一份文档两次展开产出的字节完全一致 —— 幂等是靠这个成立的。
fn plan<'a>(
    nodes: impl IntoIterator<Item = (String, Option<&'static str>, bool, Option<String>, Option<&'a str>)>,
    mode: PaletteMode,
) -> (BTreeMap<&'static str, Vec<String>>, usize) {
    let mut by_role: BTreeMap<&'static str, Vec<String>> = BTreeMap::new();
    let mut skipped = 0usize;
    for (id, explicit, colored, label, shape) in nodes {
        if mode == PaletteMode::OnlyUncolored && colored && explicit.is_none() {
            skipped += 1;
            continue;
        }
        let role = explicit
            .or_else(|| shape.and_then(role_from_shape))
            .or_else(|| label.as_deref().and_then(role_from_label))
            .unwrap_or("main");
        by_role.entry(role).or_default().push(id);
    }
    (by_role, skipped)
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
    mode: PaletteMode,
) -> Result<PaletteApplyRes, String> {
    let facts = convert::flow_facts(body)?;
    if facts.nodes.is_empty() {
        return Ok(PaletteApplyRes { body: body.to_string(), changed: false, applied: 0, skipped: 0, styles_removed: 0 });
    }
    let ours: Vec<String> = ROLES.iter().map(|r| role_class(r)).collect();
    let items = facts.nodes.iter().map(|n| {
        let explicit = n.classes.iter().find_map(|c| role_of_class(c));
        // 用户自己的类（不是 lvl-*）说明这个节点有别的上色意图；手写 style 更是明确的颜色
        let foreign = n.classes.iter().any(|c| !ours.contains(c));
        let colored = n.styled || foreign;
        (n.id.clone(), explicit, colored, n.label.clone(), Some(n.shape.key()))
    });
    let (by_role, skipped) = plan(items, mode);

    let (mut out, _) = strip_block(body, "%% dgm-palette:begin", "%% dgm-palette:end");
    let mut styles_removed = 0usize;
    if mode == PaletteMode::All {
        let colored_ids: Vec<&String> = by_role.values().flatten().collect();
        let (next, dropped) = drop_style_statements(&out, &colored_ids);
        out = next;
        styles_removed = dropped;
    }

    let mut block = String::from("%% dgm-palette:begin（Diagramon 自动配色 · ");
    block.push_str(seed.zh);
    block.push_str(if dark { " · 暗色" } else { " · 亮色" });
    block.push_str("）\n");
    for role in ROLES {
        let (fill, stroke, text) = swatch(seed, role, dark);
        block.push_str(&format!(
            "classDef {} fill:{fill},stroke:{stroke},color:{text}\n",
            role_class(role)
        ));
    }
    let mut applied = 0usize;
    for (role, ids) in &by_role {
        applied += ids.len();
        block.push_str(&format!("class {} {}\n", ids.join(","), role_class(role)));
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
    let mut skip_next_atom = false; // `digraph G` / `subgraph cluster_x`：下一个原子不是节点
    let mut skip_next_bracket = false; // `node [shape=…]` / `edge [...]`：默认属性
    let mut expect_value = false; // 刚读过 `key=`

    while i < chars.len() {
        let c = chars[i];
        if c == '\n' || c == ';' || c == '{' || c == '}' {
            in_edge = false;
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
            push_dot_node(&mut out, &text);
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
        match lower.as_str() {
            "digraph" | "subgraph" | "strict" => {
                skip_next_atom = true;
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
        push_dot_node(&mut out, &atom);
    }
    out
}

fn push_dot_node(out: &mut Vec<DotNode>, id: &str) {
    if let Some(n) = out.iter_mut().find(|n| n.id == id) {
        let _ = n; // 已存在：属性后面再合并
        return;
    }
    out.push(DotNode { id: id.to_string(), attrs: BTreeMap::new() });
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

fn apply_dot(body: &str, seed: &Seed, dark: bool, mode: PaletteMode) -> Result<PaletteApplyRes, String> {
    let nodes = dot_nodes(body);
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
        )
    });
    let (by_role, skipped) = plan(items, mode);

    // DOT 不用删任何东西：后出现的属性语句会覆盖先前的，所以"整篇重排"就是追加。
    // （Mermaid 的 `style` 语句优先级高于 classDef，那边才必须删。）
    let (mut out, _) = strip_block(body, "// dgm-palette:begin", "// dgm-palette:end");
    let styles_removed = 0usize;

    let mut block = String::from("  // dgm-palette:begin（Diagramon 自动配色 · ");
    block.push_str(seed.zh);
    block.push_str(if dark { " · 暗色" } else { " · 亮色" });
    block.push_str("）\n");
    let mut applied = 0usize;
    let by_id: BTreeMap<&str, &DotNode> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    for (role, ids) in &by_role {
        let (fill, stroke, text) = swatch(seed, role, dark);
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
    role: Option<&'static str>,
    shape: Option<String>,
    label: Option<String>,
    has_fill: bool,
}

fn d2_nodes(body: &str) -> Vec<D2Node> {
    let mut out: Vec<D2Node> = Vec::new();
    let touch = |out: &mut Vec<D2Node>, id: &str| -> usize {
        if let Some(i) = out.iter().position(|n| n.id == id) {
            return i;
        }
        out.push(D2Node { id: id.to_string(), ..Default::default() });
        out.len() - 1
    };
    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.ends_with('{') || line == "}" {
            continue;
        }
        // 只认 `左: 右` 这一种形态；没有冒号的行（`a -> b`）只登记端点
        let (lhs, rhs) = match line.split_once(':') {
            Some((l, r)) => (l.trim(), r.trim()),
            None => {
                for seg in split_d2_path(line) {
                    touch(&mut out, &seg);
                }
                continue;
            }
        };
        if lhs.contains("->") || lhs.contains("--") {
            // 边：两端都是节点，冒号右边是**边标签**，别当成节点标签
            for seg in split_d2_path(lhs) {
                touch(&mut out, &seg);
            }
            continue;
        }
        // 属性行：`a.b.style.fill: "#fff"`
        if let Some((path, key)) = split_d2_attr(lhs) {
            let i = touch(&mut out, &path);
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
        let i = touch(&mut out, lhs);
        if !rhs.is_empty() && !rhs.starts_with('{') {
            out[i].label = Some(rhs.trim_matches('"').to_string());
        }
    }
    out
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

fn apply_d2(body: &str, seed: &Seed, dark: bool, mode: PaletteMode) -> Result<PaletteApplyRes, String> {
    let nodes = d2_nodes(body);
    if nodes.is_empty() {
        return Ok(PaletteApplyRes { body: body.to_string(), changed: false, applied: 0, skipped: 0, styles_removed: 0 });
    }
    let items = nodes.iter().map(|n| {
        let explicit = n
            .role
            .or_else(|| n.shape.as_deref().and_then(role_from_d2_shape));
        (n.id.clone(), explicit, n.has_fill, n.label.clone(), None)
    });
    let (by_role, skipped) = plan(items, mode);

    let (mut out, _) = strip_block(body, "# dgm-palette:begin", "# dgm-palette:end");
    let mut block = String::from("# dgm-palette:begin（Diagramon 自动配色 · ");
    block.push_str(seed.zh);
    block.push_str(if dark { " · 暗色" } else { " · 亮色" });
    block.push_str("）\n");
    let mut applied = 0usize;
    for (role, ids) in &by_role {
        let (fill, stroke, text) = swatch(seed, role, dark);
        for id in ids {
            applied += 1;
            block.push_str(&format!("{id}.style.fill: \"{fill}\"\n"));
            block.push_str(&format!("{id}.style.stroke: \"{stroke}\"\n"));
            block.push_str(&format!("{id}.style.font-color: \"{text}\"\n"));
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
        }
    }

    #[test]
    fn mermaid_gets_one_classdef_per_role_and_a_class_per_node() {
        let res = apply(&mermaid_flow(), FormatId::Mermaid, "pine", false, PaletteMode::All).unwrap();
        assert!(res.changed);
        for role in ROLES {
            assert!(res.body.contains(&format!("classDef lvl-{role} fill:#")), "缺 {role} 的 classDef");
        }
        // 形状/标签推断：A 是体育场形（入口），C 是菱形（判断），E 标签里有"外部"
        // A 体育场形 = 入口；F 的标签是「结束」也是入口；C 的标签含 "?"
        assert!(res.body.contains("class A,F lvl-entry"), "{}", res.body);
        assert!(res.body.contains("class C lvl-decide"), "{}", res.body);
        assert!(res.body.contains("class E lvl-ext"), "E 的标签里有「外部」：\n{}", res.body);
        assert!(res.body.contains("class B,D lvl-main"), "剩下的走主链路：\n{}", res.body);
    }

    #[test]
    fn mermaid_apply_is_idempotent() {
        let once = apply(&mermaid_flow(), FormatId::Mermaid, "pine", false, PaletteMode::All).unwrap();
        let twice = apply(&once.body, FormatId::Mermaid, "pine", false, PaletteMode::All).unwrap();
        assert_eq!(twice.body, once.body, "重跑必须逐字节一致（否则点两次就多一块）");
        assert!(!twice.changed);
    }

    #[test]
    fn switching_palette_only_changes_colors_not_node_roles() {
        let pine = apply(&mermaid_flow(), FormatId::Mermaid, "pine", false, PaletteMode::All).unwrap();
        let lotus = apply(&pine.body, FormatId::Mermaid, "lotus", false, PaletteMode::All).unwrap();
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
        let light = apply(&mermaid_flow(), FormatId::Mermaid, "pine", false, PaletteMode::All).unwrap();
        let dark = apply(&mermaid_flow(), FormatId::Mermaid, "pine", true, PaletteMode::All).unwrap();
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
        let res = apply(&body, FormatId::Mermaid, "pine", false, PaletteMode::OnlyUncolored).unwrap();
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
        let res = apply(&body, FormatId::Mermaid, "pine", false, PaletteMode::All).unwrap();
        assert!(!res.body.contains("style A fill:#f00"), "整篇重排必须删掉覆盖用的 style");
        assert!(res.body.contains("class A lvl-entry"));
        assert_eq!(res.styles_removed, 1, "被覆盖的 style 必须删掉并如实计数");
    }

    #[test]
    fn mermaid_refuses_non_flowchart() {
        let err = apply("sequenceDiagram\n A->>B: hi\n", FormatId::Mermaid, "pine", false, PaletteMode::All)
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
        let res = apply(body, FormatId::Dot, "indigo", false, PaletteMode::OnlyUncolored).unwrap();
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
        let once = apply(body, FormatId::Dot, "pine", false, PaletteMode::OnlyUncolored).unwrap();
        assert_eq!(once.skipped, 1, "A 已有 fillcolor，跳过它");
        assert!(!once.body.contains("A [fillcolor=\"#") || once.body.contains("#123456"));
        let twice = apply(&once.body, FormatId::Dot, "pine", false, PaletteMode::OnlyUncolored).unwrap();
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
        let res = apply(body, FormatId::D2, "ochre", true, PaletteMode::OnlyUncolored).unwrap();
        assert!(res.changed);
        assert!(res.body.contains("b.style.fill:"));
        assert!(res.body.contains("dgm-palette:end"));
        assert_eq!(res.applied, 3);
    }

    #[test]
    fn d2_apply_is_idempotent() {
        let body = "a -> b\nb: 外部\n";
        let once = apply(body, FormatId::D2, "pine", false, PaletteMode::All).unwrap();
        let twice = apply(&once.body, FormatId::D2, "pine", false, PaletteMode::All).unwrap();
        assert_eq!(twice.body, once.body);
        assert!(!twice.changed);
    }

    #[test]
    fn canvas_formats_are_rejected_with_a_reason() {
        for f in [FormatId::Drawio, FormatId::Excalidraw] {
            let err = apply("<mxfile/>", f, "pine", false, PaletteMode::All).unwrap_err();
            assert!(err.contains("画布型"), "{err}");
        }
    }

    #[test]
    fn unknown_palette_is_a_loud_error() {
        let err = apply("flowchart TD\n A\n", FormatId::Mermaid, "nope", false, PaletteMode::All).unwrap_err();
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
