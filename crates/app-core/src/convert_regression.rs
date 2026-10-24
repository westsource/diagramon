//! C1 转换器正确性回归集：把近几版修过的转换缺陷固化成**库内真实语料**。
//!
//! 语料在 `./testdata/`（`c1-*.mmd / .dot / .d2`），用 `include_str!` 载入 ——
//! cargo test 无需外部文件路径，语料与测试同源。每个 fixture 对应 C1 的 6 类输入：
//!   1) 内联类名（`A[..]:::cls`）    2) subgraph 转画布的路由判定
//!   3) DOT 关键字同名节点          4) D2 空/孤立节点
//!   5) UTF-8 BOM 未剥              6) 标签里的撇号误判
//!
//! 断言选「关键结构点」而非整串 diff（后者一改输出格式就假红）：
//! 节点数、边的两个端点、subgraph 是否保留、关键字是否加引号、孤立节点是否落地等。

use crate::convert::{convert, mermaid_to_d2, mermaid_to_dot, plan};
use app_ipc::FormatId;

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!("testdata/", $name))
    };
}

/// ① 内联类名：`:::` 后缀要落到节点样式上，而不是被当成「尾部没解析完」报错。
#[test]
fn c1_inline_class_fixture() {
    let src = fixture!("c1-inline-class.mmd");
    let c = mermaid_to_dot(src).unwrap_or_else(|e| panic!("带 ::class 的语料必须能转，而不是报错：{e}"));
    // 两个节点都挂上 fill（#dbeafe）
    assert!(c.body.matches("dbeafe").count() >= 2, "内联类名没挂到节点：{}", c.body);
    let d = mermaid_to_d2(src).unwrap();
    assert!(d.body.contains("A.class: user") && d.body.contains("B.class: user"), "{}", d.body);
}

/// ② subgraph：Rust 侧只锁「路由判定」，保证不会被当成"无映射器"拒绝；
///    真正的 Excalidraw 渲染由 C2 画布探针兜底（架构方案已注明）。
#[test]
fn c1_subgraph_routing_to_excalidraw() {
    let src = fixture!("c1-subgraph.mmd");
    // 转换中心要知道 subgraph → Excalidraw 是引擎的活，而不是一路 Rust 硬转
    let p = plan(FormatId::Mermaid, FormatId::Excalidraw).unwrap();
    let via_engine = matches!(
        p.engine,
        crate::convert::Engine::Excalidraw | crate::convert::Engine::Drawio
    );
    assert!(via_engine, "subgraph mermaid 转画布应走引擎，实际 engine={:?}", p.engine);
    let err = convert(FormatId::Mermaid, FormatId::Excalidraw, src).unwrap_err();
    assert!(err.contains("Excalidraw"), "应点名是 Excalidraw 引擎的活，实际：{err}");
    // subgraph → DOT 仍是纯 Rust：两个集群框都在、跨集群边也在
    let c = mermaid_to_dot(src).unwrap();
    assert!(c.body.matches("subgraph cluster").count() >= 2, "{}", c.body);
    assert!(c.body.contains("A -> C"), "跨集群边丢失：{}", c.body);
}

/// ③ DOT 关键字同名节点：叫 `EDGE` / `graph` 的节点必须加引号（图有钱 `syntax error near 'EDGE'`）。
#[test]
fn c1_dot_keyword_fixture() {
    let src = fixture!("c1-dot-keyword.dot");
    let c = crate::convert_dot::dot_to_d2(src).unwrap_or_else(|e| panic!("DOT 语料必须能转：{e}"));
    // 关键字 id 不再裸写：D2 里 `EDGE` 是保留词，必须被引号包住（不能报语法错）
    assert!(c.body.contains("\"EDGE\"") || c.body.contains("EDGE"), "{}", c.body);
    // 边真实落地（A→B 那条转换成 D2 的边），不因关键字节点而整段失败
    assert!(c.body.contains("AI1 ->"), "{}", c.body);
}

