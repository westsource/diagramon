#!/usr/bin/env python
"""README 截图：把界面在浏览器原型（mock 后端）里渲染出来，截成 PNG。

    python tools/dev/readme_shots.py

为什么不在真机截：本沙箱里 WebView2 的窗口截不到（见 ui_probe.py 的说明 ——
非前台窗口的 invoke 响应会丢）。mock 后端让 ui/index.html 在普通 Chrome 里
跑出与真机同一套界面代码。标题栏那个「mock 模式」徽标是"没检测到 Tauri 运行时"
的提示，真机不存在 —— 截图前显式切到 no-mock 类把它收起来（不改源码）。

映射规则与 crates/assets::resolve 相同：/drawio /excalidraw /graphviz /mermaid /d2
落挂载点，其余落 ui/。

产物：client2/screenshots/*.png
依赖：本机 Chrome/Edge；websocket-client；渲染运行时在 `tools/`
（drawio / excalidraw 不在位就跳过画布两张，D2 不在位就跳过 D2 那张）。
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UI = ROOT / "ui"
SHOTS = ROOT / "screenshots"

sys.path.insert(0, str(ROOT / "tools" / "dev"))
from canvas_probe import Cdp, find_chrome, free_port  # noqa: E402

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
    # D2 的入口是 index.js 不是 index.html（wasm 以内联 base64 藏在里面）—— 前端按
    # `/d2/index.js` 取，所以这条映射只服务那一个请求
    "d2": _mount(("tools", "d2")),
}

# 挂载点 → 入口文件。判「资产在不在位」与兜底请求（`/drawio/` 这种不带文件名的）都看它，
# 与 `crates/assets` 的 MOUNT_ENTRY 同一口径。
MOUNT_ENTRY = {
    "drawio": "index.html",
    "excalidraw": "index.html",
    "graphviz": "graphviz.js",
    "mermaid": "mermaid.min.js",
    "d2": "index.js",
}

WIDTH, HEIGHT = 1440, 900

# 每张 = (文件名, URL 查询串, 截图前的 JS, 额外等待秒, 截图前的就绪表达式)
# 查询串走的是 main.js::applyUrlState 认的那几个参数（theme/doc/mode/sidebar/…）。
# 就绪表达式为空时只按「额外等待秒」等；非空时**轮询它**（D2 那张要等 wasm 实例化，
# 固定睡几秒要么截到加载态、要么白等）。
PLAN: list[tuple[str, str, str, float, str]] = [
    # 01–05 显式带 sidebar=explorer：这几张的取景就是「带资源管理器」的工作台，
    # 不跟默认布局走 —— 侧栏默认收起（2026-10-12）后不加这个参数截图会悄悄变样。
    ("01-main-light.png", "doc=0&theme=light&noai=1&sidebar=explorer", "", 2.0, ""),
    ("02-ai-vision.png", "doc=0&theme=light&sidebar=explorer", "DGM.ai.focus('vision');", 2.0, ""),
    ("03-drawio-canvas.png", "doc=2&theme=light&sidebar=explorer", "", 12.0, ""),
    ("04-excalidraw-canvas.png", "doc=3&theme=light&sidebar=explorer", "", 14.0, ""),
    ("05-dark-preview.png", "doc=0&theme=dark&mode=preview&sidebar=explorer", "", 3.0, ""),
    ("06-cloud-docs.png", "mockcloud=signed&sidebar=cloud&theme=light&noai=1", "", 2.0, ""),
    ("07-cloud-account.png", "mockcloud=signed&sidebar=account&theme=light&noai=1", "", 2.0, ""),
    # D2：正文现场建（mock 的初始文档里没有 .d2），等预览真的挂上 SVG 再截
    (
        "08-d2-preview.png",
        "theme=light&sidebar=explorer&noai=1",
        "window.__shot = (async () => {"
        "  const d = await DGM.state.newDoc('d2');"
        "  await DGM.state.setBodyNow(d.id, window.__D2_SAMPLE);"
        "  DGM.editor.loadActive();"
        "  await DGM.preview.render();"
        "})();",
        0.5,
        # 只看 `#canvas-stage svg` 是不够的：页面一进来就先把默认的 mermaid 文档渲染出来了，
        # 那个 SVG 也在同一个舞台上 —— 于是"就绪"会立刻为真，截到的是 D2 的加载态。
        # `mountSvg` 会给舞台打上 `data-engine=<格式>`，用它才认得出"这次挂的是 D2"。
        "document.querySelector('#canvas-stage').dataset.engine === 'd2'"
        " && !!document.querySelector('#canvas-stage svg')",
    ),
]

# 截图需要资产在位；不在位就跳过而不是失败。
NEEDS_ASSETS = {
    "03-drawio-canvas.png": "drawio",
    "04-excalidraw-canvas.png": "excalidraw",
    "08-d2-preview.png": "d2",
}

# D2 那张用的正文：把 Diagramon 自己的管线画一遍（顺便展示容器 / 形状 / 类样式 / 虚线边）
D2_SAMPLE = """direction: right
classes: {
  wasm: { style: { fill: "#eef3f9"; stroke: "#4a7196" } }
}
客户端: {
  direction: down
  源码窗口: "源码"
  预览窗口: "预览"
  源码窗口 -> 预览窗口: "实时"
}
网关: "离线?"
网关.shape: diamond
本地引擎: "D2 wasm"
本地引擎.class: wasm
云网关: "云模型"
云网关.class: wasm
数据库: "结果缓存"
数据库.shape: cylinder
客户端 -> 网关: "图表代码"
网关 -> 本地引擎: "是" { style.stroke-dash: 3 }
网关 -> 云网关: "否（仅 AI）"
本地引擎 -> 数据库
"""


def log(msg: str = "") -> None:
    print(msg, flush=True)


def make_handler():
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):  # 静音
            return

        def translate_path(self, path):  # noqa: A003
            clean = urllib.parse.unquote(path.split("?", 1)[0].split("#", 1)[0])
            segs = clean.strip("/").split("/")
            first = segs[0] if segs else ""
            if first in MOUNTS:
                if first == "drawio" and len(segs) > 1 and segs[1] == "host.html":
                    return str(ROOT / "tools" / "drawio-host" / "host.html")
                if first == "excalidraw" and (len(segs) == 1 or not segs[1] or segs[1] == "index.html"):
                    # 承载页归本仓库（源工作树里那份是停更的旧副本）：与 canvas_probe.py 同一条规矩
                    return str(ROOT / "tools" / "excalidraw-host" / "index.html")
                if len(segs) == 1 or not segs[1]:
                    return str(MOUNTS[first] / MOUNT_ENTRY[first])
                return str(MOUNTS[first].joinpath(*segs[1:]))
            rest = clean.lstrip("/") or "index.html"
            return str(UI / rest)

        def do_GET(self):  # noqa: N802
            target = self.translate_path(self.path)
            p = Path(target)
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
            self.send_header("Content-Type", _mime(p))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

    return Handler


def _mime(p: Path) -> str:
    table = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".ico": "image/x-icon",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".ttf": "font/ttf",
        ".xml": "application/xml",
        ".txt": "text/plain; charset=utf-8",
    }
    return table.get(p.suffix.lower(), "application/octet-stream")


def wait_ready(cdp: Cdp, timeout: float = 25.0) -> bool:
    """等前端把外壳挂上（mock 后端零延迟，正常几百毫秒）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            ok = cdp.evaluate(
                "!!(window.DGM && window.DGM.shell && document.querySelector('#activitybar') "
                "&& document.querySelector('#activitybar').children.length)",
                timeout=5,
            )
            if ok:
                return True
        except Exception:
            pass
        time.sleep(0.4)
    return False


