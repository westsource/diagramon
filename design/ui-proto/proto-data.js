/* ============================================================================
 * 原型数据层 —— 对应真实实现里的 crates/app-core/src/format.rs（格式注册表）
 * 与 crates/app-ipc（契约）。原型里集中在这一份，视图不做第二份清单。
 * ========================================================================== */

/** 格式注册表：能力位决定 UI 上出现什么（分屏、转换、AI 提示词、画布手势）。 */
const FORMATS = {
  mermaid: {
    id: "mermaid",
    name: "Mermaid",
    exts: [".mmd", ".mermaid"],
    color: "var(--fmt-mermaid)",
    surface: "text", // text = 源码+预览分屏；canvas = 画布即编辑器
    splitView: true,
    ai: true,
    convertFrom: true, // 可作为转换的源
    convertTo: ["drawio", "excalidraw", "dot"],
    lang: "mermaid",
    note: "文本图表，支持源码 / 分屏 / 预览三态",
  },
  dot: {
    id: "dot",
    name: "Graphviz DOT",
    short: "DOT",
    exts: [".dot", ".gv"],
    color: "var(--fmt-dot)",
    surface: "text",
    splitView: true,
    ai: true,
    convertFrom: false,
    convertTo: ["mermaid"], // 计划中，原型里标为实验
    layouts: ["dot", "neato", "fdp", "sfdp", "twopi", "circo"],
    lang: "dot",
    note: "文本图表，支持源码 / 分屏 / 预览三态，六种布局引擎",
  },
  drawio: {
    id: "drawio",
    name: "drawio",
    exts: [".drawio"],
    color: "var(--fmt-drawio)",
    surface: "canvas",
    splitView: false,
    ai: false, // 画布型：AI 通过"生成 mermaid → 转换"间接产出
    convertFrom: false,
    convertTo: [],
    lang: "xml",
    note: "画布即编辑器；文件仍是可 diff 的 mxfile XML",
  },
  excalidraw: {
    id: "excalidraw",
    name: "Excalidraw",
    exts: [".excalidraw"],
    color: "var(--fmt-excalidraw)",
    surface: "canvas",
    splitView: false,
    ai: false,
    convertFrom: false,
    convertTo: [],
    lang: "json",
    note: "手绘风画布；文件是场景 JSON",
  },
};

/** 转换矩阵：单向。disabled 的一律给理由，不做"藏起来"。 */
const CONVERSIONS = [
  { from: "mermaid", to: "drawio", ok: true, how: "drawio 自带解析器接管，结果另开标签页", tag: "已实现" },
  { from: "mermaid", to: "excalidraw", ok: true, how: "@excalidraw/mermaid-to-excalidraw，页内完成", tag: "已实现" },
  { from: "mermaid", to: "dot", ok: true, how: "本地 AST 映射：节点 → node，边 → edge，subgraph → cluster", tag: "新增" },
  { from: "dot", to: "mermaid", ok: false, how: "布局反推方向不定，只在 flowchart 子集内可用", tag: "实验" },
  { from: "drawio", to: "mermaid", ok: false, how: "需要几何 → 语义反推，计划 v3.1", tag: "计划中" },
  { from: "excalidraw", to: "mermaid", ok: false, how: "手绘元素无稳定语义，计划 v3.1", tag: "计划中" },
];

/* ---- 文档 ------------------------------------------------------------- */
const MERMAID_SRC = `%% 用户登录流程 —— 含验证码与失败锁定
flowchart TD
    A([开始]) --> B[打开登录页]
    B --> C{已记住账号?}
    C -- 是 --> D[填充账号]
    C -- 否 --> E[手动输入账号]
    D --> F[输入密码]
    E --> F
    F --> G[请求图形验证码]
    G --> H{验证码正确?}
    H -- 否 --> I[刷新验证码]
    I --> G
    H -- 是 --> J[调用 /auth/login]
    J --> K{账号密码匹配?}
    K -- 否 --> L[失败次数 +1]
    L --> M{连续失败 >= 5?}
    M -- 否 --> F
    M -- 是 --> N[锁定账号 15 分钟]
    N --> O([结束])
    K -- 是 --> P[签发 JWT]
    P --> Q[写入本地会话]
    Q --> R([进入首页])

    subgraph 风控
        L
        M
        N
    end

    classDef danger fill:#f8e9e6,stroke:#b0554a;
    class N,L danger;`;

const DOT_SRC = `// 渲染管线依赖图（digraph，布局引擎可切换）
digraph Pipeline {
    rankdir=LR;
    node [shape=box, style="rounded,filled", fillcolor="#f2f4f3", fontname="Inter"];
    edge [color="#7d8887", arrowsize=0.8];

    source   [label="源码文档"];
    parse    [label="解析器\\n(mermaid / dot)"];
    validate [label="语法校验", color="#a97a26"];
    layout   [label="布局引擎\\ndot · neato · fdp"];
    render   [label="SVG 渲染"];
    raster   [label="PNG 栅格化"];
    cache    [label="LRU 缓存\\n32 条", shape=cylinder];
    export   [label="导出 / 剪贴板", shape=box3d];

    source -> parse;
    parse -> validate;
    validate -> layout [label="通过"];
    validate -> source [label="报错行号", style=dashed, color="#b0554a"];
    layout -> render;
    render -> cache [dir=both, label="命中则复用"];
    render -> raster;
    raster -> export;

    subgraph cluster_local {
        label="本机完成，零外部请求";
        style="dashed,rounded";
        parse; validate; layout; render; raster;
    }
}`;

const DRAWIO_SRC = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="Diagramon" version="3.0.0" type="device">
  <diagram name="服务拓扑" id="topo-1">
    <mxGraphModel dx="1420" dy="860" grid="1" gridSize="10" page="1"
                  pageWidth="1169" pageHeight="826" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="client" value="桌面客户端&#10;Rust + WebView2" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#e4efec;strokeColor=#3d7d72;" vertex="1" parent="1">
          <mxGeometry x="80" y="120" width="180" height="70" as="geometry" />
        </mxCell>
        <mxCell id="gw" value="云网关&#10;/v1/ai/chat/completions" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="360" y="120" width="200" height="70" as="geometry" />
        </mxCell>
        <mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;" edge="1" parent="1" source="client" target="gw">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

