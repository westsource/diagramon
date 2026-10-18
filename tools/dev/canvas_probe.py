#!/usr/bin/env python
"""画布承载探针：验证「drawio 画布 ↔ 本站正文」这条链路真的通。

    python tools/dev/canvas_probe.py            断言 + 截图
    python tools/dev/canvas_probe.py --keep     保留 DOM/截图中间产物

## 为什么不能用自检（DIAGRAMON_SELFTEST）验这件事

自检跑在真实客户端的 WebView2 里，**后台窗口的定时器被节流到约 1 次/秒**，
而 drawio 起来要好几秒、autosave 还要再等 1.5s —— 在自检里等它只会把报告拖到超时。
自检里因此只断言「iframe 挂上了、同源可读」这类同步可判定的东西。

## 这个脚本怎么做

用普通 HTTP 在本机起一份**与 crates/assets 相同的目录布局**
（`/drawio/*` → 挂载点，其余 → 前端产物目录），再用 CDP（`--remote-debugging-port`）
驱动本机 Chrome：加载探针页 → 调它暴露的 `__runProbe()` 拿结论 → 截图。

这一层验的是**协议翻译**（`__hostQueue` / `__apply` / `export`）与**同源假设**；
Tauri 侧的协议注册由 `tools/dev/check.mjs` 的「承载面已挂载 / 同源可读」覆盖。
两层各自测自己那一半，合起来才是完整链路。

## 踩过的坑（别再改回去）

1. **不要用 `--virtual-time-budget` + `--dump-dom` 等结论**：drawio 这类持续跑计时器的
   SPA 会把虚拟时钟顶住，实测直接挂死十分钟不动。改用 CDP 主动调用、按真实时间等。
2. **不要用 `--screenshot` 等渲染**：它在 load 事件就截图，drawio 那时还是白屏。
   改用 `Page.captureScreenshot`，在断言跑完之后再截。
3. 本机有 HTTP 代理，`127.0.0.1` 必须显式绕过（`no_proxy` + 空 ProxyHandler），
   否则连本机端口都会走代理然后失败 —— 看起来像「端口没开」。

依赖：本机 Chrome / Edge；`websocket-client`；drawio 资产在 `tools/drawio`（2026-10-17 起取资产脚本
与运行时就只在本仓库，旧的 `../client` 已删除）。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SHOTS = ROOT / "ui" / ".shots"

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]

# 只有显式设了 DIAGRAMON_SOURCE_TREE 才用它（从别处的备份汇出/验收）；默认用本仓库根。
SOURCE_TREE = Path(os.environ["DIAGRAMON_SOURCE_TREE"]) if os.environ.get("DIAGRAMON_SOURCE_TREE") else ROOT


def _mount(sub: tuple) -> Path:
    """挂载点目录：显式 DIAGRAMON_SOURCE_TREE 一票优先，否则就是本仓库 `tools/<挂载点>`。

    2026-10-17 起取资产脚本与运行时就只在本仓库了，旧工作树 `../client` **已删除、不再回退** ——
    宁可让下面的"资产不在位"报出来，也不要静默测到上一份停更的副本（与承载页两份同一个坑）。
    """
    base = SOURCE_TREE if os.environ.get("DIAGRAMON_SOURCE_TREE") else ROOT
    return base.joinpath(*sub)


MOUNTS = {
    "drawio": _mount(("tools", "drawio")),
    "excalidraw": _mount(("tools", "excalidraw")),
    "graphviz": _mount(("tools", "graphviz")),
    "mermaid": _mount(("tools", "mermaid")),
}

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".cur": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    ".xml": "application/xml",
    ".txt": "text/plain; charset=utf-8",
}

PROBE_TIMEOUT_S = float(os.environ.get("DGM_PROBE_TIMEOUT", "180"))
SETTLE_S = float(os.environ.get("DGM_SHOT_SETTLE", "6"))

# 一段能渲染出可见结果的 mxfile：压缩格式要 drawio 自己解，明文 mxGraphModel 它认。
SAMPLE_XML = (
    '<mxfile host="Diagramon" type="device">'
    '<diagram id="dgm-probe" name="Page-1">'
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" '
    'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" '
    'math="0" shadow="0"><root>'
    '<mxCell id="0"/><mxCell id="1" parent="0"/>'
    '<mxCell id="2" value="DIAGRAMON_CANVAS_PROBE" '
    'style="rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">'
    '<mxGeometry x="120" y="140" width="260" height="70" as="geometry"/></mxCell>'
    "</root></mxGraphModel></diagram></mxfile>"
)

# 引擎方换的输入：带一个足够特殊的标签，好在 drawio 导出的 XML 里认出来。
# 这也是 `mermaid → drawio` 走的真实路径 —— 由 drawio 自带的 Mermaid 导入器解析，
# Rust 侧不重新实现（见 crates/app-core/src/convert.rs 的 plan()）。
SAMPLE_MERMAID = """flowchart TD
    P([开始]) --> Q{网关正常?}
    Q -- 是 --> R[DIAGRAMON_MERMAID_PROBE]
    Q -- 否 --> P