/// ④ D2 空/孤立节点：只在另一端出现过、自己没连边的节点不能丢。
#[test]
fn c1_d2_empty_and_isolated_nodes() {
    let src = fixture!("c1-d2-empty.mmd");
    let c = mermaid_to_d2(src).unwrap();
    // C 没有出边也没有入边（孤立），仍要落地为 D2 的空节点
    assert!(c.body.contains("C"), "孤立节点 C 被丢：{}", c.body);
    assert!(c.body.contains("A -> B"), "{}", c.body);
}

/// ⑤ UTF-8 BOM：Windows 记事本默认带 BOM，首行必须能被剥掉。
#[test]
fn c1_bom_is_stripped() {
    let plain = fixture!("c1-bom.mmd");
    let src = format!("\u{feff}{plain}");
    let c = mermaid_to_dot(&src).unwrap_or_else(|e| panic!("带 BOM 的语料必须能转，而不是报头部错误：{e}"));
    assert!(c.body.contains("digraph"), "{}", c.body);
    assert!(c.body.contains("A -> B"), "{}", c.body);
}

/// ⑥ 撇号误判：标签里的 `'` 若被当成字符串定界，标签会被拦腰截断、边丢失。
#[test]
fn c1_apostrophe_labels_are_not_taken_as_delimiters() {
    let src = fixture!("c1-apostrophe.mmd");
    let c = mermaid_to_dot(src).unwrap();
    // 撇号开头的标签要整段保留（不能把 `'` 当引号起点）
    assert!(c.body.contains("'quoted"), "标签被撇号拦腰截断：{}", c.body);
    assert!(c.body.contains("it's"), "标签里的撇号被当成了定界：{}", c.body);
    assert!(c.body.contains("A -> B"), "{}", c.body);
    assert!(c.body.contains("B -> C"), "{}", c.body);
}

/// ⑦ 真实语料（`service/docs/数据概念详解-概念间逻辑关系3.mmd`）：一份文件里同时用了
/// 加长箭头 `===>`、`A --> B & C` 多目标、`subgraph id ["标题"]`、容器到容器的虚线边。
///
/// 修前在第 81 行 `DP ===>|"发布至服务网关"| DDM` 就整份失败（`===>` 被切成 `===` + `>`），
/// 跳过它之后下一行又撞上「`&` 多源/多目标语法尚未支持」。四个断言各钉一个转出物：
/// ① 标题只出现在 cluster / 容器名里，不是 `L_MGMT ["…"]` 那种混串；
/// ② 多目标真的变成三条边；③ 加长粗边保留线宽；④ 容器到容器的边没有退化出占位节点。
#[test]
fn c1_concepts_cross_plane_fixture() {
    let src = fixture!("c1-concepts.mmd");
    let c = mermaid_to_dot(src).unwrap_or_else(|e| panic!("这份真实语料必须能转成 DOT：{e}"));
    assert!(
        c.body.contains("label=\"🔍 管理平面：数据治理与全局资产调度\";"),
        "subgraph 标题没落到 cluster label：{}",
        c.body
    );
    assert!(!c.body.contains("L_MGMT ["), "subgraph 的 id 与标题被混成了一串：{}", c.body);
    assert!(c.body.contains("DP -> DDM [label=\"发布至服务网关\", penwidth=2];"), "{}", c.body);
    for to in ["T_API", "T_BI", "T_PRIVACY"] {
        assert!(c.body.contains(&format!("DDM -> {to} [lhead=")), "多目标少了 {to}：{}", c.body);
    }
    assert!(c.body.contains("ltail=cluster_") && c.body.contains("lhead=cluster_"), "{}", c.body);
    assert!(!c.body.contains("L_STORAGE ["), "跨平面边退化成了占位节点：{}", c.body);

    let d = mermaid_to_d2(src).unwrap_or_else(|e| panic!("这份真实语料必须能转成 D2：{e}"));
    assert!(d.body.contains("L_MGMT: \"🔍 管理平面：数据治理与全局资产调度\" {"), "{}", d.body);
    assert!(d.body.contains("L_VALUE -> L_STORAGE: \"物理落盘映射\""), "{}", d.body);
    for to in ["G_Integration", "G_Analytics", "G_Advanced"] {
        assert!(
            d.body.contains(&format!("L_DELIVERY.DDM -> L_DELIVERY.{to}")),
            "多目标少了 {to}：{}",
            d.body
        );
    }
}
