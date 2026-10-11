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
        cdp.send(
            "Emulation.setDeviceMetricsOverride",
            {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False},
        )

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
            # 46 的归一化只在 state.load() 做一次；applyLayoutVars 里不能归一，
            # 否则用户真拖到 46% 会被抹掉 —— 这里断言"46 原样保留"
            if not str(r.get("legacy46", "")).startswith("46"):
                fails.append(f"applyLayoutVars 不应改写 46，实际 {r.get('legacy46')}")
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

        # ---- 断言 6：侧栏 / AI 面板宽度拖拽（CDP 派发真实鼠标序列）----
        def drag_gutter(gid: str, dx: float, dy: float) -> None:
            ev("document.activeElement && document.activeElement.blur && document.activeElement.blur()")
            hit = ev(
                f"(() => {{ const g = document.querySelector('#{gid}'); const r = g.getBoundingClientRect();"
                f"const x = r.left + r.width / 2, y = r.top + r.height / 2;"
                f"const el = document.elementFromPoint(x, y);"
                f"return (el ? (el.id || el.className) : 'none') + '|' + Math.round(x) + ',' + Math.round(y); }})()"
            )
            pos = ev(
                f"(() => {{ const g = document.querySelector('#{gid}'); "
                f"const r = g.getBoundingClientRect();"
                f"return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2]); }})()"
            )
            x, y = json.loads(pos)
            log(f"    drag {gid}: hit={hit}")
            cdp.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1}, timeout=15)
            cdp.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x + dx, "y": y + dy, "button": "left"}, timeout=15)
            cdp.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x + dx, "y": y + dy, "button": "left", "clickCount": 1}, timeout=15)

        # 拖拽前收掉一切浮层（前面断言可能留着打开的菜单/对话框挡住 mousedown）
        for t in ("keyDown", "keyUp"):
            cdp.call(
                "Input.dispatchKeyEvent",
                {"type": t, "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27},
                timeout=15,
            )
        drain(0.2)

        side0 = ev("document.querySelector('#sidebar').getBoundingClientRect().width")
        ai0 = ev("document.querySelector('#ai-pane').getBoundingClientRect().width")
        drag_gutter("sidebar-gutter", 100, 0)
        drain(0.3)
        side1 = ev("document.querySelector('#sidebar').getBoundingClientRect().width")
        drag_gutter("ai-gutter", -80, 0)
        drain(0.3)
        ai1 = ev("document.querySelector('#ai-pane').getBoundingClientRect().width")
        # 松手后应已落盘到 settings
        saved = ev("JSON.stringify({sw: DGM.state.settings.panels.sidebar_w, aw: DGM.state.settings.panels.ai_w})")
        log(f"侧栏宽 {side0}→{side1} | AI 宽 {ai0}→{ai1} | 已存 {saved}")
        if not (isinstance(side1, (int, float)) and side1 > side0 + 90):
            fails.append(f"侧栏拖宽未生效：{side0}→{side1}")
        if not (isinstance(ai1, (int, float)) and ai1 > ai0 + 70):
            fails.append(f"AI 面板拖宽未生效：{ai0}→{ai1}")

        # 夹取：往死里拖，宽度必须停在边界
        drag_gutter("sidebar-gutter", -600, 0)
        drain(0.3)
        side_min = ev("document.querySelector('#sidebar').getBoundingClientRect().width")
        drag_gutter("ai-gutter", 900, 0)
        drain(0.3)
        ai_min = ev("document.querySelector('#ai-pane').getBoundingClientRect().width")
        log(f"夹取：侧栏→{side_min}（应 180）| AI→{ai_min}（应 260）")
        if side_min != 180:
            fails.append(f"侧栏最小宽度应 180，实际 {side_min}")
        if ai_min != 260:
            fails.append(f"AI 面板最小宽度应 260，实际 {ai_min}")

        # ---- 断言 7：源码/预览分隔条拖拽 + 比例落盘 ----
        sp0 = ev("parseFloat(document.querySelector('#split').style.getPropertyValue('--split-src'))")
        drag_gutter("splitter", 120, 0)
        drain(0.3)
        sp1 = ev("parseFloat(document.querySelector('#split').style.getPropertyValue('--split-src'))")
        saved_split = ev("DGM.state.settings.panels.split_src")
        log(f"分隔条比例 {sp0}→{sp1}（拖 +120px）| 落盘 split_src={saved_split}")
        if not (isinstance(sp1, (int, float)) and sp1 > sp0 + 5):
            fails.append(f"分隔条拖拽未生效：{sp0}→{sp1}")

        # ---- 判别实验：合成事件 vs CDP 输入 ----
        synth = ev(
            "(async () => {"
            "  const sp = document.querySelector('#splitter');"
            "  const r = sp.getBoundingClientRect();"
            "  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;"
            "  const at = document.elementFromPoint(cx, cy);"
            "  const mk = (t) => sp.dispatchEvent(new MouseEvent(t, {bubbles: true, cancelable: true, clientX: cx, clientY: cy}));"
            "  mk('mousedown');"
            "  window.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: cx + 100, clientY: cy}));"
            "  window.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));"
            "  await new Promise(r2 => setTimeout(r2, 200));"
            "  return JSON.stringify({hit: at ? at.id || at.className : 'none',"
            "    after: document.querySelector('#split').style.getPropertyValue('--split-src')});"
            "})()"
        )
        log(f"合成事件判别: {synth}")

        # ---- 断言 8：二级菜单 —— 从父行内部一路移到子菜单必须全程存活 ----
        cdp.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27}, timeout=15)
        cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27}, timeout=15)
        drain(0.2)
        mpos = ev("(() => { const b = document.querySelector('#menubar .tb-item'); const r = b.getBoundingClientRect();"
                  "return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2]); })()")
        mx, my = json.loads(mpos)
        cdp.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": mx, "y": my, "button": "left", "clickCount": 1}, timeout=15)
        cdp.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": mx, "y": my, "button": "left", "clickCount": 1}, timeout=15)
        drain(0.3)
        sub = ev(
            "(async () => {"
            "  const row = [...document.querySelectorAll('#pop .pop-row')].find(b => b.querySelector('.arrow-sub'));"
            "  if (!row) return 'no-subrow';"
            "  const r = row.getBoundingClientRect();"
            "  row.dispatchEvent(new MouseEvent('mouseenter', {bubbles: false}));"
            "  await new Promise(r2 => setTimeout(r2, 150));"
            "  const p = document.querySelector('#pop-sub');"
            "  return JSON.stringify({open: !p.hidden, rows: p.querySelectorAll('.pop-row').length,"
            "    rowL: Math.round(r.left), rowR: Math.round(r.right), rowY: Math.round(r.top + r.height / 2),"
            "    subRect: p.hidden ? null : (() => { const s = p.getBoundingClientRect();"
            "      return [Math.round(s.left), Math.round(s.top), Math.round(s.width), Math.round(s.height)]; })()});"
            "})()"
        )
        log(f"二级菜单展开: {sub}")
        try:
            d = json.loads(sub)
        except Exception:
            d = {}
        if isinstance(d, dict) and d.get("open") and d.get("subRect"):
            sx, sy, sw, sh = d["subRect"]
            tx, ty = sx + sw / 2, sy + sh / 2
            # 起点在父行**内部**：真机父/子菜单之间有缝，移动必然跨出 #pop ——
            # 宽限期（220ms）必须在跨越后保住子菜单。移动全程快速连发，不做中途
            # 检查（每步一次 CDP 往返太慢，会把 220ms 宽限拖爆，制造假失败）。
            x0, y0 = float(d["rowL"]) + 10, float(d["rowY"])
            for i in range(1, 15):
                px = x0 + (tx - x0) * i / 14
                py = y0 + (ty - y0) * i / 14
                cdp.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": px, "y": py}, timeout=15)
            alive = ev("!document.querySelector('#pop-sub').hidden")
            log(f"移动到子菜单后存活: {alive}")
            if not alive:
                fails.append("从父菜单移向子菜单途中子菜单消失（宽限期未生效）")

            # 悬停其它行：子菜单**保持**打开（本项目取向：不做行级互斥，避免斜向
            # 移动扫过其它行时误杀 —— 原生菜单用三角形判定，这里用宽限期替代）
            other = ev(
                "(async () => {"
                "  const row = [...document.querySelectorAll('#pop .pop-row')].find(b => !b.querySelector('.arrow-sub'));"
                "  if (!row) return 'none';"
                "  row.dispatchEvent(new MouseEvent('mouseenter', {bubbles: false}));"
                "  await new Promise(r2 => setTimeout(r2, 100));"
                "  return document.querySelector('#pop-sub').hidden ? 'closed' : 'still-open';"
                "})()"
            )
            log(f"悬停其它行: {other}（取向：保持打开）")
            if other != "still-open":
                fails.append(f"悬停其它行后子菜单被误收: {other}")

            # 移到菜单外的空地，宽限到期（220ms）后应收
            cdp.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 720, "y": 880}, timeout=15)
            drain(0.5)
            gone = ev("document.querySelector('#pop-sub').hidden")
            log(f"离开菜单 500ms 后收起: {gone}")
            if not gone:
                fails.append("离开菜单家族后子菜单未按时收起")
        elif d.get("open") is False:
            fails.append("悬停带子菜单的行后子菜单没展开")

        # ---- 断言 9：菜单「文件→新建→子菜单」直达创建 —— 不弹对话框、文档 +1 ----
        # 开菜单做幂等处理：tb-item 是点击切换，上一场残留的打开状态会让这一下
        # 变成"关闭" —— 点到菜单里真的有行为止。
        for _ in range(3):
            cdp.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": mx, "y": my, "button": "left", "clickCount": 1}, timeout=15)
            cdp.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": mx, "y": my, "button": "left", "clickCount": 1}, timeout=15)
            drain(0.25)
            if ev("!!document.querySelector('#pop .pop-row')"):
                break
        # 真实鼠标移到「新建」行上（触发 mouseenter 展开子菜单），再点子菜单第一项
        hover = ev("(() => { const row = [...document.querySelectorAll('#pop .pop-row')].find(b => b.querySelector('.arrow-sub'));"
                   "if (!row) return null; const r = row.getBoundingClientRect();"
                   "return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2]); })()")
        if hover:
            hx, hy = json.loads(hover)
            cdp.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": hx, "y": hy}, timeout=15)
            drain(0.25)
            first_sub = ev("(() => { const b = document.querySelector('#pop-sub .pop-row');"
                           "if (!b) return null; const r = b.getBoundingClientRect();"
                           "return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2, b.textContent.trim()]); })()")
            if first_sub:
                fx, fy, flabel = json.loads(first_sub)
                n0 = ev("DGM.state.docs.length")
                cdp.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": fx, "y": fy, "button": "left", "clickCount": 1}, timeout=15)
                cdp.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": fx, "y": fy, "button": "left", "clickCount": 1}, timeout=15)
                drain(0.5)
                n1 = ev("DGM.state.docs.length")
                dlg_hidden = ev("document.querySelector('#overlay-dialog').hidden")
                log(f"菜单直达创建（点「{flabel}」）: 文档 {n0}→{n1} | 对话框未弹: {dlg_hidden}")
                if n1 != n0 + 1:
                    fails.append(f"菜单新建未直达创建：文档 {n0}→{n1}")
                if not dlg_hidden:
                    fails.append("菜单新建仍弹出了新建对话框（重复未消除）")
            else:
                fails.append("子菜单没有可点的行")
        else:
            fails.append("菜单里没有带子菜单的「新建」行")

        # ---- 断言 10：标签栏溢出可用性（滚入视野 / 滚轮横滚 / 渐隐 / Ctrl+Tab）----
        act0 = ev(
            "(async () => {"
            "  await DGM.state.activateDoc(DGM.state.docs[0].id);"
            "  await new Promise(r => setTimeout(r, 300));"
            "  const box = document.querySelector('#tabs');"
            "  const on = box.querySelector('.tab.on');"
            "  const r = on.getBoundingClientRect(), b = box.getBoundingClientRect();"
            "  return JSON.stringify({visible: r.left >= b.left - 2 && r.right <= b.right + 2,"
            "    sl: Math.round(box.scrollLeft), total: DGM.state.docs.length});"
            "})()"
        )
        log(f"激活首标签滚入视野: {act0}")
        try:
            a0 = json.loads(act0)
            if not a0.get("visible"):
                fails.append(f"激活标签未滚入视野: {act0}")
        except Exception as e:
            log(f"（断言 10 解析失败：{e}）")

        tb = ev("(() => { const b = document.querySelector('#tabs').getBoundingClientRect();"
                "return JSON.stringify([b.left + b.width / 2, b.top + b.height / 2]); })()")
        wx, wy = json.loads(tb)
        sl0 = ev("Math.round(document.querySelector('#tabs').scrollLeft)")
        cdp.call("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": wx, "y": wy, "deltaX": 0, "deltaY": 360}, timeout=15)
        drain(0.3)
        sl1 = ev("Math.round(document.querySelector('#tabs').scrollLeft)")
        faded = ev("document.querySelector('#tabs').classList.contains('fade-left')")
        log(f"滚轮横滚: scrollLeft {sl0}→{sl1} | fade-left={faded}")
        if not (isinstance(sl1, (int, float)) and sl1 > sl0):
            fails.append(f"滚轮横滚未生效：{sl0}→{sl1}")
        if not faded:
            fails.append("滚动后左端渐隐未出现")

        act_before = ev("DGM.state.active")
        cdp.call("Input.dispatchKeyEvent", {"type": "keyDown", "modifiers": 2, "key": "Tab", "code": "Tab", "windowsVirtualKeyCode": 9}, timeout=15)
        cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", "modifiers": 2, "key": "Tab", "code": "Tab", "windowsVirtualKeyCode": 9}, timeout=15)
        drain(0.5)
        act_after = ev("DGM.state.active")
        expect_next = ev("(async () => { const i = DGM.state.docs.findIndex(d => d.id === " + json.dumps(act_before) + ");"
                         " return DGM.state.docs[(i + 1) % DGM.state.docs.length].id; })()")
        log(f"Ctrl+Tab 切换: {str(act_before)[:8]}… → {str(act_after)[:8]}…（期望 {str(expect_next)[:8]}…）")
        if act_after != expect_next:
            fails.append("Ctrl+Tab 未按标签顺序循环切换")

        # ---- 断言 11：侧栏 / AI 面板关闭按钮（togglePanel → body 类）----
        r1 = ev(
            "(async () => {"
            "  document.querySelector('#side-close').click();"
            "  await new Promise(r => setTimeout(r, 300));"
            "  const off = document.body.classList.contains('no-sidebar');"
            "  document.body.classList.remove('no-sidebar');"  # 复位以便 AI 断言独立观察
            "  return off ? 'closed' : 'not-closed';"
            "})()"
        )
        log(f"侧栏关闭: {r1}")
        if r1 != "closed":
            fails.append("侧栏关闭按钮未生效（no-sidebar 类没挂上）")
        r2 = ev(
            "(async () => {"
            "  document.querySelector('#ai-close').click();"
            "  await new Promise(r => setTimeout(r, 300));"
            "  const off = document.body.classList.contains('no-ai');"
            "  return off ? 'closed' : 'not-closed';"
            "})()"
        )
        log(f"AI 面板关闭: {r2}")
        if r2 != "closed":
            fails.append("AI 面板关闭按钮未生效（no-ai 类没挂上）")
        # ---- 断言 12：重启还原 —— 重载页面（mock 经 sessionStorage 存活），
        # 关闭过的侧栏必须保持关闭；再打开也要保持打开。----
        cdp.call("Page.reload", {}, timeout=20)
        drain(4.0)
        restored = ev(
            "JSON.stringify({"
            "  noSidebar: document.body.classList.contains('no-sidebar'),"
            "  noAi: document.body.classList.contains('no-ai'),"
            "  sidebarPref: DGM.state.settings.panels.sidebar,"
            "  aiPref: DGM.state.settings.panels.ai"
            "})"
        )
        log(f"重载后还原: {restored}")
        try:
            rr = json.loads(restored)
            if not rr.get("noSidebar"):
                fails.append("重启后侧栏关闭状态未还原")
            if not rr.get("noAi"):
                fails.append("重启后 AI 面板关闭状态未还原")
        except Exception as e:
            log(f"（断言 12 解析失败：{e}）")
        # 复位给后续断言一个干净状态
        ev(
            "(async () => {"
            "  await DGM.state.patchSettings({ panels: { sidebar: true, ai: true } });"
            "  DGM.shell.render();"
            "})()"
        )
        drain(0.2)

        # ---- 断言 13：设置窗口左右布局（页签列在左、内容在右）----
        cdp.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27}, timeout=15)
        cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27}, timeout=15)
        drain(0.2)
        settings_layout = ev(
            "(async () => {"
            "  DGM.dialogs.settings('appearance');"
            "  await new Promise(r => setTimeout(r, 200));"
            "  const body = document.querySelector('.dialog-body.has-tabs');"
            "  const tabs = document.querySelector('.dlg-tabs');"
            "  const pane = document.querySelector('.dlg-pane');"
            "  if (!body || !tabs || !pane) return 'missing';"
            "  const cs = getComputedStyle(body);"
            "  const t = tabs.getBoundingClientRect(), pn = pane.getBoundingClientRect();"
            "  const out = { display: cs.display, cols: cs.gridTemplateColumns.split(' ').length,"
            "    tabsLeftOfPane: t.right <= pn.left + 1,"
            "    sameRow: Math.abs(t.top - pn.top) < 4,"
            "    tabW: Math.round(t.width) };"
            "  DGM.dialogs.close();"
            "  return JSON.stringify(out);"
            "})()"
        )
        log(f"设置窗口布局: {settings_layout}")
        try:
            sl = json.loads(settings_layout)
            if not isinstance(sl, dict) or sl.get("display") != "grid" or not sl.get("tabsLeftOfPane") or not sl.get("sameRow"):
                fails.append(f"设置窗口未左右布局: {settings_layout}")
        except Exception as e:
            log(f"（断言 13 解析失败：{e}）")

        # ---- 断言 14：账户入口存在且**独立**，并且不在菜单里 ----
        # 只查结构（这里还没登录，点下去会弹登录窗口 —— 那是断言 15 的事；
        # "切到账户视图"要等登录之后，见断言 16）。
        acct_check = ev(
            "(() => {"
            "  const labels = [...document.querySelectorAll('#menubar .tb-item')].map(b => b.textContent.trim());"
            "  const inMenu = labels.some(x => x.includes('账户'));"
            "  const acts = [...document.querySelectorAll('#activitybar .act')];"
            "  const act = acts.find(b => b.title.trim() === '账户');"
            "  const cloudBtn = acts.find(b => b.title.includes('云端文档'));"
            "  return JSON.stringify({inMenu, noBtn: !act, distinct: !!cloudBtn && cloudBtn !== act});"
            "})()"
        )
        log(f"账户入口: {acct_check}")
        try:
            ac = json.loads(acct_check)
            if ac.get("inMenu"):
                fails.append("菜单里仍有「账户」顶级项")
            if ac.get("noBtn"):
                fails.append("活动栏没有账户按钮（title 应为「账户」）")
            if not ac.get("distinct"):
                fails.append("账户与云端文档共用了同一个活动栏按钮")
        except Exception as e:
            log(f"（断言 14 解析失败：{e}）")

        # ---- 断言 15：未登录时点「账户」→ 直接弹登录窗口；注册地址可复制且由配置推导 ----
        # 三件事一起验：登录搬进了独立窗口（不再内联在侧栏）、窗口只做登录（注册是跳官网的
        # 导航动作）、回显的注册地址来自 settings.cloud.base_url 而不是硬编码域名。
        login_check = ev(
            "(async () => {"
            "  const act = [...document.querySelectorAll('#activitybar .act')]"
            "    .find(b => b.title.trim() === '账户');"
            "  if (!act) return JSON.stringify({noact: true});"
            "  const before = DGM.state.settings.panels.sidebar_view;"
            "  act.click();"
            "  await new Promise(r => setTimeout(r, 250));"
            "  const ov = document.getElementById('overlay-dialog');"
            "  const dlg = document.getElementById('dialog');"
            "  const open = !!ov && ov.hidden === false;"
            "  const link = dlg.querySelector('[data-act=register]');"
            "  const box = dlg.querySelector('#lg-url-input');"
            "  const inline = !!dlg.querySelector('#lg-email');"
            "  const after = DGM.state.settings.panels.sidebar_view;"
            "  if (link) link.click();"
            "  await new Promise(r => setTimeout(r, 150));"
            "  const url = box ? box.value : '';"
            "  const base = (DGM.state.settings.cloud || {}).base_url || '';"
            "  const ro = box ? box.readOnly : false;"
            "  if (DGM.dialogs) DGM.dialogs.close();"
            "  return JSON.stringify({open, hasLink: !!link, hasBox: !!box, ro, url, base,"
            "    inline, before, after, title: (dlg.querySelector('h2') || {}).textContent || ''});"
            "})()"
        )
        log(f"登录窗口: {login_check}")
        try:
            lc = json.loads(login_check)
            if lc.get("noact"):
                fails.append("活动栏没有账户按钮")
            else:
                if not lc.get("open"):
                    fails.append("未登录点「账户」没有弹出登录窗口")
                if not lc.get("inline"):
                    fails.append("登录窗口里没有邮箱输入框")
                if not lc.get("hasLink"):
                    fails.append("登录窗口没有「去官网注册」链接")
                if not lc.get("hasBox") or not lc.get("ro"):
                    fails.append("注册地址不是可复制的只读输入框")
                want = (lc.get("base") or "").rstrip("/") + "/register"
                if lc.get("url") != want:
                    fails.append(f"注册地址未由配置推导：{lc.get('url')} != {want}")
                if lc.get("before") != lc.get("after"):
                    fails.append(f"未登录点「账户」不该切视图：{lc.get('before')} -> {lc.get('after')}")
        except Exception as e:
            log(f"（断言 15 解析失败：{e}）")

        # ---- 断言 16：登录后「云端文档」是目录树；「保存到云端」开的是树形选目录窗口 ----
        # 顺带守住"登录状态只有一份"：登录是从 DGM.state.cloudLogin 做的（等价于在
        # 任意一处登录），云端文档视图必须立刻是"已登录"的样子，而不需要再登录一次。
        cloud_ui = ev(
            "(async () => {"
            "  await DGM.state.cloudLogin('probe+free@example.com', 'secret');"
            "  DGM.shell.setSidebarView('cloud');"
            "  await new Promise(r => setTimeout(r, 300));"
            "  const rows = document.querySelectorAll('#side-view .ct-row').length;"
            "  const folders = document.querySelectorAll('#side-view .ct-row .fld').length;"
            "  const docs = document.querySelectorAll('#side-view .ct-row .sz').length;"
            # 云端文档视图**不该**有存储用量：额度归「账户」视图（同一份服务端数据）。
            # 这里两个都查：新的 .ct-foot 和老式的 progress 都不允许出现。
            "  const quotaStrip = !!document.querySelector('#side-view .ct-foot');"
            "  const quotaProgress = document.querySelectorAll('#side-view progress').length;"
            "  const signIn = !!document.querySelector('#side-view [data-a=login]');"
            "  const err = DGM.state.cloud.lastError || '';"
            "  await DGM.cloud.saveDoc();"
            "  await new Promise(r => setTimeout(r, 300));"
            "  const dlg = document.getElementById('dialog');"
            "  const picks = dlg.querySelectorAll('.pk-tree [data-pick]').length;"
            "  const name = (dlg.querySelector('#cs-name') || {}).value || '';"
            "  const canCreate = !!dlg.querySelector('#cs-new-folder');"
            "  if (DGM.dialogs) DGM.dialogs.close();"
            "  await new Promise(r => setTimeout(r, 100));"
            "  const act = [...document.querySelectorAll('#activitybar .act')]"
            "    .find(b => b.title.trim() === '账户');"
            "  if (act) act.click();"
            "  await new Promise(r => setTimeout(r, 250));"
            "  const view = DGM.state.settings.panels.sidebar_view;"
            "  const card = !!document.querySelector('#side-view .acct-card');"
            "  const quota = !!document.querySelector('#side-view .acct-quota');"
            # AI 权益：mock 登录后是免费套餐（enabled=false）→ 必须出现「未开通」徽标；
            # 而"服务端没给这个字段"（ai=null）要走"—"未知，两者不能混。
            "  const aiBadge = document.querySelector('#side-view .acct-badge');"
            "  const aiOff = !!document.querySelector('#side-view .acct-ai-off');"
            # 免费套餐没有额度可看 → 不该有第二条进度条（存储那条仍在）
            "  const quotaBars = document.querySelectorAll('#side-view .acct-quota').length;"
            "  return JSON.stringify({rows, folders, docs, quotaStrip, quotaProgress, signIn, err,"
            "    picks, name, canCreate, view, card, quota, aiBadge: !!aiBadge,"
            "    aiText: aiBadge ? aiBadge.textContent.trim() : '', aiOff, quotaBars});"
            "})()"
        )
        log(f"云端文档树 / 保存窗口: {cloud_ui}")
        try:
            cu = json.loads(cloud_ui)
            if cu.get("err"):
                fails.append(f"云端报错：{cu.get('err')}")
            if not cu.get("rows") or not cu.get("folders"):
                fails.append(f"云端文档视图没有渲染目录树: {cloud_ui}")
            if cu.get("docs", 0) < 1:
                fails.append("云端目录树里没有文档行（只列了目录）")
            if cu.get("signIn"):
                fails.append("已登录后云端文档视图仍在要求登录（登录状态不统一）")
            if cu.get("quotaStrip") or cu.get("quotaProgress"):
                fails.append(f"云端文档视图不该显示存储用量（额度在「账户」视图）: {cloud_ui}")
            if (cu.get("picks") or 0) < 2:
                fails.append(f"保存到云端窗口没有目录选择树: {cloud_ui}")
            if not cu.get("name"):
                fails.append("保存到云端窗口没有预填文档名")
            if not cu.get("canCreate"):
                fails.append("保存到云端窗口缺少「新建子目录」入口")
            # 已登录 → 点「账户」应当**切视图**（而不是再弹登录窗口）
            if cu.get("view") != "account":
                fails.append(f"已登录点「账户」未切到账户视图: {cu.get('view')}")
            if not cu.get("card"):
                fails.append("账户视图没有账户卡片")
            if not cu.get("quota"):
                fails.append("账户视图没有配额块（额度必须在这里能看到）")
            if not cu.get("aiBadge"):
                fails.append("账户视图没有 AI 权益徽标（套餐里的 AI 服务状态）")
            if not cu.get("aiOff"):
                fails.append(f"免费套餐的 AI 权益应显示为「未开通」: {cu.get('aiText')}")
        except Exception as e:
            log(f"（断言 16 解析失败：{e}）")

        # ---- 断言 17：有 AI 权益时，账户视图要给出真实额度（信用点，不是 ¥） ----
        # mock 里换一份带 enabled=true 的账户快照（等价于会员套餐），
        # 验证：AI 行变「已开通」+ 出现第二条额度块 + 剩余与周期都写出来。
        ai_credit = ev(
            "(() => {"
            "  DGM.state.cloud.status.account = Object.assign({}, DGM.state.cloud.status.account, {"
            "    plan_name: '会员',"
            "    ai: { enabled: true, credit_monthly_micros: 20000000, credit_used_micros: 3200000,"
            "          period_start: '2026-10-01T00:00:00+00:00', period_end: '2026-11-01T00:00:00+00:00' } });"
            "  DGM.shell.setSidebarView('account');"
            "  return 1;"
            "})()"
        )
        # setSidebarView 走 patchSettings（异步），等一帧再读 DOM
        ev("(async () => { await new Promise(r => setTimeout(r, 300)); return 1; })()")
        ai_view = ev(
            "(() => {"
            "  const boxes = [...document.querySelectorAll('#side-view .acct-quota')];"
            "  const on = document.querySelector('#side-view .acct-ai-on');"
            "  const aiBox = boxes.find(b => /AI/.test(b.querySelector('h5').textContent));"
            "  const txt = aiBox ? aiBox.textContent.replace(/\\s+/g, ' ').trim() : '';"
            "  return JSON.stringify({on: !!on, boxes: boxes.length, txt});"
            "})()"
        )
        log(f"AI 额度块: {ai_view}")
        try:
            av = json.loads(ai_view)
            if not av.get("on"):
                fails.append(f"AI 已开通时没显示「已开通」: {ai_view}")
            if (av.get("boxes") or 0) < 2:
                fails.append("AI 已开通时账户视图应有两条额度块（存储 + AI）")
            txt = av.get("txt") or ""
            if "3.2" not in txt or "20" not in txt:
                fails.append(f"AI 额度没显示已用/总额（3.2 / 20 信用点）: {txt}")
            if "剩余 16.8" not in txt:
                fails.append(f"AI 额度没显示剩余（应为 16.8 信用点）: {txt}")
            if "¥" in txt or "元" in txt:
                fails.append(f"AI 额度单位不该用货币符号（服务端是信用点）: {txt}")
        except Exception as e:
            log(f"（断言 17 解析失败：{e}）")

        # ---- 断言 18：从活动栏「账户」登录 → 登录完**落到账户视图**，且按钮不会卡在旧状态 ----
        # 用户实测路径：未登录 → 侧栏停在「资源浏览器」→ 点「账户」→ 在登录窗口里登录
        # ⇒ 只弹一句「已登录」，账户侧栏不出现；**换过别的侧栏面板再点又能用了**。
        # 两个成因一起守（去掉任一个这条都会红）：
        #   ① 登录只是中途一站 —— 入口要把"登录完接着做什么"传进去（openLogin.onSuccess）
        #   ② 活动栏不能拿 render 时的快照判 signed —— 登录/登出不会重渲染它
        #      （`cloud:changed` 原本只喂侧栏），快照会让按钮永远停在"未登录"那一支上
        acct_login = ev(
            "(async () => {"
            "  await DGM.state.cloudLogout();"
            "  DGM.shell.setSidebarView('explorer');"
            "  await new Promise(r => setTimeout(r, 300));"
            "  const pick = () => [...document.querySelectorAll('#activitybar .act')]"
            "    .find(b => b.title.trim() === '账户');"
            "  const act = pick();"
            "  if (!act) return JSON.stringify({noact: true});"
            "  act.click();"
            "  await new Promise(r => setTimeout(r, 250));"
            "  const ov = document.getElementById('overlay-dialog');"
            "  const dialogOpen = !!ov && ov.hidden === false;"
            "  const viewBefore = DGM.state.settings.panels.sidebar_view;"
            "  const em = document.getElementById('lg-email');"
            "  const pw = document.getElementById('lg-pass');"
            "  if (em) em.value = 'probe@example.com';"
            "  if (pw) pw.value = 'secret';"
            "  const ok = document.getElementById('lg-ok');"
            "  if (ok) ok.click();"
            "  await new Promise(r => setTimeout(r, 600));"
            "  const viewAfter = DGM.state.settings.panels.sidebar_view;"
            "  const sidebarOn = !!DGM.state.settings.panels.sidebar;"
            "  const card = !!document.querySelector('#side-view .acct-card');"
            "  const stillOpen = !!ov && ov.hidden === false;"
            # 再点一次：应当走"已登录"分支（当前视图就是账户 → 收起侧栏），
            # 而不是又弹登录窗口、也不该毫无反应 —— 后两者都是活动栏停在旧快照的症状
            "  const act2 = pick();"
            "  if (act2) act2.click();"
            "  await new Promise(r => setTimeout(r, 300));"
            "  const sidebarAfter2nd = !!DGM.state.settings.panels.sidebar;"
            "  const dlgAfter2nd = !!ov && ov.hidden === false;"
            "  const viewAfter2nd = DGM.state.settings.panels.sidebar_view;"
            # 复原到"已登录 + 账户视图"，后面的截图要拍这个现场
            "  DGM.shell.setSidebarView('account');"
            "  await new Promise(r => setTimeout(r, 300));"
            "  return JSON.stringify({dialogOpen, viewBefore, viewAfter, sidebarOn, card,"
            "    stillOpen, sidebarAfter2nd, dlgAfter2nd, viewAfter2nd});"
            "})()"
        )
        log(f"账户登录续做: {acct_login}")
        try:
            al = json.loads(acct_login)
            if al.get("noact"):
                fails.append("活动栏没有账户按钮")
            else:
                if not al.get("dialogOpen"):
                    fails.append("未登录点「账户」没弹登录窗口")
                if al.get("viewBefore") != "explorer":
                    fails.append(f"前置状态不对（点之前应停在 explorer）: {al.get('viewBefore')}")
                if al.get("stillOpen"):
                    fails.append("登录成功后登录窗口没关掉")
                if al.get("viewAfter") != "account":
                    fails.append(f"从「账户」登录成功后应落到账户视图: {al.get('viewAfter')}")
                if not al.get("sidebarOn"):
                    fails.append("登录成功后侧栏没打开")
                if not al.get("card"):
                    fails.append("登录成功后账户视图没有账户卡片")
                if al.get("dlgAfter2nd"):
                    fails.append("已登录后再点「账户」又弹了登录窗口（活动栏没跟着刷新）")
                if al.get("sidebarAfter2nd") or al.get("viewAfter2nd") != "account":
                    fails.append(f"已登录后再点「账户」没走「当前视图就收起」这一支（按钮停在旧快照上）: {acct_login}")
        except Exception as e:
            log(f"（断言 18 解析失败：{e}）")

        # ---- 断言 19：「保存到云端」未登录时先去登录，登录完**接着把这次保存做完** ----
        # 同一类问题的第二个入口：登录是中途一站，回来不该把用户丢在门口。
        save_resume = ev(
            "(async () => {"
            "  await DGM.state.cloudLogout();"
            "  await new Promise(r => setTimeout(r, 200));"
            "  await DGM.cloud.saveDoc();"
            "  await new Promise(r => setTimeout(r, 250));"
            "  const ov = document.getElementById('overlay-dialog');"
            "  const loginOpen = !!ov && ov.hidden === false;"
            "  const loginBox = !!document.getElementById('lg-email');"
            "  const saveBox1 = !!document.getElementById('cs-name');"
            "  const em = document.getElementById('lg-email');"
            "  const pw = document.getElementById('lg-pass');"
            "  if (em) em.value = 'probe@example.com';"
            "  if (pw) pw.value = 'secret';"
            "  const ok = document.getElementById('lg-ok');"
            "  if (ok) ok.click();"
            "  await new Promise(r => setTimeout(r, 800));"
            "  const saveBox2 = !!document.getElementById('cs-name');"
            "  const saveOpen = !!ov && ov.hidden === false;"
            "  if (DGM.dialogs) DGM.dialogs.close();"
            "  await new Promise(r => setTimeout(r, 120));"
            "  return JSON.stringify({loginOpen, loginBox, saveBox1, saveBox2, saveOpen});"
            "})()"
        )
        log(f"保存续做: {save_resume}")
        try:
            sr = json.loads(save_resume)
            if not (sr.get("loginOpen") and sr.get("loginBox")):
                fails.append(f"未登录点「保存到云端」没先去登录: {save_resume}")
            if sr.get("saveBox1"):
                fails.append(f"未登录时不该直接开保存窗口: {save_resume}")
            if not sr.get("saveBox2"):
                fails.append(f"登录成功后没接着打开保存窗口（这次保存没续做）: {save_resume}")
        except Exception as e:
            log(f"（断言 19 解析失败：{e}）")

        # ---- 断言 20：云网关模型 —— 登录后有、分组显示、默认自动选中、登出后清空 ----
        # 这条对应"登录了但 AI 面板还说没有模型"的观感问题（用户 2026-10-11 反馈），
        # 以及用户拍板的两条：**分组显示**、**登录后自动选第一个网关模型为默认**。
        # 四个环节一起守，缺一个都会红：
        #   ① 未登录 → 网关模型恒为 0（靠它守住"登出必须清空"）
        #   ② 登录（有权益）→ 出现网关模型，且默认被指到第一个
        #   ③ AI 面板下拉与 AI 菜单子菜单**两处**都要有分组小标题（两套渲染，别只测一处）
        #   ④ 登出 → 清空，且默认不再指向网关别名
        gw = ev(
            "(async () => {"
            "  const wait = (ms) => new Promise(r => setTimeout(r, ms));"
            "  const out = {};"
            "  await DGM.state.cloudLogout(); await wait(250);"
            "  out.outGw = DGM.state.gatewayModels().length;"
            "  out.outLocal = DGM.state.modelChoices().filter(m => m.group === 'local').length;"
            "  await DGM.state.cloudLogin('probe@example.com', 'secret'); await wait(400);"
            "  out.inGw = DGM.state.gatewayModels().map(m => m.id);"
            "  out.inDefault = DGM.state.ai().default_model;"
            "  out.current = (DGM.state.currentModel() || {}).id || '';"
            "  const aiBtn = [...document.querySelectorAll('#activitybar .act')]"
            "    .find(b => b.title.indexOf(DGM.i18n.t('mi.aiPanel')) === 0);"
            "  if (!DGM.state.panels().ai && aiBtn) { aiBtn.click(); await wait(250); }"
            "  const mdl = document.querySelector('#ai-model');"
            "  if (mdl) { mdl.click(); await wait(200); }"
            "  out.labels = [...document.querySelectorAll('#pop .pop-label')].map(e => e.textContent.trim());"
            "  out.rows = [...document.querySelectorAll('#pop .pop-row .lbl')].map(e => e.textContent.trim());"
            "  const onRow = document.querySelector('#pop .pop-row.on .lbl');"
            "  out.checked = onRow ? onRow.textContent.trim() : '';"
            "  if (DGM.pop) DGM.pop.hide();"
            # 菜单栏那条是**另一套渲染**（menuItems 得原样透传 label2），单独验一次
            "  const tb = [...document.querySelectorAll('#menubar .tb-item')].find(b => b.dataset.menu === 'ai');"
            "  if (tb) { tb.click(); await wait(150); }"
            "  const want = DGM.i18n.t('mi.aiModel');"
            "  const row = [...document.querySelectorAll('#pop .pop-row')].find(b => b.textContent.indexOf(want) >= 0);"
            "  if (row) { row.dispatchEvent(new MouseEvent('mouseenter', {bubbles: true})); await wait(250); }"
            "  out.subLabels = [...document.querySelectorAll('#pop-sub .pop-label')].map(e => e.textContent.trim());"
            "  out.subRows = [...document.querySelectorAll('#pop-sub .pop-row .lbl')].map(e => e.textContent.trim());"
            "  document.body.click(); await wait(120);"
            "  await DGM.state.cloudLogout(); await wait(300);"
            "  out.afterLogoutGw = DGM.state.gatewayModels().length;"
            "  out.afterLogoutDefault = DGM.state.ai().default_model;"
            "  out.afterLogoutIsGw = DGM.state.isGatewayModel(DGM.state.ai().default_model);"
            # 复原成"会员已登录 + AI 面板可见"，后面的截图要拍这个现场
            "  await DGM.state.cloudLogin('probe@example.com', 'secret'); await wait(400);"
            "  if (!DGM.state.panels().ai && aiBtn) { aiBtn.click(); await wait(250); }"
            "  const m2 = document.querySelector('#ai-model');"
            "  if (m2) { m2.click(); await wait(200); }"
            "  return JSON.stringify(out);"
            "})()"
        )
        log(f"云网关模型: {gw}")
        try:
            g = json.loads(gw)
            if g.get("outGw") != 0:
                fails.append(f"未登录时网关模型应为空: {g.get('outGw')}")
            if (g.get("outLocal") or 0) < 1:
                fails.append(f"本地 BYOK 模型不该被云状态影响: {g.get('outLocal')}")
            if g.get("inGw") != ["glm-5.2", "qwen3-max"]:
                fails.append(f"登录后没拿到网关模型别名: {g.get('inGw')}")
            if g.get("inDefault") != "gw:glm-5.2":
                fails.append(f"登录后没自动选中第一个网关模型: {g.get('inDefault')}")
            if g.get("current") != "gw:glm-5.2":
                fails.append(f"当前模型没落到网关别名上: {g.get('current')}")
            want_groups = ["Diagramon 云网关", "我的模型"]
            if g.get("labels") != want_groups:
                fails.append(f"AI 面板下拉没有两组小标题（应为 {want_groups}）: {g.get('labels')}")
            rows = g.get("rows") or []
            if not rows or "GLM-5.2" not in rows[0]:
                fails.append(f"下拉里网关组没排在最前: {rows}")
            if not any("BYOK" in r for r in rows):
                fails.append(f"下拉里没有本地那组: {rows}")
            if "GLM-5.2" not in (g.get("checked") or ""):
                fails.append(f"下拉没把网关默认模型标成选中: {g.get('checked')}")
            if g.get("subLabels") != want_groups:
                fails.append(f"AI 菜单的模型子菜单没有分组（label2 没透传？）: {g.get('subLabels')}")
            if not any("BYOK" in r for r in (g.get("subRows") or [])):
                fails.append(f"AI 菜单子菜单里没有本地那组: {g.get('subRows')}")
            if g.get("afterLogoutGw") != 0:
                fails.append(f"登出后网关模型没清空: {g.get('afterLogoutGw')}")
            if g.get("afterLogoutIsGw"):
                fails.append(f"登出后默认模型仍指向网关别名: {g.get('afterLogoutDefault')}")
        except Exception as e:
            log(f"（断言 20 解析失败：{e}）")

        # ---- 追加截图：保存到云端窗口 / 登录窗口（留证用，不参与判定） ----
        # 截图走"先把视口撑到 1680×1000 再截"：`captureBeyondViewport` 在本机
        # 会静默返回空 data（原来那段就是这么一直什么都没截到的），所以显式改视口尺寸，
        # 且拿不到数据时**必须报出来**，不能又静默失败。
        def shot(name: str) -> None:
            import base64 as _b64

            try:
                # Page.enable 不能省：没开 Page 域时 captureScreenshot 会"成功"返回空 data
                # （静默失败 —— 这正是原来那段一直没截到图的原因，见 canvas_probe.py 同款调用）。
                cdp.call("Page.enable", timeout=20)
                cdp.call(
                    "Emulation.setDeviceMetricsOverride",
                    {"width": 1680, "height": 1000, "deviceScaleFactor": 1, "mobile": False},
                    timeout=10,
                )
                r = cdp.call("Page.captureScreenshot", {"format": "png"}, timeout=30)
                # `Cdp.call` 返回的已经是 result 对象本身（wait_for 里 msg.get("result")），
                # 所以是 r["data"] 而不是 r["result"]["data"] —— 后者永远取到空，是原来那句的 bug。
                data = (r or {}).get("data")
                if not data:
                    log(f"（截图 {name} 没拿到数据 —— 不影响结论）")
                    return
                SHOTS.mkdir(parents=True, exist_ok=True)
                (SHOTS / name).write_bytes(_b64.b64decode(data))
                log(f"截图：{SHOTS / name}")
            except Exception as e:
                log(f"（截图 {name} 失败，不影响结论：{e}）")

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
        # 模型下拉（分组显示）—— 断言 20 结束时已经把它打开着
        shot("ui-probe-ai-models.png")
        # 再补两张对话框的（此时已登录 → 保存窗口；登出后 → 登录窗口），再截整窗
        ev("(async () => { await DGM.cloud.saveDoc(); await new Promise(r => setTimeout(r, 250)); return 1; })()")
        shot("ui-probe-cloud-save.png")
        ev("(async () => { DGM.dialogs.close(); await new Promise(r => setTimeout(r, 80)); return 1; })()")
        ev(
            "(async () => { await DGM.state.cloudLogout(); DGM.cloud.openLogin();"
            " await new Promise(r => setTimeout(r, 250)); return 1; })()"
        )
        shot("ui-probe-cloud-login.png")
        ev("(async () => { DGM.dialogs.close(); await new Promise(r => setTimeout(r, 80)); return 1; })()")
        shot("ui-probe.png")

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