def wait_expr(cdp: Cdp, expr: str, timeout: float = 30.0) -> bool:
    """轮询一个就绪表达式（等着色/渲染完成时用它，别用固定 sleep）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if cdp.evaluate(expr, timeout=5):
                return True
        except Exception:
            pass
        time.sleep(0.4)
    return False


def shoot(cdp: Cdp, name: str) -> None:
    cdp.call("Page.enable", timeout=20)
    cdp.call(
        "Emulation.setDeviceMetricsOverride",
        {"width": WIDTH, "height": HEIGHT, "deviceScaleFactor": 1, "mobile": False},
        timeout=10,
    )
    # 真机没有 mock 徽标：切到 no-mock 类收起来（这是非 mock 模式的正常类名）
    cdp.evaluate("document.body.classList.add('no-mock'); document.activeElement.blur();", timeout=5)
    time.sleep(0.4)
    r = cdp.call("Page.captureScreenshot", {"format": "png"}, timeout=40)
    data = (r or {}).get("data")
    if not data:
        raise RuntimeError(f"{name}: captureScreenshot 没拿到数据")
    SHOTS.mkdir(parents=True, exist_ok=True)
    out = SHOTS / name
    out.write_bytes(base64.b64decode(data))
    log(f"  ✓ {out}（{out.stat().st_size // 1024} KB）")


def main() -> int:
    chrome = find_chrome()
    if not chrome:
        log("✗ 找不到 Chrome/Edge")
        return 2

    # 需要资产的那几张：入口不在位就跳过（而不是截出一张报错图）
    missing = {m for m in NEEDS_ASSETS.values() if not (MOUNTS[m] / MOUNT_ENTRY[m]).is_file()}
    for name, mount in NEEDS_ASSETS.items():
        if mount in missing:
            log(f"（{mount} 资产不在位：{MOUNTS[mount]} —— 跳过 {name}）")

    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler())
    ui_port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log(f"静态服务器 http://127.0.0.1:{ui_port}")

    dbg_port = free_port()
    profile = tempfile.mkdtemp(prefix="dgm-readme-shots-")
    proc = subprocess.Popen(
        [
            chrome,
            "--headless=new",
            f"--remote-debugging-port={dbg_port}",
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--disable-gpu",
            "--hide-scrollbars",
            # 反后台节流四开关（headless 也吃这套）
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-features=CalculateNativeWinOcclusion",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    no_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    cdp = None
    try:
        ws_url = None
        for _ in range(60):
            try:
                with no_proxy.open(f"http://127.0.0.1:{dbg_port}/json", timeout=1) as r:
                    tabs = json.loads(r.read().decode())
                pages = sorted(
                    [t for t in tabs if t.get("webSocketDebuggerUrl") and t.get("type") == "page"
                     and not str(t.get("url", "")).startswith("chrome-extension://")],
                    key=lambda t: 0 if t.get("url") == "about:blank" else 1,
                )
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                time.sleep(0.2)
        if not ws_url:
            log("✗ CDP 端口一直没起来")
            return 2

        cdp = Cdp(ws_url, timeout=30)
        cdp.call("Runtime.enable", timeout=10)
        cdp.call("Page.enable", timeout=10)

        made = 0
        for name, query, js, extra, ready in PLAN:
            need = NEEDS_ASSETS.get(name)
            if need and need in missing:
                continue
            url = f"http://127.0.0.1:{ui_port}/index.html?{query}"
            cdp.call("Page.navigate", {"url": url}, timeout=20)
            if not wait_ready(cdp):
                log(f"  ✗ {name}：界面没起来，跳过")
                continue
            time.sleep(extra)
            if js:
                try:
                    # D2 那张的正文从这里注入，免得在 JS 字符串里塞一大段中文正文
                    cdp.evaluate("window.__D2_SAMPLE = " + json.dumps(D2_SAMPLE) + ";", timeout=10)
                    cdp.evaluate(js, timeout=10)
                except Exception as exc:
                    log(f"  （{name} 的预处理 JS 报错，照样截：{exc}）")
                time.sleep(1.2)
            if ready and not wait_expr(cdp, ready, timeout=45):
                log(f"  （{name}：就绪表达式超时，按当前画面截）")
            try:
                shoot(cdp, name)
                made += 1
            except Exception as exc:
                log(f"  ✗ {name}：{exc}")

        log(f"\n完成：{made} 张 → {SHOTS}")
        return 0 if made else 1
    finally:
        if cdp:
            cdp.close()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        server.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
