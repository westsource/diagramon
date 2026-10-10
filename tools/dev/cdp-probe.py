#!/usr/bin/env python3
"""连到正在运行的 Diagramon（WebView2）做端到端断言 + 截图。

为什么需要它：单测只覆盖 `app-core` / `ai` 这些纯逻辑层，装配层（窗口、命令、事件）
和前端（9244 行 JS）只有"真的跑起来"才知道对不对。这里用 WebView2 自带的
远程调试端口连进去，执行 JS、读回结果、截图 —— 不依赖任何桌面输入注入。

前置：
    python -m pip install websocket-client

用法：
    # 1) 起应用（Windows / bash）
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 \
      ./target/debug/diagramon.exe &
    # 2) 断言 + 截图
    python tools/dev/cdp-probe.py --port 9333 --shot ui/.shots/real-app.png

退出码：0 = 全部断言通过；1 = 有断言失败；2 = 连不上应用。
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request

try:
    import websocket  # type: ignore
except ImportError:  # pragma: no cover - 提示装依赖
    print("缺少依赖：python -m pip install websocket-client", file=sys.stderr)
    raise SystemExit(2)


def find_page(port: int, timeout: float = 20.0) -> str:
    """等 WebView2 的调试端口起来，返回页面 target 的 websocket 地址。"""
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=2) as resp:
                targets = json.load(resp)
            pages = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
            if pages:
                return pages[0]["webSocketDebuggerUrl"]
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_err = exc
        time.sleep(0.5)
    raise SystemExit(f"连不上 WebView2 调试端口 {port}：{last_err}")


class Cdp:
    def __init__(self, url: str) -> None:
        self.ws = websocket.create_connection(url, timeout=30)
        self.next_id = 1

    def send(self, method: str, params: dict | None = None) -> dict:
        msg_id = self.next_id
        self.next_id += 1
        self.ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        while True:
            raw = self.ws.recv()
            data = json.loads(raw)
            if data.get("id") == msg_id:
                if "error" in data:
                    raise RuntimeError(f"{method} 失败：{data['error']}")
                return data.get("result", {})

    def eval(self, expression: str, await_promise: bool = True):
        res = self.send(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": await_promise,
                "returnByValue": True,
                "userGesture": True,
            },
        )
        if res.get("exceptionDetails"):
            detail = res["exceptionDetails"]
            raise RuntimeError(f"页面里抛异常：{detail.get('text')} {detail.get('exception', {}).get('description', '')}")
        return res.get("result", {}).get("value")

    def shoot(self, path: str) -> None:
        res = self.send("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(res["data"]))


# 断言脚本：跑在页面里，返回 {name: bool} + 一些观测值
PROBE_JS = r"""
(async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push({ name, pass: !!cond, extra: extra === undefined ? null : extra });
  const T = window.__TAURI__;
  const invoke = (T && T.core && T.core.invoke) || (T && T.invoke);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  ok("tauri 可用（不是 mock 模式）", !!invoke);
  ok("没有挂 mock 徽标", !document.body.classList.contains("mock"));

  // 1) 契约：格式注册表由 Rust 下发
  const info = await invoke("app_info");
  ok("app_info 版本为 3.0.0", info && info.version === "3.0.0", info && info.version);
  ok("app_info 带四种格式", info && info.formats && info.formats.length === 4, info && info.formats && info.formats.map(f => f.id).join(","));
  ok("画布型 split_view=false", info.formats.filter(f => ["drawio", "excalidraw"].includes(f.id)).every(f => f.split_view === false));

  // 2) 设置：默认值 + 局部更新（未提及的字段不能被清掉）
  const s0 = await invoke("settings_get");
  ok("settings_get 有默认主题", !!s0.theme, s0.theme);
  const s1 = await invoke("settings_patch", { patch: { accent: "lotus" } });
  ok("settings_patch 只改指定字段", s1.accent === "lotus" && s1.theme === s0.theme && s1.panels.sidebar === s0.panels.sidebar);
  await invoke("settings_patch", { patch: { accent: s0.accent } });

  // 3) 会话：新建 → 改正文 → 语法校验 → 大纲 → 作用域
  const doc = await invoke("doc_new", { format: "mermaid" });
  ok("doc_new 返回文档", !!doc && doc.format === "mermaid" && doc.dirty === true, doc && doc.name);
  const src = "flowchart TD\n    A([开始]) --> B{判断}\n    B -- 是 --> C([结束])\n    subgraph 风控\n        L --> M\n    end\n    B -- 否 --> L\n";
  await invoke("doc_set_body", { id: doc.id, body: src });
  const issues = await invoke("doc_issues", { id: doc.id });
  ok("正常源码不报问题", issues.length === 0, JSON.stringify(issues));
  const bad = src.replace("B{判断}", "B{连续失败 >= 5?}");
  await invoke("doc_set_body", { id: doc.id, body: bad });
  const issues2 = await invoke("doc_issues", { id: doc.id });
  ok("裸 >= 被报为警告", issues2.some(i => i.severity === "warning" && i.message.includes("裸的")), JSON.stringify(issues2));
  const outline = await invoke("doc_outline", { id: doc.id });
  ok("大纲含子图/节点/边三组", outline.length === 3, outline.map(g => g.title).join("/"));
  const nodes = (outline.find(g => g.title === "节点") || {}).rows || [];
  ok("大纲节点取到中文标签", nodes.some(r => r.name === "开始"), JSON.stringify(nodes.slice(0, 3)));
  await invoke("doc_set_caret", { id: doc.id, line: 6, col: 1 });
  const scope = await invoke("doc_scope", { id: doc.id });
  ok("光标在 subgraph 内拿到作用域", scope === "风控", scope);

  // 4) 画布型拒绝分屏（能力位为真的守卫）
  const d2 = await invoke("doc_new", { format: "drawio" });
  const r = await invoke("doc_set_view_mode", { id: d2.id, mode: "split" });
  const session = await invoke("session_get");
  const d2b = session.docs.find(d => d.id === d2.id);
  ok("画布型拒绝分屏且取值不变", d2b.view_mode === "preview", "mode=" + d2b.view_mode);

  // 5) 界面真的起来了：五块工作区都在
  const sel = (q) => !!document.querySelector(q);
  ok("标题栏/活动栏/侧栏/编辑区/AI/状态栏齐备",
     sel(".titlebar") && sel(".activitybar") && sel(".sidebar") && sel(".editor-col") && sel(".ai-pane") && sel(".statusbar"));
  ok("标签页渲染出新建的文档", document.querySelectorAll("#tabs .tab").length >= 2,
     document.querySelectorAll("#tabs .tab").length);
  ok("源码窗口有高亮 token", document.querySelectorAll(".cm-content, #code .tk-key, .code .tk-key").length > 0);

  // 6) AI 面板有明确入口（未配置模型时要给引导，而不是死路）
  ok("AI 面板存在", sel(".ai-pane"));
  ok("AI 三页签存在", document.querySelectorAll("#ai-tabs .ai-tab").length === 3);

  return JSON.stringify(out);
})()
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9333)
    ap.add_argument("--shot", default="")
    ap.add_argument("--keep", action="store_true", help="跑完不关连接（调试用）")
    args = ap.parse_args()

    ws_url = find_page(args.port)
    cdp = Cdp(ws_url)
    cdp.send("Runtime.enable")
    cdp.send("Page.enable")

    results = json.loads(cdp.eval(PROBE_JS))
    failed = [r for r in results if not r["pass"]]
    for r in results:
        mark = "PASS" if r["pass"] else "FAIL"
        extra = "" if r["extra"] in (None, "") else f"  ← {r['extra']}"
        print(f"{mark} {r['name']}{extra}")

    if args.shot:
        cdp.shoot(args.shot)
        print(f"\n截图已保存：{args.shot}")

    if not args.keep:
        cdp.ws.close()

    print(f"\n{len(results) - len(failed)}/{len(results)} 通过")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
