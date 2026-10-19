#!/usr/bin/env python
"""Excalidraw 承载探针：验证「mermaid → Excalidraw / 打开含图片文档」这条链真的通。

    python tools/dev/excalidraw_probe.py

## 它验什么（五个用例都走真实承载页，不 mock）

| 用例 | 断言 | 对应过的 bug |
|---|---|---|
| A 正常图 | 元素 id **就是 mermaid 节点 id**（`A` / `B` 在列） | 入口用 `regenerateIds: true` 把语义锚点换成了随机串 |
| B subgraph | 退化成单个 `image` 时，**位图的 fileId 必须能解析到文件** | 入口丢 `parsed.files` ⇒ 画布上是一块悬空 fileId 的空图 |
| C 带图片文档 | `setScene` 的 files 进画布、也能被 `getScene` 带回来 | 承载页只给 elements ⇒ 打开含图片的 `.excalidraw` 渲染不出图片（与 mermaid 无关） |
| D 换文档 | 再 `setScene` 一份无附件文档后，回报的 files **必须为空** | 附件按格式常驻单例 ⇒ 上一份文档的图片被写进新文档正文 |
| F look 透传 | `loadMermaid` 消息带的 `mermaid` 配置**真的进 m2e**（`{look:'handDrawn'}`）且照常出元素 | 转换沿用文档外观的配置链（2026-10-19）；断链时静默回退默认样式 |

## 为什么要单独一个探针（而不是并进 canvas_probe）

`canvas_probe.py` 测的是 drawio 那套 `__hostQueue` / `__apply` 协议，且**指向源工作树**；
这条链要测的是**汇出后的产物**（`assets/excalidraw/`）—— B5 那类"改了承载页但没进产物"
只有在产物上跑才暴露得出来。所以本脚本默认读 `assets/`，并在开跑前比对一次
`assets/excalidraw/index.html` 与源 `tools/excalidraw-host/index.html`。

依赖：本机 Chrome / Edge；`websocket-client`；**先跑过 `node tools/fetch-assets.mjs`**。

## 踩过的坑（别再改回去）

1. **静态服务器必须给对 MIME**：全用 `application/octet-stream` 时 Chrome 把承载页当下载，
   `Page.navigate` 返回 `ERR_ABORTED`、页面停在 `about:blank`，看起来像"引擎起不来"。
2. **本机有 HTTP 代理**，`127.0.0.1` 必须显式绕过（`no_proxy` + 空 ProxyHandler）。
3. `updateScene({files})` **不生效** —— Excalidraw 的 API 层只认 elements/appState，
   附件得走 `api.addFiles()`。承载页已按此实现；这条断言就是它的回归闸门。
"""
from __future__ import annotations

import argparse
import json
import os
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
ASSETS = ROOT / "assets"

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]

# 必须给对 MIME：见文件头"坑 1"
MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json",
    ".wasm": "application/wasm", ".woff2": "font/woff2", ".woff": "font/woff",
    ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png",
    ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
}

# 1x1 透明 PNG（真图；只有签名的半截 base64 会让画布解码失败、污染结论）
PNG_1PX = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
           "AAAADUlEQVR42mP8z8AAAwAB/AGtE1wqAAAAAElFTkSuQmCC")

SESSION = [
    {"name": "A 正常图 · id 保留", "src": "flowchart TD\n    A --> B\n"},
    {"name": "B subgraph · 位图兜底", "src": "flowchart TD\n    A --> B\n    subgraph 分组\n        B\n    end\n"},
]

