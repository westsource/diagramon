/* 两段对账：判断「转换后的图有没有少东西」。
 *
 * 校验（`DGM.validate`）回答"目标格式能不能用"，对账回答"内容有没有丢"。
 * 这两件必须分开：一个 XML 完全合法、但少了一半节点的 drawio，校验是通的。
 *
 * 为什么分两段（PRD 口径 6）：
 *   A. AI 直出段（源文本 → AI → 文本）：同域文本转换，节点/边理应 1:1，
 *      **缺失 > 0 判失败**，进回灌。
 *   B. 确定性引擎段（文本 → 引擎 → drawio/excalidraw）：退化是表达力差异，
 *      AI 改 3 轮也改不掉，**只提示不回灌**（否则白烧调用）。
 *
 * 铁律同校验层：**数不出来就说数不出来**（degraded），绝不把"没对账"当"对得上"。
 */
(function () {
  const DGM = (window.DGM = window.DGM || {});

  const CANVAS = { drawio: true, excalidraw: true };

  function fail(why) {
    return { ok: false, degraded: true, why: why, nodes: null, edges: null };
  }

  function done(nodes, edges) {
    return { ok: true, degraded: false, nodes: nodes, edges: edges };
  }

  /* ------------------------------ 各格式计数 ------------------------------ */

  /** drawio：数 mxCell 的 vertex / edge（跳过缺省的两个根 cell，它们没有 vertex/edge 属性）。 */
  function drawioCounts(body) {
    if (typeof DOMParser === "undefined") return fail("no-domparser");
    let doc;
    try {
      doc = new DOMParser().parseFromString(String(body || ""), "application/xml");
    } catch (e) {
      return fail("xml-parse");
    }
    if (doc.querySelector("parsererror")) return fail("xml-invalid");
    const cells = Array.from(doc.querySelectorAll("mxCell"));
    let nodes = 0;
    let edges = 0;
    for (const c of cells) {
      if (c.getAttribute("vertex") === "1") nodes += 1;
      else if (c.getAttribute("edge") === "1") edges += 1;
    }
    return done(nodes, edges);
  }

  /** Excalidraw：`elements` 里未删除的 arrow 算边，其余算节点（freedraw/text 也算节点）。 */
  function excalidrawCounts(body) {
    let obj;
    try {
      obj = JSON.parse(String(body || ""));
    } catch (e) {
      return fail("json-parse");
    }
    if (!obj || !Array.isArray(obj.elements)) return fail("no-elements");
    let nodes = 0;
    let edges = 0;
    for (const el of obj.elements) {
      if (!el || el.isDeleted) continue;
      if (el.type === "arrow") edges += 1;
      else nodes += 1;
    }
    return done(nodes, edges);
  }

  /** DOT：graphviz 的 json 输出里 `objects` 是节点、`edges` 是边（权威计数，不猜文本）。 */
  async function dotCounts(body, layout) {
    if (!window.DGMGraphviz) {
      if (!window.DGMGraphvizReady) return fail("graphviz-missing");
      try {
        await window.DGMGraphvizReady;
      } catch (e) {
        return fail("graphviz-not-ready");
      }
      if (!window.DGMGraphviz) return fail("graphviz-missing");
    }
    let out;
    try {
      out = await window.DGMGraphviz.layout(String(body || ""), "json", layout || "dot", {});
    } catch (e) {
      return fail("graphviz-error");
    }
    let j;
    try {
      j = JSON.parse(typeof out === "string" ? out : JSON.stringify(out));
    } catch (e) {
      return fail("graphviz-json");
    }
    if (!j || !Array.isArray(j.objects) || !Array.isArray(j.edges)) return fail("graphviz-shape");
    return done(j.objects.length, j.edges.length);
  }

  /** D2：随包 wasm 的 compile 结果里 `shapes` / `connections`（与转 drawio 用的是同一份）。 */
  async function d2Counts(body, layout) {
    if (!DGM.d2 || !DGM.d2.compile) return fail("d2-missing");
    let r;
    try {
      r = await DGM.d2.compile(String(body || ""), layout || "dagre");
    } catch (e) {
      return fail("d2-compile");
    }
    const d = (r && r.diagram) || null;
    if (!d || !Array.isArray(d.shapes)) return fail("d2-shape");
    return done(d.shapes.length, Array.isArray(d.connections) ? d.connections.length : 0);
  }

  /** Mermaid：优先走 mermaid 自己的 db（有 getVertices/getEdges 才是能数的图类型）。 */
  async function mermaidCounts(body) {
    if (typeof window.mermaid === "undefined") return fail("mermaid-missing");
    const api = window.mermaid.mermaidAPI;
    if (!api || typeof api.getDiagramFromText !== "function") return fail("mermaid-api");
    let diagram;
    try {
      diagram = await api.getDiagramFromText(String(body || ""));
    } catch (e) {
      return fail("mermaid-parse");
    }
    const db = diagram && diagram.db;
    if (!db || typeof db.getVertices !== "function" || typeof db.getEdges !== "function") {
      // 时序图/类图这类没有 vertices/edges 的概念：数不出来，如实标 degraded
      return fail("mermaid-no-vertices");
    }
    try {
      const v = db.getVertices() || {};
      const e = db.getEdges() || [];
      return done(Object.keys(v).length, Array.isArray(e) ? e.length : Object.keys(e).length);
    } catch (e) {
      return fail("mermaid-db");
    }
  }

  async function counts(format, body, opts) {
    switch (String(format || "")) {
      case "drawio":
        return drawioCounts(body);
      case "excalidraw":
        return excalidrawCounts(body);
      case "dot":
        return dotCounts(body, opts && opts.layout);
      case "d2":
        return d2Counts(body, opts && opts.layout);
      case "mermaid":
        return mermaidCounts(body);
      default:
        return fail("unknown-format");
    }
  }

  /* -------------------------------- 对账 -------------------------------- */

  /**
   * @returns {{
   *   judge: "pass"|"fail"|"notice"|"unknown",
   *   missingNodes: number, missingEdges: number, extraNodes: number, extraEdges: number,
   *   message: string
   * }}
   *   - `fail`   ：A 段缺失，应进回灌
   *   - `notice` ：B 段退化，只提示
   *   - `unknown`：数不出来，**不判失败**
   */
  async function run(opt) {
    const o = opt || {};
    const src = await counts(o.srcFormat, o.srcBody, { layout: o.srcLayout });
    const dst = await counts(o.dstFormat, o.dstBody, { layout: o.dstLayout });
    const empty = {
      missingNodes: 0,
      missingEdges: 0,
      extraNodes: 0,
      extraEdges: 0,
      message: "",
      src: src,
      dst: dst,
    };
    if (!src.ok || !dst.ok) {
      // 任何一侧数不出来 ⇒ 不判失败（"没对账" ≠ "对得上"）
      return Object.assign(empty, { judge: "unknown", why: (src.why || "") + "|" + (dst.why || "") });
    }
    const missingNodes = Math.max(0, src.nodes - dst.nodes);
    const missingEdges = Math.max(0, src.edges - dst.edges);
    const extraNodes = Math.max(0, dst.nodes - src.nodes);
    const extraEdges = Math.max(0, dst.edges - src.edges);

    const res = Object.assign(empty, { missingNodes, missingEdges, extraNodes, extraEdges });
    if (!missingNodes && !missingEdges) {
      return Object.assign(res, { judge: "pass" });
    }
    if (CANVAS[String(o.dstFormat || "")]) {
      // B 段：引擎的表达力退化，回灌修不好 —— 只提示
      return Object.assign(res, { judge: "notice" });
    }
    return Object.assign(res, { judge: "fail" });
  }

  /** 给界面/日志用的一句话（缺什么、缺多少）。 */
  function describe(r) {
    if (!r) return "";
    if (r.judge === "unknown") return "";
    const parts = [];
    if (r.missingNodes > 0) parts.push("少 " + r.missingNodes + " 个节点");
    if (r.missingEdges > 0) parts.push("少 " + r.missingEdges + " 条连线");
    if (r.extraNodes > 0) parts.push("多 " + r.extraNodes + " 个节点");
    if (r.extraEdges > 0) parts.push("多 " + r.extraEdges + " 条连线");
    return parts.join("，");
  }

  DGM.reconcile = { counts, run, describe };
})();