const EXCALIDRAW_SRC = `{
  "type": "excalidraw",
  "version": 2,
  "source": "https://diagramon.app",
  "elements": [
    {
      "id": "r1",
      "type": "rectangle",
      "x": 120, "y": 96,
      "width": 168, "height": 62,
      "strokeColor": "#3d7d72",
      "backgroundColor": "#e4efec",
      "fillStyle": "solid",
      "roughness": 1,
      "roundness": { "type": 3 }
    },
    {
      "id": "t1",
      "type": "text",
      "x": 148, "y": 116,
      "text": "客户端",
      "fontSize": 20,
      "fontFamily": 1
    },
    {
      "id": "a1",
      "type": "arrow",
      "x": 292, "y": 128,
      "points": [[0, 0], [124, 8]],
      "startBinding": { "elementId": "r1" },
      "endBinding": { "elementId": "r2" }
    }
  ],
  "appState": { "viewBackgroundColor": "#ffffff", "gridSize": null }
}`;

/** 打开的标签页。surface=text 的文档带 mode（source/split/preview）。 */
const DOCS = [
  {
    id: "d1",
    name: "登录流程.mmd",
    path: "E:/OpenCode/diagramon/docs/flows/登录流程.mmd",
    format: "mermaid",
    dirty: true,
    mode: "split",
    src: MERMAID_SRC,
    svgKey: "flow",
    caret: { line: 9, col: 12 },
    issues: [
      { sev: "warn", line: 25, msg: "subgraph 「风控」内的节点在 classDef 之前声明，部分渲染器会忽略样式", hint: "把 classDef 提到 subgraph 之前" },
      { sev: "err", line: 17, msg: "边标签含 `>=` 未转义，Mermaid 10.x 会解析成 HTML 起始标记", hint: "写成 &gt;= 或用引号包裹" },
    ],
  },
  {
    id: "d2",
    name: "渲染管线.dot",
    path: "E:/OpenCode/diagramon/docs/arch/渲染管线.dot",
    format: "dot",
    dirty: false,
    mode: "split",
    src: DOT_SRC,
    svgKey: "deps",
    layout: "dot",
    caret: { line: 6, col: 4 },
    issues: [],
  },
  {
    id: "d3",
    name: "服务拓扑.drawio",
    path: "E:/OpenCode/diagramon/docs/arch/服务拓扑.drawio",
    format: "drawio",
    dirty: false,
    mode: "preview",
    src: DRAWIO_SRC,
    svgKey: "topo",
    caret: { line: 8, col: 1 },
    issues: [],
  },
  {
    id: "d4",
    name: "白板草图.excalidraw",
    path: "E:/OpenCode/diagramon/scratch/白板草图.excalidraw",
    format: "excalidraw",
    dirty: true,
    mode: "preview",
    src: EXCALIDRAW_SRC,
    svgKey: "sketch",
    caret: { line: 4, col: 1 },
    issues: [],
  },
];

/** 侧栏「资源管理器」的工作区树。 */
const WORKSPACE = {
  root: "diagramon",
  nodes: [
    { kind: "dir", name: "docs", open: true, children: [
      { kind: "dir", name: "flows", open: true, children: [
        { kind: "file", doc: "d1" },
        { kind: "file", name: "支付回调.mmd", format: "mermaid" },
        { kind: "file", name: "注册引导.mmd", format: "mermaid" },
      ]},
      { kind: "dir", name: "arch", open: true, children: [
        { kind: "file", doc: "d2" },
        { kind: "file", doc: "d3" },
        { kind: "file", name: "数据模型.dot", format: "dot" },
      ]},
    ]},
    { kind: "dir", name: "scratch", open: true, children: [
      { kind: "file", doc: "d4" },
      { kind: "file", name: "会议速记.excalidraw", format: "excalidraw" },
    ]},
    { kind: "file", name: "README.md", format: null },
  ],
};

/** 最近打开（侧栏视图之一）。 */
const RECENT = [
  { doc: "d1", name: "登录流程.mmd", format: "mermaid", when: "12 分钟前" },
  { doc: "d2", name: "渲染管线.dot", format: "dot", when: "1 小时前" },
  { name: "支付回调.mmd", format: "mermaid", path: "docs/flows/支付回调.mmd", when: "昨天" },
  { doc: "d3", name: "服务拓扑.drawio", format: "drawio", when: "昨天" },
  { name: "数据模型.dot", format: "dot", path: "docs/arch/数据模型.dot", when: "3 天前" },
  { doc: "d4", name: "白板草图.excalidraw", format: "excalidraw", when: "上周" },
];

/* ---- AI ---------------------------------------------------------------- */
const AI_MODELS = [
  { id: "auto", name: "自动选档", sub: "服务端按请求内容选档，含识图档", dot: "var(--ok)" },
  { id: "diagram-fast", name: "diagram-fast", sub: "简单图形，响应最快 · 0.3 信用点/次", dot: "var(--ok)" },
  { id: "diagram-pro", name: "diagram-pro", sub: "复杂流程图与长源码 · 1.2 信用点/次", dot: "var(--warn)" },
  { id: "diagram-vision", name: "diagram-vision", sub: "识图专用档 · 2.0 信用点/次", dot: "var(--ai)" },
  { id: "byok", name: "BYOK · gpt-4o", sub: "直连你自己的上游，不计信用点", dot: "var(--accent)" },
];