EXPR = """
(async () => {
  const SESSION = __SESSION__;
  const PNG = __PNG__;

  // 等 Excalidraw 就绪。给上限：不设的话引擎真起不来时会一直挂到 CDP 超时，
  // 现场只剩一句 TimeoutError，分不清是"慢"还是"死"。
  await new Promise(function (resolve, reject) {
    const t0 = Date.now();
    const i = setInterval(function () {
      if (window.ExcalidrawApp && window.ExcalidrawApp.ready) { clearInterval(i); resolve(); }
      else if (Date.now() - t0 > 90000) { clearInterval(i); reject(new Error('ExcalidrawApp 90s 内没就绪')); }
    }, 100);
  });

  const out = { apiHasGetFiles: typeof (window.__excalidrawApi || {}).getFiles, cases: [] };

  function apply(msg) { window.__apply(JSON.stringify(msg)); }

  function clearQueue() { if (Array.isArray(window.__hostQueue)) { window.__hostQueue.length = 0; } }

  function waitEvent(evt, timeout) {
    return new Promise(function (resolve) {
      const t0 = Date.now();
      (function tick() {
        const q = window.__hostQueue || [];
        for (let i = 0; i < q.length; i++) {
          let m; try { m = JSON.parse(q[i]); } catch (e) { continue; }
          if (m.event === evt) { q.splice(i, 1); return resolve(m); }
        }
        if (Date.now() - t0 > (timeout || 20000)) return resolve(null);
        setTimeout(tick, 150);
      })();
    });
  }

  function scene() {
    clearQueue();
    let ret = null, thrown = null;
    try { ret = window.__apply(JSON.stringify({ action: 'getScene' })); }
    catch (e) { thrown = String((e && e.message) || e); }
    return waitEvent('scene', 15000).then(function (m) {
      return {
        msg: m,
        diag: {
          applyRet: ret,
          applyThrew: thrown,
          queueLen: (window.__hostQueue || []).length,
          queueAfter: (window.__hostQueue || []).map(function (s) { return String(s).slice(0, 160); }),
        },
      };
    });
  }

  function summarise(msg) {
    const els = (msg && msg.elements) || [];
    const files = (msg && msg.files) || {};
    const fileIds = Object.keys(files);
    const imageEls = els.filter(function (e) { return e.type === 'image'; });
    // 直读画布（绕过事件通道）：把"事件没带"和"画布本来就是空的"分开报
    let directEls = -1, directFiles = -1, directErr = null;
    try {
      directEls = (window.__excalidrawApi.getSceneElements() || []).length;
      directFiles = Object.keys(window.__excalidrawApi.getFiles() || {}).length;
    } catch (e) { directErr = String(e && e.message || e); }
    return {
      count: els.length,
      types: els.map(function (e) { return e.type; }),
      ids: els.map(function (e) { return e.id; }),
      texts: els.filter(function (e) { return e.type === 'text'; }).map(function (e) { return e.text; }),
      fileIds: fileIds,
      imageFileIds: imageEls.map(function (e) { return e.fileId; }),
      // 关键断言：每个图片元素的 fileId 都能在 files 里找到 → 位图真的到了画布上
      imagesResolved: imageEls.length > 0 && imageEls.every(function (e) { return !!files[e.fileId]; }),
      bytes: fileIds.reduce(function (a, k) { return a + String((files[k] || {}).dataURL || '').length; }, 0),
      directEls: directEls,
      directFiles: directFiles,
      directErr: directErr,
    };
  }

  // ---- A / B：走 loadMermaid（应用里"转换到 Excalidraw"用的就是这条） ----
  for (const c of SESSION) {
    clearQueue();
    apply({ action: 'loadMermaid', source: c.src });
    const loaded = await waitEvent('loaded', 30000);
    const sc = await scene();
    out.diag = out.diag || [];
    out.diag.push({ at: c.name, diag: sc.diag });
    const s = summarise(sc.msg);
    s.name = c.name;
    s.loaded = !!loaded;
    s.loadedCount = loaded ? loaded.count : null;
    s.loadedRaw = loaded ? JSON.stringify(loaded).slice(0, 300) : null;
    out.cases.push(s);
  }

  // ---- C：setScene 一份带图片的文档（模拟打开含图片的 .excalidraw） ----
  const imgEl = {
    id: 'img1', type: 'image', x: 0, y: 0, width: 40, height: 40, angle: 0,
    strokeColor: 'transparent', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [],
    frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1,
    isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
    status: 'saved', fileId: 'img1', scale: [1, 1],
  };
  const files = {};
  files['img1'] = { id: 'img1', mimeType: 'image/png', dataURL: PNG,
                    created: 1, lastRetrieved: 1 };
  const withImg = {
    type: 'excalidraw', version: 2, elements: [imgEl], appState: { viewBackgroundColor: '#ffffff' },
    files: files,
  };
  clearQueue();
  apply({ action: 'setScene', scene: JSON.stringify(withImg) });
  await new Promise(function (r) { setTimeout(r, 1500); });
  const sc1 = await scene();
  (out.diag = out.diag || []).push({ at: 'C', diag: sc1.diag });
  const c1 = summarise(sc1.msg);
  c1.name = 'C setScene 带图片';
  out.cases.push(c1);

  // ---- D：再 setScene 一份**没有**附件的文档 → files 必须清空 ----
  clearQueue();
  apply({ action: 'setScene', scene: JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} }) });
  await new Promise(function (r) { setTimeout(r, 1500); });
  const sc2 = await scene();
  (out.diag = out.diag || []).push({ at: 'D', diag: sc2.diag });
  const d = summarise(sc2.msg);
  d.name = 'D setScene 无附件 · 不泄漏';
  out.cases.push(d);

  // ---- F：loadMermaid 带 mermaid 配置（文档级外观沿用，2026-10-19）----
  // 外壳的「转换沿用渲染配置」链路：dialogs.convertViaEngine → canvas.loadMermaid →
  // 这里。配置平铺进 m2e 内置 mermaid 的 initialize（parseMermaidToExcalidraw(e, t) 里
  // `n = {...Ix, ...t}`），所以包一层 ExcalidrawMermaid 记录它实际收到的 cfg，再验证
  // 配置下转换照常出元素 —— 「发了就算」不算数，要看到引擎真的吃到了。
  const m2eWrap = { got: null, wrapped: false };
  if (window.ExcalidrawMermaid && typeof window.ExcalidrawMermaid.parseMermaidToExcalidraw === 'function') {
    const origParse = window.ExcalidrawMermaid.parseMermaidToExcalidraw;
    window.ExcalidrawMermaid.parseMermaidToExcalidraw = function (def, cfg) {
      m2eWrap.got = cfg || null;
      return origParse.call(window.ExcalidrawMermaid, def, cfg);
    };
    m2eWrap.wrapped = true;
  }
  clearQueue();
  apply({ action: 'loadMermaid', source: SESSION[0].src, mermaid: { look: 'handDrawn' } });
  const loadedF = await waitEvent('loaded', 30000);
  const scF = await scene();
  (out.diag = out.diag || []).push({ at: 'F', diag: scF.diag });
  const f = summarise(scF.msg);
  f.name = 'F loadMermaid 带 look 配置';
  f.loaded = !!loadedF;
  f.cfgGot = m2eWrap.got;
  f.cfgWrapped = m2eWrap.wrapped;
  out.cases.push(f);

  // ---- E：window.__hostFit（应用级「适应视图」的落点）----
  // 承载页只暴露 __hostZoom / __hostZoomBy 时，应用的两个「适应视图」入口
  // （Ctrl+0 的画布分支、工具条 / 双击画布）都是**静默无效**的。这里把新加的钩子钉住：
  // 有内容 ⇒ true 且视口真把内容全包进来（居中）；空文档 ⇒ false 且视口一动不动。
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function viewState() {
    const st = (window.__excalidrawApi && window.__excalidrawApi.getAppState()) || {};
    return {
      zoom: st.zoom && Number(st.zoom.value) > 0 ? Number(st.zoom.value) : 1,
      scrollX: Number(st.scrollX) || 0,
      scrollY: Number(st.scrollY) || 0,
      width: Number(st.width) || 0,
      height: Number(st.height) || 0,
    };
  }

  // 元素在**视口像素坐标**里的包围盒：screen = (scene + scroll) * zoom（Excalidraw 自己的换算式）。
  function contentBoxes() {
    const view = viewState();
    const els = (window.__excalidrawApi.getSceneElements() || [])
      .filter(function (e) { return e && !e.isDeleted; });
    const boxes = els.map(function (e) {
      return {
        l: (e.x + view.scrollX) * view.zoom, t: (e.y + view.scrollY) * view.zoom,
        r: (e.x + e.width + view.scrollX) * view.zoom,
        b: (e.y + e.height + view.scrollY) * view.zoom,
      };
    });
    if (!boxes.length) { return null; }
    const l = Math.min.apply(null, boxes.map(function (b) { return b.l; }));
    const t = Math.min.apply(null, boxes.map(function (b) { return b.t; }));
    const r = Math.max.apply(null, boxes.map(function (b) { return b.r; }));
    const b = Math.max.apply(null, boxes.map(function (b2) { return b2.b; }));
    return {
      count: boxes.length, view: view,
      left: l, right: view.width - r, top: t, bottom: view.height - b,
      centerDx: (l - (view.width - r)) / 2, centerDy: (t - (view.height - b)) / 2,
    };
  }

  const fit = { hasHostFit: typeof window.__hostFit === 'function' };
  {
    function elt(id, x, y, w, h) {
      return {
        id: id, type: 'rectangle', x: x, y: y, width: w, height: h, angle: 0,
        strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
        strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [],
        frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1,
        isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
      };
    }
    const spread = [elt('f1', 0, 0, 200, 100), elt('f2', 1400, 0, 200, 100),
                    elt('f3', 0, 900, 200, 100), elt('f4', 1400, 900, 200, 100)];
    apply({ action: 'setScene', scene: JSON.stringify({ type: 'excalidraw', version: 2, elements: spread, appState: {}, files: {} }) });
    await sleep(1600);
    // 先把视口踢到一个看不到内容的地方 —— 这样"适应之后都进来了"才是真的动了视口
    window.__excalidrawApi.updateScene({ appState: { zoom: { value: 0.2 }, scrollX: 0, scrollY: 0 } });
    await sleep(500);
    fit.before = viewState();
    fit.beforeBoxes = contentBoxes();
    fit.contentVerdict = window.__hostFit();
    await sleep(800);
    fit.after = viewState();
    fit.content = contentBoxes();
    fit.moved = JSON.stringify(fit.before) !== JSON.stringify(fit.after);

    // 空文档：没有内容可适配 ⇒ false，且视图不动（归一由 ensureViewportVisible 负责）
    apply({ action: 'setScene', scene: JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} }) });
    await sleep(1600);
    const e0 = viewState();
    fit.emptyVerdict = window.__hostFit();
    await sleep(400);
    const e1 = viewState();
    fit.emptyView = e1;
    fit.emptyUntouched = JSON.stringify(e0) === JSON.stringify(e1);
  }
  out.fit = fit;

  return JSON.stringify(out);
})().catch(function (e) {
  return JSON.stringify({ fatal: String((e && e.stack) || e) });
})
""".replace("__SESSION__", json.dumps(SESSION)).replace("__PNG__", json.dumps(PNG_1PX))


