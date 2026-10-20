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
 *   - 单文档变更（doc_save / doc_save_as / doc_set_body / doc_set_view_mode / doc_set_layout / doc_set_look）→ Doc
 *   - doc_set_caret / ai_model_key_set / ai_model_key_delete / ai_chat / ai_cancel → 无意义返回值
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

  /**
   * 原生文件拖放（Tauri 的文件拖放事件）。
   *
   * WebView2 下 Tauri 默认接管窗口的文件拖放，页面里**收不到** `dataTransfer.files` ——
   * 要拿"拖进来的文件"就只能走这条路，而且它给的是**真实路径**（正是我们要的）。
   * payload：`{ type: "enter"|"over"|"drop"|"leave", paths?: string[], position?: {x,y} }`
   * （`position` 是**物理像素**，用的人自己除以 devicePixelRatio）。
   *
   * 返回取消订阅函数；当前环境没有原生拖放（mock 原型 / 老 API）时返回 `null`，
   * 调用方据此关掉相关能力与提示 —— 不做假的"已支持"。
   */
  function onDragDrop(cb) {
    if (!isTauri) return null;
    const wv = TAURI.webview && typeof TAURI.webview.getCurrentWebview === "function" ? TAURI.webview.getCurrentWebview() : null;
    if (wv && typeof wv.onDragDropEvent === "function") {
      let un = null;
      wv.onDragDropEvent((e) => {
        try {
          cb(e && "payload" in e ? e.payload : e);
        } catch (err) {
          console.error("[DGM] drag-drop handler error:", err);
        }
      }).then((f) => (un = f));
      return () => {
        if (un) un();
      };
    }
    // 老 API 退路：事件名由 webview 发到事件总线
    if (TAURI.event && typeof TAURI.event.listen === "function") {
      let un = null;
      TAURI.event
        .listen("tauri://drag-drop", (e) => cb(e && "payload" in e ? e.payload : e))
        .then((f) => (un = f));
      return () => {
        if (un) un();
      };
    }
    return null;
  }

  DGM.ipc = {
    isTauri,
    isMock: !isTauri,
    invoke,
    on,
    onDragDrop,
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
    d2: "direction: right\n前端应用 -> 网关: HTTPS 请求\n网关 -> 用户服务: 令牌校验\n用户服务 -> 数据库: SELECT users\n",
    drawio: '<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="Diagramon">\n  <diagram name="Page-1" id="p1">\n    <mxGraphModel dx="800" dy="600" grid="1" page="1">\n      <root>\n        <mxCell id="0" />\n        <mxCell id="1" parent="0" />\n      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n',
    excalidraw: '{\n  "type": "excalidraw",\n  "version": 2,\n  "source": "https://diagramon.app",\n  "elements": [],\n  "appState": { "viewBackgroundColor": "#ffffff" }\n}\n',
  };

  const FORMATS = [
    {
      id: "mermaid", name: "Mermaid", short: "Mermaid", exts: [".mmd", ".mermaid"],
      surface: "text", split_view: true, ai: true,
      convert_to: ["drawio", "excalidraw", "dot", "d2"], layouts: [],
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
      id: "d2", name: "D2", short: "D2", exts: [".d2"],
      surface: "text", split_view: true, ai: true,
      convert_to: ["drawio"], layouts: ["dagre", "elk", "tala"],
      note: "文本图表，支持源码 / 分屏 / 预览三态；三种布局引擎（tala 较慢）",
      default_body: NEW_BODIES.d2,
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

  /** mock 的问题夹具。
   *
   *  **只用真实 lint 会产生的结论** —— 这里曾经写着"边标签含 `>=` 未转义"（还标成 error），
   *  那是假的：16 个用例跑真实 mermaid 全部 parse + render 通过，规则已从 `lint.rs` 删掉。
   *  示例文档本身都是合法的，所以夹具是空的 —— 空的**就是**合法文档该有的样子；
   *  要摆"有问题"的形态，请用一份真写坏的文档（真机走的是 `lint.rs`，不经过这里）。 */
  const ISSUES = {
    d1: [],
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

  /** mock 的云网关模型别名（形状对齐 app-ipc 的 `GatewayModel`，即 `GET /v1/ai/models`
   *  的 `data[]`）。两个条目刻意一个支持识图、一个不支持 —— 让"识图对话框标出
   *  不支持的那条"这条渲染路径在浏览器里也能看到。 */
  const MOCK_GATEWAY_MODELS = [
    { id: "glm-5.2", display_name: "GLM-5.2", supports_vision: true, max_output: 8192 },
    { id: "qwen3-max", display_name: "Qwen3 Max", supports_vision: false, max_output: 4096 },
  ];

  const Mock = {
    _seq: 0,
    _ai: new Map(), // request_id -> {timer, aborted}
    /** 会话持久化（mock）：docId -> turns[]。真机落盘，这里只存内存。 */
    _conv: {},
    /** 长期记忆（mock）：条目数组。真机落 memory/memory.json。 */
    _mem: [],
    /** BYOK 密钥（mock 只记存不存在，不回显内容）—— 键名与真机一致：按 model_id 存 ✓ */
    _cred: {},
    /** 和真机的 `hydrate_models` 对齐：`has_key` 由凭据现状**现算**，不是磁盘上那份。
     *  探针靠它断言"填了密钥 → 未配置变已配置"这条链路是通的。 */
    _hydrateCreds() {
      const ai = this.settings && this.settings.ai;
      if (!ai || !Array.isArray(ai.models)) return;
      const byId = {};
      for (const p of ai.providers || []) {
        byId[p.id] = p;
        const secret = this._cred["ai-provider:" + p.id];
        p.has_key = p.provider === "ollama" || !!secret;
        const s = String(secret || "");
        p.key_hint = s ? s.slice(0, 3) + "…" + s.slice(-4) : "";
      }
      for (const m of ai.models) {
        const p = byId[m.provider_id];
        if (p) {
          m.has_key = p.has_key;
          m.key_hint = p.key_hint;
          continue;
        }
        const secret = this._cred[m.id];
        m.has_key = m.provider === "ollama" || !!secret;
        const s = String(secret || "");
        m.key_hint = s ? s.slice(0, 3) + "…" + s.slice(-4) : "";
      }
    },
    docs: [],
    active: "d1",
    settings: null,
    /** mock 工作区（结构对齐 app-ipc 的 WorkspaceInfo） */
    ws: { root: null, name: "", tree: [], truncated: false, file_count: 0, dir_count: 0 },
    /** mock 云端（结构对齐 app-ipc 的 CloudStatus / CloudDocList / CloudFolderList）
     *
     *  文档都带 `path`（服务端口径：目录靠 path 表达，`""` = 根），
     *  folders 是那份**目录全集**（含空目录）—— 少了它树建不起来。 */
    _cloud: {
      signed: false,
      account: null,
      // 云网关可用模型别名（结构对齐 app-ipc 的 GatewayModel）。
      // **未登录时恒为空** —— 靠这个守住"登出必须清掉模型"这条不变量。
      models: [],
      folders: ["flows", "arch", "arch/web", "arch/backend"],
      docs: [
        { id: "cld-1", name: "登录流程.mmd", path: "flows", format: "mermaid", size: 1024, updated_at: "2026-10-10T10:00:00Z", version: 1 },
        { id: "cld-2", name: "渲染管线.dot", path: "arch", format: "dot", size: 2048, updated_at: "2026-10-09T18:30:00Z", version: 1 },
        { id: "cld-3", name: "组件树.excalidraw", path: "arch/web", format: "excalidraw", size: 4096, updated_at: "2026-10-08T09:15:00Z", version: 1 },
        { id: "cld-4", name: "网关时序.mermaid", path: "arch/backend", format: "mermaid", size: 1536, updated_at: "2026-10-07T21:40:00Z", version: 1 },
      ],
    },

    /** mock 的"这个账号是不是会员"由**登录用的邮箱**决定：`+free` 子地址 = 无 AI 权益。
     *
     *  为什么用邮箱而不是一个测试开关：`DGM.ipc` 是个薄包装（`invoke` 转发到 mock），
     *  从页面里给 mock 塞标志位是塞不进去的；而邮箱本来就是请求的一部分，
     *  于是"同一个页面里把两条渲染路径都走一遍"变成了换一个邮箱的事。 */
    _seed() {
      // 评审/探针用：`?mockcloud=signed` 直接把 mock 云端置为"已登录"，
      // 否则浏览器原型里永远停在未登录态，两个云端视图都看不到真实渲染。
      // 只影响 mock（真机没有这段），且只认这一个参数值，不做别的隐式行为。
      try {
        const q = new URLSearchParams(location.search);
        if (q.get("mockcloud") === "signed") {
          this._cloud.signed = true;
          this._cloud.models = MOCK_GATEWAY_MODELS.map((m) => ({ ...m }));
          this._cloud.account = {
            email: "westsource@126.com", display_name: "道荣", role: "user", plan_name: "会员",
            used_bytes: 13631488, quota_bytes: 104857600,
            ai: {
              enabled: true, credit_monthly_micros: 20000000, credit_used_micros: 3200000,
              period_start: "2026-10-01T00:00:00+00:00", period_end: "2026-11-01T00:00:00+00:00",
            },
          };
        }
      } catch (e) {
        /* 无 location / 参数非法：忽略 */
      }
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
        panels: { activitybar: true, sidebar: false, sidebar_view: "explorer", ai: true, bottom: true, bottom_tab: "problems", sidebar_w: 236, ai_w: 344, panel_h: 168, split_src: 33 },
        editor: { font_size: 13, debounce_ms: 350, lint: true, per_doc_view: true, default_view: "split", autosave: true, autosave_ms: 5000, restrict_to_workspace: false },
        ai: {
          providers: [
            { id: "p-byok-1", name: "OpenAI", provider: "openai", base_url: "https://api.openai.com/v1", max_tokens: 8192, temperature: 0.7, has_key: false, key_hint: "" },
            { id: "p-byok-2", name: "Ollama (local)", provider: "ollama", base_url: "http://localhost:11434", max_tokens: 4096, temperature: 0.3, has_key: true, key_hint: "" },
          ],
          models: [
            { id: "byok-1", provider_id: "p-byok-1", model: "gpt-4o", name: "gpt-4o", has_key: false, key_hint: "" },
            { id: "byok-2", provider_id: "p-byok-2", model: "qwen3:8b", name: "qwen3:8b", has_key: true, key_hint: "" },
          ],
          default_model: "byok-1",
          vision_notice_accepted: false,
          render_retry: true,
          context_from_doc: true,
          memory_enabled: true,
          tools_enabled: false,
          memory_auto: true,
        },
        cloud: { base_url: "https://www.diagramon.com", device_id: "" },
        recent: [
          { path: "E:/OpenCode/diagramon/docs/flows/登录流程.mmd", name: "登录流程.mmd", format: "mermaid", opened_at: 0 },
          { path: "E:/OpenCode/diagramon/docs/arch/渲染管线.dot", name: "渲染管线.dot", format: "dot", opened_at: 0 },
          { path: "E:/OpenCode/diagramon/docs/flows/支付回调.mmd", name: "支付回调.mmd", format: "mermaid", opened_at: 0 },
          { path: "E:/OpenCode/diagramon/docs/arch/服务拓扑.drawio", name: "服务拓扑.drawio", format: "drawio", opened_at: 0 },
          { path: "E:/OpenCode/diagramon/scratch/白板草图.excalidraw", name: "白板草图.excalidraw", format: "excalidraw", opened_at: 0 },
        ],
        // 存档**必须最后展开**：它是对真机 settings.json 的模拟 —— 用户改过的任何一段
        // （含 ai/editor/cloud/recent）都要赢过这里的预设。曾经展开在 panels 之后，
        // 结果 ai/editor/cloud/recent 四段永远被预设盖掉，「改了 → 重载 → 丢了」。
        ...((() => { try { return JSON.parse(sessionStorage.getItem("dgm-mock-settings") || "null") || {}; } catch (e) { return {}; } })()),
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
          // `warm_elk: true` 是**故意的**：浏览器原型里要能断言"启动按需预热"这条链路
          // （mock 声明有依据 → 启动 3 秒后 ELK 离线包应已加载，见 main.js 与 ui_probe 断言 2.5）。
          return {
            version: "3.0.0-mock",
            platform: "mock",
            formats: this._clone(FORMATS),
            limits: { preview_max_lines: 5000, preview_max_bytes: 409600 },
            warm_elk: true,
          };

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
          this._hydrateCreds();
          return this._clone(this.settings);

        case "settings_patch": {
          deepMerge(this.settings, args.patch || args);
          // mock 也持久化：sessionStorage 跨页面重载存活 —— 浏览器原型因此能
          // 验证"关闭面板 → 重启（重载）→ 状态还原"的完整链路（探针断言 12）。
          try {
            sessionStorage.setItem("dgm-mock-settings", JSON.stringify(this.settings));
          } catch (e) { /* 隐私模式等场景写不进就算了 */ }
          this._hydrateCreds();
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
            const fid = ext === "dot" || ext === "gv" ? "dot" : ext === "d2" ? "d2" : ext === "drawio" ? "drawio" : ext === "excalidraw" ? "excalidraw" : "mermaid";
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

        case "doc_set_look": {
          const d = this._doc(args.id);
          if (d) d.look = args.look;
          return d ? this._clone(d) : null;
        }

        // 外部文件作为上下文：mock 不读盘，按路径造一份固定内容（形状与 app-ipc 契约一致）。
        // 路径里带 "nope" 的当作"读不到"，供探针断言失败路径也出声。
        case "file_read_text": {
          const p = String(args.path || "").trim().replace(/\\/g, "/");
          if (!p) throw new Error("路径为空");
          if (/nope|不存在|missing/i.test(p)) throw new Error(`读不到这个文件：${p}`);
          const name = p.split("/").filter(Boolean).pop() || p;
          return { path: p, name, text: `# MOCK ${name}\n第一行内容\n第二行内容`, truncated: false };
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
          // 默认当**会员**（这样"登录后就有可用模型"这条主路径在浏览器里立刻能看到）；
          // 要摆"没权益"那一态就用 `+free` 子地址，例如 `someone+free@example.com`。
          const member = !/\+free(\+|@)/i.test(String(email));
          this._cloud.signed = true;
          this._cloud.account = {
            email, display_name: email.split("@")[0], role: "user",
            plan_name: member ? "会员" : "Free",
            used_bytes: 20480, quota_bytes: 104857600,
            // 免费套餐服务端也会给 ai 块（enabled=false）—— 那是"确实没开通"，
            // 与"服务端没给这个字段"（ai=null → 显示未知）是两回事
            ai: member
              ? {
                  enabled: true, credit_monthly_micros: 20000000, credit_used_micros: 3200000,
                  period_start: "2026-10-01T00:00:00+00:00", period_end: "2026-11-01T00:00:00+00:00",
                }
              : {
                  enabled: false, credit_monthly_micros: 0, credit_used_micros: 0,
                  period_start: "2026-10-01T00:00:00+00:00", period_end: "2026-11-01T00:00:00+00:00",
                },
          };
          // 模型别名**跟权益走**：免费账号服务端回的就是 `data: []`（200，不是 403）
          this._cloud.models = member ? MOCK_GATEWAY_MODELS.map((m) => ({ ...m })) : [];
          return this._cloud.account;
        }
        case "cloud_logout":
          this._cloud.signed = false;
          // 登出必须把模型别名一起清掉（真机是"前端清空 + 服务端不再认这个令牌"）
          this._cloud.models = [];
          return true;
        case "ai_gateway_models": {
          if (!this._cloud.signed) throw new Error("尚未登录云网关");
          // 无 AI 权益 → `data: []` + 200（不是 403）：mock 同口径，别把"没有"做成"报错"
          return { items: this._cloud.models.map((m) => ({ ...m })) };
        }
        case "cloud_docs_list":
          if (!this._cloud.signed) throw new Error("尚未登录云网关");
          return {
            items: this._cloud.docs.map((d) => ({ ...d })),
            has_more: false,
            used_bytes: this._cloud.docs.reduce((n, d) => n + d.size, 0),
            quota_bytes: 104857600,
          };
        /* 目录全集：服务端是"显式目录 ∪ 文档路径隐含的目录"，**空目录也要在**
           （上面 arch/backend 是真的有文档，另加一个空目录好把"空"这条渲染路径跑出来）。 */
        case "cloud_folders": {
          if (!this._cloud.signed) throw new Error("尚未登录云网关");
          const all = new Set(this._cloud.folders);
          for (const d of this._cloud.docs) {
            const segs = String(d.path || "").split("/").filter(Boolean);
            let acc = "";
            for (const s of segs) {
              acc = acc ? acc + "/" + s : s;
              all.add(acc);
            }
          }
          const items = [...all].sort().map((path) => {
            const segs = path.split("/");
            const direct = this._cloud.docs.filter((d) => (d.path || "") === path).length;
            const hasChildren = [...all].some((p) => p !== path && p.startsWith(path + "/"));
            return {
              path, name: segs[segs.length - 1], depth: segs.length - 1,
              document_count: direct, has_children: hasChildren,
              is_explicit: this._cloud.folders.includes(path),
            };
          });
          return { items };
        }
        case "cloud_folder_create": {
          if (!this._cloud.signed) throw new Error("尚未登录云网关");
          const path = String(args.path || "").trim().replace(/^\/+|\/+$/g, "");
          if (!path) throw new Error("云网关 422：目录名不能为空");
          if (this._cloud.folders.includes(path)) throw new Error("云网关 409：同名目录已存在（name_taken）");
          this._cloud.folders.push(path);
          return { path, name: path.split("/").pop(), depth: path.split("/").length - 1, document_count: 0, has_children: false, is_explicit: true };
        }
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
            id, name: args.name, path: args.path == null ? "" : String(args.path), format: args.format,
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

        case "ai_provider_models":
          return args.provider === "ollama"
            ? ["llama3.3:70b", "qwen3:8b"]
            : ["gpt-4.1", "gpt-4.1-mini", "o4-mini"];

        case "ai_provider_key_set":
          this._cred["ai-provider:" + args.providerId] = String(args.secret || "");
          return null;

        case "ai_provider_key_delete":
          delete this._cred["ai-provider:" + args.providerId];
          return null;

        case "ai_chat":
          return this._aiChat(args.req || args);

        case "ai_agent_run":
          return this._aiAgent(args.req || args);

        case "ai_cancel": {
          const job = this._ai.get(args.request_id);
          if (job) {
            job.aborted = true;
            clearTimeout(job.timer);
            this._ai.delete(args.request_id);
          }
          return null;
        }

        /* 会话持久化：真机按**文档路径的 SHA256** 落到 conversations/ 下，
           mock 只存内存 —— 探针要断言的是"存进去能读回来、且按文档分开"，
           不需要真的落盘（落盘那一侧的原子写/坏文件回退由 app-core 的单测覆盖）。 */
        case "conversation_load": {
          const turns = this._conv[args.id] || [];
          return { doc_key: String(args.id || ""), path: "", turns: turns.map((x) => ({ ...x })), updated_at: Date.now() };
        }

        case "conversation_save": {
          this._conv[args.id] = Array.isArray(args.turns) ? args.turns.map((x) => ({ ...x })) : [];
          return true;
        }

        case "conversation_clear": {
          delete this._conv[args.id];
          return true;
        }

        /* ---- 对话历史（全部）：夹具覆盖三种归属，供 ui_probe 断言徽章/动作/搜索 ---- */
        case "conversation_list": {
          if (this._convList) return this._convList.map((x) => ({ ...x }));
          const now = Date.now();
          const rows = [
            { key: "aaaa1111bbbb2222", path: "E:/work/登录流程.mmd", name: "登录流程.mmd", format: "mermaid",
              turns: 12, updated_at: now - 3 * 3600e3, first_prompt: "画一张登录流程图，包含失败重试",
              last_model: "GLM-5.2", missing: false, live_draft: false },
            { key: "draft-untitled-3", path: "", name: "未命名草稿 · Mermaid", format: "mermaid",
              turns: 5, updated_at: now - 12 * 60e3, first_prompt: "把失败分支补上",
              last_model: "GLM-5.2", missing: false, live_draft: true },
            { key: "cccc3333dddd4444", path: "E:/work/old/支付时序.d2", name: "支付时序.d2", format: "d2",
              turns: 21, updated_at: now - 26 * 3600e3, first_prompt: "改成异步回调的时序",
              last_model: "GLM-5.2", missing: true, live_draft: false },
          ];
          this._convList = rows.map((x) => ({ ...x }));
          return this._convList.map((x) => ({ ...x }));
        }

        case "conversation_read": {
          // 导出 Markdown 用：只给形状，探针断言的是"落了 md 文件"这条链
          return {
            doc_key: args.key,
            path: "",
            updated_at: Date.now(),
            turns: [
              { role: "user", text: "画一张登录流程", at: Date.now() - 60000, model: "", tokens: 0, thinking: "" },
              { role: "assistant", text: "flowchart TD\n    A --> B", at: Date.now(), model: "GLM-5.2", tokens: 12, thinking: "先想一下" },
            ],
          };
        }

        case "conversation_open": {
          const key = String(args.key || "");
          if (key.startsWith("draft-")) {
            const d = this.docs.find((x) => "draft-" + x.id === key);
            if (d) return this._clone(d);
          }
          const row = (this._convList || []).find((x) => x.key === key);
          const existing = row && row.path ? this.docs.find((x) => x.path === row.path) : null;
          if (existing) return this._clone(existing);
          // 已失联：恢复成新标签页（mock 里就是新建一份对应格式的文档）
          const fid = row && row.format ? row.format : "mermaid";
          return this.invoke("doc_new", { format: fid });
        }

        case "conversation_delete": {
          this._convList = (this._convList || []).filter((x) => x.key !== args.key);
          return true;
        }

        case "conversation_prune": {
          const before = (this._convList || []).length;
          this._convList = (this._convList || []).filter((x) => !(x.missing || (!x.path && !x.live_draft)));
          return before - this._convList.length;
        }

        /* 长期记忆。真机落 `memory/` 下，mock 只存内存 —— 探针要断言的是
           "只有 confirmed 会注入、pending 不会"，落盘与体积上限由 app-core 的单测覆盖。 */
        case "ai_memory_list":
          return this._memoryList(args.id);

        case "ai_memory_save": {
          const e = { ...(args.entry || {}) };
          const text = String(e.text || "").trim();
          if (!text) throw new Error("这条记忆是空的");
          e.text = text.slice(0, 200);
          e.enabled = e.enabled !== false;
          e.state = e.state === "pending" ? "pending" : "confirmed";
          e.scope = e.scope === "doc" ? "doc" : "global";
          e.doc = e.scope === "doc" ? e.doc || "" : "";
          e.at = e.at || Date.now();
          const i = this._mem.findIndex((x) => x.id === e.id);
          if (i >= 0) this._mem[i] = e;
          else this._mem.push(e);
          return this._memoryList(args.id);
        }

        case "ai_memory_delete":
          this._mem = this._mem.filter((x) => x.id !== args.entry);
          return this._memoryList(args.id);

        case "ai_memory_clear":
          this._mem = args.kind === "pending" ? this._mem.filter((x) => x.state !== "pending") : [];
          return this._memoryList(args.id);

        case "ai_memory_extract": {
          // 夹具：只有 prompt 带 `[remember]` 才产出候选（真模型对多数轮次也是回 `[]`）。
          // 产出的固定是 `pending` —— 探针要能断言"候选不注入、确认后才注入"。
          const p = String(args.prompt || "");
          if (p.includes("[remember]")) {
            const text = "偏好：" + p.replace("[remember]", "").trim().slice(0, 40);
            if (!this._mem.some((x) => x.text === text)) {
              this._mem.push({
                id: this._newId("mem"),
                text,
                scope: "global",
                doc: "",
                state: "pending",
                source: "auto",
                enabled: true,
                at: Date.now(),
              });
            }
          }
          return this._memoryList(args.id);
        }

        default:
          console.warn("[DGM mock] 未实现的命令：", cmd, args);
          return null;
      }
    },

    /* ---- 派生：大纲 / 作用域 ---- */

    /** 记忆清单 + 当前文档身份（未保存文档 ⇒ 空串，与真机的 `doc_key_of` 同口径）。 */
    _memoryList(docId) {
      const d = this._doc(docId);
      return { items: this._mem.map((x) => ({ ...x })), doc: d && d.path ? "mock-" + docId : "" };
    },

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
      } else if (d.format === "d2") {
        // 与 Rust 侧同口径的**行式扫描**（mock 只演示界面，不做第二套解析器）：
        // 容器 `名: {` → cluster，`->` 行 → 边，`a: 标签` → 节点（属性行带 `.` 不算）
        lines.forEach((ln, i) => {
          const t = ln.replace(/#.*$/, "").trim();
          if (!t || t === "}") return;
          if (/\{$/.test(t)) {
            const name = t.replace(/\{$/, "").replace(/:$/, "").trim();
            if (name && !/^(classes|vars|layers|scenarios|steps|style|direction|title|label)$/.test(name)) {
              push("容器", { name, kind: "cluster", line: i + 1 });
            }
          } else if (/->|<-|--/.test(t)) {
            push("边", { name: t.slice(0, 34), kind: "edge", line: i + 1 });
            t.split(/<->|->|--/).forEach((id) => {
              const name = id.split(":")[0].trim().replace(/^"|"$/g, "");
              if (name && !name.includes(" ") && !name.includes(".")) push("节点", { name, kind: "node", line: i + 1 });
            });
          } else {
            const m = t.match(/^([^:]+):\s*(.*)$/);
            if (m && !m[1].includes(".")) {
              const key = m[1].trim().replace(/^"|"$/g, "");
              if (key && !/^(classes|vars|layers|direction)$/.test(key)) {
                push("节点", { name: m[2].trim().replace(/^"|"$/g, "") || key, kind: "node", line: i + 1 });
              }
            }
          }
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
      const order = ["子图 subgraph", "子图 cluster", "容器", "节点", "边", "图元 mxCell", "场景元素"];
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
        } else if (d.format === "d2") {
          if (/\{$/.test(t)) {
            const name = t.replace(/\{$/, "").replace(/:$/, "").trim();
            if (name && !/^(classes|vars|layers|scenarios|steps|style|direction|title|label)$/.test(name)) stack.push(name);
          } else if (/^}\s*$/.test(t)) stack.pop();
        }
      }
      return stack.length ? stack[stack.length - 1] : "";
    },

    /* ---- 派生：AI 假流式 ---- */

    _aiText(req) {
      const f = this._fmt(req.format || "mermaid");
      const fence = f.surface === "canvas" ? "mermaid" : f.id;
      const intent = req.intent || "generate";
      // 探针夹具：「渲染校验回环」的两端。
      //   `[bad]` → 回一段**语法坏掉的** mermaid（`C{判断` 没闭合），预览必然渲染失败；
      //   ai.js 随即自动补发一次 review 请求，prompt 里带「渲染失败」字样 →
      //   这里回**正确的**代码。于是浏览器原型里能端到端断言"失败 → 自动修好"，
      //   而不必依赖真机 + 真上游。真机走真流，夹具只服务于断言。
      const probePrompt = String(req.prompt || "");
      if (probePrompt.includes("[bad]")) {
        return `第一版（这里故意留了个未闭合的花括号）：\n\n\`\`\`mermaid\nflowchart TD\n    A([开始]) --> B[第一步]\n    B --> C{判断\n\`\`\``;
      }
      if (probePrompt.includes("渲染失败") || /failed to render/i.test(probePrompt)) {
        return `把没闭合的花括号补上了：\n\n\`\`\`mermaid\nflowchart TD\n    A([开始]) --> B[第一步]\n    B --> C{判断}\n    C --> D([结束])\n\`\`\``;
      }
      // `[hist]` → 把"这次请求收到了几条前序轮次"原样回报，供探针断言多轮消息真的上行
      //（阶段二之前是单轮：每次请求都从零重建 messages，界面上的对话不参与请求）。
      if (probePrompt.includes("[hist]")) {
        const n = Array.isArray(req.history) ? req.history.length : 0;
        return `本轮请求带了前序轮次 ${n} 条。`;
      }
      // `[ctx]` → 把请求里的**附加文件**原样回显，供探针断言"文件内容真的进了请求"
      //（拖拽/手填路径那两条入口只在真机有，但"读回来的内容有没有上行"两边都能钉）。
      if (probePrompt.includes("[ctx]")) {
        const files = Array.isArray(req.files) ? req.files : [];
        return (
          `附加文件 ${files.length} 个` +
          files.map((f) => `；${f.name}=${String(f.text || "").replace(/\n/g, "\\n").slice(0, 60)}`).join("")
        );
      }
      // `[mem]` → 报"客户端有没有自己往请求里塞记忆"。
      // 记忆**只该由 Rust 在 `ai_chat` 里注入一处**；前端再塞一份就会双重注入。
      // 这条夹具是钉住"前端不碰记忆"的守卫。
      if (probePrompt.includes("[mem]")) {
        const leaked = JSON.stringify(req).includes("长期偏好");
        return leaked ? "客户端注入了记忆：是" : "客户端注入了记忆：否";
      }
      // 「调整配色」→ 官网 hero 截图夹具（与「渲染失败」同款自然语言键）：
      // 回一段"已按业务分区上色"的完成话术。正文**不代图** —— 上过色的正文由
      // 截图脚本（tools/dev/readme_shots.py 的 BUS_SAMPLE）预先放进文档，
      // 对话与画面因此互洽：AI 说改完了，预览里就是改完的样子。
      if (probePrompt.includes("调整配色")) {
        return (
          "已按业务情况调整配色：生产侧用绿色系（数据产生），接入层用蓝色系（传输接入），" +
          "消费侧用紫色系（应用消费），Kafka 核心事件总线单独用琥珀色强调，外部共享保持灰色。\n\n" +
          "改动已应用到当前文档，预览已同步刷新；哪个分区的颜色不合适，随时再说。"
        );
      }
      // `[remember]` / `[mem]` 的回复保持很短：探针要发好几轮，回复长了一轮就要等 6 秒
      if (probePrompt.includes("[remember]") || probePrompt.includes("[mem]")) {
        return `好的。\n\n\`\`\`mermaid\nflowchart TD\n    A[开始] --> B[结束]\n\`\`\``;
      }
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
      const modelId =
        req.model_id ||
        this.settings.ai.default_model ||
        (this._cloud.signed && this._cloud.models[0] ? "gw:" + this._cloud.models[0].id : "") ||
        (this.settings.ai.models[0] && this.settings.ai.models[0].id) ||
        "auto";
      // 网关与本地两处都要找：网关那条是"当前登录令牌 + 服务端别名"，
      // 本地这条才是 settings.ai.models 里的配置。
      const gwAlias = modelId.startsWith("gw:") ? modelId.slice(3) : "";
      const gwModel = gwAlias ? this._cloud.models.find((m) => m.id === gwAlias) : null;
      const localModel = this.settings.ai.models.find((m) => m.id === modelId);
      const text = this._aiText(req);
      const job = { aborted: false, timer: 0, text: "" };
      this._ai.set(request_id, job);

      // 网关别名只在**登录着**的时候能用（真机是 401）—— mock 也如实失败，
      // 否则"登出后还能拿网关模型跑"会被浏览器原型掩盖过去。
      if (gwAlias && !gwModel) {
        setTimeout(() => {
          this._ai.delete(request_id);
          emitLocal("ai://failed", {
            request_id,
            message: this._cloud.signed
              ? `云端没有这个模型别名：${gwAlias}（服务端未返回）`
              : "登录已失效或已登出，云网关模型不可用",
          });
        }, 60);
        return true;
      }
      const modelName = gwModel ? gwModel.display_name : localModel ? localModel.name : "auto";

      // 探针夹具：prompt 带 `[think]` 时模拟**思考型模型**——先连推几帧 `ai://thinking`，
      // 再以"没有正文"收尾（usage 里报 reasoning_tokens）。这正是 2026-10-14 用户报的形态：
      // token 记了 2000+、对话里一个字都没有（真机抓包见 crates/ai/src/provider.rs 的
      // reasoning_content_frames_are_kept）。真机走真流，这里只为浏览器原型可断言。
      if (String(req.prompt || "").includes("[think]")) {
        const reason = ["先读一遍这张图，", "把节点与边理清楚……", "（本轮预算全花在思考上，正文没有产出）"];
        const job2 = { aborted: false, timer: 0, text: "" };
        this._ai.set(request_id, job2);
        let k = 0;
        const tickThink = () => {
          if (job2.aborted) return;
          if (k < reason.length) {
            emitLocal("ai://thinking", { request_id, delta: reason[k++] });
            job2.timer = setTimeout(tickThink, 40);
            return;
          }
          this._ai.delete(request_id);
          emitLocal("ai://done", {
            request_id,
            text: "",
            model: modelName,
            prompt_tokens: 137,
            completion_tokens: 2140,
            reasoning_tokens: 2088,
            usage_source: "server",
          });
        };
        job2.timer = setTimeout(tickThink, 80);
        return { request_id };
      }

      // 探针夹具：prompt 带 `[cut]` 时模拟**被输出上限截断**的那条流。
      //
      // 这是 2026-10-18 用户真机报的形态（云网关 mermaid-default / member 档）：
      // 上游 `completion=4096` 里 2866 是思考，剩下 1230 token 的正文切在半句上，
      // `finish_reason=length` 一路转发到客户端 —— 而界面只看"正文空不空"，于是用户
      // 只看到一个 token 徽标、半张图，没有任何提示。真机走真流，这里只为可断言。
      if (String(req.prompt || "").includes("[cut]")) {
        const parts = ["```mermaid\nflowchart LR\n", "    A[企业专网] --> B[智控平台]\n", "    classDef device fill:#FFFBE6,stroke:#D"];
        let k = 0;
        const tickCut = () => {
          if (job.aborted) return;
          if (k < parts.length) {
            emitLocal("ai://delta", { request_id, delta: parts[k++] });
            job.timer = setTimeout(tickCut, 40);
            return;
          }
          this._ai.delete(request_id);
          emitLocal("ai://done", {
            request_id,
            text: parts.join(""),
            model: modelName,
            prompt_tokens: 1810,
            completion_tokens: 4096,
            reasoning_tokens: 2866,
            usage_source: "server",
            finish: "length",
          });
        };
        job.timer = setTimeout(tickCut, 80);
        return { request_id };
      }

      // 探针夹具：prompt 带 `[thinktext]` 时，走"思考型模型**有正文**"的次序 ——
      // 先连推几帧 `ai://thinking`，正文才来。界面据此断言：收尾自动收起原文、
      // 但原文仍在 DOM 里可展开（以前有正文的那一轮收尾会把原文整块丢掉）。
      // 与 `[think]` 的差别只有"最后有没有正文"，别的都对齐真机形态。
      if (String(req.prompt || "").includes("[thinktext]")) {
        const reason = ["先读一遍这张图，", "把节点与边理清楚……"];
        const job2 = { aborted: false, timer: 0, text: "" };
        this._ai.set(request_id, job2);
        let k = 0;
        const tickThink = () => {
          if (job2.aborted) return;
          if (k < reason.length) {
            emitLocal("ai://thinking", { request_id, delta: reason[k++] });
            job2.timer = setTimeout(tickThink, 40);
            return;
          }
          job2.timer = setTimeout(() => {
            if (job2.aborted) return;
            this._ai.delete(request_id);
            emitLocal("ai://done", {
              request_id,
              text: "配色已按暗色重排，节点与连线都换成了低饱和的对比色。",
              model: modelName,
              prompt_tokens: 137,
              completion_tokens: 640,
              reasoning_tokens: 512,
              usage_source: "server",
              finish: "stop",
            });
          }, 60);
        };
        job2.timer = setTimeout(tickThink, 80);
        return { request_id };
      }

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
            finish: "stop",
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

    /**
     * 受控工具循环（mock）：走一遍"读文档 → 校验"的活动序列再收尾。
     *
     * 真机由 Rust 的 `ai::agent::run` 驱动（每步工具执行发一条 `ai://agent`）；
     * 这里按同样的事件次序重放，让浏览器原型可以断言界面接线。`[agent]` 夹具
     * 与 `ai_chat` 的 `[bad]` 夹具对齐：活动行 + 一份**合法**的最终代码。
     */
    _aiAgent(req) {
      const request_id = req.request_id || this._newId("req");
      const job = { aborted: false, timer: 0, text: "" };
      this._ai.set(request_id, job);
      const localModel = this.settings.ai.models.find(
        (m) => m.id === (req.model_id || this.settings.ai.default_model),
      );
      const modelName = localModel ? localModel.name : "auto";

      let k = 0;
      const events = [
        { step: 1, tool: "read_document", summary: "flowchart TD（2 行，从头读）", ok: true },
        {
          step: 2,
          tool: "validate",
          summary: "没有发现问题，这段代码在当前格式下是合法的。",
          ok: true,
        },
      ];
      const tickAgent = () => {
        if (job.aborted) return;
        if (k < events.length) {
          emitLocal("ai://agent", { request_id, ...events[k++] });
          job.timer = setTimeout(tickAgent, 60);
          return;
        }
        this._ai.delete(request_id);
        emitLocal("ai://done", {
          request_id,
          text:
            "读了一遍文档并校验了候选版本，语法没有问题。\n\n```mermaid\nflowchart TD\n    A([开始]) --> B[结束]\n```",
          model: modelName,
          prompt_tokens: 412,
          completion_tokens: 96,
        });
      };
      job.timer = setTimeout(tickAgent, 80);
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