/** AI 面板三个 tab 的初始会话（原型里是静态脚本，点发送会追加模拟回复）。 */
const AI_STREAMS = {
  chat: [
    { role: "sys", text: "已连接 Diagramon 云 · 本周期剩余 428.5 信用点" },
    { role: "user", text: "画一个用户登录的流程图，要有图形验证码和连续失败锁定" },
    {
      role: "bot",
      text: "按你的要求生成了 flowchart TD：验证码错误回到「刷新验证码」形成回环，连续失败 5 次进入锁定分支，风控相关的三个节点归到 subgraph 里。",
      code: {
        format: "mermaid",
        preview: `flowchart TD\n    A([开始]) --> B[打开登录页]\n    B --> G[请求图形验证码]\n    G --> H{验证码正确?}\n    H -- 否 --> I[刷新验证码] --> G\n    H -- 是 --> J[调用 /auth/login]\n    J --> K{账号密码匹配?}\n    K -- 否 --> L[失败次数 +1]\n    L --> M{连续失败 >= 5?}\n    M -- 是 --> N[锁定账号 15 分钟]`,
        lines: 22,
      },
      used: { model: "diagram-pro", tokens: "1.8k", credits: "1.2" },
      applied: true,
      actions: ["apply", "apply-drawio", "revert", "copy"],
    },
    { role: "user", text: "把「失败次数 +1」改成直接锁定，并且加一条短信通知的分支" },
    {
      role: "bot",
      text: "已改成首次失败即锁定，并把短信通知画成锁定的并行分支（用 & 语法）。第 17 行的边标签里有 `>=`，Mermaid 10.x 会当成 HTML 标记，我顺手转义了。",
      code: { format: "mermaid", preview: `    K -- 否 --> N[锁定账号 15 分钟]\n    N & S[发送短信通知] --> O([结束])\n    K -- 是 --> P[签发 JWT]`, lines: 6 },
      used: { model: "diagram-pro", tokens: "0.9k", credits: "1.2" },
      actions: ["apply", "apply-drawio", "revert", "copy"],
      fixNote: "渲染报错自动修正：第 1 次生成的 `>=` 触发解析错误，已带报错原文回修（可在设置里关闭）",
    },
  ],
  vision: [
    { role: "sys", text: "识图会把所选图片发送到模型服务，仅用于本次生成，不落盘、不进会话记录" },
    {
      role: "user",
      text: "这张白板照片转成 Mermaid",
      image: { name: "IMG_20261010_104213.jpg", size: "1.8 MB · 3024×4032 → 已压到 1568px" },
    },
    {
      role: "bot",
      text: "识别出 6 个节点、7 条连线，是一个带审批回环的流程图。手写的「风控复核」字迹较淡，我按上下文补成了节点名，如果不对告诉我。",
      code: {
        format: "mermaid",
        preview: `flowchart LR\n    A[提交申请] --> B{初审}\n    B -- 通过 --> C[风控复核]\n    B -- 退回 --> A\n    C -- 通过 --> D[放款]\n    C -- 拒绝 --> E[归档]\n    D --> F([结束])`,
        lines: 8,
      },
      used: { model: "diagram-vision", tokens: "3.1k", credits: "2.0" },
      actions: ["apply", "apply-drawio", "copy"],
      conf: [
        { label: "整体结构", v: 92 },
        { label: "节点文字", v: 78 },
        { label: "连线方向", v: 85 },
      ],
    },
  ],
  review: [
    { role: "sys", text: "「改图」把当前标签页的源码作为上下文，只做局部修改，不重写整张图" },
    {
      role: "bot",
      text: "看了当前这张登录流程图，有三处可以改：",
      list: [
        "「锁定账号 15 分钟」是终态但画法上像中间节点，建议加双边框或改用 `end` 样式",
        "验证码回环（I → G）在 TD 布局下会拉出一条很长的反向边，改成 `flowchart LR` 或给这条边加 `linkStyle` 会清爽很多",
        "subgraph「风控」把 L/M/N 圈进去了，但 classDef 写在 subgraph 之后 —— 部分渲染器会忽略样式（与「问题」面板里那条警告是同一件事）",
      ],
      actions: ["apply-first"],
    },
  ],
};

const AI_SUGGEST = [
  "画一个用户登录流程图",
  "把这张图转成时序图",
  "给当前图补上异常分支",
  "解释这张图在讲什么",
  "精简节点，合并重复分支",
];

/* ---- 命令面板 ---------------------------------------------------------- */
/** group: ai / file / view / convert / format / help */
const COMMANDS = [
  { id: "ai.generate", label: "AI：根据描述生成图表", group: "ai", icon: "sparkles", kbd: "Ctrl+I" },
  { id: "ai.vision", label: "AI：识图 —— 截图或选图转成代码", group: "ai", icon: "scan", kbd: "Ctrl+Shift+I" },
  { id: "ai.review", label: "AI：审查并改进当前图", group: "ai", icon: "wand" },
  { id: "ai.model", label: "AI：切换模型档位", group: "ai", icon: "robot" },
  { id: "ai.apply", label: "AI：应用最近一次生成结果", group: "ai", icon: "check" },
  { id: "file.new", label: "新建图表…", group: "file", icon: "plus", kbd: "Ctrl+N" },
  { id: "file.open", label: "打开文件…", group: "file", icon: "folderOpen", kbd: "Ctrl+O" },
  { id: "file.save", label: "保存", group: "file", icon: "save", kbd: "Ctrl+S" },
  { id: "file.saveAs", label: "另存为…", group: "file", icon: "save", kbd: "Ctrl+Shift+S" },
  { id: "file.recent", label: "打开最近文件…", group: "file", icon: "clock", kbd: "Ctrl+R" },
  { id: "file.cloud", label: "云端文档…", group: "file", icon: "cloud" },
  { id: "view.mode.source", label: "视图：仅源码（隐藏预览）", group: "view", icon: "code", kbd: "Ctrl+1" },
  { id: "view.mode.split", label: "视图：源码与预览分屏", group: "view", icon: "splitV", kbd: "Ctrl+2" },
  { id: "view.mode.preview", label: "视图：仅预览（隐藏源码窗口）", group: "view", icon: "eye", kbd: "Ctrl+3" },
  { id: "view.sidebar", label: "视图：切换侧栏", group: "view", icon: "panelLeft", kbd: "Ctrl+B" },
  { id: "view.ai", label: "视图：切换 AI 面板", group: "view", icon: "panelRight", kbd: "Ctrl+Shift+A" },
  { id: "view.panel", label: "视图：切换底部面板", group: "view", icon: "panelBottom", kbd: "Ctrl+J" },
  { id: "view.activitybar", label: "视图：切换活动栏", group: "view", icon: "layers" },
  { id: "view.fullscreen", label: "视图：全屏预览（隐藏所有面板）", group: "view", icon: "maximize", kbd: "Ctrl+Shift+F" },
  { id: "view.theme", label: "外观：切换明暗主题", group: "view", icon: "moon", kbd: "Ctrl+K Ctrl+T" },
  { id: "view.zoom.fit", label: "视图：适应视图", group: "view", icon: "fit", kbd: "Ctrl+0" },
  { id: "conv.drawio", label: "转换：Mermaid → drawio", group: "convert", icon: "swap" },
  { id: "conv.excalidraw", label: "转换：Mermaid → Excalidraw", group: "convert", icon: "swap" },
  { id: "conv.dot", label: "转换：Mermaid → DOT", group: "convert", icon: "swap" },
  { id: "conv.center", label: "转换：打开转换中心", group: "convert", icon: "swap" },
  { id: "fmt.format", label: "格式化源码", group: "format", icon: "wand", kbd: "Shift+Alt+F" },
  { id: "fmt.layout", label: "DOT：切换布局引擎", group: "format", icon: "diagram" },
  { id: "exp.png", label: "导出：PNG（自适应倍率）", group: "format", icon: "download" },
  { id: "exp.svg", label: "导出：SVG", group: "format", icon: "download" },
  { id: "exp.copy", label: "复制图片到剪贴板", group: "format", icon: "copy", kbd: "Ctrl+Shift+C" },
  { id: "help.keys", label: "帮助：键盘快捷键总表", group: "help", icon: "keyboard", kbd: "Ctrl+K Ctrl+S" },
  { id: "help.guide", label: "帮助：操作说明", group: "help", icon: "info" },
  { id: "help.about", label: "帮助：关于 Diagramon", group: "help", icon: "info" },
];