def log(msg: str = "") -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


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


def make_handler():
    """映射规则与 crates/assets::resolve 相同：挂载点前缀走挂载目录，其余走 ui/。"""

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            return

        def do_GET(self):  # noqa: N802
            import urllib.parse

            clean = urllib.parse.unquote(self.path.split("?", 1)[0].split("#", 1)[0])
            p = ASSETS / clean.lstrip("/")
            if p.is_dir():
                p = p / "index.html"
            if not p.is_file():
                self.send_error(404)
                return
            data = p.read_bytes()
            self.send_response(200)
            self.send_header("content-type", MIME.get(p.suffix.lower(), "application/octet-stream"))
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    return Handler


def preflight() -> int:
    """返回 0 = 可以开跑；非 0 = 环境缺件（不拦验收，但要说明装什么）。"""
    page = ASSETS / "excalidraw" / "index.html"
    if not page.is_file():
        log(f"Excalidraw 产物不在位：{page}")
        log("  先跑 node tools/fetch-assets.mjs（它从 tools/ 汇出 assets/）")
        return 2
    src = ROOT / "tools" / "excalidraw-host" / "index.html"
    if src.is_file() and src.read_bytes() != page.read_bytes():
        # 这一条正是 B5 的回归闸门：改了承载页却没汇出，测出来的就是一份不存在的产品
        log(f"承载页不一致：{page} 与源 {src} 不同")
        log("  先跑 node tools/fetch-assets.mjs（prepack 也有同样的闸门）")
        return 2
    return 0


