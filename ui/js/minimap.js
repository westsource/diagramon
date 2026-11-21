/* 鹰眼导航：预览右下角的总览图 + 当前视口框，点击/拖动定位。
 *
 * 设计口径（与 preview.js / canvas.js 的视口约定一致）：
 * - **不是缩略图**：只画结构轮廓（节点框、连线、图片块），不画文字；190px 宽下文字
 *   本来也不可读。四格式共用同一套绘制与手势，差异只在 provider。
 * - 文本型（Mermaid / DOT / D2）：从 `#canvas-stage svg` 的 DOM 取几何，坐标用 SVG
 *   viewBox 的用户坐标；视口由 preview.js 的 `view.scale/x/y` 换算出可见内容矩形。
 * - 画布型（drawio / Excalidraw）：由承载页的 `__hostOverview()` 提供 model/scene
 *   坐标的内容框、视口框与轮廓；`__hostCenterOn()` 负责定位。这里只做轮询与绘制。
 * - 只读导航：点击/拖动只改视口（text 的 --pan/--zoom、画布的 scroll），不碰正文、
 *   不标脏、不进导出。
 *
 * 性能：
 * - 轮廓画进离屏 canvas 缓存，每帧只 blit + 视口框；只有内容/主题/尺寸变化才重建。
 * - 画布型在可见时约 30fps 轮询承载页（只读几个数字）；隐藏/禁用/页面不可见即停。
 * - 形状数有上限，超大图只画前 MAX_SHAPES 个 —— 鹰眼是导航，不是渲染真相。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const state = DGM.state;
  const t = (k, v) => DGM.i18n.t(k, v);

  const PAD = 6;
  const MAX_SHAPES = 4000;
  const POLL_MS = 33;

  let root = null;
  let canvas = null;
  let ctx = null;
  let bg = null;
  let bgCtx = null;
  let dpr = 1;

  /** none | text | canvas */
  let mode = "none";
  let format = null;
  let enabled = true;

  let textSvg = null;
  let content = null; // 内容框（当前 provider 的坐标）
  let shapes = [];
  let shapesRev = -1;
  let overview = null; // 画布型最近一次 __hostOverview()
  let bgKey = "";
  let layout = null; // { k, ox, oy, w, h, content }
  let lastView = null;

  const textView = { scale: 1, x: 0, y: 0 };

  let pollRaf = 0;
  let drawRaf = 0;
  let lastPoll = 0;
  let dragging = false;
  let pending = null;
  let pendingRaf = 0;

  function num(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }

  function isColor(v) {
    if (typeof v !== "string" || !v) return false;
    if (/^(none|transparent|currentcolor|inherit|initial|unset|revert)$/i.test(v)) return false;
    // 只接受 canvas 真能解析的颜色；drawio 的 `light-dark(...)` / `var(...)` / url(#…)
    // 原样塞给 fillStyle 会被静默忽略并沿用上一个颜色 —— 宁可不上色，也不要串色。
    return /^#[0-9a-f]{3,8}$/i.test(v) || /^(rgb|rgba|hsl|hsla)\(/i.test(v) || /^[a-z]+$/i.test(v);
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function paneVisible() {
    const vp = document.getElementById("canvas-viewport");
    return !!(vp && vp.clientWidth > 0 && vp.clientHeight > 0);
  }

  function ensureSize() {
    if (!root || !canvas || !bg) return null;
    const w = Math.max(1, root.clientWidth || 190);
    const h = Math.max(1, root.clientHeight || 132);
    const d = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    dpr = d;
    const pw = Math.round(w * d);
    const ph = Math.round(h * d);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    if (bg.width !== pw || bg.height !== ph) {
      bg.width = pw;
      bg.height = ph;
    }
    return { w, h };
  }

  function hideRoot() {
    if (root) root.hidden = true;
  }

  function reveal() {
    const on = !!(enabled && content && content.w > 0 && content.h > 0 && shapes.length);
    if (root) root.hidden = !on;
    return on;
  }

  /* ------------------------------------------------------------------ 文本型 provider */

  function mvals(m) {
    return m ? [m.a, m.b, m.c, m.d, m.e, m.f] : [1, 0, 0, 1, 0, 0];
  }

  function xform(m, x, y) {
    return [x * m.a + y * m.c + m.e, x * m.b + y * m.d + m.f];
  }

  function rectPts(m, b) {
    return [
      xform(m, b.x, b.y),
      xform(m, b.x + b.width, b.y),
      xform(m, b.x + b.width, b.y + b.height),
      xform(m, b.x, b.y + b.height),
    ];
  }

  function bboxOf(el) {
    try {
      const b = el.getBBox();
      return b && b.width > 0 && b.height > 0 ? b : null;
    } catch (e) {
      return null;
    }
  }

  function pointsOf(el) {
    const raw = (el.getAttribute("points") || "").trim();
    if (!raw) return [];
    const vals = raw.split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
    const pts = [];
    for (let i = 0; i + 1 < vals.length; i += 2) pts.push([vals[i], vals[i + 1]]);
    return pts;
  }

  /**
   * 从渲染出的 SVG DOM 提取轮廓。
   *
   * 用 `inv(rootScreenCTM) * el.screenCTM` 把每个元素归一到根 SVG 的用户坐标 ——
   * 这样舞台的 CSS 缩放/平移、SVG 的 viewBox、嵌套 `<g transform>` 都被一次性抹平，
   * 鹰眼拿到的坐标与 `viewBox` 同尺。
   */
  function buildText(svg) {
    content = null;
    shapes = [];
    shapesRev = 0;
    bgKey = "";
    if (!svg) return;

    const vb = svg.viewBox && svg.viewBox.baseVal;
    let box;
    if (vb && vb.width > 0 && vb.height > 0) {
      box = { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
    } else {
      try {
        const b = svg.getBBox();
        box = { x: b.x, y: b.y, w: b.width, h: b.height };
      } catch (e) {
        return;
      }
    }
    if (!(box.w > 0 && box.h > 0)) return;

    let rootCTM;
    try {
      rootCTM = svg.getScreenCTM();
    } catch (e) {
      rootCTM = null;
    }
    if (!rootCTM) return;
    const inv = rootCTM.inverse();
    const out = [];
    const els = svg.querySelectorAll("rect,circle,ellipse,line,polyline,polygon,path,image");

    for (const el of els) {
      if (out.length >= MAX_SHAPES) break;
      if (el.closest("defs,clipPath,mask,marker,pattern,symbol,script,style,title,desc,metadata")) continue;
      const tag = el.tagName.toLowerCase();
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;

      let m;
      try {
        m = el.getScreenCTM();
      } catch (e) {
        m = null;
      }
      if (!m) continue;
      try {
        m = inv.multiply(m);
      } catch (e) {
        continue;
      }

      const fill = isColor(cs.fill) ? cs.fill : null;
      const sw = num(parseFloat(cs.strokeWidth), 1);

      if (tag === "image") {
        const b = bboxOf(el);
        if (b) out.push({ t: "p", pts: rectPts(m, b), fill: null, sw });
        continue;
      }

      if (tag === "rect") {
        const b = bboxOf(el);
        if (!b) continue;
        // 整幅背景（mermaid 的 background rect 等）不画，否则会盖住真正的结构
        if (b.width >= box.w * 0.98 && b.height >= box.h * 0.98) continue;
        out.push({ t: "p", pts: rectPts(m, b), fill, sw });
        continue;
      }

      if (tag === "circle" || tag === "ellipse") {
        const b = bboxOf(el);
        if (!b) continue;
        out.push({
          t: "e",
          cx: b.x + b.width / 2,
          cy: b.y + b.height / 2,
          rx: b.width / 2,
          ry: b.height / 2,
          m: mvals(m),
          fill,
          sw,
        });
        continue;
      }

      if (tag === "path") {
        const d = el.getAttribute("d");
        if (!d) continue;
        out.push({ t: "path", d, m: mvals(m), fill, sw });
        continue;
      }

      let pts;
      if (tag === "line") {
        pts = [
          [num(el.getAttribute("x1"), 0), num(el.getAttribute("y1"), 0)],
          [num(el.getAttribute("x2"), 0), num(el.getAttribute("y2"), 0)],
        ];
      } else {
        pts = pointsOf(el);
      }
      if (!pts || pts.length < 2) continue;
      pts = pts.map((p) => xform(m, p[0], p[1]));
      out.push(tag === "polygon" ? { t: "p", pts, fill, sw } : { t: "l", pts, sw });
    }

    content = box;
    shapes = out;
    shapesRev += 1;
    bgKey = "";
  }

  /* ------------------------------------------------------------------ 画布型 provider */

  function buildSceneShapes(elements) {
    const out = [];
    for (const e of elements || []) {
      if (out.length >= MAX_SHAPES) break;
      if (!e || e.isDeleted) continue;
      const type = e.type;
      const x = num(e.x, 0);
      const y = num(e.y, 0);
      const w = num(e.width, 0);
      const h = num(e.height, 0);
      const fill = isColor(e.backgroundColor) ? e.backgroundColor : null;
      const sw = num(e.strokeWidth, 1);

      if (type === "line" || type === "arrow" || type === "freedraw") {
        const pts = Array.isArray(e.points)
          ? e.points.map((p) => [x + num(p[0], 0), y + num(p[1], 0)])
          : [];
        if (pts.length >= 2) out.push({ t: "l", pts, sw });
        continue;
      }
      if (!(w > 0 && h > 0)) continue;
      if (type === "ellipse") {
        out.push({ t: "e", cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2, fill, sw });
      } else if (type === "diamond") {
        out.push({
          t: "p",
          pts: [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]],
          fill,
          sw,
        });
      } else {
        // rectangle / text / image / frame / embeddable …：统一画轮廓块。
        // text 也留一块很淡的框，保证“只写了字”的白板在鹰眼里不是空的。
        out.push({ t: "r", x, y, w, h, fill: type === "text" ? null : fill, sw });
      }
    }
    return out;
  }

  function poll(ts) {
    pollRaf = 0;
    if (!enabled || mode !== "canvas" || !format) return;

    if (document.hidden || !paneVisible()) {
      pollRaf = requestAnimationFrame(poll);
      return;
    }

    if (!lastPoll || ts - lastPoll >= POLL_MS) {
      lastPoll = ts;
      let ov = null;
      try {
        ov = DGM.canvas && DGM.canvas.hostOverview ? DGM.canvas.hostOverview(format) : null;
      } catch (e) {
        ov = null;
      }
      if (ov && ov.content && ov.content.w > 0 && ov.content.h > 0 && Array.isArray(ov.shapes) && ov.shapes.length) {
        content = ov.content;
        if (ov.rev !== shapesRev || !overview) {
          shapes = ov.shapes;
          shapesRev = ov.rev;
          bgKey = "";
        }
        overview = ov;
        reveal();
        scheduleDraw();
      } else {
        // 画布还没起来 / 空文档：别把上一份的图留在屏幕上
        if (content || overview) {
          content = null;
          shapes = [];
          shapesRev = -1;
          overview = null;
          bgKey = "";
          hideRoot();
        }
      }
    }
    pollRaf = requestAnimationFrame(poll);
  }

  function startPoll() {
    if (pollRaf || !enabled || mode !== "canvas") return;
    lastPoll = 0;
    pollRaf = requestAnimationFrame(poll);
  }

  function stopPoll() {
    if (pollRaf) cancelAnimationFrame(pollRaf);
    pollRaf = 0;
  }

  /* ------------------------------------------------------------------ 绘制 */

  function scheduleDraw() {
    if (drawRaf) return;
    drawRaf = requestAnimationFrame(() => {
      drawRaf = 0;
      draw();
    });
  }

  function rebuildBg(w, h, k, ox, oy) {
    if (!bg || !bgCtx) return;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (bg.width !== pw || bg.height !== ph) {
      bg.width = pw;
      bg.height = ph;
    }
    bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bgCtx.clearRect(0, 0, w, h);
    bgCtx.save();
    bgCtx.translate(ox, oy);
    bgCtx.scale(k, k);

    const ink = cssVar("--muted", "#8a8f98");
    const neutral = cssVar("--surface-3", "#e9eceb");

    for (const s of shapes) {
      const lw = Math.max(0.6 / k, num(s.sw, 1));
      const fill = s.fill ? s.fill : null;
      const alpha = s.t === "path" || s.t === "p" ? 0.28 : 0.22;

      bgCtx.save();
      bgCtx.lineWidth = lw;
      bgCtx.lineJoin = "round";
      bgCtx.lineCap = "round";
      bgCtx.strokeStyle = ink;

      if (s.t === "r") {
        bgCtx.beginPath();
        bgCtx.rect(s.x, s.y, s.w, s.h);
        if (fill) {
          bgCtx.globalAlpha = alpha;
          bgCtx.fillStyle = fill;
          bgCtx.fill();
        }
        bgCtx.globalAlpha = 0.85;
        bgCtx.stroke();
      } else if (s.t === "e") {
        if (s.m) bgCtx.transform(s.m[0], s.m[1], s.m[2], s.m[3], s.m[4], s.m[5]);
        bgCtx.beginPath();
        bgCtx.ellipse(s.cx, s.cy, Math.max(0.01, s.rx), Math.max(0.01, s.ry), 0, 0, Math.PI * 2);
        if (fill) {
          bgCtx.globalAlpha = alpha;
          bgCtx.fillStyle = fill;
          bgCtx.fill();
        }
        bgCtx.globalAlpha = 0.85;
        bgCtx.stroke();
      } else if (s.t === "l") {
        const pts = s.pts || [];
        if (pts.length >= 2) {
          bgCtx.beginPath();
          bgCtx.moveTo(pts[0][0], pts[0][1]);
          for (let i = 1; i < pts.length; i++) bgCtx.lineTo(pts[i][0], pts[i][1]);
          bgCtx.globalAlpha = 0.8;
          bgCtx.stroke();
        }
      } else if (s.t === "p") {
        const pts = s.pts || [];
        if (pts.length >= 2) {
          bgCtx.beginPath();
          bgCtx.moveTo(pts[0][0], pts[0][1]);
          for (let i = 1; i < pts.length; i++) bgCtx.lineTo(pts[i][0], pts[i][1]);
          bgCtx.closePath();
          if (fill) {
            bgCtx.globalAlpha = alpha;
            bgCtx.fillStyle = fill;
            bgCtx.fill();
          }
          bgCtx.globalAlpha = 0.85;
          bgCtx.stroke();
        }
      } else if (s.t === "path") {
        try {
          if (s.m) bgCtx.transform(s.m[0], s.m[1], s.m[2], s.m[3], s.m[4], s.m[5]);
          const path = new Path2D(s.d);
          if (fill) {
            bgCtx.globalAlpha = alpha;
            bgCtx.fillStyle = fill;
            bgCtx.fill(path);
          }
          bgCtx.globalAlpha = 0.8;
          bgCtx.stroke(path);
        } catch (e) {
          // 单条坏路径不该让整张鹰眼消失
        }
      } else if (s.t === "text") {
        bgCtx.globalAlpha = 0.3;
        bgCtx.fillStyle = neutral;
        bgCtx.fillRect(s.x, s.y, s.w, s.h);
      }
      bgCtx.restore();
    }

    bgCtx.restore();
  }

  function viewportRect(w, h, k, ox, oy) {
    if (mode === "canvas") {
      return overview && overview.view ? overview.view : null;
    }
    const vp = document.getElementById("canvas-viewport");
    if (!vp) return null;
    const scale = textView.scale > 0 ? textView.scale : 1;
    return {
      x: -textView.x / scale,
      y: -textView.y / scale,
      w: vp.clientWidth / scale,
      h: vp.clientHeight / scale,
    };
  }

  function drawViewport(w, h, k, ox, oy) {
    const v = viewportRect(w, h, k, ox, oy);
    if (!v || !(v.w > 0) || !(v.h > 0)) return;
    lastView = v;

    const x = ox + v.x * k;
    const y = oy + v.y * k;
    const vw = v.w * k;
    const vh = v.h * k;
    const accent = cssVar("--accent", "#3d7d72");

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();

    // 视口完全在内容之外：在最近的一条边上画一根提示条，别让用户以为鹰眼丢了
    if (x > w || x + vw < 0 || y > h || y + vh < 0) {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = accent;
      if (x + vw < 0) ctx.fillRect(0, 0, 3, h);
      else if (x > w) ctx.fillRect(w - 3, 0, 3, h);
      else if (y + vh < 0) ctx.fillRect(0, 0, w, 3);
      else ctx.fillRect(0, h - 3, w, 3);
      ctx.restore();
      return;
    }

    // 视口可能比内容大（整幅图都在屏幕里）。把框裁到地图内，否则四边全在画布外、
    // 用户看不到任何“当前视口”的边框。裁到整张地图时就是“你正看着全图”。
    let rx = x;
    let ry = y;
    let rw = vw;
    let rh = vh;
    if (rx < 0) { rw += rx; rx = 0; }
    if (ry < 0) { rh += ry; ry = 0; }
    if (rx + rw > w) rw = w - rx;
    if (ry + rh > h) rh = h - ry;
    if (rw <= 1 || rh <= 1) {
      ctx.restore();
      return;
    }

    ctx.globalAlpha = 0.12;
    ctx.fillStyle = accent;
    ctx.fillRect(rx, ry, rw, rh);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx + 0.75, ry + 0.75, Math.max(1, rw - 1.5), Math.max(1, rh - 1.5));
    ctx.restore();
  }

  function draw() {
    drawRaf = 0;
    if (!enabled || !root || root.hidden) return;
    if (!content || !shapes.length) return;
    if (!paneVisible()) return;

    const size = ensureSize();
    if (!size) return;
    const w = size.w;
    const h = size.h;
    const c = content;
    const k = Math.min((w - PAD * 2) / c.w, (h - PAD * 2) / c.h);
    if (!(k > 0)) return;
    const ox = (w - c.w * k) / 2 - c.x * k;
    const oy = (h - c.h * k) / 2 - c.y * k;
    layout = { k, ox, oy, w, h, content: c };

    const key = [
      dpr, w, h, c.x, c.y, c.w, c.h, shapesRev,
      document.documentElement.dataset.theme || "",
      document.documentElement.dataset.accent || "",
    ].join("|");
    if (key !== bgKey) {
      rebuildBg(w, h, k, ox, oy);
      bgKey = key;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (bg && bg.width) ctx.drawImage(bg, 0, 0, w, h);
    drawViewport(w, h, k, ox, oy);
  }

  /* ------------------------------------------------------------------ 指针 */

  function navigate(evt) {
    if (!layout) return;
    const rect = canvas ? canvas.getBoundingClientRect() : root.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = evt.clientX - rect.left;
    const py = evt.clientY - rect.top;
    const { k, ox, oy, content: c } = layout;
    let x = (px - ox) / k;
    let y = (py - oy) / k;
    x = Math.max(c.x, Math.min(c.x + c.w, x));
    y = Math.max(c.y, Math.min(c.y + c.h, y));
    pending = { x, y };
    if (pendingRaf) return;
    pendingRaf = requestAnimationFrame(() => {
      pendingRaf = 0;
      const p = pending;
      pending = null;
      applyCenter(p);
    });
  }

  function applyCenter(p) {
    if (!p) return;
    if (mode === "canvas" && DGM.canvas && DGM.canvas.hostCenterOn) {
      DGM.canvas.hostCenterOn(format, p.x, p.y);
    } else if (mode === "text" && DGM.preview && DGM.preview.centerOnContent) {
      DGM.preview.centerOnContent(p.x, p.y);
    }
  }

  function onDown(evt) {
    if (!layout || root.hidden || evt.button !== 0) return;
    evt.preventDefault();
    evt.stopPropagation();
    dragging = true;
    root.classList.add("dragging");
    try {
      root.setPointerCapture(evt.pointerId);
    } catch (e) {
      /* 旧 WebView / 合成事件：没有 capture 也能靠 window 上的 move 收尾 */
    }
    navigate(evt);
  }

  function onMove(evt) {
    if (!dragging) return;
    evt.preventDefault();
    evt.stopPropagation();
    navigate(evt);
  }

  function onUp(evt) {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("dragging");
    try {
      root.releasePointerCapture(evt.pointerId);
    } catch (e) {
      /* 同上 */
    }
    // 单击常常在同一帧内完成 pointerdown → pointerup；不能把待执行的定位直接取消，
    // 否则“点一下鹰眼”什么都不会发生（拖拽时也一样：补上最后一次位置）。
    if (pendingRaf) {
      cancelAnimationFrame(pendingRaf);
      pendingRaf = 0;
    }
    const p = pending;
    pending = null;
    applyCenter(p);
  }

  function bind() {
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onUp);
    root.addEventListener(
      "wheel",
      (e) => {
        // 鹰眼上的滚轮不参与画布缩放/平移；别让事件冒到 #canvas-viewport
        e.preventDefault();
        e.stopPropagation();
      },
      { passive: false },
    );
    root.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    root.addEventListener("contextmenu", (e) => e.stopPropagation());
  }

  /* ------------------------------------------------------------------ 设置 / 开关 */

  function applyEnabled() {
    const was = enabled;
    enabled = !(state.settings && state.settings.editor && state.settings.editor.minimap === false);

    const btn = document.getElementById("btn-minimap");
    if (btn) {
      btn.classList.toggle("on", enabled);
      btn.setAttribute("aria-pressed", enabled ? "true" : "false");
    }
    if (root) {
      root.setAttribute("aria-label", t("ui.minimap"));
      root.title = t("ui.minimap");
    }

    bgKey = "";
    if (!enabled) {
      stopPoll();
      hideRoot();
      return;
    }
    if (mode === "canvas") {
      startPoll();
    } else if (mode === "text" && textSvg) {
      if (!shapes.length) {
        try {
          buildText(textSvg);
        } catch (e) {
          content = null;
          shapes = [];
        }
      }
      reveal();
      scheduleDraw();
    }
    if (was !== enabled && mode === "text") scheduleDraw();
  }

  function toggle() {
    const on = !(state.settings && state.settings.editor && state.settings.editor.minimap !== false);
    try {
      const p = state.patchSettings({ editor: { minimap: on } });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {
      /* mock / 未就绪：保持原样 */
    }
  }

  /* ------------------------------------------------------------------ 对外 */

  function clear() {
    mode = "none";
    format = null;
    textSvg = null;
    content = null;
    shapes = [];
    shapesRev = -1;
    overview = null;
    bgKey = "";
    layout = null;
    lastView = null;
    stopPoll();
    hideRoot();
  }

  function setText(svg, view) {
    if (!svg) {
      clear();
      return;
    }
    mode = "text";
    format = null;
    textSvg = svg;
    content = null;
    shapes = [];
    shapesRev = 0;
    overview = null;
    bgKey = "";
    if (view) {
      textView.scale = num(view.scale, 1) || 1;
      textView.x = num(view.x, 0);
      textView.y = num(view.y, 0);
    }
    if (!enabled) {
      hideRoot();
      return;
    }
    try {
      buildText(svg);
    } catch (e) {
      content = null;
      shapes = [];
    }
    reveal();
    scheduleDraw();
  }

  function setTextView(view) {
    if (!view) return;
    textView.scale = num(view.scale, 1) || 1;
    textView.x = num(view.x, 0);
    textView.y = num(view.y, 0);
    if (mode === "text" && enabled && content && shapes.length) scheduleDraw();
  }

  function setCanvas(fmt) {
    mode = "canvas";
    format = fmt;
    textSvg = null;
    content = null;
    shapes = [];
    shapesRev = -1;
    overview = null;
    bgKey = "";
    layout = null;
    lastView = null;
    hideRoot();
    if (enabled) startPoll();
  }

  function init() {
    root = document.getElementById("minimap");
    canvas = document.getElementById("minimap-canvas");
    if (!root || !canvas) return;
    ctx = canvas.getContext("2d");
    if (!ctx) return;
    bg = document.createElement("canvas");
    bgCtx = bg.getContext("2d");
    if (!bgCtx) return;

    root.setAttribute("role", "group");
    root.setAttribute("aria-label", t("ui.minimap"));
    root.title = t("ui.minimap");
    bind();

    const btn = document.getElementById("btn-minimap");
    if (btn) btn.addEventListener("click", toggle);

    DGM.bus.on("settings:changed", applyEnabled);
    window.addEventListener("resize", () => {
      bgKey = "";
      scheduleDraw();
    });
    applyEnabled();
  }

  const api = {
    init,
    setText,
    setTextView,
    setCanvas,
    clear,
    toggle,
    enabled: () => enabled,
    /** 探针用：不依赖像素断言，直接看模块的账本。 */
    debug: () => ({
      mode,
      format,
      enabled,
      shown: !!(root && !root.hidden),
      shapes: shapes.length,
      content: content ? { x: content.x, y: content.y, w: content.w, h: content.h } : null,
      view: lastView ? { x: lastView.x, y: lastView.y, w: lastView.w, h: lastView.h } : null,
    }),
  };

  DGM.minimap = api;
  init();
})();