"""

PROBE_HTML = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>canvas probe</title>
<style>
  html,body{margin:0;height:100%;font:12px/1.5 ui-monospace,Consolas,monospace}
  #h{width:100%;height:calc(100% - 210px);border:0;display:block}
  #log{height:210px;overflow:auto;background:#0d1117;color:#c9d1d9;padding:8px 10px;white-space:pre-wrap}
  #log .f{color:#ff7b72}
</style></head><body>
<iframe id="h" src="/drawio/host.html"></iframe>
<div id="log">等待断言…</div>
<script>
var SAMPLE = __SAMPLE__;
var MERMAID_SRC = __MERMAID__;
var lines = [];
var h = document.getElementById("h");

function paint() {
  var el = document.getElementById("log");
  el.textContent = lines.join("\\n");
  el.scrollTop = el.scrollHeight;
}
function say(s, bad) {
  lines.push((bad ? "FAIL " : "PASS ") + s);
  window.__probeLines = lines.slice();   // 卡住时驱动侧还能读到进度
  paint();
}
window.__probeLines = lines;
function waitFor(fn, ms, label) {
  return new Promise(function (ok, no) {
    var t0 = Date.now();
    (function tick() {
      var v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return ok(v);
      if (Date.now() - t0 > ms) return no(new Error("等 " + label + " 超时（" + ms + "ms）"));
      setTimeout(tick, 100);
    })();
  });
}

var seen = [];
function drain() {
  var w = h.contentWindow;
  var q;
  try { q = w.__hostQueue; } catch (e) { return; }
  if (!Array.isArray(q) || !q.length) return;
  var items = q.splice(0, q.length);
  for (var i = 0; i < items.length; i++) {
    try { seen.push(JSON.parse(items[i])); } catch (e) { seen.push({ event: "raw", data: items[i] }); }
  }
}
function firstOf(pred) {
  for (var i = 0; i < seen.length; i++) if (pred(seen[i])) return seen[i];
  return null;
}

/* 发一次 export 请求并等结果：这就是 flush() 取当前正文用的动作 */
function askExport(w, marker, tag) {
  seen.length = 0;                       // 只认这一轮的结果，别被上一轮残留骗了
  w.__apply(JSON.stringify({ action: "export", format: "xml" }));
  return waitFor(function () {
    return firstOf(function (e) {
      return e.event === "export" && String(e.format).toLowerCase() === "xml";
    });
  }, 25000, "export xml " + tag).then(function (ex) {
    if ((ex.xml || "").indexOf(marker) < 0) {
      throw new Error("取回的 XML 里没有 " + tag + " 的标签（" + (ex.xml || "").length + " 字节）");
    }
    return ex.xml;
  });
}

/* CDP 调这个：resolve 出断言行数组（awaitPromise + returnByValue 直接拿回结果） */
/* 完成时由页面自己写结果：驱动只轮询这个全局量。
   曾经把结果挂在驱动侧的 .then 上，实测等不到（页面侧明明已经跑完），
   所以不绕那一圈 —— 谁产生结论谁负责写。 */
function finish(list, done) {
  window.__PROBE_RESULT = list.slice();
  done(list);
}

window.__runProbe = function () {
  return new Promise(function (done) {
    // 先等**承载页自己的文档**就绪：探针页的 load 事件只保证外层文档好了，
    // iframe 里的内联脚本可能还没执行（首次跑就栽在这里，误报「未暴露 __apply」）。
    // 每次都要重读 contentWindow —— 导航会让它换成新对象。
    var t0 = Date.now();
    (function waitHost() {
      var w = h.contentWindow;
      if (w && typeof w.__apply === "function") return begin(w, done);
      if (Date.now() - t0 > 30000) {
        say("承载页 30s 内没起来（iframe 的 __apply 始终不存在）", true);
        return finish(lines, done);
      }
      setTimeout(waitHost, 100);
    })();
  });
};

function begin(w, done) {
  doBegin(w, done).catch(function (e) { say("异常：" + (e && e.message), true); finish(lines, done); });
}

function doBegin(w, done) {
  return (function () {
    say("承载页暴露 __apply");
    if (!Array.isArray(w.__hostQueue)) { say("承载页未暴露 __hostQueue", true); return finish(lines, done); }
    say("承载页暴露 __hostQueue");
    say("承载页可直读 contentWindow（同源成立）");

    setInterval(drain, 50);

    waitFor(function () { return firstOf(function (e) { return e.event === "init" || e.event === "ready"; }); }, 30000, "drawio init")
      .then(function (ini) {
        say("drawio 发出 " + ini.event + "（引擎起来了，embed 门控通过）");

        // 推第一版进去，再按 flush() 的路子取回来 —— 这条「推进去 → 取出来」就是
        // 打开文档与落盘前 flush 用的同一对动作。
        w.__apply(JSON.stringify({ action: "load", xml: SAMPLE, autosave: 1 }));
        return askExport(w, "DIAGRAMON_CANVAS_PROBE", "v1");
      })
      .then(function (xml1) {
        say("推进画布的正文能原样取回（" + (xml1 || "").length + " 字节，含探针标签）");

        // 再推第二版：证明它不是把首次载入的字符串缓存下来糊弄我们
        var v2 = SAMPLE.replace("DIAGRAMON_CANVAS_PROBE", "DIAGRAMON_CANVAS_PROBE_V2");
        w.__apply(JSON.stringify({ action: "load", xml: v2, autosave: 1 }));
        return askExport(w, "DIAGRAMON_CANVAS_PROBE_V2", "v2");
      })
      .then(function (xml2) {
        say("换一版再取回也对（" + (xml2 || "").length + " 字节，标签已更新）");

        // autosave 是 drawio 自己的回写通道（改动 1.5s 后）。它是加速项不是必需项：
        // 落盘前 flush 已经保证拿得到最新正文，所以这里没等到也如实说明、不算失败。
        return waitFor(function () {
          return firstOf(function (e) {
            return (e.event === "autosave" || e.event === "save") && typeof e.xml === "string" && e.xml.length > 0;
          });
        }, 4000, "autosave").then(
          function () { say("drawio 的 autosave 回写也通了"); },
          function () { say("（drawio 这次没触发 autosave —— 它不是必需项，落盘走 flush）"); },
        );
      })
      .then(function () {
        // 引擎转换：把 Mermaid 源码交给 drawio 自己的导入器（这正是
        // 「mermaid → drawio」在应用里的做法），再取回 XML 看标签在不在。
        seen.length = 0;
        w.__apply(JSON.stringify({
          action: "load",
          autosave: 1,
          descriptor: { format: "mermaid", data: MERMAID_SRC, wrap: true },
        }));
        return waitFor(function () {
          return firstOf(function (e) {
            return e.event === "export" && String(e.format).toLowerCase() === "xml";
          });
        }, 3000, "（第一次 export 只是探个路）")
          .then(function () { return true; })
          .catch(function () { return false; })
          .then(function () {
            seen.length = 0;
            w.__apply(JSON.stringify({ action: "export", format: "xml" }));
            return waitFor(function () {
              return firstOf(function (e) {
                return e.event === "export" && String(e.format).toLowerCase() === "xml"
                  && (e.xml || "").indexOf("DIAGRAMON_MERMAID_PROBE") >= 0;
              });
            }, 40000, "drawio 解析 Mermaid 后的 XML");
          })
          .then(
            function (ex) { say("引擎转换：mermaid 源码经 drawio 导入器变成了 mxfile（" + (ex.xml || "").length + " 字节）"); },
            function () { say("引擎转换：drawio 没有把 Mermaid 转出来（descriptor 可能不被支持）", true); },
          );
      })
      .then(function () {
        if (typeof w.__hostZoom === "function") say("缩放读数可用（__hostZoom → " + w.__hostZoom() + "）");
        else say("承载页未暴露 __hostZoom", true);
        if (typeof w.__hostFit === "function") say("适应视图钩子可用（__hostFit）");
        else say("承载页未暴露 __hostFit", true);
      })
      .then(function () {
        // ── 「适应视图」的语义（应用级 Ctrl+0 / 工具条 / 双击画布）──
        //
        // 旧实现是合成 drawio 自己的 Ctrl+Shift+J —— 那是 `fitTwoPages`：铺**两页宽的页面框**，
        // 内容远小于页面时缩得太小，页面框之外的单元格则被切掉。新实现走运行时桥（承载页拦
        // `mxGraph.prototype.getGraphBounds` 抓 graph 实例）调 `mxGraph.fit`：两维都适配、
        // 按 [0.2, 30] 夹取（与 SVG 预览模式同口径）、再自己居中。下面把四条硬要求钉住。
        var dlWin = h.contentDocument.getElementById("dl").contentWindow;
        var dlDoc = dlWin.document;
        var hostWin = h.contentWindow;
        var pause = function () { return new Promise(function (r) { setTimeout(r, 700); }); };

        function fitXml(cells) {
          return '<mxfile host="Diagramon" type="device"><diagram id="dgm-fit" name="Page-1">' +
            '<mxGraphModel dx="800" dy="600" page="1" pageScale="1" pageWidth="850" pageHeight="1100" ' +
            'math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>' + cells +
            "</root></mxGraphModel></diagram></mxfile>";
        }
        // 标签一律留空：形状节点的包围盒会把溢出的标签算进去（30× 时一个字的标签比框本身还大），
        // 几何断言会被标签带偏 —— 测的是"内容放进视口"，就该只看几何。
        function fitVertex(id, x, y, vw, vh) {
          return '<mxCell id="' + id + '" value="" style="rounded=1;" vertex="1" parent="1">' +
            '<mxGeometry x="' + x + '" y="' + y + '" width="' + vw + '" height="' + vh +
            '" as="geometry"/></mxCell>';
        }

        var FIX = {
          small: fitXml(fitVertex(2, 120, 140, 260, 70)),                             // 内容远小于页面
          outside: fitXml(fitVertex(2, 120, 140, 260, 70) + fitVertex(3, 900, 1200, 200, 80)),
          tiny: fitXml(fitVertex(2, 100, 100, 10, 10)),                               // 顶到 30× 夹取
          huge: fitXml(fitVertex(2, 0, 0, 20000, 20000)),                             // 底到 0.2× 夹取
          empty: fitXml(""),
        };

        function fitLoad(xml) {
          seen.length = 0;
          hostWin.__apply(JSON.stringify({ action: "load", xml: xml, autosave: 1 }));
          return waitFor(function () {
            return dlDoc.querySelector(".geDiagramContainer") ? true : null;
          }, 8000, "画布容器").then(function () {
            return new Promise(function (r) { setTimeout(r, 1500); });
          });
        }

        function fitScale() {
          var g = dlWin.__diagramonGraph;
          return g ? g.view.scale : 0;
        }

        // 每个单元格渲染出来的包围盒 vs 画布容器：四边都在里面 = 没被切掉。
        function fitGeometry() {
          var g = dlWin.__diagramonGraph;
          if (!g) return null;
          var cont = dlDoc.querySelector(".geDiagramContainer");
          var cr = cont.getBoundingClientRect();
          var boxes = [];
          var model = g.model, root = model.getRoot();
          (function walk(c) {
            for (var i = 0; i < model.getChildCount(c); i++) {
              var ch = model.getChildAt(c, i);
              var st = g.view.getState(ch);
              if (st && st.shape && st.shape.node && st.shape.node.getBoundingClientRect) {
                boxes.push(st.shape.node.getBoundingClientRect());
              }
              walk(ch);
            }
          })(root);
          if (!boxes.length) return { cells: 0 };
          var l = Math.min.apply(null, boxes.map(function (r) { return r.left; }));
          var t = Math.min.apply(null, boxes.map(function (r) { return r.top; }));
          var rr = Math.max.apply(null, boxes.map(function (r) { return r.right; }));
          var bb = Math.max.apply(null, boxes.map(function (r) { return r.bottom; }));
          return {
            cells: boxes.length,
            left: l - cr.left, right: cr.right - rr, top: t - cr.top, bottom: cr.bottom - bb,
            centerDx: ((l - cr.left) - (cr.right - rr)) / 2,
            centerDy: ((t - cr.top) - (cr.bottom - bb)) / 2,
          };
        }

        function fitInside(geo, tol) {
          return !!geo && geo.cells > 0 && geo.left >= -tol && geo.right >= -tol
            && geo.top >= -tol && geo.bottom >= -tol;
        }
        function fitGaps(geo) {
          if (!geo) return "读不到几何";
          return "单元格 " + geo.cells + " 个，留白 左/右/上/下=" + Math.round(geo.left) + "/"
            + Math.round(geo.right) + "/" + Math.round(geo.top) + "/" + Math.round(geo.bottom);
        }
        function fitCentered(geo, tol) {
          return !!geo && Math.abs(geo.centerDx) <= tol && Math.abs(geo.centerDy) <= tol;
        }

        // 对照：drawio 自己的 Fit Page（旧实现合成的那一组键）= fitTwoPages
        function legacyPageFit() {
          var target = dlDoc.querySelector(".geDiagramContainer") || dlDoc.body;
          target.dispatchEvent(new dlWin.KeyboardEvent("keydown", {
            key: "J", code: "KeyJ", keyCode: 74, ctrlKey: true, shiftKey: true,
            bubbles: true, cancelable: true,
          }));
        }

        say("运行时桥抓到了 editor graph 句柄（__diagramonGraph）", !dlWin.__diagramonGraph);

        return fitLoad(FIX.small)
          .then(function () { legacyPageFit(); return pause(); })
          .then(function () {
            var pageScale = fitScale();
            var ok = hostWin.__hostFit() === true;
            return pause().then(function () {
              var geo = fitGeometry();
              var contentScale = fitScale();
              say("内容远小于页面：页面框适配 " + Math.round(pageScale * 100) + "% → 内容适配 "
                + Math.round(contentScale * 100) + "%（" + fitGaps(geo) + "）",
                !(ok && contentScale > pageScale * 2));
              say("适应视图：所有单元格都在容器里（两维都适配）", !fitInside(geo, 4));
              say("适应视图：内容居中（偏移 " + Math.round(geo ? geo.centerDx : 0) + "/"
                + Math.round(geo ? geo.centerDy : 0) + "px）", !fitCentered(geo, 3));
            });
          })
          .then(function () { return fitLoad(FIX.outside); })
          .then(function () {
            var ok = hostWin.__hostFit() === true;
            return pause().then(function () {
              var geo = fitGeometry();
              say("页面框之外的单元格也一起进视口（" + fitGaps(geo) + "）", !(ok && fitInside(geo, 4)));
              say("页面框之外的单元格：同样居中", !fitCentered(geo, 3));
            });
          })
          .then(function () { return fitLoad(FIX.tiny); })
          .then(function () {
            var ok = hostWin.__hostFit() === true;
            return pause().then(function () {
              var s = fitScale();
              say("极小内容停在上限 30×（实测 " + Math.round(s * 100) + "%）", !(ok && s <= 30.001 && s > 29));
            });
          })
          .then(function () { return fitLoad(FIX.huge); })
          .then(function () {
            var ok = hostWin.__hostFit() === true;
            return pause().then(function () {
              var s = fitScale();
              // 不夹取时它本该 ≈3%（725 高 / 20000 宽），下限把结果抬到 0.2×
              say("超大内容停在下限 0.2×（实测 " + Math.round(s * 100) + "%）",
                !(ok && s >= 0.1999 && s <= 0.2001));
            });
          })
          .then(function () { return fitLoad(FIX.empty); })
          .then(function () {
            var g0 = dlWin.__diagramonGraph;
            var cont0 = dlDoc.querySelector(".geDiagramContainer");
            var before = g0 ? { scale: g0.view.scale, sl: cont0.scrollLeft, st: cont0.scrollTop } : null;
            var verdict = hostWin.__hostFit();
            return pause().then(function () {
              var g1 = dlWin.__diagramonGraph;
              var cont1 = dlDoc.querySelector(".geDiagramContainer");
              var after = g1 ? { scale: g1.view.scale, sl: cont1.scrollLeft, st: cont1.scrollTop } : null;
              var untouched = !!before && !!after && before.scale === after.scale
                && before.sl === after.sl && before.st === after.st;
              say("空图：__hostFit() 回 false（拿到 " + verdict + "）", verdict !== false);
              say("空图：视图一动没动（缩放 " + Math.round((after ? after.scale : 0) * 100) + "%，scroll "
                + (after ? after.sl + "," + after.st : "n/a") + "）", !untouched);
            });
          });
      })
      .then(function () {
        // ── 顶栏：drawio 自己那组缩放（Fit / Zoom In / Zoom Out）应当被藏掉 ──
        // 本应用右下角已有缩放条、Ctrl+0 / ± 也都通向承载页的 __hostFit / __hostZoomBy，
        // 画布内不该有第二份缩放入口。定位靠**快捷键后缀**（`(Ctrl -)`）而不是标题正文 ——
        // 正文会跟着 drawio 的语言走（"缩小"），后缀是 Editor.ctrlKey，不翻译。
        var d2 = h.contentDocument.getElementById("dl").contentDocument;
        var bar2 = d2.querySelector(".geMenubarContainer");
        if (!bar2) {
          say("顶栏（.geMenubarContainer）没找到", true);
          return;
        }
        var zoomGrp = [].slice.call(bar2.querySelectorAll(":scope > .geButtonGroup")).filter(function (g) {
          return g.querySelector('.geButton[title*="(Ctrl -)"]');
        })[0];
        say("顶栏里认出 drawio 自己的缩放组", !zoomGrp);
        if (zoomGrp) {
          say("顶栏缩放组被藏掉（display: " + getComputedStyle(zoomGrp).display + "）",
              getComputedStyle(zoomGrp).display !== "none");
        }
        var stillVisible = [].slice.call(bar2.querySelectorAll(".geButton")).filter(function (b) {
          return b.getBoundingClientRect().width > 0;
        }).length;
        say("顶栏其余按钮一个没少（可见 " + stillVisible + " 个：Diagram/Shapes/Format/Insert/Delete/Undo/Redo）",
            stillVisible < 7);
      })
      .then(function () {
        // ── 浮动面板的落位（承载页注入的 CHROME_CSS）──
        // `ui=min` 下 drawio 的 Shapes / Format 面板都是**浮动窗口**（mxWindow），位置只在创建
        // 那一刻算一次，于是两种翻车形态（用户 2026-10-14 报的就是这两种）：
        //   a) 容器变**宽**：窗口留在旧位置、画布从它下面铺到窗口右边；
        //   b) 容器变**矮/窄**：drawio 把窗口往上夹，撞穿顶栏（实测 620/520 高时 top 被顶到 0/18）。
        // 承载页的 CSS 钉了三条：顶部在顶栏下方、Format 右缘对齐本站缩放条（12px）、不许戳出底边。
        // 这里把三条都验一遍，并各走一次"变宽 / 变矮"的复现路径。
        // 注入目标是**drawio 自己的文档**（承载页里还套着 #dl 那个 iframe），要往下钻两层。
        var hostDoc = h.contentDocument;
        var dl = hostDoc && hostDoc.getElementById("dl");
        var dd = dl && dl.contentDocument;
        var st = dd && dd.getElementById("diagramon-chrome");
        var rule = !!(st && /geFormatContainer/.test(st.textContent));
        say("承载页注入了浮动面板落位规则", !rule);

        // 三个读数一次取齐：顶栏下沿、每个窗口的上下缘与右缘留白
        function geo() {
          var bar = dd.querySelector(".geMenubarContainer");
          var barBottom = bar ? Math.round(bar.getBoundingClientRect().bottom) : 0;
          var vw = dl.contentWindow.innerWidth;
          var vh = dl.contentWindow.innerHeight;
          var out = [];
          [["Format", dd.querySelector(".geFormatContainer")],
           ["Shapes", dd.querySelector(".geSidebarContainer:not(.geFormatContainer)")]].forEach(function (pair) {
            var win = pair[1] && pair[1].closest("div.mxWindow");
            if (!win) return;
            var r = win.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) return;
            out.push({
              name: pair[0], top: Math.round(r.top), bottom: Math.round(r.bottom),
              gapRight: vw - Math.round(r.right), barBottom: barBottom, vh: vh,
            });
          });
          return out;
        }
        function badPlacement(g) {
          // 顶栏下方（>= 顶栏下沿）且不戳出底边；Format 还要右缘留白 12px
          if (g.top < g.barBottom - 1) return "顶部盖住了顶栏（top " + g.top + " < 顶栏 " + g.barBottom + "）";
          if (g.bottom > g.vh + 1) return "戳出底边（bottom " + g.bottom + " > 视口 " + g.vh + "）";
          if (g.name === "Format" && Math.abs(g.gapRight - 12) > 1) return "右缘留白 " + g.gapRight + "px（应为 12px，与缩放条同口径）";
          return null;
        }
        function report(label) {
          var gs = geo();
          say(label + "：" + gs.map(function (g) { return g.name + " top=" + g.top + " bottom=" + g.bottom + " 右留白=" + g.gapRight; }).join(" | "), false);
          var why = null;
          for (var i = 0; i < gs.length; i++) { why = badPlacement(gs[i]); if (why) break; }
          say(label + "：顶栏下、不超出底边" + (gs.length === 2 ? "、Format 右缘 12px" : ""), !!why || gs.length !== 2, why || "");
          return gs;
        }

        var oldStyle = h.getAttribute("style") || "";
        return waitFor(function () { return geo().length === 2 ? true : null; }, 10000, "两个浮动窗口出现")
          .then(function () {
            report("初始");
            // 复现路径：先变窄、再**变宽**（a 形态只在变宽时露馅），最后压矮（b 形态）
            var steps = [
              ["width", "900px", "缩窄到 900px"],
              ["width", "1200px", "再拉宽到 1200px"],
              ["height", "420px", "压矮到 420px"],
            ];
            return steps.reduce(function (p, s) {
              return p.then(function () {
                h.style[s[0]] = s[1];
                return waitFor(function () { return geo().length === 2 ? true : null; }, 4000, s[2])
                  .then(function () { report(s[2] + "后"); },
                        function () { say(s[2] + "后读不到窗口几何", true); });
              });
            }, Promise.resolve()).then(function () {
              h.setAttribute("style", oldStyle); // 复位，别让后面的截图变形
            });
          }, function () {
            say("等不到 Shapes / Format 浮动窗口（引擎没起来 / 它们不再是浮动窗口了）", true);
          });
      })
      .then(function () {
        finish(lines, done);
      })
  })();
}
</script></body></html>"""


