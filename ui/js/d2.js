/* D2（d2lang）：页内 wasm 渲染 + 编译产物 → drawio（mxfile）。
 *
 * - 资产在 `/d2/index.js`（`crates/assets` 的第五个挂载点），**故意不放在 `ui/vendor/`**：
 *   `build.frontendDist = "../ui"` 会把 ui 再嵌进 exe 一份，11MB 会变成 22MB。
 * - 单例懒加载：首次用到才 `import()`，之后复用同一个实例（实测首次编译约 2–6s（冷启动），
 *   复用后 ~30ms）。失败不缓存，下次还能重试（资产可能刚被取资产脚本补齐）。
 * - 报错是 **JSON 数组串**（`[{"range":"index,0:0:0-0:5:5","errmsg":"index:1:1: …"}]`），
 *   `preview.js` 的通用 `describeError` 只认 `line N:` 的形态，匹配不上 —— 这里单独抽。
 * - 转换出口只有一个：`D2 → drawio`。`compile()` 给的是**已布局的绝对几何**，
 *   直接映射成 mxGraph 的 vertex/edge 就能保住位置与走线，不必再算一遍布局。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const t = (k, v) => DGM.i18n.t(k, v);

  /** 3.12.0 的迁移开关：出问题切回旧的 JS 拼 XML（保留一个版本）。 */
  const PLAN_TO_DRAWIO = true;

  let enginePromise = null;
  /** 引擎是否已经就绪（首次 `import` + 实例化完成）—— 首开要给用户一个加载态 */
  let ready = false;
  /** 上次编译的缓存（同一份正文 + 布局的重渲染很多：敲字、切视图、换主题） */
  let last = { key: null, result: null };

  function load() {
    if (!enginePromise) {
      enginePromise = import("/d2/index.js")
        .then((m) => {
          const eng = new m.D2();
          ready = true;
          return eng;
        })
        .catch((err) => {
          // 不留失败的 promise：资产补齐后（或离线守卫放行后）还能重试
          enginePromise = null;
          throw new Error(t("preview.d2.unavailable", { msg: (err && err.message) || String(err) }));
        });
    }
    return enginePromise;
  }

  function isReady() {
    return ready;
  }

  /** 预热：只在「最近打开过 .d2」时由 main.js 调，失败静默（不能因为预热弹错）。 */
  function warmup() {
    load().catch(() => {});
  }

  async function compile(body, layout) {
    const key = (layout || "") + "\u0000" + body;
    if (last.key === key && last.result) return last.result;
    const eng = await load();
    const result = await eng.compile(body, layout ? { layout } : undefined);
    last = { key, result };
    return result;
  }

  /** 正文 → SVG 文本（交给 `preview.js` 的 mountSvg 挂载）。 */
  async function renderSvg(body, layout) {
    const eng = await load();
    const r = await compile(body, layout);
    return eng.render(r.diagram, r.renderOptions || {});
  }

  /**
   * D2 的错误载荷 → `{line, col, text}`；不是 D2 的形态就返回 null（交给通用解析）。
   *
   * 多条错误只取第一条 + 「另有 N 处」：面板是一位宽度的文本，列五条没人看；
   * 行号仍然给第一条的，足够把光标带过去。
   */
  function describeError(raw) {
    let arr = null;
    try {
      arr = JSON.parse(String(raw == null ? "" : raw));
    } catch (e) {
      return null;
    }
    if (!Array.isArray(arr) || !arr.length) return null;
    const first = arr[0] || {};
    if (typeof first.errmsg !== "string") return null;
    const m = /index:(\d+):(\d+)/.exec(first.errmsg);
    const text = first.errmsg.replace(/^index:\d+:\d+:\s*/, "");
    return {
      line: m ? Number(m[1]) : 0,
      col: m ? Number(m[2]) : 0,
      text: text + (arr.length > 1 ? t("preview.d2.moreErrors", { n: arr.length - 1 }) : ""),
    };
  }

  /**
   * 多板文档（`layers: { … }`）里的板数量；0 = 没有多板。
   *
   * D2 默认只渲染 root 板，有 layers 时输出就是**空图** —— 界面必须说清，
   * 否则用户会以为渲染坏了（板切换器按方案不做）。
   */
  function boardCount(body) {
    const lines = String(body || "").split("\n");
    let depth = 0;
    let inside = false;
    let n = 0;
    for (const raw of lines) {
      const text = raw.replace(/\s+$/, "");
      const open = (text.match(/\{/g) || []).length;
      const close = (text.match(/\}/g) || []).length;
      if (!inside) {
        if (/^\s*layers\s*:\s*\{/.test(text)) {
          inside = true;
          depth = open - close;
        }
        continue;
      }
      // layers 的直接子级就是板（缩进一层 + 以 `{` 收尾）
      if (depth === 1 && /\{\s*$/.test(text) && /^\s+\S/.test(text)) n += 1;
      depth += open - close;
      if (depth <= 0) break;
    }
    return n;
  }

  /* ------------------------------------------------------------------ D2 → drawio */

  /** D2 的形状 → drawio 的 style 片段。表里没有的一律**退化**成方框并由 notes 说明。 */
  const DRAWIO_SHAPES = {
    rectangle: "",
    square: "",
    oval: "shape=ellipse",
    circle: "shape=ellipse",
    cylinder: "shape=cylinder3",
    diamond: "rhombus",
    hexagon: "shape=hexagon",
    parallelogram: "shape=parallelogram",
    document: "shape=document",
    step: "shape=step",
    page: "shape=note",
    person: "shape=actor",
    text: "text;strokeColor=none;fillColor=none",
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 标签：drawio 的 html=1 用 `<br>` 换行（D2 的标签里可能真有换行）。 */
  function label(s) {
    return esc(s).replace(/\n/g, "<br>");
  }

  function arrowOf(name) {
    if (!name || name === "none") return "none";
    if (name === "triangle" || name === "arrow") return "block";
    if (name === "diamond") return "diamond";
    if (name === "circle") return "oval";
    return "classic";
  }

  function fontStyleOf(s) {
    return (s.bold ? 1 : 0) | (s.italic ? 2 : 0) | (s.underline ? 4 : 0);
  }

  /**
   * 编译产物 → mxfile XML + 保真度说明。
   *
   * 三处**必须**说清（都是实测踩过的）：
   * 1. `pos` 是**绝对坐标**，而 mxGraph 的子 cell 几何是相对父容器的 ⇒ 必须减父容器偏移；
   * 2. `route` **含两个端点**（实测一段直连是 4 个点：首点=源边界、末点=目标边界），
   *    当 waypoints 用的只能是中间那部分，否则走线会在两端各折一下；
   * 3. `fill` / `stroke` 是**主题色标**（`B4` / `B1` 这种），不是具体色值 ⇒ 不能当 `fillColor` 用。
   */
  /** D2 `compile()` 产物 → `CanvasPlan`（JS 只给**绝对坐标**，相对化只在 Rust 的 emit 里做）。 */
  function toPlan(diagram, srcBody) {
    const shapes = Array.isArray(diagram.shapes) ? diagram.shapes : [];
    const conns = Array.isArray(diagram.connections) ? diagram.connections : [];
    const notes = [];
    const issues = [];

    const byId = new Map(shapes.map((s) => [s.id, s]));
    const ids = new Map();
    const used = new Set();
    const cellId = (raw) => {
      if (ids.has(raw)) return ids.get(raw);
      const base = "d2-" + (String(raw).replace(/[^\w.\-\u4e00-\u9fff]/g, "_") || "cell");
      let id = base;
      let n = 2;
      while (used.has(id)) id = `${base}_${n++}`;
      used.add(id);
      ids.set(raw, id);
      return id;
    };

    const parentOf = (path) => {
      const parts = String(path).split(".");
      for (let i = parts.length - 1; i > 0; i -= 1) {
        const cand = parts.slice(0, i).join(".");
        if (byId.has(cand)) return cand;
      }
      return null;
    };
    const isContainer = new Set();
    for (const s of shapes) {
      const p = parentOf(s.id);
      if (p) isContainer.add(p);
    }

    const containers = [];
    const nodes = [];
    const unmapped = new Set();
    // 父先于子（Rust emit 会再拓扑排序一次，这里排是为了 report 顺序稳定）
    const ordered = shapes
      .map((s) => ({ s, depth: String(s.id).split(".").length }))
      .sort((a, b) => a.depth - b.depth)
      .map((x) => x.s);

    for (const s of ordered) {
      const parent = parentOf(s.id);
      const rect = {
        x: Math.round(s.pos ? s.pos.x : 0),
        y: Math.round(s.pos ? s.pos.y : 0),
        w: Math.round(s.width || 0),
        h: Math.round(s.height || 0),
      };
      if (isContainer.has(s.id)) {
        containers.push({
          id: cellId(s.id),
          label: s.label || "",
          rect,
          parent: parent ? cellId(parent) : null,
          role: "Container",
          // 保留旧产物外观（role 的配色会被这些键覆盖，drawio 后者优先）
          raw_style: [
            "rounded=1",
            "verticalAlign=top",
            "fillColor=none",
            "strokeColor=#9aa4ae",
            "recursiveResize=0",
          ],
        });
        continue;
      }

      const raw = ["fillColor=#ffffff", "strokeColor=#000000", "fontColor=#000000"];
      if (Object.prototype.hasOwnProperty.call(DRAWIO_SHAPES, s.type)) {
        const mapped = DRAWIO_SHAPES[s.type];
        if (mapped) raw.push(mapped);
      } else {
        raw.push("rounded=0");
        if (s.type) unmapped.add(s.type);
      }
      if (s.borderRadius > 0) {
        raw.push("rounded=1");
        raw.push(`arcSize=${Math.max(4, Math.round((s.borderRadius / Math.max(1, Math.min(s.width, s.height))) * 100))}`);
      }
      if (s.strokeWidth) raw.push(`strokeWidth=${s.strokeWidth}`);
      if (s.strokeDash > 0) raw.push("dashed=1");
      if (s.fontSize) raw.push(`fontSize=${s.fontSize}`);
      const fs = fontStyleOf(s);
      if (fs) raw.push(`fontStyle=${fs}`);
      if (s.tooltip) raw.push(`tooltip=${esc(s.tooltip)}`);
      if (s.icon) raw.push("image=;imageAspect=0");
      if (s.link) raw.push(`link=${esc(s.link)}`);

      nodes.push({
        id: cellId(s.id),
        label: s.label || "",
        rect,
        shape: "Rect",
        role: "Primary",
        parent: parent ? cellId(parent) : null,
        raw_style: raw,
        raw_children: [],
        at: null,
      });
    }

    const edges = [];
    for (const c of conns) {
      const route = Array.isArray(c.route) ? c.route : [];
      const raw = ["edgeStyle=none", "rounded=0"];
      const end = arrowOf(c.dstArrow);
      if (c.isCurve) raw.push("curved=1");
      if (c.strokeWidth) raw.push(`strokeWidth=${c.strokeWidth}`);
      if (c.strokeDash > 0) raw.push("dashed=1");
      if (c.label) raw.push("labelBackgroundColor=#ffffff");
      if (c.fontSize) raw.push(`fontSize=${c.fontSize}`);
      const fs = fontStyleOf(c);
      if (fs) raw.push(`fontStyle=${fs}`);
      if (c.srcArrow && c.srcArrow !== "none") raw.push(`startArrow=${arrowOf(c.srcArrow)}`);
      // `arrow` 只表达“有没有/哪类箭头”，精确形状（oval/diamond）留在 raw 里
      const arrow = end === "none" ? "None" : end === "classic" ? "Classic" : end === "open" ? "Open" : "Block";
      if (end !== "block" && end !== "none") raw.push(`endArrow=${end}`);
      edges.push({
        id: cellId(c.id || `${c.src}->${c.dst}`),
        from: byId.has(c.src) ? cellId(c.src) : "",
        to: byId.has(c.dst) ? cellId(c.dst) : "",
        label: c.label || null,
        points: route.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
        curved: !!c.isCurve,
        arrow,
        dashed: c.strokeDash > 0,
        role: "Primary",
        raw_style: raw,
        at: null,
      });
    }

    if (unmapped.size) {
      const list = [...unmapped].sort().join(" / ");
      notes.push(t("conv.d2.mxfile.shapes", { list }));
      issues.push({ level: "degraded", code: "shape.fallback", params: { shapes: list }, at: null });
    }
    if (shapes.some((s) => s.icon) || conns.some((c) => c.icon)) {
      notes.push(t("conv.d2.mxfile.icon"));
      issues.push({ level: "degraded", code: "icon.dropped", params: { n: "1" }, at: null });
    }
    const cfg = diagram.config || {};
    if (cfg.themeID || cfg.sketch) {
      notes.push(t("conv.d2.mxfile.theme"));
      issues.push({ level: "degraded", code: "style.approx", params: { n: "1" }, at: null });
    }
    const boards = boardCount(srcBody);
    if (boards > 0) {
      notes.push(t("conv.d2.mxfile.boards"));
      issues.push({ level: "degraded", code: "board.collapsed", params: { n: String(boards) }, at: null });
    }
    notes.push(t("conv.d2.mxfile.geometry"));
    issues.push({ level: "info", code: "layout.recomputed", params: {}, at: null });
    if (containers.length) {
      issues.push({ level: "info", code: "cluster.mapped", params: {}, at: null });
    }

    if (!nodes.length && !containers.length) throw new Error(t("conv.d2.mxfile.empty"));

    return {
      plan: {
        pages: [{ name: "Page-1", id: "p1", nodes, edges, containers }],
        provenance: { from: "d2", source_hash: "", converted_at: Date.now(), app_version: "" },
        issues,
      },
      notes,
    };
  }

  function toMxfile(diagram, srcBody) {
    const shapes = Array.isArray(diagram.shapes) ? diagram.shapes : [];
    const conns = Array.isArray(diagram.connections) ? diagram.connections : [];
    const notes = [];

    const byId = new Map(shapes.map((s) => [s.id, s]));
    const ids = new Map();
    const used = new Set();
    const cellId = (raw) => {
      if (ids.has(raw)) return ids.get(raw);
      const base = String(raw).replace(/[^\w.\-\u4e00-\u9fff]/g, "_") || "cell";
      let id = base;
      let n = 2;
      while (used.has(id)) id = `${base}_${n++}`;
      used.add(id);
      ids.set(raw, id);
      return id;
    };

    /** 点号路径的最近存在祖先 = 父容器（`组.a` → `组`）。 */
    const parentOf = (path) => {
      const parts = String(path).split(".");
      for (let i = parts.length - 1; i > 0; i -= 1) {
        const cand = parts.slice(0, i).join(".");
        if (byId.has(cand)) return cand;
      }
      return null;
    };

    const isContainer = new Set();
    for (const s of shapes) {
      const p = parentOf(s.id);
      if (p) isContainer.add(p);
    }

    const cells = [];
    const unmapped = new Set();
    // 父 cell 必须先出现（drawio 解析时按 id 建父子，顺序反了容器就是空壳）
    const ordered = shapes
      .map((s) => ({ s, depth: String(s.id).split(".").length }))
      .sort((a, b) => a.depth - b.depth || 0)
      .map((x) => x.s);

    for (const s of ordered) {
      const parent = parentOf(s.id);
      const parentShape = parent ? byId.get(parent) : null;
      const x = Math.round((s.pos ? s.pos.x : 0) - (parentShape && parentShape.pos ? parentShape.pos.x : 0));
      const y = Math.round((s.pos ? s.pos.y : 0) - (parentShape && parentShape.pos ? parentShape.pos.y : 0));

      const styleBits = ["html=1", "whiteSpace=wrap"];
      if (isContainer.has(s.id)) {
        // 容器用普通矩形 + container=1：**不带标题栏**，子 cell 的坐标才好对得上
        styleBits.push("rounded=1", "verticalAlign=top", "fillColor=none", "strokeColor=#9aa4ae", "container=1", "collapsible=0", "recursiveResize=0");
      } else {
        // 表里的 `rectangle` / `square` 是**空串**（D2 默认矩形，不必写 style），
        // 所以判"有没有映射"要用 hasOwnProperty 而不是真值 —— 否则普通方框会被记进
        // 「退化为方框」的 notes 里，自相矛盾。
        if (Object.prototype.hasOwnProperty.call(DRAWIO_SHAPES, s.type)) {
          const mapped = DRAWIO_SHAPES[s.type];
          if (mapped) styleBits.push(mapped);
        } else {
          styleBits.push("rounded=0");
          if (s.type) unmapped.add(s.type);
        }
        if (s.borderRadius > 0) styleBits.push("rounded=1", `arcSize=${Math.max(4, Math.round((s.borderRadius / Math.max(1, Math.min(s.width, s.height))) * 100))}`);
      }
      if (s.strokeWidth) styleBits.push(`strokeWidth=${s.strokeWidth}`);
      if (s.strokeDash > 0) styleBits.push("dashed=1");
      if (s.fontSize) styleBits.push(`fontSize=${s.fontSize}`);
      const fs = fontStyleOf(s);
      if (fs) styleBits.push(`fontStyle=${fs}`);
      if (s.tooltip) styleBits.push(`tooltip=${esc(s.tooltip)}`);
      if (s.icon) styleBits.push("image=;imageAspect=0");

      const attrs = [
        `id="${esc(cellId(s.id))}"`,
        `value="${label(s.label)}"`,
        `style="${esc(styleBits.filter(Boolean).join(";"))}"`,
        "vertex=\"1\"",
        `parent="${parent ? esc(cellId(parent)) : "1"}"`,
      ];
      if (s.link) attrs.push(`link="${esc(s.link)}"`);
      cells.push(
        `        <mxCell ${attrs.join(" ")}>\n` +
          `          <mxGeometry x="${x}" y="${y}" width="${Math.round(s.width)}" height="${Math.round(s.height)}" as="geometry" />\n` +
          `        </mxCell>`,
      );
    }

    for (const c of conns) {
      const route = Array.isArray(c.route) ? c.route : [];
      const pts = route.slice(1, -1).map((p) => `<mxPoint x="${Math.round(p.x)}" y="${Math.round(p.y)}" />`);
      const styleBits = ["edgeStyle=none", "html=1", "rounded=0", "endArrow=" + arrowOf(c.dstArrow), "startArrow=" + arrowOf(c.srcArrow)];
      if (c.isCurve) styleBits.push("curved=1");
      if (c.strokeWidth) styleBits.push(`strokeWidth=${c.strokeWidth}`);
      if (c.strokeDash > 0) styleBits.push("dashed=1");
      if (c.label) styleBits.push("labelBackgroundColor=#ffffff");
      if (c.fontSize) styleBits.push(`fontSize=${c.fontSize}`);
      const fs = fontStyleOf(c);
      if (fs) styleBits.push(`fontStyle=${fs}`);

      const attrs = [
        `id="${esc(cellId(c.id || `${c.src}->${c.dst}`))}"`,
        `value="${label(c.label)}"`,
        `style="${esc(styleBits.filter(Boolean).join(";"))}"`,
        "edge=\"1\"",
        `parent="1"`,
      ];
      // 两端的 cell 一定已经被上面建出来了（connections 总指向 shapes 里的 id）
      if (byId.has(c.src)) attrs.push(`source="${esc(cellId(c.src))}"`);
      if (byId.has(c.dst)) attrs.push(`target="${esc(cellId(c.dst))}"`);
      const geo = pts.length
        ? `          <mxGeometry relative="1" as="geometry">\n            <Array as="points">\n              ${pts.join("\n              ")}\n            </Array>\n          </mxGeometry>`
        : '          <mxGeometry relative="1" as="geometry" />';
      cells.push(`        <mxCell ${attrs.join(" ")}>\n${geo}\n        </mxCell>`);
    }

    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<mxfile host="Diagramon">\n' +
      '  <diagram name="Page-1" id="p1">\n' +
      '    <mxGraphModel dx="800" dy="600" grid="1" page="1">\n' +
      "      <root>\n" +
      '        <mxCell id="0" />\n' +
      '        <mxCell id="1" parent="0" />\n' +
      cells.join("\n") +
      "\n      </root>\n" +
      "    </mxGraphModel>\n" +
      "  </diagram>\n" +
      "</mxfile>\n";

    if (unmapped.size) {
      notes.push(t("conv.d2.mxfile.shapes", { list: [...unmapped].sort().join(" / ") }));
    }
    if (shapes.some((s) => s.icon) || conns.some((c) => c.icon)) {
      notes.push(t("conv.d2.mxfile.icon"));
    }
    const cfg = diagram.config || {};
    if (cfg.themeID || cfg.sketch) {
      notes.push(t("conv.d2.mxfile.theme"));
    }
    if (boardCount(srcBody) > 0) {
      notes.push(t("conv.d2.mxfile.boards"));
    }
    notes.push(t("conv.d2.mxfile.geometry"));

    if (!cells.length) throw new Error(t("conv.d2.mxfile.empty"));
    return { xml, notes };
  }

  /** 正文 → `{xml, notes, report}`（给转换中心用）。 */
  async function toDrawio(body, layout) {
    const r = await compile(body, layout);
    if (!PLAN_TO_DRAWIO) return toMxfile(r.diagram, body);
    const made = toPlan(r.diagram, body);
    const out = await DGM.ipc.invoke("plan_to_drawio", {
      plan: made.plan,
      source: body,
      options: { layout: (r.diagram && r.diagram.config && r.diagram.config.layoutID) || layout || null },
    });
    return { xml: out.body, notes: made.notes.concat(out.notes || []), report: out.report };
  }

  DGM.d2 = { warmup, compile, renderSvg, describeError, boardCount, toDrawio, toMxfile, toPlan, isReady };
})();
