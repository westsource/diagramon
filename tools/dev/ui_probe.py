#!/usr/bin/env python
"""UI 探针：在浏览器原型（mock 后端）里验证「整窗交互是活的」。

    python tools/dev/ui_probe.py

复现「主窗口菜单全部无响应」这类全局性死亡：它没法在沙箱里点真窗口，
但 mock 后端让 ui/index.html 能在普通 Chrome 里跑 —— 启动错误、事件绑定
失败、透明遮罩挡点击，都能在这里现形。

做法（坑都踩过，别改回去）：
1. 简单 HTTP serve ui/（无 __TAURI__ ⇒ ipc.js 自动启用 mock 后端）；
2. CDP 驱动本机 Chrome（headless + 反后台节流四开关 —— 见 canvas_probe.py 的注释）；
3. 收 Runtime 的 console / exception 事件（启动错误第一时间现形）；
4. 程序化点击菜单 / 标签，断言弹出物真的出现 —— 「点了没反应」当场复现。
"""

from __future__ import annotations

import json
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
UI = ROOT / "ui"
SHOTS = ROOT / "ui" / ".shots"

sys.path.insert(0, str(ROOT / "tools" / "dev"))
from canvas_probe import CHROME_CANDIDATES, Cdp as CDP, find_chrome, free_port  # noqa: E402


def log(msg: str = "") -> None:
    print(msg, flush=True)


def serve_ui() -> tuple[ThreadingHTTPServer, int]:
    class H(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(UI), **kw)

        def log_message(self, *args):  # 静音
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, srv.server_address[1]