const GROUP_LABEL = { ai: "AI", file: "文件", view: "视图与外观", convert: "格式转换", format: "格式与导出", help: "帮助" };

/* ---- 菜单栏 ------------------------------------------------------------
 * 每一项都带明确的 `act`（分发用），不靠 label 字符串匹配。
 * act 语法：new:<fmt> / open:<docId> / conv:<to> / model:<id> / mode:<m>
 *           cmd:<commandId> / doc:close / app:quit / tip:<文案> / todo
 * children 存在时渲染为二级菜单（悬停展开）。
 */
const MENUS = [
  { id: "file", label: "文件", items: [
    { label: "新建图表…", kbd: "Ctrl+N", icon: "plus", children: [
      { label: "Mermaid", icon: "file", act: "new:mermaid", kbd: ".mmd" },
      { label: "Graphviz DOT", icon: "file", act: "new:dot", kbd: ".dot" },
      { label: "drawio", icon: "file", act: "new:drawio", kbd: ".drawio" },
      { label: "Excalidraw", icon: "file", act: "new:excalidraw", kbd: ".excalidraw" },
    ]},
    { label: "打开文件…", kbd: "Ctrl+O", icon: "folderOpen", act: "tip:原型里请从侧栏「资源管理器」点开一个文件" },
    { label: "打开最近文件", icon: "clock", kbd: "Ctrl+R", children:
      RECENT.slice(0, 5).map((r) => {
        const d = r.doc ? DOCS.find((x) => x.id === r.doc) : null;
        return d
          ? { label: d.name, icon: "file", act: "open:" + d.id, kbd: r.when }
          : { label: r.name, icon: "file", act: "todo", kbd: r.when };
      }).concat([{ sep: true }, { label: "更多…（含搜索过滤）", icon: "search", act: "cmd:file.recent" }]) },
    { sep: true },
    { label: "保存到云端…", icon: "cloud", act: "cmd:file.cloud" },
    { label: "云端文档…", icon: "cloud", act: "cmd:file.cloud" },
    { sep: true },
    { label: "保存", kbd: "Ctrl+S", icon: "save", act: "cmd:file.save" },
    { label: "另存为…", kbd: "Ctrl+Shift+S", icon: "save", act: "cmd:file.saveAs" },
    { sep: true },
    { label: "转换为", icon: "swap", children: [
      { label: "drawio", icon: "swap", act: "conv:drawio", kbd: "已实现" },
      { label: "Excalidraw", icon: "swap", act: "conv:excalidraw", kbd: "已实现" },
      { label: "DOT", icon: "swap", act: "conv:dot", kbd: "新增" },
      { sep: true },
      { label: "转换中心…（含全部方向与理由）", icon: "swap", act: "cmd:conv.center" },
    ]},
    { sep: true },
    { label: "关闭标签页", kbd: "Ctrl+W", icon: "close", act: "doc:close" },
    { label: "退出", kbd: "Ctrl+Q", icon: "close", act: "app:quit" },
  ]},
  { id: "edit", label: "编辑", items: [
    { label: "撤销", kbd: "Ctrl+Z", icon: "undo", act: "tip:编辑器内撤销由 CodeMirror 提供" },
    { label: "重做", kbd: "Ctrl+Y", icon: "undo", act: "tip:编辑器内重做由 CodeMirror 提供" },
    { sep: true },
    { label: "查找替换", kbd: "Ctrl+F", icon: "search", act: "tip:CodeMirror SearchPanel，作用域是当前源码窗口" },
    { label: "格式化源码", kbd: "Shift+Alt+F", icon: "wand", act: "cmd:fmt.format" },
    { sep: true },
    { label: "剪切", kbd: "Ctrl+X", act: "todo" }, { label: "复制", kbd: "Ctrl+C", act: "todo" },
    { label: "粘贴", kbd: "Ctrl+V", act: "todo" }, { label: "全选", kbd: "Ctrl+A", act: "todo" },
  ]},
  { id: "view", label: "视图", items: [
    { label: "命令面板…", kbd: "Ctrl+Shift+P", icon: "bolt", act: "cmd:palette" },
    { sep: true },
    { label: "外观与设置…", icon: "palette", act: "cmd:view.settings" },
    { label: "切换明暗主题", kbd: "Ctrl+K Ctrl+T", icon: "moon", act: "cmd:view.theme" },
    { sep: true },
    { label: "切换侧栏", kbd: "Ctrl+B", icon: "panelLeft", act: "cmd:view.sidebar", check: true },
    { label: "切换 AI 面板", kbd: "Ctrl+Shift+A", icon: "panelRight", act: "cmd:view.ai", check: true },
    { label: "切换底部面板", kbd: "Ctrl+J", icon: "panelBottom", act: "cmd:view.panel", check: true },
    { label: "切换活动栏", icon: "layers", act: "cmd:view.activitybar", check: true },
    { sep: true },
    { label: "仅源码（隐藏预览）", kbd: "Ctrl+1", icon: "code", act: "mode:source", radio: "mode" },
    { label: "源码与预览分屏", kbd: "Ctrl+2", icon: "splitV", act: "mode:split", radio: "mode" },
    { label: "仅预览（隐藏源码窗口）", kbd: "Ctrl+3", icon: "eye", act: "mode:preview", radio: "mode" },
    { label: "全屏预览（隐藏所有面板）", kbd: "Ctrl+Shift+F", icon: "maximize", act: "cmd:view.fullscreen" },
    { sep: true },
    { label: "适应视图", kbd: "Ctrl+0", icon: "fit", act: "cmd:view.zoom.fit" },
    { label: "放大", kbd: "Ctrl+=", act: "cmd:view.zoom.in" },
    { label: "缩小", kbd: "Ctrl+-", act: "cmd:view.zoom.out" },
  ]},
  { id: "ai", label: "AI", items: [
    { label: "生成图表…", kbd: "Ctrl+I", icon: "sparkles", act: "cmd:ai.generate" },
    { label: "识图（截图 → 代码）…", kbd: "Ctrl+Shift+I", icon: "scan", act: "cmd:ai.vision" },
    { label: "审查并改进当前图", icon: "wand", act: "cmd:ai.review" },
    { label: "应用最近一次生成结果", icon: "check", act: "cmd:ai.apply" },
    { sep: true },
    { label: "切换模型档位", icon: "robot", children:
      AI_MODELS.map((m) => ({ label: m.name, icon: "robot", act: "model:" + m.id, kbd: m.sub.slice(0, 18) })) },
    { label: "历史会话…", icon: "history", act: "cmd:ai.history" },
    { sep: true },
    { label: "AI 设置…", icon: "settings", act: "cmd:view.settings.ai" },
    { label: "本周期用量：已用 71.5 / 500 信用点", disabled: true, icon: "bolt" },
  ]},
  { id: "account", label: "账户", items: [
    { label: "已登录：道荣 (westsource@126.com)", disabled: true, icon: "user" },
    { label: "会员：Pro · 2026-11-03 到期", disabled: true, icon: "key" },
    { sep: true },
    { label: "用量与账单…", icon: "bolt", act: "cmd:view.settings.cloud" },
    { label: "云端文档…", icon: "cloud", act: "cmd:file.cloud" },
    { sep: true },
    { label: "退出登录", icon: "close", act: "todo" },
  ]},
  { id: "help", label: "帮助", items: [
    { label: "键盘快捷键总表", kbd: "Ctrl+K Ctrl+S", icon: "keyboard", act: "cmd:help.keys" },
    { label: "操作说明", icon: "info", act: "cmd:help.guide" },
    { sep: true },
    { label: "Mermaid 文档", icon: "globe", act: "tip:原型不打开外部链接" },
    { label: "Graphviz DOT 规范", icon: "globe", act: "tip:原型不打开外部链接" },
    { sep: true },
    { label: "检查更新…", icon: "refresh", act: "cmd:help.update" },
    { label: "关于 Diagramon", icon: "info", act: "cmd:help.about" },
  ]},
];

