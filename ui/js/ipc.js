/* 与 Rust 侧通信的薄封装 + 开发用 mock 后端。
 *
 * 契约真源：crates/app-ipc/src/lib.rs（字段名/命令名以它为准）。
 *
 * 本文件只做三件事：
 *   1) 统一 invoke / event.listen / window / dialog 的容错包装（Tauri 2 新版是 core.invoke，
 *      老版是顶层 invoke，两者都兼容）。
 *   2) 提供一个可在普通浏览器里直接打开的 mock 后端：检测不到 window.__TAURI__ 时启用，
 *      并在界面可见处标注「mock 模式」，绝不悄悄降级。
 *   3) 暴露一组与契约一一对应的小工具（DGM.ipc.invoke(cmd, args)）。
 *
 * 返回值约定（契约未固定返回值时的补充，前端一律做成可容错）：
 *   - 列表型变更（doc_new / doc_open_paths / doc_close / doc_activate）→ Session{docs,active}
 *   - 单文档变更（doc_save / doc_save_as / doc_set_body / doc_set_view_mode / doc_set_layout）→ Doc
 *   - doc_set_caret / cred_set / cred_delete / ai_chat / ai_cancel → 无意义返回值
 *   - doc_issues → Issue[] · doc_outline → OutlineGroup[] · doc_scope → String
 *   前端 applyResult() 同时接受 Session 与 Doc，所以 Rust 侧两种都接得住。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const TAURI = window.__TAURI__;
  const isTauri = !!(TAURI && (TAURI.core || typeof TAURI.invoke === "function"));

  /* ------------------------------------------------------------------ 事件总线 */

  const bus = new Map(); // event -> Set<handler>（mock 模式用；Tauri 模式走原生 listen）

  function emitLocal(event, payload) {
    const set = bus.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (e) {
        console.error("[DGM] event handler error:", e);
      }
    }
  }

  /* ------------------------------------------------------------------ invoke */

  async function invoke(cmd, args) {
    if (!isTauri) return Mock.invoke(cmd, args);
    const core = TAURI.core;
    if (core && typeof core.invoke === "function") return core.invoke(cmd, args);
    if (typeof TAURI.invoke === "function") return TAURI.invoke(cmd, args);
    throw new Error("Tauri invoke 不可用");
  }

  /** 订阅事件（ai://delta 等）。返回取消订阅函数。 */
  function on(event, handler) {
    if (isTauri && TAURI.event && typeof TAURI.event.listen === "function") {
      let unlisten = null;
      TAURI.event.listen(event, (e) => {
        try {
          handler(e && "payload" in e ? e.payload : e);
        } catch (err) {
          console.error("[DGM] event handler error:", err);
        }
      }).then((fn) => (unlisten = fn));
      return () => {
        if (unlisten) unlisten();
      };
    }
    if (!bus.has(event)) bus.set(event, new Set());
    bus.get(event).add(handler);
    return () => {
      const s = bus.get(event);
      if (s) s.delete(handler);
    };
  }

  /* ------------------------------------------------------------------ 窗口控制 */

  function currentWindow() {
    if (TAURI && TAURI.window && typeof TAURI.window.getCurrentWindow === "function") {
      try {
        return TAURI.window.getCurrentWindow();
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  const win = {
    minimize() {
      const w = currentWindow();
      if (w && typeof w.minimize === "function") return w.minimize();
    },
    toggleMaximize() {
      const w = currentWindow();
      if (w && typeof w.toggleMaximize === "function") return w.toggleMaximize();
      if (w && typeof w.isMaximized === "function") return w.isMaximized();
    },
    close() {
      const w = currentWindow();
      if (w && typeof w.close === "function") return w.close();
    },
    async isMaximized() {
      const w = currentWindow();
      if (w && typeof w.isMaximized === "function") return w.isMaximized();
      return false;
    },
    /** 自定义标题栏拖拽（data-tauri-drag-region 已覆盖大部分场景，这里给窗口按钮旁的兜底）。 */
    startDragging() {
      const w = currentWindow();
      if (w && typeof w.startDragging === "function") return w.startDragging();
    },
  };

  /* ------------------------------------------------------------------ 对话框 */

  async function pickPaths(opts) {
    if (TAURI && TAURI.dialog && typeof TAURI.dialog.open === "function") {
      const res = await TAURI.dialog.open(
        Object.assign({ multiple: true, directory: false }, opts || {}),
      );
      if (res == null) return [];
      return Array.isArray(res) ? res : [res];
    }
    return []; // mock：由调用方兜底（项目里 sample 文档已够用）
  }

  async function pickSavePath(opts) {
    if (TAURI && TAURI.dialog && typeof TAURI.dialog.save === "function") {
      return TAURI.dialog.save(Object.assign({}, opts || {}));
    }
    return null;
  }

  /**
   * 选一张图片并读成 dataURL。
   * Tauri：dialog.open 拿路径 → fs.readFile（若装了 fs 插件）→ base64。
   * 否则：回退到 <input type=file>（WebView2 与浏览器都可用）。
   * 返回值 { name, size, dataUrl } 或 null。
   */
  async function pickImage() {
    const fsMod = TAURI && TAURI.fs;
    if (TAURI && TAURI.dialog && fsMod && typeof fsMod.readFile === "function") {
      try {
        const p = await pickPaths({
          multiple: false,
          filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
        });
        if (!p.length) return null;
        const path = p[0];
        const bytes = await fsMod.readFile(path);
        const ext = (path.split(".").pop() || "png").toLowerCase();
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/png";
        let bin = "";
        for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
        const name = path.split(/[\\/]/).pop();
        return { name, size: bytes.length, dataUrl: `data:${mime};base64,${btoa(bin)}` };
      } catch (e) {
        console.warn("[DGM] dialog+fs 读图失败，回退到 input[type=file]：", e && e.message);
      }
    }
    return pickImageViaInput();
  }

  function pickImageViaInput() {
    return new Promise((resolve) => {
      const input = document.getElementById("ai-image-file");
      if (!input) return resolve(null);
      const done = (val) => {
        input.value = "";
        input.removeEventListener("change", onChange);
        resolve(val);
      };
      const onChange = () => {
        const file = input.files && input.files[0];
        if (!file) return done(null);
        const reader = new FileReader();
        reader.onload = () => done({ name: file.name, size: file.size, dataUrl: reader.result });
        reader.onerror = () => done(null);
        reader.readAsDataURL(file);
      };
      input.addEventListener("change", onChange);
      input.click();
    });
  }

  DGM.ipc = {
    isTauri,
    isMock: !isTauri,
    invoke,
    on,
    emit: emitLocal, // 仅供 mock 后端内部与本地事件转发
    win,
    dialog: { pickPaths, pickSavePath, pickImage },
  };

  /* ==================================================================
   * 内置 mock 后端
   * 只有在检测不到 window.__TAURI__ 时启用。数据形状严格对齐 app-ipc 契约。
   * ================================================================== */

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

  const NEW_BODIES = {
    mermaid: "flowchart TD\n    A([开始]) --> B[第一步]\n    B --> C{判断}\n    C -- 是 --> D([结束])\n    C -- 否 --> B\n",
    dot: "digraph G {\n    rankdir=LR;\n    node [shape=box];\n    A -> B -> C;\n}\n",
    drawio: '<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="Diagramon">\n  <diagram name="Page-1" id="p1">\n    <mxGraphModel dx="800" dy="600" grid="1" page="1">\n      <root>\n        <mxCell id="0" />\n        <mxCell id="1" parent="0" />\n      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n',
    excalidraw: '{\n  "type": "excalidraw",\n  "version": 2,\n  "source": "https://diagramon.app",\n  "elements": [],\n  "appState": { "viewBackgroundColor": "#ffffff" }\n}\n',
  };

  const FORMATS = [
    {
      id: "mermaid", name: "Mermaid", short: "Mermaid", exts: [".mmd", ".mermaid"],
      surface: "text", split_view: true, ai: true,
      convert_to: ["drawio", "excalidraw", "dot"], layouts: [],
      note: "文本图表，支持源码 / 分屏 / 预览三态",
      default_body: NEW_BODIES.mermaid,
    },
    {
      id: "dot", name: "Graphviz DOT", short: "DOT", exts: [".dot", ".gv"],
      surface: "text", split_view: true, ai: true,
      convert_to: [], layouts: ["dot", "neato", "fdp", "sfdp", "twopi", "circo"],
      note: "文本图表，支持源码 / 分屏 / 预览三态，六种布局引擎",
      default_body: NEW_BODIES.dot,
    },
    {
      id: "drawio", name: "drawio", short: "drawio", exts: [".drawio"],
      surface: "canvas", split_view: false, ai: false,
      convert_to: [], layouts: [],
      note: "画布即编辑器；文件仍是可 diff 的 mxfile XML",
      default_body: NEW_BODIES.drawio,
    },
    {
      id: "excalidraw", name: "Excalidraw", short: "Excalidraw", exts: [".excalidraw"],
      surface: "canvas", split_view: false, ai: false,
      convert_to: [], layouts: [],
      note: "手绘风画布；文件是场景 JSON",
      default_body: NEW_BODIES.excalidraw,
    },
  ];

  const ISSUES = {
    d1: [
      { severity: "warning", line: 25, message: "subgraph「风控」内的节点在 classDef 之前声明，部分渲染器会忽略样式", hint: "把 classDef 提到 subgraph 之前" },
      { severity: "error", line: 17, message: "边标签含 `>=` 未转义，Mermaid 10.x 会解析成 HTML 起始标记", hint: "写成 &gt;= 或用引号包裹" },
    ],
    d2: [],
    d3: [],
    d4: [],
  };

  function nowSeq() {
    Mock._seq += 1;
    return Mock._seq;
  }

  /** mock 工作区的默认根：从示例文档的路径推出来，好让浏览器里也能看到一棵真树。 */
  const MOCK_WS_ROOT = "E:/OpenCode/diagramon/docs";

  const Mock = {
    _seq: 0,
    _ai: new Map(), // request_id -> {timer, aborted}
    docs: [],
    active: "d1",
    settings: null,
    /** mock 工作区（结构对齐 app-ipc 的 WorkspaceInfo） */
    ws: { root: null, name: "", tree: [], truncated: false, file_count: 0, dir_count: 0 },
    /** mock 云端（结构对齐 app-ipc 的 CloudStatus / CloudDocList） */
    _cloud: {
      signed: false,
      account: null,
      docs: [
        { id: "cld-1", name: "登录流程.mmd", path: "flows/", format: "mermaid", size: 1024, updated_at: "2026-10-10T10:00:00Z" },
        { id: "cld-2", name: "渲染管线.dot", path: "arch/", format: "dot", size: 2048, updated_at: "2026-10-09T18:30:00Z" },
      ],
    },

    _seed() {
      this.docs = [
        { id: "d1", path: "E:/OpenCode/diagramon/docs/flows/登录流程.mmd", name: "登录流程.mmd", format: "mermaid", body: MERMAID_SRC, dirty: true, view_mode: "split", caret_line: 9, caret_col: 12, layout: null },
        { id: "d2", path: "E:/OpenCode/diagramon/docs/arch/渲染管线.dot", name: "渲染管线.dot", format: "dot", body: DOT_SRC, dirty: false, view_mode: "split", caret_line: 6, caret_col: 4, layout: "dot" },
        { id: "d3", path: "E:/OpenCode/diagramon/docs/arch/服务拓扑.drawio", name: "服务拓扑.drawio", format: "drawio", body: DRAWIO_SRC, dirty: false, view_mode: "preview", caret_line: 8, caret_col: 1, layout: null },
        { id: "d4", path: "E:/OpenCode/diagramon/scratch/白板草图.excalidraw", name: "白板草图.excalidraw", format: "excalidraw", body: EXCALIDRAW_SRC, dirty: true, view_mode: "preview", caret_line: 4, caret_col: 1, layout: null },
      ];
      this.active = "d1";
      // mock 里默认就"打开着"这个示例工作区：否则浏览器原型永远是空树，
      // 看不出这步做了什么。真机上要不要打开由用户点「打开文件夹」决定。
      this.ws = this._wsFromDocs(MOCK_WS_ROOT);
      this.settings = {
        theme: "light",
        density: "normal",
        accent: "pine",
        locale: "zh-CN",
        panels: { activitybar: true, sidebar: true, sidebar_view: "explorer", ai: true, bottom: true, bottom_tab: "problems", sidebar_w: 236, ai_w: 344, panel_h: 168, split_src: 46 },
        editor: { font_size: 13, debounce_ms: 350, lint: true, per_doc_view: true, default_view: "split", autosave: true, autosave_ms: 5000, restrict_to_workspace: false },
        ai: {
          models: [
            { id: "gw-fast", name: "diagram-fast（云网关）", provider: "custom", base_url: "https://api.diagramon.app/v1/ai", model: "diagram-fast", max_tokens: 4096, temperature: 0.4, has_key: true, key_hint: "gw-…7f2a" },
            { id: "byok-1", name: "BYOK · gpt-4o", provider: "openai", base_url: "https://api.openai.com/v1", model: "gpt-4o", max_tokens: 8192, temperature: 0.7, has_key: false, key_hint: "" },
          ],
          default_model: "gw-fast",
          vision_notice_accepted: false,
          render_retry: true,
          context_from_doc: true,
        },
        cloud: { base_url: "https://api.diagramon.app/v1", device_id: "" },
        recent: [
          { path: "E:/OpenCode/diagramon/docs/flows/登录流程.mmd", name: "登录流程.mmd", format: "mermaid", opened_at: 0 },
          { path: "E:/OpenCode/diagramon/docs/arch/渲染管线.dot", name: "渲染管线.dot", format: "dot", opened_at: 0 },
          { path: "E:/OpenCode/diagramon/docs/flows/支付回调.mmd", name: "支付回调.mmd", format: "mermaid", opened_at: 0 },
          { path: "E:/OpenCode/diagramon/docs/arch/服务拓扑.drawio", name: "服务拓扑.drawio", format: "drawio", opened_at: 0 },
          { path: "E:/OpenCode/diagramon/scratch/白板草图.excalidraw", name: "白板草图.excalidraw", format: "excalidraw", opened_at: 0 },
        ],
      };
    },

    _doc(id) {
      return this.docs.find((d) => d.id === id) || null;
    },
    _clone(x) {
      return JSON.parse(JSON.stringify(x));
    },
    /** 从已打开文档的路径堆出一棵树（真机那侧是 Rust 扫盘；mock 里等价物就是这些文档）。 */
    _wsFromDocs(root) {
      const base = String(root || "").replace(/\\/g, "/").replace(/\/$/, "");
      const docs = this.docs.filter((d) => d.path && (!base || d.path.startsWith(base)));
      const dirs = new Map();
      const files = [];
      for (const d of docs) {
        const p = d.path.replace(/\\/g, "/");
        const rest = base && p.startsWith(base) ? p.slice(base.length).replace(/^\//, "") : p;
        const parts = rest.split("/").filter(Boolean);
        if (parts.length < 2) {
          files.push({ name: parts[0] || d.name, path: p, dir: false, format: d.format, children: [] });
          continue;
        }
        let cur = dirs;
        for (const seg of parts.slice(0, -1)) {
          if (!cur.has(seg)) cur.set(seg, new Map());
          cur = cur.get(seg);
        }
        cur.__files = (cur.__files || []).concat([{ name: parts[parts.length - 1], path: p, dir: false, format: d.format, children: [] }]);
      }
      const build = (map, prefix) => {
        const out = [];
        for (const [seg, sub] of map) {
          if (seg === "__files") continue;
          const path = prefix + "/" + seg;
          out.push({ name: seg, path, dir: true, format: null, children: build(sub, path) });
        }
        for (const f of map.__files || []) out.push(f);
        return out;
      };
      const tree = build(dirs, base);
      const count = (nodes) => nodes.reduce((n, x) => n + (x.dir ? count(x.children) : 1), 0);
      const dirCount = (nodes) => nodes.reduce((n, x) => n + (x.dir ? 1 + dirCount(x.children) : 0), 0);
      return {
        root: base || null,
        name: base.split("/").filter(Boolean).pop() || "",
        tree: tree.concat(files),
        truncated: false,
        file_count: count(tree) + files.length,
        dir_count: dirCount(tree),
      };
    },
    /** mock 版全库搜索：命中形状与 Rust 侧逐字段一致（行列都按字符算）。 */
    _search(req) {
      const q = String(req.query == null ? "" : req.query);
      const done = { request_id: req.request_id || "mock", total: 0, files: 0, truncated: false, error: null };
      const hits = [];
      if (!q.trim()) return { hits, done };
      let re = null;
      if (req.regex) {
        try {
          re = new RegExp(q, req.case_sensitive ? "g" : "gi");
        } catch (e) {
          done.error = String((e && e.message) || e);
          return { hits, done };
        }
      }
      const limit = req.max_results ? req.max_results : 500;
      const needle = req.case_sensitive ? q : q.toLowerCase();
      for (const d of this.docs) {
        if (!d.path) continue;
        let fileHits = 0;
        const lines = String(d.body || "").split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          let col = -1;
          if (re) {
            re.lastIndex = 0;
            const m = re.exec(line);
            if (m) col = m.index;
          } else {
            const idx = (req.case_sensitive ? line : line.toLowerCase()).indexOf(needle);
            if (idx >= 0) col = idx;
          }
          if (col < 0) continue;
          done.total += 1;
          fileHits += 1;
          hits.push({
            path: d.path, name: d.name, format: d.format, line: i + 1,
            column: col + 1, text: line.length > 240 ? line.slice(0, 240) + "…" : line,
          });
          if (done.total >= limit) {
            done.truncated = true;
            break;
          }
        }
        if (done.total >= limit) {
          done.files += 1;
          break;
        }
        if (fileHits) done.files += 1;
      }
      return { hits, done };
    },
    _session() {
      return { docs: this._clone(this.docs), active: this.active };
    },
    _fmt(id) {
      return FORMATS.find((f) => f.id === id) || FORMATS[0];
    },
    _newId(prefix) {
      return prefix + nowSeq().toString(36) + Date.now().toString(36).slice(-3);
    },

    async invoke(cmd, args) {
      args = args || {};
      switch (cmd) {
        case "app_info":
          return { version: "3.0.0-mock", platform: "mock", formats: this._clone(FORMATS), limits: { preview_max_lines: 5000, preview_max_bytes: 409600 } };

        // mock 下**故意不给转换结果**：转换器只有 Rust 侧一份实现
        // （`crates/app-core/src/convert.rs`），在浏览器里再写一份 best-effort
        // 就是"两处实现、互不同步"的老问题。如实报错，让人去跑真实客户端。
        case "convert_text": {
          const req = args.req || {};
          throw new Error(
            `mock 模式没有转换器（${req.from} → ${req.to}）：真实转换在 Rust 侧，` +
              "请用 node tools/dev/check.mjs 起真实客户端，或用 python tools/dev/canvas_probe.py 验画布链路",
          );
        }

        case "settings_get":
          return this._clone(this.settings);

        case "settings_patch": {
          deepMerge(this.settings, args.patch || args);
          return this._clone(this.settings);
        }

        case "session_get":
          return this._session();

        case "doc_new": {
          const f = this._fmt(args.format);
          const n = this.docs.filter((d) => d.format === args.format).length + 1;
          const doc = {
            id: this._newId("n"),
            path: null,
            name: `未命名-${n}${f.exts[0]}`,
            format: f.id,
            body: f.default_body,
            dirty: true,
            view_mode: f.split_view ? "split" : "preview",
            caret_line: 1,
            caret_col: 1,
            layout: f.layouts.length ? f.layouts[0] : null,
          };
          this.docs.push(doc);
          this.active = doc.id;
          return this._clone(doc);
        }

        case "doc_open_paths": {
          const paths = args.paths || [];
          for (const p of paths) {
            const existing = this.docs.find((d) => d.path === p);
            if (existing) {
              this.active = existing.id;
              continue;
            }
            const name = p.split(/[\\/]/).pop() || p;
            const ext = (name.split(".").pop() || "").toLowerCase();
            const fid = ext === "dot" || ext === "gv" ? "dot" : ext === "drawio" ? "drawio" : ext === "excalidraw" ? "excalidraw" : "mermaid";
            const f = this._fmt(fid);
            const doc = {
              id: this._newId("o"),
              path: p,
              name,
              format: fid,
              body: f.default_body,
              dirty: false,
              view_mode: f.split_view ? "split" : "preview",
              caret_line: 1,
              caret_col: 1,
              layout: f.layouts.length ? f.layouts[0] : null,
            };
            this.docs.push(doc);
            this.active = doc.id;
          }
          return this._session();
        }

        case "doc_save": {
          const d = this._doc(args.id);
          if (d) d.dirty = false;
          return d ? this._clone(d) : null;
        }

        case "doc_save_as": {
          const d = this._doc(args.id);
          if (d) {
            d.path = args.path;
            d.name = (args.path || d.name).split(/[\\/]/).pop();
            d.dirty = false;
          }
          return d ? this._clone(d) : null;
        }

        case "doc_close": {
          const i = this.docs.findIndex((d) => d.id === args.id);
          if (i >= 0) this.docs.splice(i, 1);
          if (this.active === args.id) {
            const nx = this.docs[Math.min(i, this.docs.length - 1)];
            this.active = nx ? nx.id : null;
          }
          return this._session();
        }

        case "doc_activate": {
          if (this._doc(args.id)) this.active = args.id;
          return this._session();
        }

        case "doc_set_body": {
          const d = this._doc(args.id);
          if (d) {
            if (d.body !== args.body) d.dirty = true;
            d.body = args.body;
          }
          return d ? this._clone(d) : null;
        }

        case "doc_set_caret": {
          const d = this._doc(args.id);
          if (d) {
            d.caret_line = args.line;
            d.caret_col = args.col;
          }
          return null;
        }

        case "doc_set_view_mode": {
          const d = this._doc(args.id);
          if (d) d.view_mode = args.mode;
          return d ? this._clone(d) : null;
        }

        case "doc_set_layout": {
          const d = this._doc(args.id);
          if (d) d.layout = args.layout;
          return d ? this._clone(d) : null;
        }

        case "doc_issues":
          return this._clone(ISSUES[args.id] || []);

        case "doc_outline":
          return this._outline(args.id);

        case "doc_scope":
          return this._scope(args.id);

        case "doc_reload": {
          const d = this._doc(args.id);
          if (!d) throw new Error("文档不存在：" + args.id);
          return this._clone(d);
        }

        /* ---- 工作区（mock：从已打开文档的路径反推出一棵真树） ---- */
        case "workspace_get":
          return this._clone(this.ws);

        case "workspace_open": {
          const root = args.path || MOCK_WS_ROOT;
          const docs = this.docs.filter((d) => d.path && d.path.startsWith(root));
          if (!docs.length) throw new Error("mock 工作区里没有图表文件：" + root);
          this.ws = { ...this._wsFromDocs(root), root, name: root.split(/[\\/]/).filter(Boolean).pop() };
          return this._clone(this.ws);
        }

        case "workspace_close":
          this.ws = this._wsFromDocs("");
          return this._clone(this.ws);

        case "workspace_new_file": {
          const dir = String(args.dir || "").replace(/\\/g, "/").replace(/\/$/, "");
          const f = this._fmt(args.format);
          let name = String(args.name || "").trim();
          if (name && !/\.[a-z0-9]+$/i.test(name)) name += f.exts[0];
          if (!name) throw new Error("名称为空");
          const path = dir + "/" + name;
          if (this.docs.some((d) => d.path === path)) throw new Error("同名文件已存在：" + name);
          const doc = {
            id: this._newId("n"), path, name, format: f.id, body: f.default_body,
            dirty: true, view_mode: f.split_view ? "split" : "preview",
            caret_line: 1, caret_col: 1, layout: f.layouts.length ? f.layouts[0] : null,
          };
          this.docs.push(doc);
          this.active = doc.id;
          this.ws = this._wsFromDocs(this.ws.root);
          return path;
        }

        case "workspace_rename": {
          const d = this.docs.find((x) => x.path === args.path);
          if (!d) throw new Error("找不到：" + args.path);
          let name = String(args.name || "").trim();
          const dot = d.path.lastIndexOf(".");
          if (name && !/\.[a-z0-9]+$/i.test(name)) name += d.path.slice(dot);
          d.path = d.path.replace(/[^\\/]+$/, name);
          d.name = name;
          this.ws = this._wsFromDocs(this.ws.root);
          return d.path;
        }

        case "workspace_delete": {
          const i = this.docs.findIndex((x) => x.path === args.path);
          if (i < 0) throw new Error("找不到：" + args.path);
          const [gone] = this.docs.splice(i, 1);
          if (this.active === gone.id) this.active = this.docs[0] ? this.docs[0].id : null;
          this.ws = this._wsFromDocs(this.ws.root);
          return null;
        }

        case "search_run": {
          const req = args.req || {};
          const { hits, done } = this._search(req);
          // 逐条推，模拟流式（mock 下 setTimeout 可用；真机那侧由 Rust 推）
          hits.forEach((h) => setTimeout(() => emitLocal("search://hit", h), 0));
          setTimeout(() => emitLocal("search://done", done), 0);
          return null;
        }

        case "search_cancel":
          return null;

        /* ---- 云网关（mock：一个内存账户 + 两份示例文档） ---- */
        case "cloud_status": {
          const cfg = (this.settings.cloud || {}).base_url || "";
          return this._cloud.signed
            ? { signed_in: true, base_url: cfg, account: this._cloud.account }
            : { signed_in: false, base_url: cfg, account: null };
        }
        case "cloud_login": {
          if (!(this.settings.cloud || {}).base_url) throw new Error("云网关未配置：先在 设置 → 云端 里填服务地址");
          const { email } = args;
          if (!email || !args.password) throw new Error("邮箱和密码都要填");
          this._cloud.signed = true;
          this._cloud.account = {
            email, display_name: email.split("@")[0], role: "user", plan_name: "Free",
            used_bytes: 20480, quota_bytes: 104857600,
          };
          return this._cloud.account;
        }
        case "cloud_logout":
          this._cloud.signed = false;
          return true;
        case "cloud_docs_list":
          if (!this._cloud.signed) throw new Error("尚未登录云网关");
          return {
            items: this._cloud.docs.map((d) => ({ ...d })),
            has_more: false,
            used_bytes: this._cloud.docs.reduce((n, d) => n + d.size, 0),
            quota_bytes: 104857600,
          };
        case "cloud_doc_save": {
          if (!this._cloud.signed) throw new Error("尚未登录云网关");
          // 乐观锁与真实服务端同口径：version=0 = 仅当不存在时创建；
          // 带版本但不匹配 = 409 version_conflict（客户端如实透传给用户）
          const id = args.id || "cld-" + this._newId("");
          const ex = this._cloud.docs.find((d) => d.id === id);
          if (!ex && args.id) throw new Error("云端没有这份文档（版本冲突或已删除）");
          if (ex && args.version && ex.version !== args.version) {
            throw new Error("云网关 409：文档已被其它设备修改（version_conflict）");
          }
          const nextVer = (ex ? ex.version : 0) + 1;
          const doc = {
            id, name: args.name, path: "", format: args.format,
            size: String(args.body || "").length, updated_at: new Date().toISOString(),
            version: nextVer,
          };
          if (ex) Object.assign(ex, doc);
          else this._cloud.docs.push(doc);
          return { ...doc };
        }
        case "cloud_doc_open": {
          if (!this._cloud.signed) throw new Error("尚未登录云网关");
          const d = this._cloud.docs.find((x) => x.id === args.id);
          if (!d) throw new Error("云端没有这份文档：" + args.id);
          return { id: d.id, name: d.name, format: d.format, body: this._fmt(d.format).default_body, version: d.version || 1 };
        }
        case "cloud_doc_delete": {
          if (!this._cloud.signed) throw new Error("尚未登录云网关");
          const i = this._cloud.docs.findIndex((x) => x.id === args.id);
          if (i >= 0) this._cloud.docs.splice(i, 1);
          return true;
        }

        case "search_once": {
          const { hits, done } = this._search(args.req || {});
          return [hits, done];
        }

        case "export_write":
          // mock：不落盘，只回报目标路径
          return args.path || null;

        case "cred_set":
        case "cred_delete":
          return null;

        case "ai_chat":
          return this._aiChat(args.req || args);

        case "ai_cancel": {
          const job = this._ai.get(args.request_id);
          if (job) {
            job.aborted = true;
            clearTimeout(job.timer);
            this._ai.delete(args.request_id);
          }
          return null;
        }

        default:
          console.warn("[DGM mock] 未实现的命令：", cmd, args);
          return null;
      }
    },

    /* ---- 派生：大纲 / 作用域 ---- */

    _outline(id) {
      const d = this._doc(id);
      if (!d) return [];
      const lines = d.body.split("\n");
      const groups = {};
      const push = (title, row) => {
        if (!groups[title]) groups[title] = { title, rows: [] };
        groups[title].rows.push(row);
      };
      if (d.format === "mermaid") {
        lines.forEach((ln, i) => {
          const t = ln.trim();
          if (t.startsWith("subgraph")) push("子图 subgraph", { name: t.replace("subgraph ", ""), kind: "cluster", line: i + 1 });
          else if (/-->|--x|-\.->|==>|&/.test(t) && !t.startsWith("%%")) push("边", { name: t.slice(0, 34), kind: "edge", line: i + 1 });
          else if (/\[[({]/.test(t) && !t.startsWith("%%") && !t.startsWith("class")) {
            const m = t.match(/\[([^\]]*)\]|\(\(([^)]*)\)\)|\(([^)]*)\)|\{([^}]*)\}/);
            push("节点", { name: (m && m[0] ? m[0].replace(/[[\](){ }]/g, "") : t.slice(0, 24)), kind: "node", line: i + 1 });
          }
        });
      } else if (d.format === "dot") {
        lines.forEach((ln, i) => {
          const t = ln.trim();
          if (t.startsWith("subgraph")) push("子图 cluster", { name: t.replace(/subgraph\s*/, "").replace(/[{;]$/, ""), kind: "cluster", line: i + 1 });
          else if (/->|--/.test(t)) push("边", { name: t.slice(0, 34), kind: "edge", line: i + 1 });
          else if (/^\w+\s*\[/.test(t)) push("节点", { name: t.split(/\s*\[/)[0], kind: "node", line: i + 1 });
        });
      } else if (d.format === "drawio") {
        lines.forEach((ln, i) => {
          const m = ln.match(/<mxCell id="([^"]+)"\s+value="([^"]*)"/);
          if (m) push("图元 mxCell", { name: m[2].replace(/&#10;/g, " "), kind: "element", line: i + 1 });
        });
      } else {
        lines.forEach((ln, i) => {
          const m = ln.match(/"type":\s*"(\w+)"/);
          if (m) push("场景元素", { name: m[1], kind: "element", line: i + 1 });
        });
      }
      const order = ["子图 subgraph", "子图 cluster", "节点", "边", "图元 mxCell", "场景元素"];
      return order.filter((k) => groups[k]).map((k) => groups[k]);
    },

    _scope(id) {
      const d = this._doc(id);
      if (!d) return "";
      const stack = [];
      const lines = d.body.split("\n").slice(0, d.caret_line);
      for (const ln of lines) {
        const t = ln.trim();
        if (d.format === "mermaid") {
          if (/^subgraph\b/.test(t)) stack.push(t.replace(/^subgraph\s*/, "") || "(匿名)");
          else if (/^end\s*$/.test(t)) stack.pop();
        } else if (d.format === "dot") {
          if (/^subgraph\b/.test(t)) stack.push((t.match(/subgraph\s+(\S+)/) || [])[1] || "(匿名)");
          else if (/^}\s*$/.test(t)) stack.pop();
        }
      }
      return stack.length ? stack[stack.length - 1] : "";
    },

    /* ---- 派生：AI 假流式 ---- */

    _aiText(req) {
      const f = this._fmt(req.format || "mermaid");
      const fence = f.surface === "canvas" ? "mermaid" : f.id;
      const intent = req.intent || "generate";
      if (intent === "vision") {
        return `识别出 6 个节点、7 条连线，是一个带审批回环的流程图。手写的「风控复核」字迹较淡，我按上下文补成了节点名。\n\n\`\`\`${fence}\nflowchart LR\n    A[提交申请] --> B{初审}\n    B -- 通过 --> C[风控复核]\n    B -- 退回 --> A\n    C -- 通过 --> D[放款]\n    C -- 拒绝 --> E[归档]\n    D --> F([结束])\n\`\`\`\n\n图里有两处低置信（节点文字 / 连线方向），落地前请核对一下。`;
      }
      if (intent === "review") {
        return `看了当前这张图，有三处可以改：\n\n- 「锁定账号 15 分钟」是终态但画法上像中间节点，建议加双边框或改用 end 样式\n- 验证码回环在 TD 布局下会拉出一条很长的反向边，改成 flowchart LR 会清爽很多\n- subgraph「风控」把 L/M/N 圈进去了，但 classDef 写在 subgraph 之后，部分渲染器会忽略样式\n\n改好的一版：\n\n\`\`\`${fence}\n${(req.context || NEW_BODIES.mermaid).split("\n").slice(0, 10).join("\n")}\n\`\`\``;
      }
      return `按你的要求生成了 ${f.name}：验证码错误回到「刷新验证码」形成回环，连续失败 5 次进入锁定分支，风控相关的三个节点归到 subgraph 里。\n\n\`\`\`${fence}\nflowchart TD\n    A([开始]) --> B[打开登录页]\n    B --> G[请求图形验证码]\n    G --> H{验证码正确?}\n    H -- 否 --> I[刷新验证码] --> G\n    H -- 是 --> J[调用 /auth/login]\n    J --> K{账号密码匹配?}\n    K -- 否 --> L[失败次数 +1]\n    L --> M{连续失败 >= 5?}\n    M -- 是 --> N[锁定账号 15 分钟]\n\`\`\`\n\n共 12 个节点、14 条边；分支处用了菱形判定，异常路径归到 subgraph 里。需要我补短信通知分支吗？`;
    },

    _aiChat(req) {
      const request_id = req.request_id || this._newId("req");
      const modelId = req.model_id || this.settings.ai.default_model || (this.settings.ai.models[0] && this.settings.ai.models[0].id) || "auto";
      const model = this.settings.ai.models.find((m) => m.id === modelId);
      const modelName = model ? model.name : "auto";
      const text = this._aiText(req);
      const job = { aborted: false, timer: 0, text: "" };
      this._ai.set(request_id, job);

      // 按片段流式吐出（每 45ms 一段），最后 done
      const chunks = chunkText(text);
      let i = 0;
      const tick = () => {
        if (job.aborted) return;
        if (i >= chunks.length) {
          this._ai.delete(request_id);
          emitLocal("ai://done", {
            request_id,
            text,
            model: modelName,
            prompt_tokens: 380 + Math.floor(Math.random() * 120),
            completion_tokens: 220 + Math.floor(Math.random() * 160),
          });
          return;
        }
        const delta = chunks[i++];
        emitLocal("ai://delta", { request_id, delta });
        job.timer = setTimeout(tick, 42);
      };
      job.timer = setTimeout(tick, 260);

      return { request_id };
    },
  };

  function chunkText(text) {
    const out = [];
    let i = 0;
    while (i < text.length) {
      const n = 3 + Math.floor(Math.random() * 6);
      out.push(text.slice(i, i + n));
      i += n;
    }
    return out;
  }

  function deepMerge(target, patch) {
    if (!patch || typeof patch !== "object") return target;
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object" && !Array.isArray(target[k])) {
        deepMerge(target[k], v);
      } else {
        target[k] = Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : v;
      }
    }
    return target;
  }

  Mock._seed();

  // 便于控制台调试（mock 专属，不进生产逻辑）
  DGM.mock = Mock;
})();