def main() -> int:
    chrome = find_chrome()
    if not chrome:
        log("✗ 找不到 Chrome/Edge")
        return 2
    srv, ui_port = serve_ui()
    dbg_port = free_port()
    # 本机有系统代理：127.0.0.1 必须显式绕过，否则连自己的 CDP 端口都会走代理然后失败
    no_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    user_data = tempfile.mkdtemp(prefix="dgm-uiprobe-")
    proc = subprocess.Popen(
        [
            chrome,
            "--headless=new",
            f"--remote-debugging-port={dbg_port}",
            f"--user-data-dir={user_data}",
            "--no-first-run",
            "--disable-gpu",
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
    cdp = None
    fails: list[str] = []
    errors: list[str] = []
    try:
        # 等 devtools 端口起来
        ws_url = None
        for _ in range(50):
            try:
                import websocket  # noqa: F401

                with no_proxy.open(
                    f"http://127.0.0.1:{dbg_port}/json", timeout=1
                ) as r:
                    tabs = json.loads(r.read().decode())
                # /json 第一个可能是扩展后台页 —— 只挑真页面（about:blank 优先）
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
        cdp = CDP(ws_url, timeout=30)
        cdp.send("Runtime.enable")
        cdp.send("Page.enable")

        # 收错误（按需 pump 几秒；事件会被 CDP 类攒进 _events，最后用 seen() 取）
        def drain(sec: float) -> None:
            end = time.time() + sec
            while time.time() < end:
                cdp.pump(timeout=min(0.5, max(0.05, end - time.time())))

        cdp.send("Page.navigate", {"url": f"http://127.0.0.1:{ui_port}/index.html"})
        drain(4.0)  # 等启动跑完（mock 后端零延迟，4s 足够）

        def ev(expr: str):
            r = cdp.call(
                "Runtime.evaluate",
                {"expression": expr, "returnByValue": True, "awaitPromise": True},
                timeout=20,
            )
            res = (r or {}).get("result", {})
            if res.get("subtype") == "error":
                errors.append("eval-error: " + str(res.get("description"))[:400])
                return None
            return res.get("value")

        # ---- 诊断：页面到底加载成什么样 ----
        info = ev("JSON.stringify({href: location.href, dgm: typeof window.DGM, "
                  "bodyLen: document.body ? document.body.innerHTML.length : -1, "
                  "scripts: document.scripts.length, "
                  "title: document.title})")
        log(f"页面状态: {info}")

        # ---- 断言 1：boot 走完（boot:done 由 main.js 打点；mock 下 note 走 console） ----
        menus = ev("document.querySelectorAll('#menubar > *').length")
        tabs = ev("document.querySelectorAll('#tabs .tab').length")
        vms = ev("document.querySelectorAll('#viewmodes button').length")
        body_rows = ev("getComputedStyle(document.body).cursor")
        log(f"菜单项: {menus} | 标签: {tabs} | 视图模式按钮: {vms} | cursor: {body_rows}")

        # ---- 断言 2：遮罩是否挡住了全窗（透明但可命中的元素）----
        hit = ev(
            "(() => { const b = document.querySelector('#menubar'); "
            "if (!b) return 'no-menubar'; "
            "const r = b.getBoundingClientRect(); "
            "const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); "
            "return el ? (el.closest('#menubar') ? 'ok' : 'blocked-by:' + el.id + '.' + el.className) : 'offscreen'; })()"
        )
        log(f"菜单可命中: {hit}")
        if hit != "ok":
            fails.append(f"菜单被挡/不可命中: {hit}")

        # ---- 断言 3：程序化点菜单，弹出物要出现 ----
        opened = ev(
            "(() => { const b = document.querySelector('#menubar > *'); "
            "if (!b) return false; b.click(); "
            "const p = document.querySelector('#menubar .menu.open, #menubar [data-open], .menu-drop'); "
            "const anyPop = !!document.querySelector('#pop:not([hidden]), .menu.open, [data-menu-open]'); "
            "return anyPop; })()"
        )
        log(f"点击菜单后弹出: {opened}")
        if not opened:
            fails.append("点击菜单没有弹出具 —— 「点了没反应」复现")

        # ---- 断言 4：关闭按钮链路（mock 下 win.close 是 no-op，只验 quit 确认框弹出）----
        # 有脏文档时应弹确认；无脏文档直接走 close。这里只验按钮监听器活着：
        ev("document.querySelectorAll('#tabs .tab .x').forEach(x => x.remove())")  # 避免误点
        # ---- 断言 4b：源码窗格比例规则（默认 1/3，夹 1/4–1/2，旧默认 46 归一）----
        ratios = ev(
            "(async () => {"
            "  const out = {};"
            "  const get = () => parseFloat(DGM.state && getSplitVar()) ;"
            "  function getSplitVar(){ return document.querySelector('#split').style.getPropertyValue('--split-src'); }"
            "  out.initial = getSplitVar();"
            "  await DGM.state.patchSettings({ panels: { split_src: 80 } });"
            "  DGM.shell.applyLayoutVars(); out.over50 = getSplitVar();"
            "  await DGM.state.patchSettings({ panels: { split_src: 10 } });"
            "  DGM.shell.applyLayoutVars(); out.under25 = getSplitVar();"
            "  await DGM.state.patchSettings({ panels: { split_src: 46 } });"
            "  DGM.shell.applyLayoutVars(); out.legacy46 = getSplitVar();"
            "  await DGM.state.patchSettings({ panels: { split_src: 33 } });"
            "  DGM.shell.applyLayoutVars();"
            "  return JSON.stringify(out);"
            "})()"
        )
        log(f"分屏比例规则: {ratios}")
        try:
            r = json.loads(ratios or "{}")
            if not str(r.get("initial", "")).startswith("33"):
                fails.append(f"分屏默认应为 33%，实际 {r.get('initial')}")
            if not str(r.get("over50", "")).startswith("50"):
                fails.append(f"超过 50 应夹到 50，实际 {r.get('over50')}")
            if not str(r.get("under25", "")).startswith("25"):
                fails.append(f"低于 25 应夹到 25，实际 {r.get('under25')}")
            if not str(r.get("legacy46", "")).startswith("33"):
                fails.append(f"旧默认 46 应归一成 33，实际 {r.get('legacy46')}")
        except Exception as e:
            log(f"（比例断言解析失败：{e}）")

        # ---- 断言 5：标签压测 —— 标签过多时 tabbar 必须保持单行 ----
        stress = ev(
            "(async () => {"
            "  for (let i = 0; i < 12; i++) await DGM.state.newDoc(['mermaid','dot','mermaid','dot'][i % 4]);"
            "  await new Promise(r => setTimeout(r, 300));"
            "  const bar = document.querySelector('#tabbar');"
            "  const vm = document.querySelector('#viewmodes');"
            "  const btns = [...vm.querySelectorAll('button')];"
            "  const ys = new Set(btns.map(b => Math.round(b.getBoundingClientRect().top)));"
            "  const tabsYs = new Set([...document.querySelectorAll('#tabs .tab')].map(t => Math.round(t.getBoundingClientRect().top)));"
            "  return JSON.stringify({"
            "    n: document.querySelectorAll('#tabs .tab').length,"
            "    barOver: bar.scrollHeight - bar.clientHeight,"
            "    vmRows: ys.size,"
            "    tabRows: tabsYs.size,"
            "    detail: {"
            "      barH: bar.clientHeight,"
            "      tabsH: document.querySelector('#tabs').offsetHeight,"
            "      addH: document.querySelector('.tab-add') ? document.querySelector('.tab-add').offsetHeight : -1,"
            "      rightH: document.querySelector('.tabbar-right') ? document.querySelector('.tabbar-right').offsetHeight : -1,"
            "      vmH: vm.offsetHeight,"
            "      btnH: btns.length ? btns[0].offsetHeight : -1"
            "    }"
            "  });"
            "})()"
        )
        log(f"标签压测(12 个): {stress}")
        try:
            st = json.loads(stress or "{}")
            if st.get("barOver", 0) > 2:
                fails.append(f"tabbar 内容溢出 {st['barOver']}px（挤成两行）")
            if st.get("vmRows", 1) > 1:
                fails.append(f"viewmodes 变成 {st['vmRows']} 行")
            if st.get("tabRows", 1) > 1:
                fails.append(f"标签条变成 {st['tabRows']} 行")
        except Exception as e:
            log(f"（压测解析失败：{e}）")

        # 诊断：viewmodes 按钮的内部构成
        diag = ev(
            "(() => { const b = document.querySelector('#viewmodes button'); if (!b) return 'none';"
            "  const svg = b.querySelector('svg'), sp = b.querySelector('span');"
            "  const cs = getComputedStyle(b);"
            "  return JSON.stringify({ btnH: b.offsetHeight, btnW: b.offsetWidth,"
            "    lh: cs.lineHeight, fs: cs.fontSize, pad: cs.padding,"
            "    svgH: svg ? svg.getBoundingClientRect().height : -1,"
            "    svgW: svg ? svg.getBoundingClientRect().width : -1,"
            "    spH: sp ? sp.getBoundingClientRect().height : -1,"
            "    spText: sp ? sp.textContent : '' }); })()"
        )
        log(f"viewmodes 按钮构成: {diag}")

        close_alive = ev(
            "(() => { const b = document.querySelector('#win-close'); "
            "if (!b) return 'no-btn'; "
            "return 'btn-exists'; })()"
        )
        log(f"关闭按钮存在: {close_alive}")

        # 汇总启动期间的 console error / 异常
        for params in cdp.seen("Runtime.exceptionThrown"):
            d = params.get("exceptionDetails", {})
            txt = d.get("exception", {}).get("description") or d.get("text", "")
            errors.append("exception: " + txt[:400])
        for params in cdp.seen("Runtime.consoleAPICalled"):
            if params.get("type") in ("error",):
                parts = [str(a.get("value") or a.get("description") or "") for a in params.get("args", [])]
                errors.append("console.error: " + " ".join(parts)[:400])
        # boot 打点走 mock 的 console.log —— 抓出来确认 boot 走到哪
        boots = [
            "".join(str(a.get("value") or "") for a in p.get("args", []))
            for p in cdp.seen("Runtime.consoleAPICalled")
            if any("boot:" in str(a.get("value") or "") for a in p.get("args", []))
        ]

        log("")
        log(f"boot 打点: {boots if boots else '（没抓到 console 打点）'}")
        if errors:
            log("")
            log("── 页面错误（前 10 条）──")
            for e in errors[:10]:
                log("  " + e)
            if len(errors) > 10:
                log(f"  … 共 {len(errors)} 条")
            fails.append(f"页面有 {len(errors)} 条 console/异常错误")

        # ---- 截图留证 ----
        SHOTS.mkdir(parents=True, exist_ok=True)
        shot = SHOTS / "ui-probe.png"
        import base64

        try:
            r = cdp.call(
                "Page.captureScreenshot",
                {"format": "png", "captureBeyondViewport": True},
                timeout=15,
            )
            data = (r or {}).get("result", {}).get("data")
            if data:
                shot.write_bytes(base64.b64decode(data))
                log(f"截图：{shot}")
        except Exception as e:
            log(f"（截图失败，不影响结论：{e}）")

        log("")
        if fails:
            for f in fails:
                log("✗ " + f)
            return 1
        log("✓ 整窗交互在浏览器原型里是活的（菜单可命中、可弹出）")
        return 0
    finally:
        if cdp:
            cdp.close()
        proc.kill()
        srv.shutdown()


if __name__ == "__main__":
    sys.exit(main())