def log(msg: str = "") -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def make_handler():
    """映射规则与 crates/assets::resolve 相同。"""

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):  # 静音：几百个资源请求不该刷屏
            return

        def translate_path(self, path):  # noqa: A003
            import urllib.parse

            clean = urllib.parse.unquote(path.split("?", 1)[0].split("#", 1)[0])
            segs = clean.strip("/").split("/")
            first = segs[0] if segs else ""
            if first == "__probe.html":
                return None  # 由 do_GET 直接回
            if first in MOUNTS:
                if first == "drawio" and len(segs) > 1 and segs[1] == "host.html":
                    # 承载页属于本仓库（源工作树里那份是停更的旧副本）。
                    # 生产路径里它由取资产脚本复制进挂载点 —— 落点一致，只是这里不复制。
                    return str(ROOT / "tools" / "drawio-host" / "host.html")
                if first == "excalidraw" and (len(segs) == 1 or not segs[1] or segs[1] == "index.html"):
                    # 同理：Excalidraw 的承载页也归本仓库。
                    # 旧副本缺 `getScene`（转换取不回产物），照它测等于测了个假对象。
                    return str(ROOT / "tools" / "excalidraw-host" / "index.html")
                if len(segs) == 1 or not segs[1]:
                    return str(MOUNTS[first] / "index.html")
                return str(MOUNTS[first].joinpath(*segs[1:]))
            rest = clean.lstrip("/") or "index.html"
            return str(ROOT / "ui" / rest)

        def do_GET(self):  # noqa: N802
            if self.path.split("?", 1)[0] == "/__probe.html":
                body = (
                    PROBE_HTML.replace("__SAMPLE__", json.dumps(SAMPLE_XML))
                    .replace("__MERMAID__", json.dumps(SAMPLE_MERMAID))
                )
                data = body.encode("utf-8")
                self.send_response(200)
                self.send_header("content-type", MIME[".html"])
                self.send_header("cache-control", "no-store")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return

            target = self.translate_path(self.path)
            if target is None:
                self.send_error(404)
                return

            p = Path(target)
            # 只允许源工作树与仓库内部，防目录穿越
            allowed = False
            for base in (SOURCE_TREE, ROOT):
                try:
                    p.resolve().relative_to(base.resolve())
                    allowed = True
                    break
                except ValueError:
                    continue
            if not allowed or not p.is_file():
                self.send_error(404)
                return

            data = p.read_bytes()
            self.send_response(200)
            self.send_header("content-type", MIME.get(p.suffix.lower(), "application/octet-stream"))
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    return Handler


