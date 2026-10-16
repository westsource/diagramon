#!/usr/bin/env python3
"""导出 PNG 报「位图栅格化失败」的分步诊断。

复用 canvas_probe 的 Chrome/CDP 设施，在浏览器原型（mock）里把
`preview.js::toPngDataUrl` 的管线逐段跑一遍，看断在哪一步：
  ① 页面里真实渲染出的 SVG → outerHTML
  ② DOMParser("image/svg+xml") 是否产生 parsererror
  ③ 序列化文本 → data URL → new Image() 是否触发 onerror（并抓 Chrome 的原始报错）
  ④ 分别测 mermaid 与 DOT 两种格式的文档
"""
import json
import os
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from canvas_probe import Cdp as CDP, find_chrome, free_port  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
UI = os.path.join(ROOT, "ui")


def serve_ui():
    handler = SimpleHTTPRequestHandler

    class H(handler):
        def log_message(self, *a):
            pass

        def __init__(self, *a, **kw):
            super().__init__(*a, directory=UI, **kw)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, srv.server_address[1]


def main():
    srv, port = serve_ui()
    cport = free_port()
    chrome = find_chrome()
    proc = cdp = None
    try:
        import subprocess
        user_data = os.path.join(os.environ.get("TEMP", "/tmp"), "dgm-export-debug-profile")
        proc = subprocess.Popen(
            [
                chrome,
                f"--remote-debugging-port={cport}",
                f"--user-data-dir={user_data}",
                "--headless=new",
                "--no-sandbox",
                "--no-proxy-server",
                "--no-first-run",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        import time

        ws_url = None
        for _ in range(60):
            try:
                import urllib.request

                with urllib.request.urlopen(f"http://127.0.0.1:{cport}/json", timeout=1) as r:
                    tabs = json.loads(r.read())
                pages = sorted(
                    [
                        t
                        for t in tabs
                        if t.get("webSocketDebuggerUrl")
                        and t.get("type") == "page"
                        and not str(t.get("url", "")).startswith("chrome-extension://")
                    ],
                    key=lambda t: 0 if t.get("url") == "about:blank" else 1,
                )
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                time.sleep(0.5)
        if not ws_url:
            print("✗ CDP 端口没起来")
            return 2
        cdp = CDP(ws_url, timeout=30)
        cdp.call("Page.enable", {})
        cdp.call("Runtime.enable", {})
        cdp.call("Page.navigate", {"url": f"http://127.0.0.1:{port}/index.html"})
        time.sleep(7)

        def ev(expr):
            r = cdp.call(
                "Runtime.evaluate",
                {"expression": expr, "returnByValue": True, "awaitPromise": True, "timeout": 20000},
            )
            res = (r or {}).get("result", {})
            if res.get("subtype") == "error":
                return "EVAL-ERROR: " + str(res.get("description"))[:600]
            return res.get("value")

        # ① 建 mermaid 文档、等渲染；再建 DOT 文档、等渲染
        print("== boot ==", ev("JSON.stringify({href: location.href, rs: document.readyState, "
                              "scripts: document.scripts.length, dgm: typeof DGM, "
                              "bodyLen: document.body ? document.body.innerHTML.length : -1})"))
        print("== newDoc mermaid ==", ev(
            "(async () => { const d = await DGM.state.newDoc(['mermaid']); "
            "DGM.tabs ? DGM.tabs.activate(d.id) : DGM.state.activateDoc(d.id); "
            "await new Promise(r=>setTimeout(r,2500)); "
            "const s = document.querySelector('#canvas-stage svg'); "
            "return JSON.stringify({id: !!d, svgMounted: !!s, viewBox: s && s.getAttribute('viewBox'), "
            "head: s ? s.outerHTML.slice(0,120) : ''}); })()"))

        # ② 分步管线（mermaid）
        print("== pipeline mermaid ==", ev(
            "(async () => {"
            "  const s = document.querySelector('#canvas-stage svg');"
            "  if (!s) return JSON.stringify({fail:'no svg mounted'});"
            "  const text = s.outerHTML;"
            "  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');"
            "  const pe = doc.querySelector('parsererror');"
            "  const root = doc.documentElement;"
            "  const out = { parserError: !!pe, rootTag: root ? root.nodeName : null,"
            "    nsOk: !!(root && root.namespaceURI === 'http://www.w3.org/2000/svg') };"
            "  const ser = new XMLSerializer().serializeToString(root);"
            "  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(ser);"
            "  out.urlLen = url.length;"
            "  const img = await new Promise((resolve) => {"
            "    const n = new Image();"
            "    n.onload = () => resolve({load:'ok', w: n.naturalWidth, h: n.naturalHeight});"
            "    n.onerror = (e) => resolve({load:'error'});"
            "    n.src = url;"
            "  });"
            "  out.img = img;"
            "  try { const u = await DGM.preview.toPngDataUrl(); out.toPng = 'ok:len=' + u.length; }"
            "  catch (e) { out.toPng = 'fail: ' + (e && e.message || e); }"
            "  return JSON.stringify(out);"
            "})()"))

        # ③ 换 DOT 文档再来一遍
        print("== newDoc dot ==", ev(
            "(async () => { const d = await DGM.state.newDoc(['dot']); "
            "DGM.tabs ? DGM.tabs.activate(d.id) : DGM.state.activateDoc(d.id); "
            "await new Promise(r=>setTimeout(r,3000)); "
            "const s = document.querySelector('#canvas-stage svg'); "
            "return JSON.stringify({svgMounted: !!s, head: s ? s.outerHTML.slice(0,120) : ''}); })()"))
        print("== pipeline dot ==", ev(
            "(async () => {"
            "  const s = document.querySelector('#canvas-stage svg');"
            "  if (!s) return JSON.stringify({fail:'no svg mounted'});"
            "  const text = s.outerHTML;"
            "  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');"
            "  const pe = doc.querySelector('parsererror');"
            "  const root = doc.documentElement;"
            "  const out = { parserError: !!pe, rootTag: root ? root.nodeName : null,"
            "    nsOk: !!(root && root.namespaceURI === 'http://www.w3.org/2000/svg') };"
            "  try { const u = await DGM.preview.toPngDataUrl(); out.toPng = 'ok:len=' + u.length; }"
            "  catch (e) { out.toPng = 'fail: ' + (e && e.message || e); }"
            "  return JSON.stringify(out);"
            "})()"))

        # ④ 收集 console error（img onerror 时 Chrome 会往 console 打原始原因）
        errs = []
        for p in cdp.seen("Runtime.consoleAPICalled") or []:
            if p.get("type") in ("error", "warning"):
                parts = [str(a.get("value") or a.get("description") or "") for a in p.get("args", [])]
                errs.append(" ".join(parts)[:300])
        print("== console ==", json.dumps(errs[:10], ensure_ascii=False))
        return 0
    finally:
        try:
            if cdp:
                cdp.close()
        except Exception:
            pass
        try:
            srv.shutdown()
        except Exception:
            pass
        try:
            if proc:
                proc.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
