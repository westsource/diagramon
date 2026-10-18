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

        # ---- 断言 1b：默认布局 —— 侧栏必须**默认收起**（2026-10-12 拍板：画布优先），
        # 活动栏保留（它是重新打开侧栏的入口）。此断言必须在任何 patchSettings 之前跑。
        fresh = ev(
            "JSON.stringify({"
            "  noSidebar: document.body.classList.contains('no-sidebar'),"
            "  sideW: document.querySelector('#sidebar').getBoundingClientRect().width,"
            "  actW: document.querySelector('#activitybar').getBoundingClientRect().width,"
            "  pref: DGM.state.settings.panels.sidebar"
            "})"
        )
        log(f"默认布局: {fresh}")
        try:
            ff = json.loads(fresh or "{}")
            if not ff.get("noSidebar"):
                fails.append("侧栏应默认收起（body 缺 no-sidebar 类）")
            if ff.get("sideW") not in (0, 0.0):
                fails.append(f"侧栏默认宽度应为 0，实际 {ff.get('sideW')}")
            if not (isinstance(ff.get("actW"), (int, float)) and ff.get("actW") > 0):
                fails.append(f"活动栏应保留（重新打开侧栏的入口），实际宽 {ff.get('actW')}")
            if ff.get("pref") is not False:
                fails.append(f"panels.sidebar 默认应为 false，实际 {ff.get('pref')}")
        except Exception as e:
            log(f"（断言 1b 解析失败：{e}）")
        # 后面的断言要在「侧栏打开」的状态下跑 —— 显式打开，别依赖默认值
        ev(
            "(async () => {"
            "  await DGM.state.patchSettings({ panels: { sidebar: true } });"
            "  DGM.shell.render();"
            "})()"
        )
        drain(0.3)

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

        # ---- 断言 5b：转换近入口 + 弹出锚点存活（stopPropagation 约定）----
        # 历史教训：文档级"点外就关"监听会吃掉同一次点击里刚弹出的菜单 ——
        # side-more / tab-more / btn-layout / 状态栏 layout 曾全部死于这个坑
        # （2026-10-13 探针实测：handler 触发、菜单填充、随即被关）。
        # 这里一并守住：修复过的四个锚点 + 新加的两个「转换为」近入口，弹出后必须活着。
        anchors = ev(
            "(async () => {"
            "  const out = {};"
            "  const probe = async (name, sel) => {"
            "    const b = document.querySelector(sel);"
            "    if (!b || b.hidden) { out[name] = 'no-anchor'; return; }"
            "    b.click();"
            "    await new Promise(r2 => setTimeout(r2, 0));"
            "    const p = document.querySelector('#pop');"
            "    out[name] = (!p.hidden && p.querySelectorAll('.pop-row').length > 0) ? 'alive' : 'dead';"
            "    document.body.click();"
            "    await new Promise(r2 => setTimeout(r2, 0));"
            "  };"
            "  await probe('tab-convert', '#tab-convert');"
            "  await probe('status-convert', '#statusbar [data-a=\"convert\"]');"
            "  await probe('side-more', '#side-more');"
            "  await probe('tab-more', '#tab-more');"
            "  await probe('btn-layout', '#btn-layout');"
            "  await probe('status-layout', '#statusbar [data-a=\"layout\"]');"
            "  return JSON.stringify(out);"
            "})()"
        )
        log(f"弹出锚点存活: {anchors}")
        try:
            av = json.loads(anchors or "{}")
        except Exception:
            av = {}
        for name in ("tab-convert", "status-convert", "side-more", "tab-more", "btn-layout", "status-layout"):
            if av.get(name) != "alive":
                fails.append(f"弹出锚点 {name} 点击后菜单没存活（点了没反应复现）")

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

        # ---- 断言 14b：帮助菜单下有三种格式的官方文档入口（Mermaid / DOT / D2）----
        # 这三条点了会用系统浏览器打开官方文档（不是"离线优先不外跳"的占位）。D2 是后加的，
        # 这里钉住它别在后续调整菜单时被漏掉。**只读标签，不点那三行** ——
        # 点了会真去开浏览器，探针不该做这种副作用。
        doc_menu = ev(
            "(() => {"
            "  const bar = document.querySelector('#menubar .tb-item[data-menu=\"help\"]');"
            "  if (!bar) return JSON.stringify({err: 'no-help-item'});"
            "  bar.click();"
            "  const rows = [...document.querySelectorAll('#pop .pop-row .lbl')].map(e => e.textContent.trim());"
            "  bar.click();"
            "  const has = (s) => rows.some(x => x.includes(s));"
            "  return JSON.stringify({rows, mermaid: has('Mermaid'), dot: has('DOT'), d2: has('D2')});"
            "})()"
        )
        log(f"帮助菜单文档入口: {doc_menu}")
        try:
            dm = json.loads(doc_menu or "{}")
            if dm.get("err"):
                fails.append(f"找不到帮助菜单：{dm.get('err')}")
            else:
                for key, name in (("mermaid", "Mermaid 文档"), ("dot", "Graphviz DOT 规范"), ("d2", "D2 参考")):
                    if not dm.get(key):
                        fails.append(f"帮助菜单缺「{name}」入口（现有：{dm.get('rows')}）")
        except Exception as e:
            fails.append(f"帮助菜单文档入口断言解析失败：{e} / {doc_menu}")

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

        # ---- 断言 21：保存对话框按**本标签页的格式**推荐扩展名 ----
        # 历史 bug 形态（v2 客户端踩过，见其 FileService.SaveFileAsync 的注释）：类型清单按注册表
        # 顺序排、Mermaid 恒在第一 ⇒ drawio / DOT / Excalidraw 标签页另存为时被补成 `.mmd`，
        # 后缀与内容对不上、下次打开按错格式解析。这里钉住三件事：
        #   1) 建议文件名带本格式的规范扩展名；
        #   2) 类型清单第一项是本格式、首扩展名即规范扩展名（Win32 拿它当缺省后缀），末项是「所有文件」；
        #   3) 用户把名字里的后缀删掉时，落盘路径补回**本格式**的扩展名。
        save_check = ev(
            "(async () => {"
            "  const seen = []; let ret = null;"
            "  const orig = DGM.ipc.dialog.pickSavePath;"
            "  DGM.ipc.dialog.pickSavePath = async (o) => { seen.push(JSON.parse(JSON.stringify(o || {}))); return ret; };"
            "  const got = [];"
            "  for (const fmt of ['mermaid', 'dot', 'd2', 'drawio', 'excalidraw']) {"
            "    const d = await DGM.state.newDoc(fmt);"
            "    await DGM.state.activateDoc(d.id);"
            "    ret = null; await DGM.shell.saveActive(true);"
            "    const o = seen[seen.length - 1] || {};"
            "    ret = 'E:/tmp/probe-' + fmt; await DGM.shell.saveActive(true);"
            "    const after = DGM.state.doc(d.id) || {};"
            "    got.push({ fmt, def: o.defaultPath || '', filters: o.filters || [], saved: after.path || '' });"
            "  }"
            "  DGM.ipc.dialog.pickSavePath = orig;"
            "  return JSON.stringify(got);"
            "})()"
        )
        log(f"保存扩展名推荐: {save_check}")
        try:
            CANON = {"mermaid": "mmd", "dot": "dot", "d2": "d2", "drawio": "drawio", "excalidraw": "excalidraw"}
            rows = json.loads(save_check or "[]")
            if len(rows) != len(CANON):
                fails.append(f"保存扩展名推荐没跑全（拿到 {len(rows)} 个格式）")
            for row in rows:
                fmt = row.get("fmt")
                ext = CANON.get(fmt)
                if not ext:
                    continue
                if not str(row.get("def") or "").lower().endswith("." + ext):
                    fails.append(f"{fmt} 标签页的建议文件名没带规范扩展名 .{ext}：{row.get('def')}")
                filters = row.get("filters") or []
                if not filters:
                    fails.append(f"{fmt} 保存对话框没有文件类型清单（用户删掉后缀就会存出个没后缀的文件）")
                    continue
                if (filters[0].get("extensions") or [None])[0] != ext:
                    fails.append(f"{fmt} 类型清单第一项不是本格式的规范扩展名（Win32 据此补后缀）：{filters[0]}")
                if "*" not in (filters[-1].get("extensions") or []):
                    fails.append(f"{fmt} 类型清单末项不是「所有文件」：{filters[-1]}")
                if not str(row.get("saved") or "").lower().endswith("." + ext):
                    fails.append(f"{fmt} 用户没写后缀时应补 .{ext}，实际落盘路径 {row.get('saved')}")
        except Exception as e:
            fails.append(f"保存扩展名推荐断言解析失败：{e} / {save_check}")

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

        # 关于对话框：软件介绍必须真的渲染出来。
        # 历史 bug 形态：介绍被写成"仅非 mock 模式显示"，于是原型与自检环境里永远看不到它；
        # 同时确认 mock 警告是**另起一条**（warn 样式），而不是把介绍顶掉。
        lang0 = ev("(DGM.i18n && DGM.i18n.lang) || 'zh-CN'")
        ev("(async () => { DGM.i18n.setLang('zh-CN'); DGM.i18n.apply(); DGM.dialogs.about(); "
           "await new Promise(r => setTimeout(r, 200)); return 1; })()")
        about = ev(
            "(() => { const d = document.querySelector('#dialog'); if (!d) return null; "
            "const cs = [...d.querySelectorAll('.callout')]; "
            "return JSON.stringify({ hasDesc: d.textContent.indexOf('本地优先的图表编辑器') >= 0, "
            "mockWarn: cs.some(c => c.classList.contains('warn') && c.textContent.indexOf('mock') >= 0) }); })()"
        )
        log(f"关于对话框（介绍 + mock 警告）: {about}")
        try:
            a = json.loads(about or "{}")
            if not a.get("hasDesc"):
                fails.append("关于对话框里没有软件介绍（dlg.about.desc 没渲染出来）")
            if not a.get("mockWarn"):
                fails.append("关于对话框在 mock 模式下没有另起一条 mock 警告")
        except Exception as e:
            fails.append(f"关于对话框断言解析失败：{e} / {about}")
        ev("(async () => { DGM.dialogs.close(); await new Promise(r => setTimeout(r, 80)); return 1; })()")
        ev(f"DGM.i18n.setLang({json.dumps(lang0)}); DGM.i18n.apply(); 1")

        # 自定义模型：Add/Remove 必须真的改变行数并落到 settings。
        # 历史 bug 形态：pAI 用 state 渲染而草稿写在 draftAi 里，add/remove 改完草稿重画
        # 又被 settings() 重置 —— 「Add model 点了没反应」，坏了很多版没人发现。
        model_check = ev(
            "(async () => {"
            "  const rows = () => document.querySelectorAll('#model-list .model-row').length;"
            "  const st = () => (DGM.state.settings.ai.models || []).length;"
            "  DGM.dialogs.settings('ai');"
            "  await new Promise(r => setTimeout(r, 150));"
            "  const n0 = rows(), s0 = st();"
            "  [...document.querySelectorAll('[data-act]')].find(b => b.dataset.act === 'add').click();"
            "  await new Promise(r => setTimeout(r, 150));"
            "  const n1 = rows();"
            "  [...document.querySelectorAll('[data-act^=\"del:\"]')].pop().click();"
            "  await new Promise(r => setTimeout(r, 150));"
            "  const n2 = rows();"
            "  [...document.querySelectorAll('[data-act]')].find(b => b.dataset.act === 'save').click();"
            "  await new Promise(r => setTimeout(r, 200));"
            "  const s1 = st();"
            "  DGM.dialogs.close();"
            "  return JSON.stringify({ n0, n1, n2, s0, s1 });"
            "})()"
        )
        log(f"自定义模型 Add/Remove: {model_check}")
        try:
            mc = json.loads(model_check or "{}")
            if mc.get("n1") != mc.get("n0", -99) + 1:
                fails.append(f"点 Add model 后行数没 +1：{mc.get('n0')}→{mc.get('n1')}（草稿渲染断了）")
            if mc.get("n2") != mc.get("n0"):
                fails.append(f"删掉刚加的模型后行数没回到原值：{mc.get('n2')}")
            if mc.get("s1") != mc.get("s0"):
                fails.append(f"保存后 settings 里模型数变了（应只加又删）：{mc.get('s0')}→{mc.get('s1')}")
        except Exception as e:
            fails.append(f"自定义模型断言解析失败：{e} / {model_check}")

        close_alive = ev(
            "(() => { const b = document.querySelector('#win-close'); "
            "if (!b) return 'no-btn'; "
            "return 'btn-exists'; })()"
        )
        log(f"关闭按钮存在: {close_alive}")

        # ---- 断言 22：源码窗口的 Tab（光标处补到制表位）/ Shift+Tab 反缩进 / 当前行高亮 ----
        # vendor 的 basic setup 带行号与当前行高亮，但**没带 indentWithTab**：修之前按
        # Tab 走的是浏览器默认行为（焦点挪出编辑器），源码窗口里根本缩不了行。
        # 这里用真实按键 + 真实点击钉五件事：**空选区按 Tab 在光标处补到下一个制表位**
        # （2026-10-18 起；旧实现一律插在行首，于是"光标在句子中间按 Tab 整行右移"）、
        # 行首仍整档 4 空格、有选区整块缩进、焦点不跑、撤销是一步；顺带钉住
        # 「当前行高亮」的装饰确实挂在光标行上（vendor 换包时最容易悄悄丢掉的就是它 ——
        # 它是随包资产，不在本仓库构建）。
        def press(key: str, code: str, vk: int, modifiers: int = 0, times: int = 1) -> None:
            for _ in range(times):
                for t in ("keyDown", "keyUp"):
                    cdp.call(
                        "Input.dispatchKeyEvent",
                        {"type": t, "key": key, "code": code,
                         "windowsVirtualKeyCode": vk, "modifiers": modifiers},
                        timeout=15,
                    )
                drain(0.15)

        for t in ("keyDown", "keyUp"):  # 先收掉前面断言可能留着的对话框
            cdp.call(
                "Input.dispatchKeyEvent",
                {"type": t, "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27},
                timeout=15,
            )
        drain(0.2)
        src_ready = ev(
            "(async () => {"
            "  const d = DGM.state.docs.find(x => x.format === 'mermaid');"
            "  if (!d) return JSON.stringify({noDoc: true});"
            "  await DGM.state.activateDoc(d.id);"
            "  await DGM.state.setViewMode(d.id, 'split');"
            "  DGM.shell.render();"
            "  await new Promise(r => setTimeout(r, 400));"
            "  const ln = document.querySelectorAll('.cm-line')[1];"
            "  const r = ln ? ln.getBoundingClientRect() : null;"
            "  const al = document.querySelector('.cm-activeLine');"
            "  const pl = [...document.querySelectorAll('.cm-line')].find(l => !l.classList.contains('cm-activeLine'));"
            "  return JSON.stringify({"
            "    mode: DGM.state.mode(d),"
            "    lines: document.querySelectorAll('.cm-line').length,"
            "    activeLine: document.querySelectorAll('.cm-activeLine').length,"
            "    activeBg: al ? getComputedStyle(al).backgroundColor : null,"
            "    plainBg: pl ? getComputedStyle(pl).backgroundColor : null,"
            "    pos: r ? [r.left + 24, r.top + r.height / 2] : null"
            "  });"
            "})()"
        )
        log(f"源码窗口就绪: {src_ready}")
        try:
            sr = json.loads(src_ready or "{}")
            if sr.get("noDoc"):
                fails.append("没有 mermaid 文档，源码窗口断言无从下手")
            else:
                if sr.get("mode") != "split" or not sr.get("lines"):
                    fails.append(f"源码窗口没渲染（mode={sr.get('mode')} 行数={sr.get('lines')}）")
                if sr.get("activeLine") != 1:
                    fails.append(f"当前行高亮缺失：.cm-activeLine 命中 {sr.get('activeLine')} 个（应为 1）")
                # 有装饰类还不够 —— 底色得真的画出来（--accent 被改坏时 color-mix 会整条失效）
                if sr.get("activeBg") and sr.get("activeBg") == sr.get("plainBg"):
                    fails.append(f"当前行高亮没有底色：{sr.get('activeBg')}（与普通行相同）")
                if sr.get("pos"):
                    cx, cy = sr["pos"]
                    for t in ("mousePressed", "mouseReleased"):
                        cdp.call("Input.dispatchMouseEvent",
                                 {"type": t, "x": cx, "y": cy, "button": "left", "clickCount": 1}, timeout=15)
                    drain(0.25)
                    base = ev("DGM.editor.getValue()") or ""
                    line_no = int(ev("(DGM.editor.caret() || {}).line || 1") or 1)

                    def lead(s: str) -> str:
                        return s[: len(s) - len(s.lstrip(" \t"))]

                    # ① 光标处插入（2026-10-18 起：补空格对齐到下一个 tab stop —— VS Code 口径）。
                    #    Home → 行首，再右移 6 个字符 ⇒ 光标偏移 6，4 的倍数差 2 ⇒ 必须**在光标处**
                    #    补 2 个空格。旧实现会把整行右移 4 格，所以"行首空白不变"就是判别式。
                    press("Home", "Home", 36)
                    press("ArrowRight", "ArrowRight", 39, times=6)
                    pre = (ev("DGM.editor.getValue()") or "").split("\n")
                    press("Tab", "Tab", 9)
                    ts = json.loads(
                        ev(
                            "JSON.stringify({doc: DGM.editor.getValue(),"
                            " col: (DGM.editor.caret() || {}).col || 0,"
                            " focus: document.activeElement.className,"
                            " activeLine: document.querySelectorAll('.cm-activeLine').length})"
                        )
                        or "{}"
                    )
                    post = (ts.get("doc") or "").split("\n")
                    changed = [i for i in range(min(len(pre), len(post))) if pre[i] != post[i]]
                    log(f"Tab 光标处插入: 行 {line_no} | 变更行 {[i + 1 for i in changed]} | 光标列 {ts.get('col')}"
                        f" | 焦点 {ts.get('focus')}")
                    want = pre[line_no - 1][:6] + "  " + pre[line_no - 1][6:]
                    if changed != [line_no - 1] or post[line_no - 1] != want:
                        fails.append(f"Tab 没在光标处补到下一个制表位（期望 {want!r}，实得 {post[line_no - 1]!r}）")
                    if lead(post[line_no - 1]) != lead(pre[line_no - 1]):
                        fails.append("Tab 把整行右移了（行首空白变了）—— 光标处插入没生效")
                    if ts.get("col") != 9:
                        fails.append(f"插入后光标没停在补进去的空格之后（列 {ts.get('col')}，应 9）")
                    if "cm-content" not in str(ts.get("focus")):
                        fails.append(f"按 Tab 后焦点跑出了编辑器：{ts.get('focus')}")
                    if ts.get("activeLine") != 1:
                        fails.append(f"缩进后当前行高亮没了：{ts.get('activeLine')}")
                    # 撤销：Tab 插入必须是一步（userEvent=input.indent）
                    press("z", "KeyZ", 90, modifiers=2)
                    if (ev("DGM.editor.getValue()") or "") != base:
                        fails.append("Ctrl+Z 没把 Tab 插入整步撤掉")
                    # ② 行首按 Tab 仍是整档 4 空格（与旧行为一致，肌肉记忆不废）；Shift+Tab 对称
                    press("Home", "Home", 36)
                    press("Tab", "Tab", 9)
                    hs = json.loads(
                        ev(
                            "JSON.stringify({doc: DGM.editor.getValue(),"
                            " col: (DGM.editor.caret() || {}).col || 0})"
                        )
                        or "{}"
                    )
                    h_lines = (hs.get("doc") or "").split("\n")
                    if h_lines[line_no - 1] != "    " + pre[line_no - 1]:
                        fails.append(f"行首按 Tab 没插入一档 4 空格：{h_lines[line_no - 1]!r}")
                    if hs.get("col") != 5:
                        fails.append(f"行首缩进后光标位置不对（列 {hs.get('col')}，应 5）")
                    press("Tab", "Tab", 9, modifiers=8)
                    if (ev("DGM.editor.getValue()") or "") != base:
                        fails.append("Shift+Tab 与 Tab 不对称（没回到缩进前的样子）")
                    # 整块缩进：Shift+↓ 选中多行 → Tab 时每一行都动，且只动这些行
                    press("ArrowDown", "ArrowDown", 40, modifiers=8, times=2)
                    pre_block = ev("DGM.editor.getValue()") or ""
                    press("Tab", "Tab", 9)
                    block = (ev("DGM.editor.getValue()") or "").split("\n")
                    pb = pre_block.split("\n")
                    bdiff = [i for i in range(min(len(block), len(pb))) if pb[i] != block[i]]
                    log(f"整块缩进: 变更行 {[i + 1 for i in bdiff]}")
                    if len(bdiff) < 2 or any(block[i] != "    " + pb[i] for i in bdiff):
                        fails.append(f"跨行选区没整块缩进（变更行 {[i + 1 for i in bdiff]}）")
                    press("Tab", "Tab", 9, modifiers=8)  # 反缩进回原位，别影响后面的截图
                    if (ev("DGM.editor.getValue()") or "") != pre_block:
                        fails.append("整块反缩进没回到原样")
                else:
                    fails.append("源码窗口拿不到第 2 行的坐标（点不进编辑器）")
        except Exception as e:
            log(f"（断言 22 解析失败：{e}）")

        # ---- 断言 23：预览视口 —— 只有「初始化」与显式「适应视图」才自动适应 ----
        # 用户反馈（2026-10-14）：改之前每敲一个字/换一次主题都重新适应一次大小与位置，
        # 用户手动调过的缩放与平移会被抹掉。这里钉三件事：重渲染不动视口、显式适应仍然
        # 适应、换文档（= 初始化）仍然适应；顺带钉住状态栏那一项仍是「回到 100%」。
        vp_ready = ev(
            "(async () => {"
            "  window.__vpSnap = () => {"
            "    const st = document.querySelector('#canvas-stage');"
            "    return st.style.getPropertyValue('--zoom') + '|' + st.style.getPropertyValue('--pan-x');"
            "  };"
            "  const d = DGM.state.docs.find(x => x.format === 'mermaid');"
            "  if (!d) return 'no-doc';"
            "  await DGM.state.activateDoc(d.id);"
            "  await DGM.state.setViewMode(d.id, 'split');"
            "  DGM.shell.render();"
            "  await new Promise(r => setTimeout(r, 700));"
            "  return window.__vpSnap();"
            "})()"
        )
        log(f"视口适应（初始化）: {vp_ready}")
        if vp_ready in (None, "", "no-doc"):
            fails.append("预览视口断言起不来（没有 mermaid 文档？）")
        else:
            fitted = vp_ready
            zoomed = ev("(() => { DGM.preview.zoomIn(); DGM.preview.zoomIn(); return window.__vpSnap(); })()")
            if zoomed == fitted:
                fails.append(f"预览放大没接上：{fitted} → {zoomed}")
            ev("DGM.preview.schedule()")
            drain(1.2)
            after_rerender = ev("window.__vpSnap()")
            log(f"重渲染后视口: {after_rerender}（手动调过后应保持）")
            if after_rerender != zoomed:
                fails.append(f"重渲染把用户调过的缩放/位置改掉了：{zoomed} → {after_rerender}")
            # 显式「适应视图」：Ctrl+0（真实按键）→ 必须真的按画布大小适应
            press("0", "Digit0", 48, modifiers=2)
            drain(0.5)
            refit = ev("window.__vpSnap()")
            log(f"Ctrl+0 适应后: {refit}（应回到 {fitted}）")
            if refit != fitted:
                fails.append(f"Ctrl+0 没有回到适应值：{fitted} → {refit}")
            # 状态栏那一项仍是「回到 100%」（与「适应视图」是两回事）
            ev("document.querySelector('#statusbar [data-a=zoom]').click()")
            drain(0.5)
            hundred = ev("window.__vpSnap()")
            log(f"状态栏回到 100%: {hundred}")
            if str(hundred).split("|")[0] != "1":
                fails.append(f"状态栏缩放项没回到 100%：{hundred}")
            # 换文档 = 一次新的「初始化」：新文档仍要按画布适应
            fresh = ev(
                "(async () => {"
                "  await DGM.state.newDoc(['mermaid']);"
                "  DGM.editor.loadActive();"
                "  DGM.preview.schedule();"
                "  await new Promise(r => setTimeout(r, 900));"
                "  return window.__vpSnap();"
                "})()"
            )
            log(f"新文档（初始化）: {fresh}")
            if not fresh or fresh == hundred:
                fails.append(f"新文档没有重新适应视口：{hundred} → {fresh}")

        # ---- 断言 24：AI「有 token、没有正文」不再是空气泡 ----
        # 2026-10-14 用户报的 bug：用思考型模型改图，token 记了 2000+，对话里一个字都没有。
        # 根因：客户端只认 `delta.content`，把整条流的 `reasoning_content` 全丢了（真机抓包
        # 见 crates/ai/src/provider.rs 的 reasoning_content_frames_are_kept：104 帧全是思考）。
        # mock 里用 prompt 带 `[think]` 复现同一形态：先流思考、再以"没有正文"收尾 ——
        # 界面必须给出思考进度 + 一句说清为什么没有正文，而不是留一个空气泡。
        think = ev(
            "(async () => {"
            "  const before = DGM.state.usage.completion;"
            "  DGM.ai.focus('chat');"
            "  await new Promise(r => setTimeout(r, 150));"
            "  const ta = document.querySelector('#ai-input');"
            "  ta.value = '[think] 把配色改成暗色';"
            "  ta.dispatchEvent(new Event('input', { bubbles: true }));"  # 让发送按钮解禁（真实路径）
            "  document.querySelector('#ai-send').click();"
            "  await new Promise(r => setTimeout(r, 2500));"
            "  const s = document.querySelector('#ai-stream');"
            "  const notice = s.querySelector('.bubble.notice');"
            "  return JSON.stringify({"
            "    think: s.querySelectorAll('.think').length,"
            "    thinkBody: ((s.querySelector('.think-body') || {}).textContent || '').slice(0, 40),"
            "    notice: notice ? notice.textContent : '',"
            "    tokens: DGM.state.usage.completion - before"
            "  });"
            "})()"
        )
        log(f"思考型模型（无正文）: {think}")
        try:
            tk = json.loads(think or "{}")
            if not tk.get("think"):
                fails.append("思考型模型这一轮没有显示思考块（reasoning 又被丢了？）")
            if not tk.get("thinkBody"):
                fails.append("思考原文没有显示出来（用户只能看到一行摘要）")
            if not tk.get("notice"):
                fails.append("没有正文时界面没给任何说明（空气泡 = 用户报的 bug 原形）")
            elif "2088" not in tk.get("notice", ""):
                fails.append(f"说明里没带上思考 token 数：{tk.get('notice')}")
            if not (tk.get("tokens") or 0) > 0:
                fails.append(f"用量没记上（这一轮真的花了 token）：{tk.get('tokens')}")
        except Exception as e:
            log(f"（断言 24 解析失败：{e}）")

        # ---- 断言 25：渲染校验回环（渲染失败 → 自动修正一次；关掉开关就不修） ----
        # 设置里那个「渲染失败时把报错原文发回模型修正一次」的开关，在接上这条链路之前
        # 是个**空开关**：UI 上是开的，行为上什么都不做（全仓没有一处读 `render_retry`）。
        # 这里钉三件事：
        #   ① 坏语法落地后真的自动补发了一次（多一条 sys 提示 + 多一条回复）；
        #   ② 修正结果**自动落回文档**，不需要用户再点一次「应用」；
        #   ③ 关掉开关后**一次都不补发** —— 第二次是真实计费的调用，用户有权拒绝。
        # mock 夹具见 ipc.js `_aiText` 的 `[bad]` 分支（第一版坏语法、修正那版好语法）。
        def retry_round() -> str:
            return ev(
                "(async () => {"
                "  const s = document.querySelector('#ai-stream');"
                "  const snap = () => ({"
                "    msgs: s.querySelectorAll('.msg').length,"
                "    sys: s.querySelectorAll('.msg.sys').length,"
                "    body: DGM.editor.getValue() || ''"
                "  });"
                "  const d = DGM.state.docs.find(x => x.format === 'mermaid');"
                "  if (!d) return 'no-doc';"
                "  await DGM.state.activateDoc(d.id);"
                "  DGM.ai.focus('chat');"
                "  await new Promise(r => setTimeout(r, 250));"
                "  const before = snap();"
                "  const ta = document.querySelector('#ai-input');"
                "  ta.value = '[bad] 随便画一张';"
                "  ta.dispatchEvent(new Event('input', { bubbles: true }));"
                "  document.querySelector('#ai-send').click();"
                "  await new Promise(r => setTimeout(r, 2200));"  # 等第一版流完
                "  await DGM.ai.applyLast();"  # 落地 → 渲染失败 → 触发回环
                "  await new Promise(r => setTimeout(r, 4500));"  # 等自动修正那一轮跑完
                "  const after = snap();"
                "  return JSON.stringify({"
                "    dMsgs: after.msgs - before.msgs,"
                "    dSys: after.sys - before.sys,"
                "    body: after.body"
                "  });"
                "})()"
            )

        on_run = retry_round()
        log(f"渲染回环（开关开）: {on_run}")
        try:
            r = json.loads(on_run or "{}")
            if r.get("dSys") != 1:
                fails.append(f"渲染失败后没自动补发修正（sys 提示 {r.get('dSys')} 条，应为 1）")
            if (r.get("dMsgs") or 0) < 4:
                fails.append(f"自动修正没产生新回复（本轮只多了 {r.get('dMsgs')} 条消息）")
            if "([结束])" not in (r.get("body") or ""):
                fails.append("自动修正的结果没落回文档（还停在那版坏语法上）")
        except Exception as e:
            log(f"（断言 25 解析失败：{e}）")

        off_state = ev(
            "(async () => {"
            "  await DGM.state.patchSettings({ ai: { render_retry: false } });"
            "  await new Promise(r => setTimeout(r, 150));"
            "  return DGM.state.ai().render_retry === false ? 'off' : 'still-on';"
            "})()"
        )
        if off_state != "off":
            fails.append(f"渲染重试开关没关掉：{off_state}")
        else:
            off_run = retry_round()
            log(f"渲染回环（开关关）: {off_run}")
            try:
                r = json.loads(off_run or "{}")
                if r.get("dSys") != 0:
                    fails.append(f"关掉开关后仍然自动补发（sys {r.get('dSys')} 条）—— 第二次是真实计费调用")
                if (r.get("dMsgs") or 0) > 2:
                    fails.append(f"关掉开关后仍多出 {r.get('dMsgs')} 条消息（应只有本轮的用户+回复）")
            except Exception as e:
                log(f"（断言 25 关闭态解析失败：{e}）")
            # 复原：开关打开 + 文档回到可渲染的正文（后面的截图不该拍到错误面板）
            ev(
                "(async () => {"
                "  await DGM.state.patchSettings({ ai: { render_retry: true } });"
                "  await DGM.editor.applyBody('flowchart TD\\n    A([开始]) --> B[第一步]\\n    B --> C{判断}\\n    C --> D([结束])');"
                "  await new Promise(r => setTimeout(r, 500));"
                "  return 1;"
                "})()"
            )

        # ---- 断言 26：多轮消息真的把前序轮次带上了 ----
        # 阶段二之前这里是**单轮**：`build_messages` 每次只产出 system + 一条 user，
        # 界面上那个"对话"只是转录显示、不参与请求。这条断言钉住两个方向：
        # 第一轮带 0 条、第二轮带 2 条（上一轮的用户 + 回复）。
        # mock 夹具 `[hist]` 把"收到几条前序轮次"原样回报（见 ipc.js `_aiText`）。
        hist = ev(
            "(async () => {"
            "  DGM.ai.focus('chat');"
            "  await new Promise(r => setTimeout(r, 200));"
            "  DGM.ai.clear();"
            "  await new Promise(r => setTimeout(r, 200));"
            "  const ta = document.querySelector('#ai-input');"
            "  const send = async (v) => {"
            "    ta.value = v;"
            "    ta.dispatchEvent(new Event('input', { bubbles: true }));"
            "    document.querySelector('#ai-send').click();"
            "    await new Promise(r => setTimeout(r, 1800));"
            "  };"
            "  await send('[hist] 第一句');"
            "  await send('[hist] 第二句');"
            "  const txt = (document.querySelector('#ai-stream').textContent) || '';"
            "  return JSON.stringify({"
            "    first: txt.includes('前序轮次 0 条'),"
            "    second: txt.includes('前序轮次 2 条'),"
            "    tail: txt.slice(-80)"
            "  });"
            "})()"
        )
        log(f"多轮前序轮次: {hist}")
        try:
            r = json.loads(hist or "{}")
            if not r.get("first"):
                fails.append("第一轮不该带前序轮次（或多轮链路没接上）")
            if not r.get("second"):
                fails.append(f"第二轮没把上一轮带上去（单轮重建 messages）：{r.get('tail')}")
        except Exception as e:
            log(f"（断言 26 解析失败：{e}）")
            fails.append("断言 26 拿不到结果（多轮消息链路可能整个没接上）")

        # ---- 断言 27：会话按文档持久化（写盘 → 读回 → 按文档分开） ----
        # 阶段三之前：`conversations_dir()` 全仓零读写（只建了个空目录），而对话框的说明
        # 却写着"按文档稳定身份持久化（真实实现里路径 SHA256）"。这条断言钉住四件事：
        #   ① 一轮对话结束后**真的存了**（读回来的 turns 里有 user + assistant）；
        #   ② assistant 那条带上了模型名（否则还原后就只剩一句无出处的文本）；
        #   ③ 以磁盘为准重载后，内存条数与磁盘一致（读路径真的接通了）；
        #   ④ **按文档分开**：新开一份文档，它的会话是空的（不是把上一份带过来）。
        conv = ev(
            "(async () => {"
            "  DGM.ai.focus('chat');"
            "  await new Promise(r => setTimeout(r, 150));"
            "  DGM.ai.clear();"
            "  await new Promise(r => setTimeout(r, 250));"
            "  const d = DGM.state.activeDoc();"
            "  if (!d) return 'no-doc';"
            "  const ta = document.querySelector('#ai-input');"
            "  ta.value = '画一张流程';"
            "  ta.dispatchEvent(new Event('input', { bubbles: true }));"
            "  document.querySelector('#ai-send').click();"
            # 生成档的回复很长（mock 每 42ms 推一小段），**必须等够**：
            # 等短了会读到"消息还在流、onDone 还没跑"的中间态，看起来像落盘坏了。
            "  await new Promise(r => setTimeout(r, 6000));"
            "  const mem = DGM.ai.turnCount();"
            "  const saved = await DGM.ipc.invoke('conversation_load', { id: d.id });"
            "  const turns = (saved && saved.turns) || [];"
            "  await DGM.ai.ensureConversation(d.id, true);"
            "  await new Promise(r => setTimeout(r, 400));"
            "  const after = DGM.ai.turnCount();"
            "  const fresh = await DGM.state.newDoc(['mermaid']);"
            "  await new Promise(r => setTimeout(r, 400));"
            "  const other = DGM.ai.turnCount();"
            "  return JSON.stringify({"
            "    mem,"
            "    n: turns.length,"
            "    roles: turns.map(x => x.role),"
            "    model: (turns[1] || {}).model || '',"
            "    hasImage: JSON.stringify(turns).includes('data:image'),"
            "    after,"
            "    other,"
            "    freshOk: !!fresh"
            "  });"
            "})()"
        )
        log(f"会话持久化: {conv}")
        try:
            r = json.loads(conv or "{}")
            if (r.get("n") or 0) < 2:
                fails.append(f"一轮对话结束后没落盘（内存 {r.get('mem')} 条 / 磁盘读回 {r.get('n')} 条）")
            elif r.get("roles") != ["user", "assistant"]:
                fails.append(f"落盘的轮次角色不对：{r.get('roles')}")
            if not r.get("model"):
                fails.append("落盘的 assistant 轮次没带模型名（还原后无从展示出处）")
            if r.get("hasImage"):
                fails.append("会话里出现了 data:image —— 图片绝不能落盘")
            if r.get("after") != r.get("n"):
                fails.append(f"以磁盘为准重载后条数对不上：内存 {r.get('after')} / 磁盘 {r.get('n')}")
            if not r.get("freshOk"):
                fails.append("新开文档失败，无法验证会话按文档分开")
            elif r.get("other") != 0:
                fails.append(f"新文档不该带着上一份的会话（拿到 {r.get('other')} 条）")
        except Exception as e:
            log(f"（断言 27 解析失败：{e}）")
            fails.append("断言 27 拿不到结果（会话持久化链路可能整个没接上）")

        # ---- 断言 28：长期记忆（候选不生效 → 确认后才生效；前端不自己注入） ----
        # 三条最要紧的性质在这里钉住：
        #   ① 自动提取出来的候选是 `pending`，**不注入 prompt**（注入与否的语义由
        #      app-core::memory 的单测覆盖，这里管的是"它真的落在 pending 上"）；
        #   ② 关掉 `memory_auto` 后**不再发那次额外调用**（它是真实计费的）；
        #   ③ 前端**不得**自己往请求里塞记忆 —— 注入只该发生在 Rust 的 `ai_chat` 一处，
        #      前端再塞一份就是双重注入（mock 夹具 `[mem]` 回报这件事）。
        mem = ev(
            "(async () => {"
            "  const items = () => ((DGM.state.memory && DGM.state.memory.items) || []);"
            "  const bar = document.querySelector('#ai-memory-bar');"
            "  const out = {};"
            "  await DGM.state.memoryClear('all');"
            "  await DGM.state.patchSettings({ ai: { memory_enabled: true, memory_auto: true } });"
            "  DGM.ai.focus('chat');"
            "  await new Promise(r => setTimeout(r, 250));"
            "  DGM.ai.clear();"
            "  await new Promise(r => setTimeout(r, 300));"
            "  const ta = document.querySelector('#ai-input');"
            "  const send = async (v) => {"
            "    ta.value = v;"
            "    ta.dispatchEvent(new Event('input', { bubbles: true }));"
            "    document.querySelector('#ai-send').click();"
            "    await new Promise(r => setTimeout(r, 2200));"
            "  };"
            # ① 带 [remember] 的一轮 → 自动提取出一条 pending
            "  await send('[remember] 配色一律用暗色');"
            "  await new Promise(r => setTimeout(r, 800));"
            "  out.afterExtract = items().length;"
            "  out.pendingState = (items()[0] || {}).state || '';"
            "  out.barShown = !!bar && !bar.hidden;"
            # ② 关掉自动提取后再聊一轮 → 不该再添候选
            "  await DGM.state.patchSettings({ ai: { memory_auto: false } });"
            "  await send('[remember] 节点不要圆角');"
            "  await new Promise(r => setTimeout(r, 800));"
            "  out.afterAutoOff = items().length;"
            "  await DGM.state.patchSettings({ ai: { memory_auto: true } });"
            # ③ 前端不得自己注入记忆
            "  await send('[mem] 顺便画一张');"
            "  const txt = document.querySelector('#ai-stream').textContent || '';"
            "  out.clientInjected = txt.includes('客户端注入了记忆：是');"
            # ④ 确认那条候选 → confirmed，提示条消失
            "  const first = items().filter(x => x.state === 'pending')[0];"
            "  if (first) await DGM.state.memorySave({ ...first, state: 'confirmed' });"
            "  out.confirmed = items().filter(x => x.state === 'confirmed').length;"
            "  out.stillPending = items().filter(x => x.state === 'pending').length;"
            "  out.barHiddenAfterConfirm = !!bar && bar.hidden;"
            # ⑤ 停用后不计入注入（此处只验证开关落盘；注入过滤由单测覆盖）
            "  const conf = items().filter(x => x.state === 'confirmed')[0];"
            "  if (conf) await DGM.state.memorySave({ ...conf, enabled: false });"
            "  out.disabled = items().filter(x => x.enabled === false).length;"
            # ⑥ 清空
            "  await DGM.state.memoryClear('all');"
            "  out.afterClear = items().length;"
            "  return JSON.stringify(out);"
            "})()"
        )
        log(f"长期记忆: {mem}")
        try:
            r = json.loads(mem or "{}")
            if r.get("afterExtract") != 1:
                fails.append(f"带 [remember] 的一轮没产出候选（拿到 {r.get('afterExtract')} 条）")
            if r.get("pendingState") != "pending":
                fails.append(f"自动候选不是 pending（拿到 {r.get('pendingState')!r}）—— 候选必须等用户确认")
            if not r.get("barShown"):
                fails.append("有待确认候选但提示条没出现（用户无从知道 AI 提议记了什么）")
            if r.get("afterAutoOff") != 1:
                fails.append(f"关掉自动提取后仍然新增候选（{r.get('afterAutoOff')} 条）—— 那是真实计费的调用")
            if r.get("clientInjected"):
                fails.append("前端自己往请求里塞了记忆 —— 注入只该在 Rust 一处，否则双重注入")
            if r.get("confirmed") != 1 or r.get("stillPending") != 0:
                fails.append(f"确认候选失败：confirmed={r.get('confirmed')} pending={r.get('stillPending')}")
            if not r.get("barHiddenAfterConfirm"):
                fails.append("候选确认后提示条仍在（会一直催用户）")
            if r.get("disabled") != 1:
                fails.append(f"停用没有落盘（enabled=false 的条目 {r.get('disabled')} 条）")
            if r.get("afterClear") != 0:
                fails.append(f"清空后仍有 {r.get('afterClear')} 条")
        except Exception as e:
            log(f"（断言 28 解析失败：{e}）")
            fails.append("断言 28 拿不到结果（长期记忆链路可能整个没接上）")

        # ---- 断言 29：受控工具循环（开关分流 + 工具活动行 + 最终正文可应用） ----
        # ① 关着时走 `ai_chat`（流式：气泡里出现 delta 帧）；
        # ② 开着时走 `ai_agent_run`：气泡里出现工具活动行（read_document / validate）、
        #    请求体里**不该**再逐字流式（非流式的特征是 delta 帧为 0）；
        # ③ 最终正文带合法代码块 —— 与 ai_chat 共用同一收尾（ai://done）。
        agent = ev(
            "(async () => {"
            "  const out = {};"
            # 等到不忙为止：上一轮的记忆提取调用也会占着 busy（断言 28 留下的状态），
            # 固定等待会被它拖爆 —— 2026-10-16 断言 29 的假失败就是这条。
            "  const waitIdle = async () => {"
            "    for (let i = 0; i < 40 && DGM.state.ui.aiBusy; i++) await new Promise(r => setTimeout(r, 150));"
            "  };"
            "  const ta = document.querySelector('#ai-input');"
            "  const send = async (v) => {"
            "    ta.value = v;"
            "    ta.dispatchEvent(new Event('input', { bubbles: true }));"
            "    document.querySelector('#ai-send').click();"
            "    await waitIdle();"
            "    await new Promise(r => setTimeout(r, 300));"
            "  };"
            "  DGM.ai.focus('chat');"
            "  await new Promise(r => setTimeout(r, 250));"
            # 记忆提取（memory_auto）会额外发一轮流式调用，混进 delta 计数 —— 这里关掉
            "  await DGM.state.patchSettings({ ai: { memory_auto: false, tools_enabled: false } });"
            "  DGM.ai.clear();"
            "  await waitIdle();"
            "  await new Promise(r => setTimeout(r, 300));"
            # ① 开关关：流式（delta 帧数 > 0 是 mock 流式的直接证据）
            "  let deltas = 0;"
            "  const onDelta = () => deltas++;"
            "  const off1 = DGM.ipc.on('ai://delta', onDelta);"
            "  await send('[agent] 画一张');"
            "  out.offDeltas = deltas;"
            "  off1();"
            # ② 开关开：工具活动行出现、非流式
            "  deltas = 0;"
            "  let agentEvents = 0;"
            "  const off2 = DGM.ipc.on('ai://delta', onDelta);"
            "  const off3 = DGM.ipc.on('ai://agent', () => agentEvents++);"
            "  await DGM.state.patchSettings({ ai: { tools_enabled: true } });"
            "  out.setAfter = (DGM.state.settings.ai || {}).tools_enabled;"
            "  await send('[agent] 再画一张');"
            "  out.onDeltas = deltas;"
            "  out.agentEvents = agentEvents;"
            "  off2();"
            "  off3();"
            "  const steps = [...document.querySelectorAll('#ai-stream .agent-step b')].map(x => x.textContent);"
            "  out.steps = steps;"
            "  const stream = document.querySelector('#ai-stream');"
            "  out.hasCode = (stream.textContent || '').includes('flowchart TD');"
            "  await DGM.state.patchSettings({ ai: { tools_enabled: false, memory_auto: true } });"
            "  return JSON.stringify(out);"
            "})()"
        )
        log(f"工具循环: {agent}")
        try:
            r = json.loads(agent or "{}")
            if (r.get("offDeltas") or 0) <= 0:
                fails.append("开关关着时没有流式帧 —— ai_chat 的流式路径被误伤")
            if not r.get("setAfter"):
                fails.append("patchSettings 没能把 tools_enabled 打开（设置链路有问题）")
            if (r.get("agentEvents") or 0) < 2:
                fails.append(f"ai://agent 事件只有 {r.get('agentEvents')} 条 —— 前端没收到工具活动（ai_agent_run 可能没被调用）")
            if (r.get("onDeltas") or 0) != 0:
                fails.append(f"开关开着时仍出现了 {r.get('onDeltas')} 帧流式 —— 应走非流式的 ai_agent_run")
            steps = r.get("steps") or []
            if "read_document" not in steps or "validate" not in steps:
                fails.append(f"工具活动行缺失：{steps}（应有 read_document 与 validate）")
            if not r.get("hasCode"):
                fails.append("工具循环的最终正文里没有代码块 —— 收尾没有走到 ai://done 的渲染路径")
        except Exception as e:
            log(f"（断言 29 解析失败：{e}）")
            fails.append("断言 29 拿不到结果（工具循环链路可能整个没接上）")

        # ---- 断言 30：PNG 导出在含 <br> 的标签上不炸 ----
        # 2026-10-16 用户真机报「位图栅格化失败」：mermaid 的 htmlLabels 把标签里的
        # `<br>` 以未闭合 HTML 写进 <foreignObject>，导出时按 image/svg+xml 严格解析
        # 直接 parsererror。修复是优先克隆**活着的 DOM 节点**（XMLSerializer 必然良构）。
        # 这条断言钉住：正文带 <br> / & 的 mermaid 文档必须能出 PNG。
        png = ev(
            "(async () => {"
            "  const d = DGM.state.activeDoc();"
            "  if (!d) return JSON.stringify({fail:'no doc'});"
            "  const prev = d.body;"
            "  await DGM.state.setBody(d.id, 'flowchart TD\\n    A[\"AT&T <br>换行\"] --> B[结束]');"
            "  DGM.preview.render();"
            "  await new Promise(r => setTimeout(r, 2600));"
            "  const out = {};"
            "  try { const u = await DGM.preview.toPngDataUrl(); out.png = 'ok:len=' + u.length; }"
            "  catch (e) { out.png = 'fail: ' + (e && e.message || e); }"
            "  await DGM.state.setBody(d.id, prev);"
            "  DGM.preview.render();"
            "  await new Promise(r => setTimeout(r, 800));"
            "  return JSON.stringify(out);"
            "})()"
        )
        log(f"PNG导出br回归: {png}")
        try:
            r = json.loads(png or "{}")
            if not str(r.get("png", "")).startswith("ok:"):
                fails.append(f"含 <br> 标签的图导出 PNG 失败：{r.get('png')}（foreignObject 的未闭合 HTML 又把 XML 解析炸了）")
        except Exception as e:
            log(f"（断言 30 解析失败：{e}）")
            fails.append("断言 30 拿不到结果（PNG 导出链路可能整个没接上）")

        # ---- 断言 31：被输出上限截断的正文必须说出来 ----
        # 2026-10-18 用户真机实录：让 AI 按业务优化样式，界面走到「5906 tok」就没了下文，
        # 正文切在 `classDef device fill:#D` 半句上，**没有任何提示**。查线上 `ai_usage`：
        # status=ok / finish_reason=length / completion=4096（其中 2866 是思考）—— 上游说清
        # "我撞上限了"，网关也原样转发了，是客户端整包丢掉了 `finish_reason`。
        # 这条断言钉住：有正文但流不是正常收尾时，界面必须给一句说明。
        # mock 夹具见 ipc.js `_aiChat` 的 `[cut]` 分支（正文半句 + finish:"length"）。
        # 正文气泡取**最后一条**（前面的断言在同一个 AI 流里也留过气泡，取第一条会看错对象）。
        cut = ev(
            "(async () => {"
            "  const before = DGM.state.usage.completion;"
            "  DGM.ai.focus('chat');"
            "  await new Promise(r => setTimeout(r, 150));"
            "  const ta = document.querySelector('#ai-input');"
            "  ta.value = '[cut] 帮我根据业务优化样式、图标';"
            "  ta.dispatchEvent(new Event('input', { bubbles: true }));"
            "  document.querySelector('#ai-send').click();"
            "  await new Promise(r => setTimeout(r, 2200));"
            "  const s = document.querySelector('#ai-stream');"
            "  const notice = s.querySelector('.bubble.notice');"
            "  const bodies = s.querySelectorAll('.bubble[data-req]:not(.notice)');"
            "  const body = bodies[bodies.length - 1];"
            "  return JSON.stringify({"
            "    text: body ? body.textContent.slice(-80) : '',"
            "    notice: notice ? notice.textContent : '',"
            "    tokens: DGM.state.usage.completion - before"
            "  });"
            "})()"
        )
        log(f"被输出上限截断: {cut}")
        try:
            c = json.loads(cut or "{}")
            if "classDef device" not in (c.get("text") or ""):
                fails.append(f"截断那轮的正文没落到气泡里：{c.get('text')!r}")
            if not c.get("notice"):
                fails.append("正文被截断了，界面一个字都没说（用户报的 bug 原形）")
            elif "输出上限" not in c.get("notice", ""):
                fails.append(f"截断说明没点明是输出上限：{c.get('notice')}")
            if not (c.get("tokens") or 0) > 0:
                fails.append(f"截断这一轮的用量没记上：{c.get('tokens')}")
        except Exception as e:
            log(f"（断言 31 解析失败：{e}）")
            fails.append("断言 31 拿不到结果（截断提示链路没接上）")

        # ---- 断言 32：思考块能折叠 / 展开，且用户的选择不被重排冲掉 ----
        # 3.2.0 起思考原文会显示，但**收尾时被整块丢掉**：有正文的那一轮，用户事后
        # 再也读不到推理过程（那是花了 token 换来的）。这条钉四件事：
        #   ① 有正文的收尾**自动收起**（要读的是正文），但原文仍在 DOM 里、可展开；
        #   ② 点摘要行展开（原文可读）、再按 Enter 收起；
        #   ③ 用户点过之后，整栏重排（切页签/切文档）不再改他的选择；
        #   ④ 没有正文的那一轮**默认展开** —— 推理是那一轮唯一的产出。
        # mock 夹具 `[thinktext]` 复现"先思考、后正文"的真机次序（见 ipc.js）。
        collapse = ev(
            "(async () => {"
            "  const out = {};"
            "  const waitIdle = async () => {"
            "    for (let i = 0; i < 40 && DGM.state.ui.aiBusy; i++) await new Promise(r => setTimeout(r, 150));"
            "  };"
            "  const rows = () => [...document.querySelectorAll('#ai-stream .think[role=\"button\"]')];"
            "  const row = () => rows()[rows().length - 1] || null;"
            "  const snap = () => {"
            "    const r = row();"
            "    const b = r ? r.nextElementSibling : null;"  # 原文块就是摘要行的下一个兄弟
            "    const isBody = !!(b && b.classList.contains('think-body'));"
            "    return {"
            "      expanded: r ? r.getAttribute('aria-expanded') : 'no-row',"
            "      hidden: isBody ? b.hidden : 'no-body',"
            "      chars: isBody ? (b.textContent || '').length : 0"
            "    };"
            "  };"
            "  await DGM.state.patchSettings({ ai: { memory_auto: false, tools_enabled: false } });"
            "  DGM.ai.focus('chat');"
            "  await new Promise(r => setTimeout(r, 200));"
            "  DGM.ai.clear();"
            "  await new Promise(r => setTimeout(r, 250));"
            "  const ta = document.querySelector('#ai-input');"
            "  const send = async (v) => {"
            "    ta.value = v;"
            "    ta.dispatchEvent(new Event('input', { bubbles: true }));"
            "    document.querySelector('#ai-send').click();"
            "    await waitIdle();"
            "    await new Promise(r => setTimeout(r, 300));"
            "  };"
            # ① 先思考、后正文 → 收尾自动收起，但原文还在
            "  await send('[thinktext] 把配色改成暗色');"
            "  out.afterDone = snap();"
            "  out.label = row() ? row().textContent.trim() : '';"
            # ② 点开 → 原文可读；键盘 Enter 收起
            "  row().click();"
            "  await new Promise(r => setTimeout(r, 80));"
            "  out.opened = snap();"
            # ③ 整栏重排（focus 会 render）不该改用户的选择
            "  DGM.ai.focus('chat');"
            "  await new Promise(r => setTimeout(r, 150));"
            "  out.afterRerender = snap();"
            "  row().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));"
            "  await new Promise(r => setTimeout(r, 80));"
            "  out.closedByKey = snap();"
            # ④ 没有正文的那一轮：默认展开
            "  await send('[think] 只看不画');"
            "  out.noText = snap();"
            "  await DGM.state.patchSettings({ ai: { memory_auto: true } });"
            "  return JSON.stringify(out);"
            "})()"
        )
        log(f"思考块折叠: {collapse}")
        try:
            r = json.loads(collapse or "{}")
            after, opened, rerender, closed, no_text = (
                r.get("afterDone") or {},
                r.get("opened") or {},
                r.get("afterRerender") or {},
                r.get("closedByKey") or {},
                r.get("noText") or {},
            )
            if after.get("expanded") != "false":
                fails.append(f"有正文的收尾没有自动收起思考块（aria-expanded={after.get('expanded')}）")
            if after.get("chars") in (0, None):
                fails.append(f"收尾后思考原文被丢掉了（{after.get('chars')} 字）—— 用户再也读不到推理过程")
            elif after.get("hidden") is not True:
                fails.append(f"收起状态的原文块没藏起来（hidden={after.get('hidden')}）")
            if opened.get("expanded") != "true":
                fails.append(f"点摘要行没能展开（aria-expanded={opened.get('expanded')}）")
            elif opened.get("hidden") is not False:
                fails.append(f"展开后原文块仍然藏着（hidden={opened.get('hidden')}）")
            if not (opened.get("chars") or 0) > 0:
                fails.append("展开后没读到思考原文")
            if rerender.get("expanded") != "true":
                fails.append(f"整栏重排把用户的展开状态冲掉了（aria-expanded={rerender.get('expanded')}）")
            if closed.get("expanded") != "false" or closed.get("hidden") is not True:
                fails.append(f"键盘 Enter 没能收起（aria-expanded={closed.get('expanded')} / hidden={closed.get('hidden')}）")
            if no_text.get("expanded") != "true":
                fails.append(f"没有正文的那一轮思考块该默认展开（aria-expanded={no_text.get('expanded')}）")
        except Exception as e:
            log(f"（断言 32 解析失败：{e}）")
            fails.append("断言 32 拿不到结果（思考块折叠链路可能整个没接上）")

        # ---- 断言 33：模型的「空闲超时」存得下、读得回、留空即自动 ----
        # BYOK 直连的对面不发心跳，而本地 Ollama 冷启动加载权重常 >90s 才吐第一个字节 ——
        # 这一格就是让用户按模型把"空闲多久算死"调开（Rust 侧 `ai::provider::idle_timeout_for`：
        # 留空 = ollama 300s / 其它 90s，填了钳到 15–1800）。
        # 钉的是**设置这条链路**：填 45 → 保存 → 重开还是 45；清空 → 保存 → 重开是空（null）。
        idle = ev(
            "(async () => {"
            "  const open = async () => { DGM.dialogs.settings('ai'); await new Promise(r => setTimeout(r, 200)); };"
            "  const box = () => { const rows = document.querySelectorAll('#model-list .model-row');"
            "    return rows.length ? rows[rows.length - 1].querySelector('[data-f=\"idle_timeout_s\"]') : null; };"
            "  const put = (v) => { const b = box(); if (!b) return 'missing'; b.value = v; return b.value; };"
            "  const save = async () => { [...document.querySelectorAll('[data-act]')].find(b => b.dataset.act === 'save').click();"
            "    await new Promise(r => setTimeout(r, 260)); };"
            "  const stored = () => { const ms = DGM.state.settings.ai.models || [];"
            "    return ms.length ? (ms[ms.length - 1].idle_timeout_s === undefined ? 'undefined' : ms[ms.length - 1].idle_timeout_s) : 'no-model'; };"
            "  await open();"
            "  const initial = put('45');"
            "  await save();"
            "  const afterSave = stored();"
            "  await open();"
            "  const savedShown = box() ? box().value : 'missing';"
            "  put('');"
            "  await save();"
            "  const afterClear = stored();"
            "  await open();"
            "  const clearedShown = box() ? box().value : 'missing';"
            "  DGM.dialogs.close();"
            "  await new Promise(r => setTimeout(r, 120));"
            "  return JSON.stringify({ initial, afterSave, savedShown, afterClear, clearedShown });"
            "})()"
        )
        log(f"空闲超时字段: {idle}")
        try:
            r = json.loads(idle or "{}")
            if r.get("afterSave") != 45:
                fails.append(f"填了 45 保存后没落到 settings（idle_timeout_s={r.get('afterSave')!r}）")
            if r.get("savedShown") != "45":
                fails.append(f"重开设置后那一格没回显 45（{r.get('savedShown')!r}）")
            if r.get("afterClear") not in (None, "undefined"):
                fails.append(f"清空后应落成 null（留空 = 自动），实际 {r.get('afterClear')!r}")
            if r.get("clearedShown") != "":
                fails.append(f"清空保存后那一格不是空的（{r.get('clearedShown')!r}）")
        except Exception as e:
            log(f"（断言 33 解析失败：{e}）")
            fails.append("断言 33 拿不到结果（空闲超时那一格没接上）")

        # ---- 断言 34：思考原文随会话落盘，下次启动能加载回来 ----
        # 3.5.3 起思考块可折叠，但推理只活在内存里 —— 重启后还原的轮次连块都没有，
        # "随时点开重读"就成了空话（而推理是真实计费的产出）。这条钉四件事：
        #   ① 有正文的那一轮，思考原文真的写进了磁盘（`conversation_load` 读回来带着它）；
        #   ② **只有思考、没有正文**的那一轮也会落盘（推理是那一轮唯一的产出）；
        #   ③ 以磁盘为准重载后，思考块在界面上重新出现（渲染路径真的接上了）；
        #   ④ 界面条数与磁盘条数一致（`persistConversation` / `turnsFor` 共用同一判据）。
        persist_think = ev(
            "(async () => {"
            "  const out = {};"
            "  const waitIdle = async () => {"
            "    for (let i = 0; i < 40 && DGM.state.ui.aiBusy; i++) await new Promise(r => setTimeout(r, 150));"
            "  };"
            "  await DGM.state.patchSettings({ ai: { memory_auto: false, tools_enabled: false } });"
            "  DGM.ai.focus('chat');"
            "  await new Promise(r => setTimeout(r, 200));"
            "  DGM.ai.clear();"
            "  await new Promise(r => setTimeout(r, 250));"
            "  const d = DGM.state.activeDoc();"
            "  if (!d) return 'no-doc';"
            "  const ta = document.querySelector('#ai-input');"
            "  const send = async (v) => {"
            "    ta.value = v;"
            "    ta.dispatchEvent(new Event('input', { bubbles: true }));"
            "    document.querySelector('#ai-send').click();"
            "    await waitIdle();"
            "    await new Promise(r => setTimeout(r, 300));"
            "  };"
            "  await send('[thinktext] 把配色改成暗色');"  # 先思考、后正文
            "  await send('[think] 只看不画');"  # 只有思考、没有正文
            "  const saved = await DGM.ipc.invoke('conversation_load', { id: d.id });"
            "  const turns = (saved && saved.turns) || [];"
            "  const bots = turns.filter(t => t.role === 'assistant');"
            "  out.n = turns.length;"
            "  out.bots = bots.length;"
            "  out.withThink = bots.filter(t => (t.thinking || '').includes('先读一遍这张图')).length;"
            "  out.thinkOnly = bots.filter(t => !(t.text || '').trim() && (t.thinking || '').trim()).length;"
            "  out.memTurns = DGM.ai.turnCount();"
            "  out.memWithThink = DGM.ai.turnsFor().filter(t => (t.thinking || '').trim()).length;"
            "  await DGM.ai.ensureConversation(d.id, true);"  # 以磁盘为准重载
            "  await new Promise(r => setTimeout(r, 400));"
            "  out.afterTurns = DGM.ai.turnCount();"
            "  out.restoredRows = document.querySelectorAll('#ai-stream .think[role=\"button\"]').length;"
            "  out.restoredBodies = [...document.querySelectorAll('#ai-stream .think-body')]"
            "    .filter(b => (b.textContent || '').includes('先读一遍这张图')).length;"
            "  return JSON.stringify(out);"
            "})()"
        )
        log(f"思考原文持久化: {persist_think}")
        try:
            r = json.loads(persist_think or "{}")
            if (r.get("withThink") or 0) < 2:
                fails.append(f"落盘的轮次没带上思考原文（只有 {r.get('withThink')} 条带）")
            if (r.get("thinkOnly") or 0) < 1:
                fails.append("只有思考、没有正文的那一轮没落盘 —— 推理是那一轮唯一的产出")
            if r.get("memTurns") != r.get("n"):
                fails.append(f"界面条数与落盘条数对不上：内存 {r.get('memTurns')} / 磁盘 {r.get('n')}")
            if (r.get("memWithThink") or 0) < 2:
                fails.append(f"turnsFor 没把思考原文带给（历史会话）对话框：{r.get('memWithThink')} 条带")
            if r.get("afterTurns") != r.get("n"):
                fails.append(f"以磁盘为准重载后条数对不上：{r.get('afterTurns')} / {r.get('n')}")
            if (r.get("restoredRows") or 0) < 2:
                fails.append(f"重载后思考块没回来（界面上只有 {r.get('restoredRows')} 个折叠块）")
            if (r.get("restoredBodies") or 0) < 2:
                fails.append(f"重载后思考原文没渲染出来（{r.get('restoredBodies')} 块带原文）")
        except Exception as e:
            log(f"（断言 34 解析失败：{e}）")
            fails.append("断言 34 拿不到结果（思考原文的落盘/加载链路可能没接上）")

        # ---- 断言 35：欢迎页最近 5 条 +「更多」→ 文件打开历史 ----
        # 用户 2026-10-18 提的两件事：
        #   ① 欢迎页的「最近」只留 5 条，并多一个「更多」按钮，点开**文件打开历史**窗口；
        #   ② 文件菜单「最近打开文件 → 更多」以前打开的是 **AI 会话历史**（`dialogs.history`），
        #      与"最近文件"四个字对不上 —— 必须开同一个文件历史窗口。
        # 这条还钉住：窗口里点一行**真的打开文件**（走 `DGM.shell.openPath`，与欢迎页/侧栏同一入口）。
        recent = ev(
            "(async () => {"
            "  const out = {};"
            "  const seed = Array.from({ length: 7 }, (_, i) => ({"
            "    path: 'E:/tmp/probe-recent-' + (i + 1) + '.mmd',"
            "    name: 'probe-recent-' + (i + 1) + '.mmd',"
            "    format: 'mermaid',"
            "    opened_at: Date.now() - i * 60000"
            "  }));"
            "  const before = (DGM.state.settings.recent || []).slice();"
            "  await DGM.state.patchSettings({ recent: seed });"
            "  out.seeded = (DGM.state.settings.recent || []).length;"
            "  for (const doc of [...DGM.state.docs]) await DGM.state.closeDoc(doc.id);"  # 无文档 = 欢迎页
            "  await new Promise(r => setTimeout(r, 400));"
            "  const w = document.querySelector('#welcome');"
            "  out.welcomeShown = !!w && !w.hidden;"
            "  out.rowCount = w ? w.querySelectorAll('[data-recent]').length : 0;"
            "  const more = document.querySelector('#w-recent-more');"
            "  out.hasMore = !!more;"
            "  more.click();"
            "  await new Promise(r => setTimeout(r, 150));"
            "  const dlg = document.querySelector('#dialog');"
            "  out.title = ((dlg && dlg.querySelector('h2')) || {}).textContent || '';"
            "  out.rows = dlg ? dlg.querySelectorAll('#recent-rows .hist-row').length : 0;"
            "  const f = document.querySelector('#recent-filter');"
            "  out.hasFilter = !!f;"
            "  f.value = 'probe-recent-3';"
            "  f.dispatchEvent(new Event('input', { bubbles: true }));"
            "  await new Promise(r => setTimeout(r, 100));"
            "  const kept = dlg.querySelectorAll('#recent-rows .hist-row');"
            "  out.filtered = kept.length;"
            "  out.filterKeepsFocus = document.activeElement === f;"
            "  kept[0].click();"
            "  await new Promise(r => setTimeout(r, 600));"
            "  out.openedPath = ((DGM.state.docs.find(x => x.path === 'E:/tmp/probe-recent-3.mmd')) || {}).path || '';"
            "  out.dialogClosed = document.querySelector('#overlay-dialog').hidden;"
            "  DGM.shell.runCommand('file.recent');"  # 菜单「更多」走的就是这条命令
            "  await new Promise(r => setTimeout(r, 200));"
            "  const dlg2 = document.querySelector('#dialog');"
            "  out.cmdTitle = ((dlg2 && dlg2.querySelector('h2')) || {}).textContent || '';"
            "  out.aiTitle = DGM.i18n.t('dlg.history.title');"
            "  DGM.dialogs.close();"
            "  await DGM.state.patchSettings({ recent: before });"
            "  await DGM.state.newDoc(['mermaid']);"  # 收尾留一份文档（后面的截图不该拍到欢迎页）
            "  return JSON.stringify(out);"
            "})()"
        )
        log(f"最近文件 / 打开历史窗口: {recent}")
        try:
            r = json.loads(recent or "{}")
            if r.get("seeded") != 7:
                fails.append(f"recent 没按预期落成 7 条（拿到 {r.get('seeded')}）—— 后面的断言不可信")
            if not r.get("welcomeShown"):
                fails.append("关掉所有文档后欢迎页没显示出来")
            if r.get("rowCount") != 5:
                fails.append(f"欢迎页「最近」应只列 5 条（拿到 {r.get('rowCount')}）")
            if not r.get("hasMore"):
                fails.append("欢迎页「最近」没有「更多」按钮")
            if r.get("title") != "文件打开历史":
                fails.append(f"「更多」打开的窗口标题不是「文件打开历史」：{r.get('title')!r}")
            if r.get("rows") != 7:
                fails.append(f"文件打开历史窗口没列出全部 7 条（拿到 {r.get('rows')}）")
            if not r.get("hasFilter") or r.get("filtered") != 1:
                fails.append(f"过滤框没起作用（过滤后 {r.get('filtered')} 条）")
            if not r.get("filterKeepsFocus"):
                fails.append("过滤时输入框丢了焦点（列表重绘把输入框也重画了？）")
            if r.get("openedPath") != "E:/tmp/probe-recent-3.mmd":
                fails.append(f"点窗口里的一行没打开那份文件（拿到 {r.get('openedPath')!r}）")
            if not r.get("dialogClosed"):
                fails.append("点了行之后窗口没关")
            if not r.get("cmdTitle") or r.get("cmdTitle") == r.get("aiTitle"):
                fails.append(f"菜单里的「更多」仍然打开 AI 会话历史（标题 {r.get('cmdTitle')!r}）")
            elif r.get("cmdTitle") != "文件打开历史":
                fails.append(f"菜单里的「更多」没打开文件打开历史窗口：{r.get('cmdTitle')!r}")
        except Exception as e:
            log(f"（断言 35 解析失败：{e}）")
            fails.append("断言 35 拿不到结果（欢迎页/最近文件链路可能没接上）")

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