/* ---- 底部面板 ---------------------------------------------------------- */
const PANEL_TABS = [
  { id: "problems", label: "问题", icon: "alert", countFrom: "issues" },
  { id: "output", label: "输出", icon: "term" },
  { id: "convert", label: "转换记录", icon: "swap" },
  { id: "usage", label: "AI 用量", icon: "bolt" },
];

const OUTPUT_LOG = [
  { t: "11:42:07", m: "文档已打开：登录流程.mmd（mermaid，2.1 KB）", k: "" },
  { t: "11:42:07", m: "mermaid v11.4.0 初始化完成（页内渲染，零外部请求）", k: "ok" },
  { t: "11:42:08", m: "渲染完成 · 22 节点 · 26 边 · 1 subgraph · 138 ms", k: "ok" },
  { t: "11:42:08", m: "后台预生成 PNG @2.5x（按元素数量自适应倍率）", k: "" },
  { t: "11:43:12", m: "语法校验：第 17 行边标签含未转义的 `>=`", k: "err" },
  { t: "11:43:12", m: "已把报错原文发回模型请求修正（第 2 次真实调用，计入用量）", k: "warn" },
  { t: "11:43:19", m: "修正后渲染完成 · 141 ms · LRU 命中 1/32", k: "ok" },
  { t: "11:43:40", m: "离线守卫：拦截 0 次外部请求（本会话累计 0）", k: "ok" },
  { t: "11:44:02", m: "转换：mermaid → dot 完成，另开标签页「登录流程.dot」", k: "ok" },
];

const CONVERT_LOG = [
  { t: "11:44:02", from: "mermaid", to: "dot", doc: "登录流程.mmd", ok: true, note: "22 节点 · 26 边 · subgraph → cluster；结果另开标签页，原文件不动" },
  { t: "昨天 18:20", from: "mermaid", to: "drawio", doc: "支付回调.mmd", ok: true, note: "交给 drawio 自带解析器；单向，画布改动不回写源码" },
  { t: "昨天 16:03", from: "mermaid", to: "excalidraw", doc: "注册引导.mmd", ok: true, note: "@excalidraw/mermaid-to-excalidraw 页内完成" },
  { t: "10-06 09:41", from: "dot", to: "mermaid", doc: "数据模型.dot", ok: false, note: "跳过 3 条 record 形状边（flowchart 子集外），已生成部分结果" },
];

const USAGE = {
  period: "2026-10-01 → 2026-11-01",
  used: 71.5,
  total: 500,
  warnRatio: 0.8,
  badRatio: 0.95,
  rows: [
    { model: "diagram-pro", calls: 34, credits: 40.8, avg: "1.2" },
    { model: "diagram-vision", calls: 9, credits: 18.0, avg: "2.0" },
    { model: "diagram-fast", calls: 42, credits: 12.6, avg: "0.3" },
    { model: "BYOK · gpt-4o", calls: 6, credits: 0, avg: "—" },
  ],
  reserved: 2.4,
  note: "在途预留 2.4 信用点（已发出、尚未回账的请求）不计入已用，但计入可用余额。",
};

/* ---- 状态栏 ------------------------------------------------------------ */
const STATUS_RIGHT = ["layout", "zoom", "encoding", "eol", "lang"];