def main() -> int:
    try:
        import websocket  # noqa: F401
    except ImportError:
        log("缺少 websocket-client：<python> -m pip install websocket-client")
        return 2

    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(SHOTS / "excalidraw-probe.json"),
                    help="结论落盘位置（默认 ui/.shots/excalidraw-probe.json，prepack 会清）")
    args = ap.parse_args()

    code = preflight()
    if code:
        return code
    chrome = find_chrome()
    if not chrome:
        log("没找到 Chrome / Edge 可执行文件")
        return 2

    import websocket

    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler())
    web = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    page_port = free_port()
    profile = Path(tempfile.mkdtemp(prefix="dgm-excalidraw-probe-"))
    log(f"静态服务器 http://127.0.0.1:{web}（映射规则与 crates/assets::resolve 相同）")

    proc = subprocess.Popen(
        [chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         "--window-size=1400,900",
         "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
         "--disable-renderer-backgrounding", "--disable-features=CalculateNativeWinOcclusion",
         f"--user-data-dir={profile}", f"--remote-debugging-port={page_port}", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

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
        log("连不上 CDP 端口")
        proc.terminate()
        server.shutdown()
        return 2

    os.environ["no_proxy"] = "127.0.0.1,localhost"
    os.environ["NO_PROXY"] = "127.0.0.1,localhost"
    ws = websocket.create_connection(ws_url, timeout=300, suppress_origin=True)
    seq = [0]

    def call(method, params=None, timeout=120):
        seq[0] += 1
        mid = seq[0]
        ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        end = time.time() + timeout
        while time.time() < end:
            msg = json.loads(ws.recv())
            if msg.get("id") == mid:
                return msg.get("result", {})
        raise TimeoutError(method)

    failures: list[str] = []
    try:
        call("Page.enable")
        call("Runtime.enable")
        call("Page.navigate", {"url": f"http://127.0.0.1:{web}/excalidraw/index.html?lang=zh-CN"})

        def ev(expr, timeout=30):
            r = call("Runtime.evaluate", {"expression": expr, "returnByValue": True}, timeout=timeout)
            return r.get("result", {}).get("value")

        # 等 bundle 起来（ExcalidrawApp 是承载页挂到 window 上的入口）
        ok = False
        end = time.time() + 120
        while time.time() < end:
            if ev("typeof window.ExcalidrawApp && typeof window.ExcalidrawApp.mount") == "function":
                ok = True
                break
            time.sleep(2)
        if not ok:
            log("ExcalidrawApp 没出现（bundle 加载失败？看 assets/excalidraw/app.js 在不在）")
            return 2

        r = call("Runtime.evaluate",
                 {"expression": EXPR, "returnByValue": True, "awaitPromise": True}, timeout=300)
        if "exceptionDetails" in r:
            log("页面异常：" + json.dumps(r["exceptionDetails"], ensure_ascii=False)[:1200])
            return 1
        data = json.loads(r["result"]["value"])

        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

        if data.get("fatal"):
            log("致命：" + str(data["fatal"])[:800])
            return 1

        log(f"api.getFiles 可见: {data.get('apiHasGetFiles')}")
        for d in data.get("diag") or []:
            log(f"DIAG {d['at']} " + json.dumps(d["diag"], ensure_ascii=False)[:700])
        for c in data.get("cases") or []:
            log("-" * 66)
            log(f"{c['name']} | 元素 {c['count']} {c['types']} | loaded {c.get('loaded')}")
            log(f"   id: {c['ids']}")
            log(f"   文本: {c['texts']}")
            log(f"   files: {c['fileIds']} | 图片 fileId: {c['imageFileIds']}"
                f" | 全部解析: {c['imagesResolved']} | 字节 {c['bytes']}")
            log(f"   直读画布: elements={c.get('directEls')} files={c.get('directFiles')}"
                f" | loadedCount={c.get('loadedCount')} | err={c.get('directErr') or ''}")
            if c["name"].startswith("D") and c.get("directFiles"):
                # 别把这一行当成"没清干净"：`addFiles` 是合并语义、没有公开的清空入口，
                # 所以画布**内存**里可能还留着上一份的附件；关键是回报给宿主的 files 为空
                # （承载页只报元素真正引用到的附件），落盘正文因此不会带上它们。
                log(f"（直读 files={c['directFiles']} 属预期：画布内存未清，但回报为空即正确）")

        by = {c["name"]: c for c in data.get("cases") or []}

        a = by.get("A 正常图 · id 保留")
        if not a or a["count"] < 5:
            failures.append("A：正常图没产出预期元素数")
        elif "A" not in a["ids"] or "B" not in a["ids"]:
            failures.append(f"A：上游 id 没保留（拿到 {a['ids']}）")

        b = by.get("B subgraph · 位图兜底")
        if not b:
            failures.append("B：用例缺失")
        elif b["types"] != ["image"]:
            failures.append(f"B：预期退化成单个 image，实际 {b['types']}（上游可能已支持 subgraph，请更新断言）")
        elif not b["imagesResolved"]:
            failures.append(f"B：位图 fileId 解析不到文件（files={b['fileIds']}，元素要的是 {b['imageFileIds']}）")
        elif b["bytes"] < 100:
            failures.append(f"B：位图字节过少（{b['bytes']}），像是空的")

        c1 = by.get("C setScene 带图片")
        if not c1 or "img1" not in c1["fileIds"]:
            failures.append(f"C：setScene 带的附件没进画布（files={c1 and c1['fileIds']}）")

        d = by.get("D setScene 无附件 · 不泄漏")
        if not d or d["fileIds"]:
            failures.append(f"D：换文档后 files 没清空（files={d and d['fileIds']}）")

        # ── E：应用级「适应视图」的落点（window.__hostFit）──
        fit = data.get("fit") or {}

        def round1(v):
            try:
                return round(float(v), 1)
            except Exception:
                return v

        if not fit.get("hasHostFit"):
            failures.append("E：承载页没暴露 __hostFit（画布上的「适应视图」会静默无效）")
        else:
            if fit.get("contentVerdict") is not True:
                failures.append(f"E：有内容时 __hostFit() 应回 true，实际 {fit.get('contentVerdict')!r}")
            if not fit.get("moved"):
                failures.append(f"E：__hostFit() 没改动视口（前 {fit.get('before')} 后 {fit.get('after')}）")
            boxes = fit.get("content") or None
            if not boxes or boxes.get("count", 0) < 4:
                failures.append(f"E：适应之后读不到内容包围盒（{boxes}）")
            else:
                tol = 2
                gaps = {k: boxes[k] for k in ("left", "right", "top", "bottom")}
                if any(float(v) < -tol for v in gaps.values()):
                    failures.append(f"E：适应之后还有内容在视口外（留白 {gaps}，视口 {boxes.get('view')}）")
                if abs(boxes["centerDx"]) > 3 or abs(boxes["centerDy"]) > 3:
                    failures.append(f"E：内容没居中（偏移 {round1(boxes['centerDx'])}/{round1(boxes['centerDy'])}px）")
            if fit.get("emptyVerdict") is not False:
                failures.append(f"E：空文档时 __hostFit() 应回 false，实际 {fit.get('emptyVerdict')!r}")
            if not fit.get("emptyUntouched"):
                failures.append(f"E：空文档时视图被动了（{fit.get('emptyView')}）")

        # ── F：loadMermaid 带 look 配置（外壳 → 引擎的配置链）──
        f_case = by.get("F loadMermaid 带 look 配置")
        if not f_case:
            failures.append("F：用例缺失")
        elif not f_case.get("cfgWrapped"):
            failures.append("F：页面里没包到 ExcalidrawMermaid.parseMermaidToExcalidraw（m2e 未就绪或改动过）")
        elif (f_case.get("cfgGot") or {}).get("look") != "handDrawn":
            failures.append(f"F：m2e 没收到 look 配置（cfg={f_case.get('cfgGot')}）—— 外壳→引擎的配置链断了")
        elif not f_case["loaded"] or f_case["count"] < 3:
            failures.append(f"F：handDrawn 配置下转换没出元素（loaded={f_case.get('loaded')} count={f_case['count']}）")

        log("=" * 66)
        if f_case:
            log(f"F look 透传 | m2e 收到: {json.dumps(f_case.get('cfgGot'), ensure_ascii=False)} "
                f"| 元素 {f_case['count']} | loaded {f_case.get('loaded')}")
        if fit:
            boxes = fit.get("content") or {}
            log(f"E 适应视图 | __hostFit: {fit.get('hasHostFit')} | 有内容裁决 {fit.get('contentVerdict')}"
                f" | 视口 {fit.get('before')} → {fit.get('after')}")
            log(f"   内容包围盒（视口坐标系）: 左={round1(boxes.get('left'))} 右={round1(boxes.get('right'))}"
                f" 上={round1(boxes.get('top'))} 下={round1(boxes.get('bottom'))}"
                f" 居中偏移={round1(boxes.get('centerDx'))}/{round1(boxes.get('centerDy'))}")
            log(f"   空文档裁决 {fit.get('emptyVerdict')} | 视图未动 {fit.get('emptyUntouched')}")
        if failures:
            for f in failures:
                log("FAIL: " + f)
            return 1
        log(f"Excalidraw 承载探针：全部通过（结论 {out_path}）")
        return 0
    finally:
        try:
            ws.close()
        except Exception:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
