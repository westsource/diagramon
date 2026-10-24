/* 统一校验层：给「AI 增强转换」一个**格式无关**的判定入口。
 *
 * 为什么单独一层：回灌（失败回喂模型）要判断"这一版到底行不行"，而五种格式的判据
 * 完全不同 —— Mermaid/DOT 有引擎级 parse、D2 有 wasm 编译、drawio/Excalidraw 是
 * XML/JSON 结构。上层（重试状态机）不该知道这些差异。
 *
 * 契约（上层只认这三样）：
 *   { ok: boolean, issues: [{line, column, text, fingerprint}], degraded: boolean }
 *
 * 铁律：**宁可说"校验不了"，也不假红**。
 *   - 引擎未就绪 / 超大文档 / 该格式没有判据 ⇒ `degraded = true` 且 `ok = true`。
 *     上层看到 degraded 就知道"这次通过不算数"，不会当成真的没问题。
 *   - 只有真的拿到判据并失败，才 `ok = false`。
 *
 * `fingerprint` 是给"连续两轮同一个错误就止损"用的：行号 + 文本的 hash，
 * 模型卡在同一个错上时两轮指纹相同。
 */
(function () {
  const DGM = (window.DGM = window.DGM || {});

  /** 与 guard 对齐：超大文档不做引擎级校验（避免万行文档在主线程重 layout）。 */
  const MAX_LINES = 5000;

  /** FNV-1a 32 位。只用来判"两轮是不是同一个错"，不需要抗碰撞强度。 */
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  }

  function fingerprint(issue) {
    const line = issue && issue.line != null ? String(issue.line) : "-";
    const col = issue && issue.column != null ? String(issue.column) : "-";
    // 列也进指纹：同一行上不同位置的两个错误不该被误判成"同一个错没修好"
    return fnv1a(line + ":" + col + ":" + String((issue && issue.text) || ""));
  }

  /** 引擎 Issue[] → 契约里的精简形态（保留行列，丢掉展示专用字段）。 */
  function normalise(list) {
    return (list || []).map((i) => {
      const one = {
        line: i && i.line != null ? i.line : null,
        column: i && i.column != null ? i.column : null,
        text: String((i && (i.message || i.text)) || ""),
      };
      one.fingerprint = fingerprint(one);
      return one;
    });
  }

  function tooBig(body) {
    return String(body || "").split("\n").length + 1 > MAX_LINES;
  }

  /** Mermaid / DOT：复用 C3 的引擎校验（`DGM.engineLint`，真实行列）。 */
  async function engineFormat(fmtId, body, layout) {
    // 先判引擎在不在：`engineLint` 在"引擎不可用"和"没有错误"时都返回 []，
    // 直接把 [] 当成"通过"会把"根本没校验"冒充成"校验通过"。
    const ready =
      fmtId === "mermaid"
        ? typeof window.mermaid !== "undefined"
        : !!(window.DGMGraphviz || window.DGMGraphvizReady);
    if (!ready) return { ok: true, issues: [], degraded: true };
    if (!DGM.engineLint) return { ok: true, issues: [], degraded: true };

    let raw = [];
    try {
      raw = await DGM.engineLint.issues({ format: fmtId, body, layout: layout || "dot" });
    } catch (e) {
      return { ok: true, issues: [], degraded: true }; // 校验器自己炸了，不算文档的错
    }
    // 空结果且引擎确实在 = 真通过；但 mermaid 的 parse 在部分语法上会"静默放行"
    // （例如被 strict 挡住的 directive），这里不再加猜测，保持"有错才报"。
    const issues = normalise(raw);
    return { ok: issues.length === 0, issues, degraded: false };
  }

  /** D2：随包 wasm 的 compile（只编译、不布局）。 */
  async function d2Format(body, layout) {
    if (!DGM.d2 || !DGM.d2.compile) return { ok: true, issues: [], degraded: true };
    try {
      await DGM.d2.compile(body, layout || "dagre");
      return { ok: true, issues: [], degraded: false };
    } catch (err) {
      const raw = err && err.message ? err.message : err;
      const d = DGM.d2.describeError ? DGM.d2.describeError(raw) : null;
      if (!d || !d.line) {
        // 编译失败但拿不到行号：这是"确实坏了"，但定位不了。
        // 仍判失败（ok=false），行号留空 —— 回灌时模型能拿到原文。
        return {
          ok: false,
          issues: normalise([{ line: null, column: null, message: String(d ? d.text : raw) }]),
          degraded: false,
        };
      }
      return {
        ok: false,
        issues: normalise([{ line: d.line, column: d.col, message: d.text }]),
        degraded: false,
      };
    }
  }

  /** drawio：XML 必须可解析，且要有 mxGraphModel（否则承载页会白屏）。 */
  function drawioFormat(body) {
    if (typeof DOMParser === "undefined") return { ok: true, issues: [], degraded: true };
    let doc;
    try {
      doc = new DOMParser().parseFromString(String(body || ""), "application/xml");
    } catch (e) {
      return { ok: true, issues: [], degraded: true };
    }
    const err = doc.querySelector("parsererror");
    if (err) {
      return {
        ok: false,
        issues: normalise([{ line: null, column: null, message: "XML 无法解析：" + String(err.textContent || "").trim().slice(0, 200) }]),
        degraded: false,
      };
    }
    if (!doc.querySelector("mxGraphModel") && !doc.querySelector("mxfile")) {
      return {
        ok: false,
        issues: normalise([{ line: null, column: null, message: "缺少 mxGraphModel / mxfile 根节点" }]),
        degraded: false,
      };
    }
    return { ok: true, issues: [], degraded: false };
  }

  /** Excalidraw：JSON 必须可解析，且 `elements` 是数组（空数组也算合法空图）。 */
  function excalidrawFormat(body) {
    let obj;
    try {
      obj = JSON.parse(String(body || ""));
    } catch (e) {
      return {
        ok: false,
        issues: normalise([{ line: null, column: null, message: "JSON 无法解析：" + String(e && e.message ? e.message : e) }]),
        degraded: false,
      };
    }
    if (!obj || !Array.isArray(obj.elements)) {
      return {
        ok: false,
        issues: normalise([{ line: null, column: null, message: "缺少 elements 数组" }]),
        degraded: false,
      };
    }
    return { ok: true, issues: [], degraded: false };
  }

  /** 统一入口。`format` 是格式 id（mermaid/dot/d2/drawio/excalidraw）。 */
  async function run(format, body, opts) {
    const fmt = String(format || "");
    const text = String(body == null ? "" : body);
    if (!text.trim()) {
      return { ok: false, issues: normalise([{ line: null, column: null, message: "内容为空" }]), degraded: false };
    }
    if (tooBig(text)) {
      // 与引擎校验同一道护栏：大文档不跑，明确标"没校验"而不是"通过"
      return { ok: true, issues: [], degraded: true };
    }
    switch (fmt) {
      case "mermaid":
      case "dot":
        return engineFormat(fmt, text, opts && opts.layout);
      case "d2":
        return d2Format(text, opts && opts.layout);
      case "drawio":
        return drawioFormat(text);
      case "excalidraw":
        return excalidrawFormat(text);
      default:
        return { ok: true, issues: [], degraded: true };
    }
  }

  DGM.validate = {
    run,
    fingerprint,
    MAX_LINES,
    /** 一轮校验的"错误指纹集合"，供连续两轮对比（顺序无关）。 */
    signature(result) {
      const list = ((result && result.issues) || []).map((i) => i.fingerprint).sort();
      return fnv1a(list.join(","));
    },
  };
})();