/* ---- 快捷键总表（帮助对话框用） --------------------------------------- */
const SHORTCUTS = [
  { g: "AI（第一公民）", rows: [
    ["Ctrl+I", "打开 AI 并聚焦输入框（当前图自动作为上下文）"],
    ["Ctrl+Shift+I", "识图：截取屏幕区域 → 当前格式代码"],
    ["Ctrl+Shift+A", "显示 / 隐藏 AI 面板"],
    ["Enter / Shift+Enter", "发送 / 换行"],
    ["Ctrl+Enter", "发送并直接应用到编辑器"],
  ]},
  { g: "视图与面板（VS Code 式）", rows: [
    ["Ctrl+B", "侧栏（资源管理器 / 搜索 / 云端 / 转换 / 大纲）"],
    ["Ctrl+J", "底部面板（问题 / 输出 / 转换记录 / AI 用量）"],
    ["Ctrl+Shift+P 或 F1", "命令面板"],
    ["Ctrl+1 / Ctrl+2 / Ctrl+3", "仅源码 / 分屏 / 仅预览（源码窗口可隐藏）"],
    ["Ctrl+Shift+F", "全屏预览：一次隐藏所有面板，再按恢复"],
    ["Ctrl+K Ctrl+T", "切换明暗主题"],
    ["Alt+1…Alt+5", "切换活动栏视图"],
  ]},
  { g: "文件与编辑", rows: [
    ["Ctrl+N / Ctrl+O / Ctrl+S", "新建 / 打开 / 保存"],
    ["Ctrl+Shift+S", "另存为"],
    ["Ctrl+W", "关闭标签页"],
    ["Ctrl+F", "查找替换"],
    ["Shift+Alt+F", "格式化源码"],
    ["Ctrl+Tab", "在标签页间切换"],
  ]},
  { g: "画布手势（四种格式一致）", rows: [
    ["滚轮 / Shift+滚轮", "纵向平移 / 横向平移"],
    ["Ctrl+滚轮", "以光标为中心缩放"],
    ["拖拽 / 中键拖拽 / 空格+拖拽", "平移（画布内左键用于选择）"],
    ["双击 或 Ctrl+0", "适应视图"],
    ["Ctrl+= / Ctrl+-", "放大一档 / 缩小一档"],
  ]},
];

/* ---- 设置对话框的结构（外观/编辑器/AI/转换/云端） --------------------- */
const SETTINGS_TABS = [
  { id: "appearance", label: "外观", icon: "palette" },
  { id: "editor", label: "编辑器与视图", icon: "code" },
  { id: "ai", label: "AI", icon: "sparkles" },
  { id: "convert", label: "格式与转换", icon: "swap" },
  { id: "cloud", label: "账户与云端", icon: "cloud" },
];

/* ---- SVG 图形：四种格式的预览示意 ------------------------------------ */
/* 颜色全部取自 CSS 变量（class 在 proto.css 的 .dg 段），因此明暗主题自动适配。 */

function flowSvg() {
  return `
<svg class="dg" width="470" height="640" viewBox="0 0 470 640">
  <defs>
    <marker id="ah" markerWidth="9" markerHeight="9" refX="7.5" refY="3.2" orient="auto">
      <path d="M0,0 L8,3.2 L0,6.4 z" class="arrowhead"/>
    </marker>
  </defs>
  <!-- 开始 -->
  <rect class="node-box accent" x="185" y="14" width="100" height="34" rx="17"/>
  <text class="node-label" x="235" y="32">开始</text>
  <path class="edge" d="M235,48 V70" marker-end="url(#ah)"/>
  <!-- 打开登录页 -->
  <rect class="node-box" x="165" y="72" width="140" height="38" rx="6"/>
  <text class="node-label" x="235" y="91">打开登录页</text>
  <path class="edge" d="M235,110 V134" marker-end="url(#ah)"/>
  <!-- 判定：验证码 -->
  <path class="node-box" d="M235,136 L315,168 L235,200 L155,168 Z"/>
  <text class="node-label" x="235" y="164">验证码正确?</text>
  <!-- 否 → 刷新 -->
  <path class="edge" d="M315,168 H370 V222" marker-end="url(#ah)"/>
  <text class="edge-label" x="342" y="161">否</text>
  <rect class="node-box" x="310" y="224" width="120" height="36" rx="6"/>
  <text class="node-label" x="370" y="242">刷新验证码</text>
  <path class="edge dash" d="M430,242 H452 V168 H317" marker-end="url(#ah)"/>
  <!-- 是 → 调用登录 -->
  <path class="edge" d="M235,200 V228" marker-end="url(#ah)"/>
  <text class="edge-label" x="252" y="216">是</text>
  <rect class="node-box" x="155" y="230" width="160" height="38" rx="6"/>
  <text class="node-label" x="235" y="243">调用 /auth/login</text>
  <text class="node-sub" x="235" y="258">POST · 带验证码票据</text>
  <path class="edge" d="M235,268 V292" marker-end="url(#ah)"/>
  <!-- 判定：密码 -->
  <path class="node-box" d="M235,294 L325,328 L235,362 L145,328 Z"/>
  <text class="node-label" x="235" y="324">账号密码匹配?</text>
  <!-- 否 → 风控 subgraph -->
  <path class="edge" d="M145,328 H86 V382" marker-end="url(#ah)"/>
  <text class="edge-label" x="112" y="321">否</text>
  <rect class="cluster" x="20" y="384" width="180" height="182" rx="8"/>
  <text class="cluster-label" x="34" y="402">风控</text>
  <rect class="node-box warn" x="46" y="412" width="128" height="34" rx="6"/>
  <text class="node-label" x="110" y="429">失败次数 +1</text>
  <path class="edge" d="M110,446 V464" marker-end="url(#ah)"/>
  <path class="node-box warn" d="M110,466 L168,490 L110,514 L52,490 Z"/>
  <text class="node-label" x="110" y="486">连续失败</text>
  <text class="node-label" x="110" y="500">&gt;= 5?</text>
  <rect class="node-box bad" x="42" y="524" width="136" height="34" rx="6"/>
  <text class="node-label bad" x="110" y="541">锁定账号 15 分钟</text>
  <path class="edge" d="M110,514 V522" marker-end="url(#ah)"/>
  <!-- 回到输入密码 -->
  <path class="edge dash" d="M168,490 H206 V134 H233" marker-end="url(#ah)"/>
  <text class="edge-label" x="196" y="483">否</text>
  <!-- 是 → 签发 JWT -->
  <path class="edge" d="M235,362 V390" marker-end="url(#ah)"/>
  <text class="edge-label" x="252" y="378">是</text>
  <rect class="node-box accent" x="165" y="392" width="140" height="38" rx="6"/>
  <text class="node-label" x="235" y="411">签发 JWT</text>
  <path class="edge" d="M235,430 V456" marker-end="url(#ah)"/>
  <rect class="node-box" x="155" y="458" width="160" height="38" rx="6"/>
  <text class="node-label" x="235" y="477">写入本地会话</text>
  <text class="node-sub" x="235" y="490">DPAPI 加密</text>
  <path class="edge" d="M235,496 V522" marker-end="url(#ah)"/>
  <rect class="node-box accent" x="175" y="524" width="120" height="34" rx="17"/>
  <text class="node-label" x="235" y="541">进入首页</text>
  <!-- 图例 -->
  <g transform="translate(238,586)">
    <text class="edge-label start" x="0" y="0" >图例：</text>
    <rect class="node-box" x="34" y="-9" width="14" height="12" rx="3"/>
    <text class="edge-label start" x="53" y="0" >常规</text>
    <rect class="node-box warn" x="84" y="-9" width="14" height="12" rx="3"/>
    <text class="edge-label start" x="103" y="0" >风控</text>
    <path class="edge dash" d="M136,-3 h20"/>
    <text class="edge-label start" x="161" y="0" >回环</text>
  </g>
</svg>`;
}

