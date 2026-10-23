#!/usr/bin/env python
"""C4-0 性能基线探针(C4-① 的数据来源)：在浏览器原型(mock 后端)里实测大图的
主线程渲染阻塞时长 X(阈值默认 200ms)。

    python tools/dev/perf_baseline.py [--nodes 4000]

背景(架构-改善型C4C5方案 §4)：C4-① 的 AC4-1 要求"先测量定阈值 X，超 200ms 才
考虑上渲染切帧/外置"。本探针把"卡"从不可控变成可量化，给测试一个可重复测法。

测两档,都走真实引擎:
  1) 应用级: 只低于 guard 阈值(默认 4800 行 < 5000)的较大图,走 DGM.preview.render()
     —— 测"正常能渲染的大图"在预览链路上主线程最长阻塞(这正是日常会卡的档位)。
  2) 引擎级(万行): 直接用 window.mermaid.render() 渲染 ~N 节点的长图(绕过应用的
     guard 守卫,那是 C4-③ 的提示流,不影响测引擎本身的布局+SVG 成本),用
     PerformanceObserver('longtask') 采主线程长任务。该档接近"万行图强渲染"的实况。

输出 JSON 均记在 ui/.shots/perf-baseline.json,给 check.mjs 之外的测试人回读。
dev 探针,不进包(AGENTS.md: tools/** 不进包)。
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SHOTS = ROOT / "ui" / ".shots"

sys.path.insert(0, str(ROOT / "tools" / "dev"))
from ui_probe import serve_ui, log  # noqa: E402  (复用同一套静态服务器)
from canvas_probe import Cdp as CDP, find_chrome, free_port  # noqa: E402


def main() -> int:
    nodes = 4000
    if "--nodes" in sys.argv:
        try:
            nodes = int(sys.argv[sys.argv.index("--nodes") + 1])
        except Exception:
            pass

    chrome = find_chrome()
    if not chrome:
        log("✗ 找不到 Chrome/Edge")
        return 2
    srv, ui_port = serve_ui()
    dbg_port = free_port()
    no_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    user_data = tempfile.mkdtemp(prefix="dgm-perf-")
    proc = subprocess.Popen(
        [
            chrome,
            "--headless=new",
            f"--remote-debugging-port={dbg_port}",
            f"--user-data-dir={user_data}",
            "--no-first-run",
            "--disable-gpu",
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
    try:
        ws_url = None
        for _ in range(50):
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
        cdp = CDP(ws_url, timeout=60)
        cdp.send("Runtime.enable")
        cdp.send("Page.enable")
        cdp.send("Emulation.setDeviceMetricsOverride",
                 {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})

        def drain(sec: float) -> None:
            end = time.time() + sec
            while time.time() < end:
                cdp.pump(timeout=min(0.5, max(0.05, end - time.time())))

        cdp.send("Page.navigate", {"url": f"http://127.0.0.1:{ui_port}/index.html"})
        drain(4.0)

        def ev(expr: str):
            r = cdp.call("Runtime.evaluate",
                         {"expression": expr, "returnByValue": True, "awaitPromise": True},
                         timeout=60)
            res = (r or {}).get("result", {})
            return res.get("value")

        # 等 mermaid 就绪
        for _ in range(40):
            if ev("typeof window.mermaid !== 'undefined'"):
                break
            time.sleep(0.25)

        # ---- 档 1：应用级（低于 guard 阈值的较大图，走真实预览链路）----
        APPL_LINES = 4800  # < guard 5000，能正常渲染；对应"较大但没被拦"的日常档
        app_measure = ev(
            f"""(async () => {{
              const n = {APPL_LINES};
              let body = "flowchart LR\\n";
              for (let i = 1; i < n; i++) body += "  n" + i + " --> n" + (i + 1) + "\\n";
              const d = await DGM.state.newDoc('mermaid');
              if (DGM.state.active !== d.id) await DGM.state.activateDoc(d.id);
              DGM.editor.loadActive();
              await DGM.state.setBodyNow(d.id, body);
              const tasks = [];
              let obs;
              try {{
                obs = new PerformanceObserver((list) => {{
                  for (const e of list.getEntries()) tasks.push(e.duration);
                }});
                obs.observe({{ entryTypes: ['longtask'] }});
              }} catch (e) {{}}
              const t0 = performance.now();
              await DGM.preview.render();
              const dt = performance.now() - t0;
              if (obs) obs.disconnect();
              const lines = body.split('\\n').length;
              return JSON.stringify({{
                lines, bytes: body.length,
                renderMs: Math.round(dt * 10) / 10,
                longTasks: tasks, maxLongTask: tasks.length ? Math.round(Math.max(...tasks) * 10) / 10 : 0,
                mermaidAvail: typeof window.mermaid !== 'undefined'
              }});
            }})()"""
        )
        log(f"档1 应用级预览渲染({APPL_LINES} 行): {app_measure}")

        # ---- 档 2：引擎级万行（直接用 mermaid.render，绕过应用的 guard）----
        eng_measure = ev(
            f"""(async () => {{
              const n = {nodes};
              let body = "flowchart LR\\n";
              for (let i = 1; i < n; i++) body += "  n" + i + " --> n" + (i + 1) + "\\n";
              const tasks = [];
              let obs;
              try {{
                obs = new PerformanceObserver((list) => {{
                  for (const e of list.getEntries()) tasks.push(e.duration);
                }});
                obs.observe({{ entryTypes: ['longtask'] }});
              }} catch (e) {{}}
              // 预热一次(首次 import/初始化不参与计时)
              window.mermaid.initialize({{ startOnLoad: false, securityLevel: 'strict' }});
              const t0 = performance.now();
              const out = await window.mermaid.render('perf-eng', body);
              const dt = performance.now() - t0;
              if (obs) obs.disconnect();
              const lines = body.split('\\n').length;
              return JSON.stringify({{
                nodes: n, lines, bytes: body.length,
                renderMs: Math.round(dt * 10) / 10,
                longTasks: tasks, maxLongTask: tasks.length ? Math.round(Math.max(...tasks) * 10) / 10 : 0,
                svgLen: out ? out.length : -1
              }});
            }})()"""
        )
        log(f"档2 引擎级万行({nodes} 节点)渲染: {eng_measure}")

        report = {
            "app_level_under_guard": json.loads(app_measure or "{}"),
            "engine_level_wanhang": json.loads(eng_measure or "{}"),
            "threshold_ms_default": 200,
        }
        SHOTS.mkdir(parents=True, exist_ok=True)
        (SHOTS / "perf-baseline.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        log("基线已写 → ui/.shots/perf-baseline.json")

        # 输出一句结论：档 1(maxLongTask) 与档 2(SVG 构建耗时) 是否触线
        app = report["app_level_under_guard"]
        eng = report["engine_level_wanhang"]
        log(
            "结论: 应用级最大长任务 %.1fms / 阈值 200ms → %s；"
            "引擎级 %d 节点渲染 %.1fms → %s"
            % (
                app.get("maxLongTask", 0),
                "未触线" if app.get("maxLongTask", 0) < 200 else "**触线(建议上切帧)**",
                nodes,
                eng.get("renderMs", 0),
                "未触线" if eng.get("renderMs", 0) < 200 else "**触线(建议上切帧)**",
            )
        )
        return 0
    finally:
        if cdp:
            cdp.close()
        proc.kill()
        srv.shutdown()


if __name__ == "__main__":
    sys.exit(main())