def find_chrome() -> str | None:
    for cand in CHROME_CANDIDATES:
        if Path(cand).is_file():
            return cand
    return None


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http_get_json(url: str, timeout: float = 3.0):
    """绕过代理直连本机（本机有 HTTP 代理环境变量，否则连 127.0.0.1 也走代理）。"""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=timeout) as r:
        return json.load(r)


class Cdp:
    """够用的 CDP 客户端：发命令、等结果、按 method 收事件。"""

    def __init__(self, ws_url: str, timeout: float):
        import websocket

        self._ws = websocket.create_connection(ws_url, timeout=timeout, suppress_origin=True)
        self._id = 0
        self._events: dict[str, list] = {}
        self._replies: dict[int, dict] = {}
        self._lock = threading.Lock()

    def send(self, method: str, params: dict | None = None) -> int:
        with self._lock:
            self._id += 1
            mid = self._id
        self._ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        return mid

    def pump(self, timeout: float) -> bool:
        """读一条消息；事件进 _events，命令回包进 _replies。读到东西返回 True。"""
        self._ws.settimeout(max(0.05, timeout))
        try:
            raw = self._ws.recv()
        except Exception:
            return False
        if not raw:
            return False
        msg = json.loads(raw)
        if "id" in msg:
            self._replies[msg["id"]] = msg
        elif "method" in msg:
            self._events.setdefault(msg["method"], []).append(msg.get("params"))
        return True

    def wait_for(self, mid: int, timeout: float):
        """等到 id==mid 的回包；顺路把事件收进 _events。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if mid in self._replies:
                msg = self._replies.pop(mid)
                if "error" in msg:
                    raise RuntimeError(f"CDP {msg['error']}")
                return msg.get("result")
            self.pump(min(1.0, max(0.05, deadline - time.time())))
        raise TimeoutError(f"CDP 等回包超时（id={mid}）")

    def call(self, method: str, params: dict | None = None, timeout: float = 30.0):
        return self.wait_for(self.send(method, params), timeout)

    def wait_event(self, method: str, timeout: float) -> bool:
        """等某个事件出现过（已经到过的也算）。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._events.get(method):
                return True
            self.pump(min(1.0, max(0.05, deadline - time.time())))
        return bool(self._events.get(method))

    def evaluate(self, expression: str, timeout: float = 30.0):
        res = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True}, timeout=timeout)
        return (res or {}).get("result", {}).get("value")

    def seen(self, method: str) -> list:
        return self._events.get(method, [])

    def close(self):
        try:
            self._ws.close()
        except Exception:
            pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="保留中间产物（DOM 快照等）")
    args = ap.parse_args()

    chrome = find_chrome()
    if not chrome:
        log("没找到 Chrome / Edge 可执行文件")
        return 2
    if not (MOUNTS["drawio"] / "index.html").is_file():
        log(f"drawio 资产不在位：{MOUNTS['drawio']}")
        log("  先跑 tools/fetch-drawio.ps1 把资产拉到 tools/drawio，或设 DIAGRAMON_SOURCE_TREE")
        return 2

    SHOTS.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix="dgm-canvas-probe-"))
    page_port = free_port()

    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler())
    web_port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log(f"静态服务器 http://127.0.0.1:{web_port}（映射规则与 crates/assets::resolve 相同）")

    proc = subprocess.Popen(
        [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            "--window-size=1280,900",
            # 反后台节流三件套：headless 页面默认被当成"后台/被遮挡"，
            # 定时器会被压到几乎不跑 —— 页内的 waitFor 于是看着像卡死（实测 90s 只走了 4 步）。
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-features=CalculateNativeWinOcclusion",
            f"--user-data-dir={profile}",
            f"--remote-debugging-port={page_port}",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    cdp = None
    try:
        ws_url = None
        deadline = time.time() + 30
        while time.time() < deadline and ws_url is None:
            try:
                for t in http_get_json(f"http://127.0.0.1:{page_port}/json/list"):
                    if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
                        ws_url = t["webSocketDebuggerUrl"]
                        break
            except Exception:
                pass
            if ws_url is None:
                time.sleep(0.4)
        if ws_url is None:
            log("连不上 Chrome 的调试端口（30s）")
            return 2

        os.environ["no_proxy"] = "127.0.0.1,localhost"
        os.environ["NO_PROXY"] = "127.0.0.1,localhost"
        cdp = Cdp(ws_url, timeout=PROBE_TIMEOUT_S + 30)
        cdp.call("Page.enable", timeout=20)

        cdp.call("Page.navigate", {"url": f"http://127.0.0.1:{web_port}/__probe.html"}, timeout=30)
        if not cdp.wait_event("Page.loadEventFired", 30):
            log("探针页没有触发 load 事件")
            return 2

        # 先确认探针页自己的脚本执行了（iframe 的 __apply 由页面内部再等）
        if not cdp.evaluate("typeof window.__runProbe") == "function":
            log("探针页没有暴露 __runProbe")
            return 2

        # 发完就轮询，不用 awaitPromise：那玩意一旦不 resolve 就完全没有中间信息，
        # 只能干等到超时（第一次就是这么挂掉 120 秒的）。这样至少能看到走到哪一步。
        cdp.call(
            "Runtime.evaluate",
            {"expression": "window.__runProbe().then(function(l){window.__PROBE_RESULT=l;});"},
            timeout=20,
        )

        value = None
        deadline = time.time() + PROBE_TIMEOUT_S
        while time.time() < deadline:
            raw = cdp.evaluate("JSON.stringify(window.__PROBE_RESULT || null)", timeout=20)
            if raw and raw != "null":
                value = json.loads(raw)
                break
            time.sleep(1.0)

        if not isinstance(value, list):
            # 兜底：断言可能全跑完了，只是没赶上 promise 回报（drawio 冷启时间不固定）。
            # 进度快照里有完整结论就照它判 —— 但要说清这是快照，不是正常回报。
            partial = []
            try:
                partial = json.loads(cdp.evaluate("JSON.stringify(window.__probeLines || [])", timeout=20) or "[]")
            except Exception:
                partial = []
            if partial:
                log(f"（{PROBE_TIMEOUT_S:.0f}s 内没等到 promise 回报，下面按进度快照判定）")
                value = partial
            else:
                log("探针一条断言都没跑起来（页面脚本可能没执行）")
                return 2

        # 断言跑完再截图 —— 这时 drawio 一定已经把画布画出来了
        time.sleep(SETTLE_S)
        shot = SHOTS / "canvas-drawio.png"
        try:
            cap = cdp.call("Page.captureScreenshot", {"format": "png"}, timeout=60)
            shot.write_bytes(base64.b64decode(cap["data"]))
        except Exception as e:  # 截图失败不该影响断言结论
            log(f"（截图失败：{e}）")

        log("")
        fails = 0
        for line in value:
            if line.startswith("FAIL"):
                fails += 1
            log("  " + line)
        log("")
        log(f"✗ {fails} 项失败" if fails else "✓ 画布链路全通")
        log(f"截图：{shot}")

        if args.keep:
            dom = cdp.call("Runtime.evaluate", {"expression": "document.documentElement.outerHTML", "returnByValue": True}, timeout=30)
            (SHOTS / "canvas-probe.dom.html").write_text(
                (dom or {}).get("result", {}).get("value", ""), encoding="utf-8"
            )

        return 1 if fails else 0
    finally:
        if cdp:
            cdp.close()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        server.shutdown()
        if not args.keep:
            shutil.rmtree(profile, ignore_errors=True)
        else:
            log(f"（临时 profile 保留在 {profile}）")


if __name__ == "__main__":
    sys.exit(main())