function depsSvg() {
  const box = (x, y, w, h, l1, l2, cls) => `
  <rect class="node-box ${cls || ""}" x="${x}" y="${y}" width="${w}" height="${h}" rx="7"/>
  <text class="node-label" x="${x + w / 2}" y="${l2 ? y + h / 2 - 7 : y + h / 2}">${l1}</text>
  ${l2 ? `<text class="node-sub" x="${x + w / 2}" y="${y + h / 2 + 9}">${l2}</text>` : ""}`;
  const edge = (d, label, lx, ly, dash) => `
  <path class="edge ${dash ? "dash" : ""}" d="${d}" marker-end="url(#ah2)"/>
  ${label ? `<text class="edge-label" x="${lx}" y="${ly}">${label}</text>` : ""}`;
  return `
<svg class="dg" width="760" height="420" viewBox="0 0 760 420">
  <defs>
    <marker id="ah2" markerWidth="9" markerHeight="9" refX="7.5" refY="3.2" orient="auto">
      <path d="M0,0 L8,3.2 L0,6.4 z" class="arrowhead"/>
    </marker>
  </defs>
  <rect class="cluster" x="152" y="52" width="452" height="268" rx="10"/>
  <text class="cluster-label" x="168" y="74">本机完成，零外部请求</text>
  ${box(20, 176, 106, 46, "源码文档")}
  ${box(172, 176, 116, 46, "解析器", "mermaid / dot")}
  ${box(172, 268, 116, 46, "语法校验", "报错定位行号", "warn")}
  ${box(320, 176, 116, 46, "布局引擎", "dot · neato · fdp")}
  ${box(464, 176, 116, 46, "SVG 渲染", "页内完成")}
  ${box(464, 268, 116, 46, "PNG 栅格化", "自适应 1.5–5x")}
  ${box(624, 176, 116, 46, "导出 / 剪贴板", "", "accent")}
  <ellipse class="node-box" cx="378" cy="102" rx="58" ry="24"/>
  <text class="node-label" x="378" y="97">LRU 缓存</text>
  <text class="node-sub" x="378" y="112">32 条</text>
  ${edge("M126,199 H170", "", 0, 0)}
  ${edge("M230,222 V266", "", 0, 0)}
  ${edge("M288,291 H378 V224", "通过", 330, 284)}
  ${edge("M230,266 C230,240 150,240 128,206", "报错", 168, 250, true)}
  ${edge("M436,199 H462", "", 0, 0)}
  ${edge("M522,176 V126", "写入", 540, 152)}
  ${edge("M436,102 C470,102 500,140 512,172", "命中复用", 470, 92, true)}
  ${edge("M522,222 V266", "", 0, 0)}
  ${edge("M580,291 H682 V224", "", 0, 0)}
  ${edge("M580,199 H622", "", 0, 0)}
  <text class="edge-label start" x="176" y="352">当前布局：dot　·　状态栏可切换 neato / fdp / sfdp / twopi / circo</text>
  <text class="edge-label start" x="176" y="370">切换走增量更新，不重载 WASM</text>
</svg>`;
}

function topoSvg() {
  const n = (x, y, w, h, t1, t2, cls) => `
  <rect class="node-box ${cls || ""}" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>
  <text class="node-label" x="${x + w / 2}" y="${t2 ? y + h / 2 - 8 : y + h / 2}">${t1}</text>
  ${t2 ? `<text class="node-sub" x="${x + w / 2}" y="${y + h / 2 + 10}">${t2}</text>` : ""}`;
  return `
<svg class="dg" width="720" height="400" viewBox="0 0 720 400">
  <defs>
    <marker id="ah3" markerWidth="9" markerHeight="9" refX="7.5" refY="3.2" orient="auto">
      <path d="M0,0 L8,3.2 L0,6.4 z" class="arrowhead"/>
    </marker>
  </defs>
  <text class="cluster-label" x="36" y="40">服务拓扑（drawio · 画布即编辑器，文件仍是 mxfile XML）</text>
  <rect class="cluster" x="24" y="60" width="300" height="300" rx="10"/>
  <text class="cluster-label" x="40" y="82">本机</text>
  ${n(48, 104, 250, 62, "桌面客户端", "Rust + Tauri 2 + WebView2", "accent")}
  ${n(48, 200, 118, 56, "源码编辑器", "CodeMirror 6")}
  ${n(180, 200, 118, 56, "预览画布", "页内渲染")}
  ${n(48, 286, 250, 54, "本地资产（dgm:// 协议）", "mermaid · graphviz · drawio · excalidraw")}
  <rect class="cluster" x="356" y="60" width="340" height="300" rx="10"/>
  <text class="cluster-label" x="372" y="82">Diagramon 云</text>
  ${n(380, 104, 292, 62, "AI 云网关", "/v1/ai/chat/completions")}
  ${n(380, 190, 140, 56, "别名目录", "档位与候选链")}
  ${n(532, 190, 140, 56, "计量与信用点", "本周期 428.5 剩余")}
  ${n(380, 274, 292, 54, "上游供应商（BYOK 时绕过本层）", "OpenAI · Azure · Ollama · 自定义")}
  <path class="edge" d="M298,135 H378" marker-end="url(#ah3)"/>
  <text class="edge-label" x="338" y="128">access token</text>
  <path class="edge" d="M107,166 V198" marker-end="url(#ah3)"/>
  <path class="edge" d="M239,166 V198" marker-end="url(#ah3)"/>
  <path class="edge" d="M173,228 H178" marker-end="url(#ah3)"/>
  <path class="edge dash" d="M173,256 V284" marker-end="url(#ah3)"/>
  <path class="edge" d="M450,166 V188" marker-end="url(#ah3)"/>
  <path class="edge" d="M602,166 V188" marker-end="url(#ah3)"/>
  <path class="edge" d="M522,166 V272" marker-end="url(#ah3)"/>
  <path class="edge dash" d="M298,313 H356" marker-end="url(#ah3)"/>
  <text class="edge-label" x="327" y="306">离线守卫：0 次外发</text>
</svg>`;
}

function sketchSvg() {
  return `
<svg class="dg" width="640" height="380" viewBox="0 0 640 380">
  <defs>
    <marker id="ah4" markerWidth="9" markerHeight="9" refX="7.5" refY="3.2" orient="auto">
      <path d="M0,0 L8,3.2 L0,6.4 z" class="arrowhead"/>
    </marker>
  </defs>
  <text class="cluster-label" x="34" y="36">白板草图（Excalidraw · 手绘风 · roughness=1）</text>
  <path class="sketch" d="M56,86 c40,-6 96,-4 132,2 c6,32 4,74 -2,104 c-42,6 -96,4 -130,-2 c-6,-34 -4,-72 0,-104 z"/>
  <text class="sketch-text" x="121" y="132">想法</text>
  <text class="sketch-text sketch-sub" x="121" y="156">随手记</text>
  <path class="edge" d="M192,138 c40,-8 60,10 96,4" marker-end="url(#ah4)"/>
  <text class="edge-label" x="240" y="128">先画出来</text>
  <path class="sketch" d="M292,84 c46,-8 108,-2 146,4 c8,36 2,80 -4,110 c-48,8 -104,4 -142,-2 c-8,-38 -6,-76 0,-112 z"/>
  <text class="sketch-text" x="364" y="132">流程图</text>
  <text class="sketch-text sketch-sub" x="364" y="156">mermaid 起步</text>
  <path class="edge" d="M442,140 c34,-4 52,8 82,2" marker-end="url(#ah4)"/>
  <text class="edge-label" x="484" y="130">转换</text>
  <path class="sketch" d="M526,90 c30,-4 62,0 78,4 c4,30 2,66 -2,92 c-28,6 -60,4 -78,-2 c-4,-30 -2,-64 2,-94 z"/>
  <text class="sketch-text" x="565" y="134">drawio</text>
  <text class="sketch-text sketch-sub" x="565" y="156">再精修</text>
  <path class="sketch" d="M120,244 c86,-10 300,-10 400,0 c8,26 6,58 -2,80 c-104,10 -300,10 -396,0 c-8,-26 -8,-56 -2,-80 z"/>
  <text class="sketch-text" x="320" y="278">单向转换：画布上的改动不回写 mermaid 源码</text>
  <text class="sketch-text sketch-sub" x="320" y="302">原 .mmd 标签页保持不动，转换结果另开新标签页</text>
  <path class="edge dash" d="M364,196 V240" marker-end="url(#ah4)"/>
</svg>`;
}

const SVG_FLOW = flowSvg();
const SVG_DEPS = depsSvg();
const SVG_TOPO = topoSvg();
const SVG_SKETCH = sketchSvg();

/** 转换结果预览：mermaid → dot 的示意输出（转换对话框里用）。 */
const CONV_DOT_OUT = `// 由 登录流程.mmd 转换生成 · 单向（不回写源文件）
digraph converted {
    rankdir=TB;
    node [shape=box, style="rounded,filled", fillcolor="#f2f4f3"];

    A [label="开始", shape=oval];
    B [label="打开登录页"];
    G [label="请求图形验证码"];
    H [label="验证码正确?", shape=diamond];
    I [label="刷新验证码"];
    N [label="锁定账号 15 分钟", fillcolor="#f8e9e6"];

    subgraph cluster_risk {
        label="风控";
        L [label="失败次数 +1"];
        M [label="连续失败 >= 5?", shape=diamond];
        N;
    }

    A -> B; B -> G; G -> H;
    H -> I [label="否"]; I -> G;
    H -> J [label="是"];
    K -> L [label="否"]; L -> M;
    M -> N [label="是"];
}`;

const CONV_EXCALIDRAW_OUT = `{
  "type": "excalidraw",
  "version": 2,
  "elements": [
    { "id": "A", "type": "ellipse",   "x": 180, "y": 20,  "width": 110, "height": 46 },
    { "id": "B", "type": "rectangle", "x": 165, "y": 96,  "width": 140, "height": 52 },
    { "id": "H", "type": "diamond",   "x": 160, "y": 180, "width": 150, "height": 76 }
  ],
  "appState": { "viewBackgroundColor": "#ffffff" }
}
// 18 个元素 · 由 mermaid-to-excalidraw 页内生成`;

const CONV_DRAWIO_OUT = `<mxfile host="Diagramon" version="3.0.0">
  <diagram name="登录流程" id="conv-1">
    <mxGraphModel dx="1420" dy="860" grid="1" page="1">
      <root>
        <mxCell id="0"/><mxCell id="1" parent="0"/>
        <mxCell id="A" value="开始" style="ellipse;whiteSpace=wrap;html=1;"
                vertex="1" parent="1">
          <mxGeometry x="180" y="20" width="110" height="46" as="geometry"/>
        </mxCell>
        <!-- 22 个节点 · 26 条边 · 1 个 cluster → swimlane -->
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
