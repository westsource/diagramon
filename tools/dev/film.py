#!/usr/bin/env python
"""介绍片逐帧渲染器：把真实的 `ui/` 一帧一帧算出来，再 pipe 给 ffmpeg 合成 mp4。

    python tools/dev/film.py                 # 渲染 SHOTS 里全部镜头 → var/film/diagramon.mp4
    python tools/dev/film.py --only=intro    # 只渲某个镜头（调试用）
    python tools/dev/film.py --list          # 列镜头表
    python tools/dev/film.py --frames        # 额外把每帧存成 PNG（查画面用，很占地方）

## 为什么是「渲染」不是「录屏」

录屏受三件事摆布：抓图速度、浏览器掉帧、人的手抖。三者都会在成片里留下抖动，
而抖动是产品片最不能有的东西 —— 观众会把它读成「这软件卡」。

这里的做法是反过来的：**每一帧由一个时间参数 t 算出**。循环里只做两件事 ——
把页面调到 t 对应的状态，抓一图。于是：

- 帧率与机器快慢无关，30fps 就是 30fps，绝不掉帧；
- 想慢放就改 t 的步长，不必重录；
- 抓图慢也不影响成片，只是渲染久一点（4 分钟片约 7200 帧，十分钟左右渲完）。

画面本身仍然是真 `ui/` 在真 Chrome 里渲染出来的 —— 不是画的假界面，也不是 AI 生成的
伪 UI。这一点对这个片子是硬要求：它的全部说服力都在「真源码、真行号、真渲染」。

## 镜头怎么写

每个 Shot = 一次 `Page.navigate`（状态用 URL 参数一次到位，见 `ui/js/main.js::applyUrlState`）
+ 一段 `setup`（进场后跑一次）+ 一个 `frame(t)`（每帧跑一次，t 是镜头内秒数）。

`frame(t)` 里可以直接用 `DGM.*` 的全局 API，注入的 `F` 是几个缓动小工具。

## 依赖

本机 Chrome/Edge、`websocket-client`（readme_shots 同款）、PATH 里的 `ffmpeg`
（或设 `FFMPEG`）。渲染运行时要在 `tools/` 下就位，否则画布类镜头没有内容可拍。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "dev"))

from canvas_probe import Cdp, find_chrome, free_port  # noqa: E402
from readme_shots import make_handler, wait_ready  # noqa: E402

OUT = ROOT / "var" / "film"

# B 站 / YouTube 的常规规格。16:9 1920×1080、30fps —— 上传平台不会再转一次裁切。
WIDTH, HEIGHT = 1920, 1080
FPS = 30


# ---------------------------------------------------------------- 注入页面的工具
# 写成一段常驻脚本：所有镜头的 frame(t) 都靠这几个函数，避免每个镜头各写一份缓动。
PRELUDE = r"""
window.F = {
  // 0..1 截断
  c: (x) => Math.max(0, Math.min(1, x)),
  // 区间映射：t 在 [a,b] 内线性归一到 0..1，区外截断
  seg: (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a))),
  // ease-out cubic：进场用，收尾自然减速
  out: (x) => 1 - Math.pow(1 - x, 3),
  // ease-in-out：位移类用它，两头都软
  io: (x) => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2,
  // 淡入 + 上移：产品片里最常用的一手
  rise: (el, p, dist) => {
    p = F.c(p);
    el.style.opacity = p;
    el.style.transform = `translateY(${(1 - p) * (dist === undefined ? 24 : dist)}px)`;
  },
  el: (sel) => document.querySelector(sel),
  all: (sel) => Array.from(document.querySelectorAll(sel)),
};

// 转场 / 片头共用的全屏层。真机不存在这层，只在片子里出现。
// 挂到 documentElement 而不是 body：镜头要按 scale 推 body，挂 body 上会被一起缩放。
window.F.screen = () => {
  let o = document.getElementById('film-screen');
  if (!o) {
    o = document.createElement('div');
    o.id = 'film-screen';
    o.style.cssText =
      'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;' +
      'justify-content:center;flex-direction:column;pointer-events:none;' +
      'background:#0b0d10;' +
      'font-family:"Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif;';
    document.documentElement.appendChild(o);
  }
  return o;
};
window.F.screenText = (html) => { F.screen().innerHTML = html; return F.screen(); };
window.F.screenFade = (x) => {
  const o = F.screen();
  o.style.opacity = Math.max(0, Math.min(1, x));
  o.style.display = o.style.opacity <= 0.001 ? 'none' : 'flex';
};

// 收起 mock 徽标 + 去掉焦点圈（真机没有前者，后者抓图时很显眼）；
// 再把 html 底色兜住 —— body 被 scale 缩放后，四边会漏出 html 的底色。
window.F.clean = () => {
  document.body.classList.add('no-mock');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const bg = getComputedStyle(document.body).backgroundColor;
  if (bg && bg !== 'rgba(0, 0, 0, 0)') document.documentElement.style.background = bg;
};

/* ------------------------------------------------------------------ AI 接管
 *
 * 要让「AI 对话生图」在逐帧渲染里可拍，必须解决一件事：mock 后端的流式是靠
 * `setTimeout(…, 42)` 按真实时间推的，而我们是**按帧算状态**。两者不同步，
 * 抓图速度（~110ms/帧）也追不上 42ms 一次的 tick。
 *
 * 解法：把 `ai_chat` 这一路接管过来。ai.js 调的是 `ipc.invoke(cmd, …)`
 * （对象引用，不是解构），所以覆盖 `DGM.ipc.invoke` 就能拦下请求；
 * 再用 `DGM.ipc.emit('ai://delta', …)` 按我要的速度推进。
 *
 * 于是流式变成纯参数：`F.aiFeed(n)` = 「正文显示到第 n 个字符」。
 * 界面侧仍然是 ai.js 自己的 onDelta → render 全链路，代码块、"应用"按钮、
 * token 徽标都是真渲染出来的，不是我拼的 DOM。
 *
 * `ai_resolve_intent` 一并接管：mock 的意图判定会左右这次请求走不走得下去，
 * 拍片时不需要它猜。
 */
window.F.aiHook = () => {
  if (window.__aiHooked) return;
  window.__aiHooked = true;
  const orig = DGM.ipc.invoke.bind(DGM.ipc);
  window.__ai = { reqId: null, text: '', sent: 0, intent: 'generate', busy: false };
  DGM.ipc.invoke = function (cmd, args) {
    if (cmd === 'ai_resolve_intent') {
      return Promise.resolve({ intent: window.__ai.intent, confidence: 0.94, reason: '影片编排' });
    }
    if (cmd === 'ai_chat' || cmd === 'ai_agent_run') {
      const req = (args && args.req) || args || {};
      const id = req.request_id || ('film-' + Date.now());
      const a = window.__ai;
      a.reqId = id;
      // 可以按调用次序给不同回复（`__AI_SEQ`）：生成即校验那一镜要靠它，
      // 第一轮吐坏的、渲染失败后 ai.js 自己发起的第二轮吐好的。
      a.count = (a.count || 0) + 1;
      const seq = window.__AI_SEQ;
      a.text = seq
        ? (seq[Math.min(a.count - 1, seq.length - 1)] || '')
        : (window.__AI_REPLY || '');
      a.sent = 0;
      a.busy = true;
      return Promise.resolve({ request_id: id });
    }
    return orig(cmd, args);
  };
};

/** 正文推进到第 n 个字符（只补差额，可以随便调小调大）。 */
window.F.aiFeed = (n) => {
  const a = window.__ai;
  if (!a.reqId) return 0;
  const upto = Math.max(0, Math.min(a.text.length, Math.round(n)));
  if (upto > a.sent) {
    const delta = a.text.slice(a.sent, upto);
    a.sent = upto;
    DGM.ipc.emit('ai://delta', { request_id: a.reqId, delta });
  }
  return upto;
};

/** 收尾：把剩下的字数补完，发 done（这样 token 徽标、代码卡才定稿）。 */
window.F.aiDone = () => {
  const a = window.__ai;
  if (!a.reqId) return;
  F.aiFeed(a.text.length);
  DGM.ipc.emit('ai://done', {
    request_id: a.reqId,
    text: a.text,
    model: 'diagramon-auto',
    prompt_tokens: 386,
    completion_tokens: 742,
    finish: 'stop',
  });
  a.reqId = null;
  a.busy = false;
};

/** 接管 `convert_text`。
 *
 *  mock 后端的 `convert_text` 是**直接抛错**的（"mock 模式没有转换器"），转换对话框于是
 *  按钮变灰、底下挂一条"请用 check.mjs 起真实客户端"的提示 —— 这段演进去就是穿帮。
 *
 *  这里让它真的返回一份 DOT（engine 报 `rust`，与真机的契约形状一致）。目标选 DOT 而不是
 *  drawio：DOT 由随包的 graphviz wasm 即时渲染，而 drawio 承载页要 12–14 秒才起来，
 *  那 12 秒在镜头里就是一段加载动画。
 */
window.F.convHook = () => {
  if (window.__convHooked) return;
  window.__convHooked = true;
  const orig = DGM.ipc.invoke.bind(DGM.ipc);
  DGM.ipc.invoke = function (cmd, args) {
    if (cmd === 'convert_text') {
      const req = (args && args.req) || {};
      if (req.from === 'mermaid' && req.to === 'dot') {
        return Promise.resolve({
          engine: 'rust',
          body: window.__FILM_DOT || '',
          notes: window.__FILM_CONV_NOTES || [],
        });
      }
    }
    return orig(cmd, args);
  };
};

/** 左下角字幕。片中不出现旁白音轨之前，靠它把「说不了但必须讲清」的事讲掉。
 *  只支持一行/两行，超过就折行 —— 全屏大字留给片头片尾。 */
window.F.caption = (text, p) => {
  if (window.__NO_CAPTION) return;
  let c = document.getElementById('film-caption');
  if (!c) {
    c = document.createElement('div');
    c.id = 'film-caption';
    // 必须自带底色：这几镜有浅色主题的，白字直接压在浅色界面上会彻底看不见（实测过）。
    c.style.cssText =
      'position:fixed;left:96px;bottom:196px;z-index:99990;max-width:1000px;' +
      'font-family:"Microsoft YaHei","PingFang SC",sans-serif;font-size:23px;' +
      'line-height:1.55;color:#f2f6f4;letter-spacing:.02em;pointer-events:none;' +
      'background:rgba(10,14,16,.80);padding:12px 20px;border-radius:9px;' +
      'border-left:3px solid #6fb2a3;opacity:0;';
    document.documentElement.appendChild(c);
  }
  if (text) c.innerHTML = text;
  const q = Math.max(0, Math.min(1, p || 0));
  c.style.opacity = q;
  c.style.transform = `translateY(${(1 - q) * 12}px)`;
};

/** 统一版面：收起左侧资源面板、打开右侧 AI 面板。
 *
 *  为什么不只调 `patchSettings` + `applyLayoutVars`：`patchSettings` 是异步的，
 *  紧接着调 `applyLayoutVars` 读到的还是旧 settings，类名不会变 —— 实测资源面板照样在。
 *  所以先把类名与 CSS 变量**直接落下去**（下一帧就正确），再补一次延迟同步兜住其余布局。
 */
window.F.panels = (aiW, panelH, splitSrc) => {
  const apply = () => {
    document.body.classList.add('no-sidebar');
    document.body.classList.remove('no-ai');
    const root = document.documentElement;
    root.style.setProperty('--ai-w', aiW + 'px');
    if (panelH) root.style.setProperty('--panel-h', panelH + 'px');
    document.body.style.setProperty('--sidebar-w', '0px');
    const split = document.querySelector('#split');
    if (split) split.style.setProperty('--split-src', Math.max(25, Math.min(50, splitSrc || 33)) + '%');
  };
  // 立即落一次：第一帧就得是对的。
  apply();
  // 再在 patchSettings 落地后落一次：它完成后会触发 shell.render → applyLayoutVars，
  // 那里读 settings 把 --ai-w 改回旧值（实测面板宽度会从 500 缩回 ~344）。
  try {
    const r = DGM.state.patchSettings({
      panels: { sidebar: false, ai: true, ai_w: aiW, panel_h: panelH, split_src: splitSrc },
    });
    if (r && typeof r.then === "function") r.then(apply).catch(apply);
    else setTimeout(apply, 120);
  } catch (e) {
    setTimeout(apply, 120);
  }
  if (!document.getElementById('film-panels')) {
    const st = document.createElement('style');
    st.id = 'film-panels';
    st.textContent =
      '.sidebar,#sidebar-gutter{display:none!important}' +
      '.body-row{grid-template-columns:var(--activitybar-w) 0 0 minmax(0,1fr) 5px var(--ai-w)!important}';
    document.head.appendChild(st);
  }
};

/** 打字机：把文字按进度填进 AI 输入框（不触发发送）。 */
window.F.typeInto = (sel, full, p) => {
  const el = document.querySelector(sel);
  if (!el) return;
  el.value = full.slice(0, Math.round(full.length * Math.max(0, Math.min(1, p))));
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

/** 给某个元素打一圈「影片高亮」——全片不出现鼠标指针，靠它指「点这儿」。
 *  `sel` 传假值 = 只清掉现有高亮。 */
window.F.mark = (sel, on, pad) => {
  const old = document.getElementById('film-mark');
  if (old) old.remove();
  if (!on || !sel) return;
  const el = document.querySelector(sel);
  if (!el) return;
  const r = el.getBoundingClientRect();
  const p = pad === undefined ? 3 : pad;
  const d = document.createElement('div');
  d.id = 'film-mark';
  d.style.cssText =
    'position:fixed;pointer-events:none;z-index:99998;border:2px solid #6fb2a3;' +
    'border-radius:7px;box-shadow:0 0 0 4px rgba(111,178,163,.18);' +
    `left:${r.left - p}px;top:${r.top - p}px;` +
    `width:${r.width + p * 2}px;height:${r.height + p * 2}px;`;
  document.documentElement.appendChild(d);
};
"""


@dataclass
class Shot:
    """一个镜头。

    query: 进场 URL 参数（`theme=dark&mode=preview` 这种），状态一次到位、不用模拟点击。
    setup: 进场后跑一次的 JS，用来建覆盖层、缓存元素引用。
    frame: `(t) => {...}`，t 是镜头内秒数；每个输出帧调一次。
    note:  写给人看的镜头说明。
    """

    name: str
    secs: float
    query: str = ""
    setup: str = ""
    frame: str = ""
    note: str = ""
    # 镜头自带的数据（提示词、AI 回复正文之类），注入成 `window.__FILM_DATA`。
    # 走 JSON 而不是往 JS 字符串里拼，长正文才不会被转义搞死。
    data: dict = field(default_factory=dict)


# ---------------------------------------------------------------- 镜头表
# 目前只有前两个 —— 先验证「片头 / 真界面」两类镜头都拍得出来，再往里铺内容。

# 片头那块版面的 HTML。抽出来单独写，是因为它比一行 setup 长得多，塞进 JS 字符串里
# 会变成一堆转义，改一次错一次。
#
# 版式：左文右图。底色不用纯黑 —— 产品的暗色基调是 #16191a，纯黑比它更"死"，
# 会让人读作"没加载出来的黑屏"。中间提亮一档，四角压暗，画面才有体积。
# 图用的是产品预览区自己的语言：点阵网格 + 圆角节点 + 细连线，不画任何软件界面
# （片头是包装，不是产品截图；这里画界面反而是假的）。
INTRO_HTML = """
<div id="film-glow"></div>
<div id="film-bg"></div>
<svg id="film-graph" viewBox="120 0 660 540" xmlns="http://www.w3.org/2000/svg">
  <g class="edges" stroke="#6fb2a3" stroke-width="1.6" fill="none" stroke-linecap="round">
    <path d="M240,68 L240,120"/>
    <path d="M240,168 L240,188"/>
    <path d="M240,312 L240,370"/>
    <path d="M345,250 L556,250"/>
    <path d="M240,418 L240,470"/>
  </g>
  <g class="nodes" fill="rgba(255,255,255,.05)" stroke="#5f696b" stroke-width="1.3">
    <rect x="150" y="20"  width="180" height="48" rx="9" data-at="0.45"/>
    <rect x="150" y="120" width="180" height="48" rx="9" data-at="0.75"/>
    <polygon points="240,188 345,250 240,312 135,250" data-at="1.10"
             fill="rgba(111,178,163,.22)" stroke="#6fb2a3" stroke-width="1.7"/>
    <rect x="150" y="370" width="180" height="48" rx="9" data-at="1.55"/>
    <rect x="150" y="470" width="180" height="48" rx="9" data-at="1.85"/>
    <rect x="556" y="226" width="204" height="48" rx="9" data-at="1.55"
          stroke="#8a7854"/>
  </g>
  <g class="labels" fill="#c3cbca" font-size="15" text-anchor="middle"
     font-family="Microsoft YaHei, PingFang SC, sans-serif">
    <text x="240" y="49"  data-at="0.45">开始</text>
    <text x="240" y="149" data-at="0.75">请求登录</text>
    <text x="240" y="255" data-at="1.10" fill="#9fd5c8">校验通过？</text>
    <text x="240" y="399" data-at="1.55">签发 JWT</text>
    <text x="240" y="499" data-at="1.85">进入首页</text>
    <text x="658" y="255" data-at="1.55" fill="#c9b58c">拒绝 · 计数 +1</text>
  </g>
</svg>
<div id="film-copy">
  <div id="c1">让AI画一张图，很容易</div>
  <div id="c2">和它一起把这张图维护下去，很难</div>
  <div id="c3"><i></i><span>AI最懂的多格式图表编辑器 Diagramon</span></div>
</div>
<style>
  #film-glow { position: absolute; inset: 0;
    background: radial-gradient(120% 95% at 44% 38%, #222b2d 0%, #171c1e 44%, #0b0e10 100%); }
  #film-bg { position: absolute; inset: 0;
    background-image: radial-gradient(circle, rgba(255,255,255,.085) 1px, transparent 1px);
    background-size: 24px 24px;
    -webkit-mask-image: linear-gradient(96deg, rgba(0,0,0,.4) 0%, rgba(0,0,0,.78) 45%, #000 82%);
    mask-image: linear-gradient(96deg, rgba(0,0,0,.4) 0%, rgba(0,0,0,.78) 45%, #000 82%); }
  #film-graph { position: absolute; right: 170px; top: 300px; width: 580px;
    opacity: .95; }
  #film-graph .nodes > *, #film-graph .labels > * { opacity: 0; }
  #film-copy { position: absolute; left: 148px; top: 372px; width: 920px;
    font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif; }
  #c1 { font-size: 54px; font-weight: 300; color: #8a9492; letter-spacing: .045em;
    opacity: 0; margin-bottom: 24px; }
  #c2 { font-size: 54px; font-weight: 600; color: #eef3f1; letter-spacing: .045em;
    opacity: 0; line-height: 1.34; }
  #c3 { margin-top: 62px; opacity: 0; display: flex; align-items: center; gap: 16px; }
  #c3 i { display: block; width: 44px; height: 2px; background: #6fb2a3; }
  #c3 span { font-size: 17px; color: #7f8987; letter-spacing: .3em; }
</style>
"""


INTRO = Shot(
    name="intro",
    secs=6.5,
    query="theme=dark",
    note="片头：左文右图，一张流程图在现场长出来（点阵网格 + 真实渲染语言）",
    setup=r"""
F.screen();
// 底色交给版面里的 #film-glow（径向渐变），这层只兜最暗的底
F.screen().style.background = '#0b0e10';
F.screenText(window.__INTRO_HTML);
// 量出每条边多长，好让它们各自从 0 长到全；量完先全部藏起来
document.querySelectorAll('#film-graph .edges path').forEach((p) => {
  const L = p.getTotalLength();
  p.dataset.len = L;
  p.style.strokeDasharray = L;
  p.style.strokeDashoffset = L;
});
""",
    frame=r"""
// 边逐条生长（每条 0.62s，间隔 0.3s）
document.querySelectorAll('#film-graph .edges path').forEach((p, i) => {
  const s = 0.30 + i * 0.30;
  const q = F.out(F.seg(t, s, s + 0.62));
  p.style.strokeDashoffset = (+p.dataset.len) * (1 - q);
});
// 节点 / 标签按 data-at 指定的时刻淡入，跟在自己的边之后
document.querySelectorAll('#film-graph .nodes > *, #film-graph .labels > *').forEach((n) => {
  const at = +n.dataset.at;
  n.style.opacity = F.out(F.seg(t, at, at + 0.45));
});
// 文案两行错开落下，第二行出场时第一行压暗，把视线交给它
const a = F.out(F.seg(t, 0.80, 1.75));
const b = F.out(F.seg(t, 1.70, 2.70));
const c = F.out(F.seg(t, 2.75, 3.35));
const c1 = document.getElementById('c1');
c1.style.opacity = a * (1 - 0.5 * b);
c1.style.transform = `translateY(${(1 - a) * 20}px)`;
const c2 = document.getElementById('c2');
c2.style.opacity = b;
c2.style.transform = `translateY(${(1 - b) * 20}px)`;
const c3 = document.getElementById('c3');
c3.style.opacity = c;
c3.style.transform = `translateY(${(1 - c) * 14}px)`;
// 收尾：图往前推一点、整体淡到黑（不是淡到透明 —— 那会露出底下的暗色界面，
// 观众会看见一闪而过的真实主界面，再被下一镜重新载入的浅色界面顶掉）
const out = F.io(F.seg(t, 5.45, 6.45));
document.getElementById('film-glow').style.opacity = 1 - out;
document.getElementById('film-bg').style.opacity = 1 - out;
document.getElementById('film-copy').style.opacity = 1 - out;
const g = document.getElementById('film-graph');
g.style.opacity = 0.95 * (1 - out);
g.style.transformOrigin = '50% 50%';
g.style.transform = `scale(${1 + 0.07 * out})`;
""",
)


# ---------------------------------------------------------------- 入门操作：AI 对话生图
# 这段源码是用户给的现场例子（监控业务域 · 浏览器访问）。末尾那个 dgm-palette 块是
# Diagramon 自动配色落地后的结果，所以叙述里说「配色已按角色落地」而不是「AI 挑了颜色」。
AI_SCRIPT = {
    "prompt": "画一个监控业务域的浏览器访问流程图",
    "reply": (
        "按访问来源把这条链路拆成了三条路径：办公网、监控网，以及各自失败之后往哪走。"
        "配色已按角色落地（判断 / 入口 / 外部 / 异常），换色系不会改正文。\n\n"
        "```mermaid\n"
        "flowchart TD\n"
        "    A([用户使用浏览器访问监控业务域]):::lvl-entry\n"
        "    B[业务事件发生，需要处置]\n"
        "    C[点击发布情报板]\n"
        "    D{访问来源网络类型}:::lvl-decide\n"
        "    E[办公网访问]:::lvl-ext\n"
        "    F[跳转失败：办公网未开通网络访问]:::lvl-risk\n"
        "    G[跳转至情报板发布模块]\n"
        "    H{情报板发布服务模块校验来源IP}:::lvl-decide\n"
        "    I[提供情报板发布服务]\n"
        "    J[拒绝服务]:::lvl-risk\n"
        "    K([情报板发布完成]):::lvl-entry\n"
        "    L([流程结束]):::lvl-entry\n"
        "    A --> B --> C --> D\n"
        "    D -->|办公网| E --> F --> L\n"
        "    D -->|监控网| G --> H\n"
        "    H -->|来源IP属于监控网| I --> K\n"
        "    H -->|来源IP不属于监控网| J --> L\n"
        "    K --> L\n"
        "%% dgm-palette:begin id=indigo（Diagramon 自动配色 · 黛蓝 · 亮色）\n"
        "classDef lvl-decide fill:#e4d5ec,stroke:#914db3,color:#3f234d\n"
        "class D,H lvl-decide\n"
        "classDef lvl-entry fill:#d7d5ec,stroke:#554db3,color:#26234d\n"
        "class A,K,L lvl-entry\n"
        "classDef lvl-ext fill:#d5ece6,stroke:#4db399,color:#234d43\n"
        "class E lvl-ext\n"
        "classDef lvl-main fill:#d5e0ec,stroke:#4d80b3,color:#23384d\n"
        "class B,C,G,I lvl-main\n"
        "classDef lvl-risk fill:#f1d3d0,stroke:#c94436,color:#571f19\n"
        "class F,J lvl-risk\n"
        "%%{init: {'themeVariables': {'lineColor': '#546678'}}}%%\n"
        "%% dgm-palette:end\n"
        "```\n"
    ),
}

# 正文里的那段源码单独取出来给后续镜头复用（手动改图要从它出发）。
# 从 reply 里截而不是再抄一遍：抄两遍迟早只改一处。
MONITOR_SRC = AI_SCRIPT["reply"].split("```mermaid\n", 1)[1].rsplit("```", 1)[0]

# 手动改图改这一行：节点文字变长，预览里那个框跟着变长 —— 一眼能看出「这是活的」
_HUMAN_FROM = "    C[点击发布情报板]\n"
_HUMAN_TO = "    C[点击发布情报板 · P1 优先]\n"
MONITOR_SRC_EDITED = MONITOR_SRC.replace(_HUMAN_FROM, _HUMAN_TO)


AI_GEN = Shot(
    name="ai-gen",
    secs=20.0,
    query="doc=0&theme=light",
    note="AI 对话生图：输入需求 → 发送 → 流式吐源码 → 应用 → 预览长出图",
    data=AI_SCRIPT,
    setup=r"""
F.clean();
F.aiHook();
window.__AI_REPLY = window.__FILM_DATA.reply;
window.__markState = false;
// 版面比例：AI 面板拉宽到 540（默认 344 里代码会挤成一团看不清），
// 底部问题面板压薄，把高度让给预览
F.panels(500, 116, 34);
// 空白 Mermaid 文档：生图该从无到有，不是改造一张已有的图。
// 注意 doc_new 会用该格式的 `default_body` 填一份骨架（真机也这样），演示里要清掉。
DGM.state.newDoc('mermaid').then(async (d) => {
  const doc = DGM.state.doc(d && d.id);
  // 标签名由 Rust 的 doc_new 生成（「未命名-N」），演示里换成人能读的名字
  if (doc) doc.name = '监控业务域.mmd';
  await DGM.state.setBodyNow(d.id, '');
  DGM.editor.loadActive();
  DGM.tabs.render();
  DGM.shell.renderDocTitle();
});
""",
    frame=r"""
// 0) 标签改名。不能只做一次：点「应用」后 applyBlock 会把文档重新拉一遍，
//    name 被 mock 的「未命名-N」盖回来。所以这里做成"不对就改"，改对后自然不再进分支。
{
  const a = DGM.state.activeDoc();
  if (a && a.format === 'mermaid' && a.name !== '监控业务域.mmd') {
    a.name = '监控业务域.mmd';
    DGM.tabs.render();
    DGM.shell.renderDocTitle();
  }
}
// 1) 打字机输入需求
if (t < 5.2) F.typeInto('#ai-input', window.__FILM_DATA.prompt, F.seg(t, 1.05, 4.55));
// 2) 发送按钮打一圈高亮（全片不出现鼠标指针，靠这个指「点这儿」）
const wantMark = t > 5.6 && t < 6.75;
if (window.__markState !== wantMark) { window.__markState = wantMark; F.mark('#ai-send', wantMark); }
// 3) 发送（只发一次）
if (t > 6.75 && !window.__aiSent) {
  window.__aiSent = true;
  DGM.ai.send();
}
// 4) 流式：正文显示到第 n 个字符
if (window.__ai && window.__ai.reqId) {
  F.aiFeed((window.__AI_REPLY || '').length * F.seg(t, 7.4, 12.7));
  if (t > 12.72) F.aiDone();
}
// 5) 高亮「应用代码到编辑器」
const applySel = '#ai-stream .code-card-actions button.primary';
if (t > 13.6 && t < 14.7) {
  if (window.__markState2 !== true) { window.__markState2 = true; F.mark(applySel, true, 4); }
} else if (window.__markState2 === true) {
  window.__markState2 = false;
  F.mark(applySel, false);
}
// 6) 点应用（走真实点击，applyBlock 全链路：写正文 → 打脏标 → 预览重渲染）
if (t > 14.7 && !window.__applied) {
  window.__applied = true;
  const btns = document.querySelectorAll(applySel);
  const b = btns[btns.length - 1];
  if (b) b.click();
}
// 应用之后补一次「适应视图」。
// setBodyNow 与「应用代码」两路渲染会撞在一起，先到的那次 fit 读到还没布局完的 SVG，
// 缩放被算成 600%+（画面里只剩图的一角，看着像渲染坏了 —— 实测 svgs=1，不是叠加）。
if (window.__applied && !window.__refit) {
  if (window.__applyAt === undefined) window.__applyAt = t;
  if (t - window.__applyAt > 1.4) { window.__refit = true; DGM.preview.fit(); }
}
""",
)


AI_EDIT_HUMAN = Shot(
    name="ai-edit-human",
    secs=9.5,
    query="doc=0&theme=light",
    note="手动改图：定位到一行、改节点文字，预览跟着变（证明产物是活的，不是截图）",
    data={"src": MONITOR_SRC, "edited": MONITOR_SRC_EDITED, "name": "监控业务域.mmd"},
    setup=r"""
F.clean();
window.__m = null;
// 手动改图时 AI 面板收起来，把宽度让给源码与预览
F.panels(500, 108, 42);
DGM.state.newDoc('mermaid').then(async (d) => {
  await DGM.state.setBodyNow(d.id, window.__FILM_DATA.src);
  DGM.editor.loadActive();
});
""",
    frame=r"""
// 建好文档就开拍的镜头，首帧容器尺寸可能还没落定 —— 实测预览整段空白
// （fit 缩放被算到 800%+，图只剩一角，观众读到的是"渲染窗口是空白的"）。
// 开场强制渲染 + 适应视图一次。
if (t > 0.9 && !window.__booted) {
  window.__booted = true;
  try { DGM.preview.render(); } catch (e) {}
  setTimeout(() => { try { DGM.preview.fit(); } catch (e) {} }, 220);
}
{
  const a = DGM.state.activeDoc();
  if (a && a.format === 'mermaid' && a.name !== window.__FILM_DATA.name) {
    a.name = window.__FILM_DATA.name;
    DGM.tabs.render();
    DGM.shell.renderDocTitle();
  }
}
// 定位到第 4 行（C[点击发布情报板]）——光标落过去，观众知道看哪儿
if (t > 1.3 && !window.__went) { window.__went = true; DGM.editor.gotoLine(4); }
// 给这一行打高亮
const want = t > 1.7 && t < 3.2;
if (window.__m !== want) { window.__m = want; F.mark('.cm-content .cm-line:nth-child(4)', want, 1); }
// 改：只改一次。逐字符堆打字动画更假，一次改完配前置定位反而清楚
if (t > 3.2 && !window.__did) {
  window.__did = true;
  F.mark(null, false);
  window.__m = false;
  const a = DGM.state.activeDoc();
  if (a) {
    DGM.state.setBodyNow(a.id, window.__FILM_DATA.edited);
    DGM.editor.setValue(window.__FILM_DATA.edited);
    DGM.preview.schedule();
  }
}
""",
)


# AI 改图：在「拒绝服务」后面补一个告警节点。改的是结构（多一个节点 + 一条边），
# 比改文字更能说明「它读的是整份源码，写回的也是整份源码」。
MONITOR_SRC_ALERT = MONITOR_SRC_EDITED.replace(
    "    J[拒绝服务]:::lvl-risk\n",
    "    J[拒绝服务]:::lvl-risk\n    M[推送告警通知]:::lvl-risk\n",
).replace(
    "    H -->|来源IP不属于监控网| J --> L\n",
    "    H -->|来源IP不属于监控网| J --> M --> L\n",
)

AI_EDIT_SCRIPT = {
    "src": MONITOR_SRC_EDITED,
    "applied": MONITOR_SRC_ALERT,
    "name": "监控业务域.mmd",
    "prompt": "在拒绝服务后面加一个告警通知节点",
    "reply": (
        "在「拒绝服务」之后补了一个告警通知节点，失败路径现在是先推送告警、再结束。\n\n"
        "```mermaid\n" + MONITOR_SRC_ALERT + "```\n"
    ),
}


AI_EDIT_AI = Shot(
    name="ai-edit-ai",
    secs=17.0,
    query="doc=0&theme=light",
    note="AI 改图：描述一句结构改动 → 它返回整份源码 → 应用 → 预览多出一个节点",
    data=AI_EDIT_SCRIPT,
    setup=r"""
F.clean();
F.aiHook();
window.__AI_REPLY = window.__FILM_DATA.reply;
window.__markState = false;
window.__markState2 = false;
F.panels(500, 108, 34);
DGM.state.newDoc('mermaid').then(async (d) => {
  await DGM.state.setBodyNow(d.id, window.__FILM_DATA.src);
  DGM.editor.loadActive();
});
""",
    frame=r"""
// 建好文档就开拍的镜头，首帧容器尺寸可能还没落定 —— 实测预览整段空白
// （fit 缩放被算到 800%+，图只剩一角，观众读到的是"渲染窗口是空白的"）。
// 开场强制渲染 + 适应视图一次。
if (t > 0.9 && !window.__booted) {
  window.__booted = true;
  try { DGM.preview.render(); } catch (e) {}
  setTimeout(() => { try { DGM.preview.fit(); } catch (e) {} }, 220);
}
{
  const a = DGM.state.activeDoc();
  if (a && a.format === 'mermaid' && a.name !== window.__FILM_DATA.name) {
    a.name = window.__FILM_DATA.name;
    DGM.tabs.render();
    DGM.shell.renderDocTitle();
  }
}
// 输入「改一句结构」
if (t < 5.4) F.typeInto('#ai-input', window.__FILM_DATA.prompt, F.seg(t, 1.3, 4.8));
// 高亮发送
const m1 = t > 5.5 && t < 6.7;
if (window.__markState !== m1) { window.__markState = m1; F.mark('#ai-send', m1); }
// 发送
if (t > 6.7 && !window.__aiSent) {
  window.__aiSent = true;
  DGM.ai.send();
}
// 流式
if (window.__ai && window.__ai.reqId) {
  F.aiFeed((window.__AI_REPLY || '').length * F.seg(t, 7.3, 12.2));
  if (t > 12.22) F.aiDone();
}
// 高亮「应用」
const applySel = '#ai-stream .code-card-actions button.primary';
const m2 = t > 13.0 && t < 14.2;
if (window.__markState2 !== m2) { window.__markState2 = m2; F.mark(applySel, m2, 4); }
// 应用
if (t > 14.2 && !window.__applied) {
  window.__applied = true;
  const btns = document.querySelectorAll(applySel);
  const b = btns[btns.length - 1];
  if (b) b.click();
}
// 应用之后补一次「适应视图」。
// setBodyNow 与「应用代码」两路渲染会撞在一起，先到的那次 fit 读到还没布局完的 SVG，
// 缩放被算成 600%+（画面里只剩图的一角，看着像渲染坏了 —— 实测 svgs=1，不是叠加）。
if (window.__applied && !window.__refit) {
  if (window.__applyAt === undefined) window.__applyAt = t;
  if (t - window.__applyAt > 1.4) { window.__refit = true; DGM.preview.fit(); }
}
""",
)


MAIN = Shot(
    name="main",
    secs=4.6,
    query="theme=light",
    note="主界面全景：真 ui 渲染，黑场淡入，当前文档就是监控业务域那张图",
    data={"src": MONITOR_SRC, "name": "监控业务域.mmd"},
    setup=r"""
F.clean();
// 转场层留着，靠 fade 收掉；先挡住，避免第一帧闪出白底
F.screenText('');
F.screenFade(1);
F.panels(500, 96, 38);
// 全景镜头里的图必须就是这张（mock 自带的示例文档是「登录流程」，用它会和全片脱节）
DGM.state.newDoc('mermaid').then(async (d) => {
  await DGM.state.setBodyNow(d.id, window.__FILM_DATA.src);
  DGM.editor.loadActive();
  DGM.preview.schedule();
});
""",
    frame=r"""
// 建好文档就开拍的镜头，首帧容器尺寸可能还没落定 —— 实测预览整段空白
// （fit 缩放被算到 800%+，图只剩一角，观众读到的是"渲染窗口是空白的"）。
// 开场强制渲染 + 适应视图一次。
if (t > 0.9 && !window.__booted) {
  window.__booted = true;
  try { DGM.preview.render(); } catch (e) {}
  setTimeout(() => { try { DGM.preview.fit(); } catch (e) {} }, 220);
}
{
  const a = DGM.state.activeDoc();
  if (a && a.format === 'mermaid' && a.name !== window.__FILM_DATA.name) {
    a.name = window.__FILM_DATA.name;
    DGM.tabs.render();
    DGM.shell.renderDocTitle();
  }
}
// 只做淡入。这里曾经按 1.05→1.00 推镜头，实拍发现缩放会把顶部标题栏推出画外：
// 标题栏承载「这是个桌面软件」这条信息（菜单、窗口按钮），比那点镜头感重要。
const fade = 1 - F.io(F.seg(t, 0, 0.7));
F.screenFade(fade);
// 这一镜是 newDoc 建好就开拍，首帧容器尺寸还没落定 —— 实测预览会是空的。
// 淡入之后再强制渲染 + 适应视图一次。
if (t > 0.9 && !window.__fixed) {
  window.__fixed = true;
  try { DGM.preview.render(); } catch (e) {}
  setTimeout(() => { try { DGM.preview.fit(); } catch (e) {} }, 220);
}
""",
)


# ---------------------------------------------------------------- 入门操作：识图生图
# 源图是用户给的「网络结构图.png」（集团网络拓扑）。原图有三十多个节点，逐个抄进 Mermaid
# 会密到看不清，这里按三个域的主干收一遍：数据中心 → 监控网 / 企业网 / 外联域 → 各自的落地。
VISION_SRC = (
    "flowchart TD\n"
    "    A([互联网]):::lvl-ext\n"
    "    B[边界防火墙]:::lvl-risk\n"
    "    C[集团数据中心 DMZ]:::lvl-main\n"
    "    D[经营管控域]:::lvl-main\n"
    "    E[外联域 · 收费指标采集]:::lvl-main\n"
    "    F{监控网}:::lvl-decide\n"
    "    G{企业网}:::lvl-decide\n"
    "    H[速通外联域]:::lvl-main\n"
    "    I[监控子网]:::lvl-main\n"
    "    J[车路协同专网]:::lvl-main\n"
    "    K[收费网络]:::lvl-main\n"
    "    L([收费总中心]):::lvl-entry\n"
    "    M([隧道监控中心]):::lvl-entry\n"
    "    N([监控分中心]):::lvl-entry\n"
    "    O([养护子公司]):::lvl-entry\n"
    "    P([客服坐席 · 永乐中心]):::lvl-entry\n"
    "    Q([速通公司]):::lvl-entry\n"
    "    R([大浮坨分中心]):::lvl-entry\n"
    "    A --> B --> C\n"
    "    C --> D\n"
    "    C --> E\n"
    "    D --> F\n"
    "    D --> G\n"
    "    E --> K --> L\n"
    "    E --> H --> Q\n"
    "    F --> I\n"
    "    I --> M\n"
    "    I --> N\n"
    "    G --> J --> R\n"
    "    G --> O\n"
    "    G --> P\n"
    "%% dgm-palette:begin id=indigo（Diagramon 自动配色 · 黛蓝 · 亮色）\n"
    "classDef lvl-decide fill:#e4d5ec,stroke:#914db3,color:#3f234d\n"
    "class F,G lvl-decide\n"
    "classDef lvl-entry fill:#d7d5ec,stroke:#554db3,color:#26234d\n"
    "class L,M,N,O,P,Q,R lvl-entry\n"
    "classDef lvl-ext fill:#d5ece6,stroke:#4db399,color:#234d43\n"
    "class A lvl-ext\n"
    "classDef lvl-main fill:#d5e0ec,stroke:#4d80b3,color:#23384d\n"
    "class C,D,E,H,I,J,K lvl-main\n"
    "classDef lvl-risk fill:#f1d3d0,stroke:#c94436,color:#571f19\n"
    "class B lvl-risk\n"
    "%% dgm-palette:end\n"
)


def _data_url(path: Path) -> str:
    """把本地图片读成 data URL。文件不在就给空串 —— 脚本 clone 到别的机器上不该崩。"""
    try:
        return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()
    except Exception:
        return ""


VISION_IMG = Path("C:/Users/rong/Downloads/网络结构图.png")

VISION_GEN = Shot(
    name="vision-gen",
    secs=25.0,
    query="doc=0&theme=light",
    note="识图生图：把图片附进 AI 面板 → 发送 → 流式吐源码 → 应用 → 预览出拓扑图",
    data={
        "img": _data_url(VISION_IMG),
        "imgName": "网络结构图.png",
        "prompt": "照这张网络结构图重画成 Mermaid，保留三个域的层级",
        "reply": (
            "按原图的三条出口整理了：数据中心往外分监控网、企业网、外联域，"
            "各自的落地单位挂在自己那条线上。\n\n"
            "```mermaid\n" + VISION_SRC + "```\n"
        ),
        "name": "集团网络结构.mmd",
    },
    setup=r"""
F.clean();
F.aiHook();
window.__AI_REPLY = window.__FILM_DATA.reply;
window.__markState = false;
window.__markState2 = false;
F.panels(500, 108, 34);
DGM.state.newDoc('mermaid').then(async (d) => {
  await DGM.state.setBodyNow(d.id, '');
  DGM.editor.loadActive();
  DGM.tabs.render();
  DGM.preview.schedule();
});
""",
    frame=r"""
// 建好文档就开拍的镜头，首帧容器尺寸可能还没落定 —— 实测预览整段空白
// （fit 缩放被算到 800%+，图只剩一角，观众读到的是"渲染窗口是空白的"）。
// 开场强制渲染 + 适应视图一次。
if (t > 0.9 && !window.__booted) {
  window.__booted = true;
  try { DGM.preview.render(); } catch (e) {}
  setTimeout(() => { try { DGM.preview.fit(); } catch (e) {} }, 220);
}
{
  const a = DGM.state.activeDoc();
  if (a && a.format === 'mermaid' && a.name !== window.__FILM_DATA.name) {
    a.name = window.__FILM_DATA.name;
    DGM.tabs.render();
    DGM.shell.renderDocTitle();
  }
}
// 1) 附件进面板：走 attachDataUrl（真链路：压缩到 ≤1568px、进 attachments、意图切到识图）
if (t > 2.2 && !window.__attached) {
  window.__attached = true;
  if (window.__FILM_DATA.img) DGM.ai.attachDataUrl(window.__FILM_DATA.img, window.__FILM_DATA.imgName);
}
// 2) 输入需求
if (t > 3.6 && t < 7.6) F.typeInto('#ai-input', window.__FILM_DATA.prompt, F.seg(t, 3.6, 7.2));
// 3) 高亮发送
const m1 = t > 7.7 && t < 8.9;
if (window.__markState !== m1) { window.__markState = m1; F.mark('#ai-send', m1); }
// 4) 发送
if (t > 8.9 && !window.__aiSent) {
  window.__aiSent = true;
  DGM.ai.send();
}
// 5) 流式
if (window.__ai && window.__ai.reqId) {
  F.aiFeed((window.__AI_REPLY || '').length * F.seg(t, 9.4, 16.6));
  if (t > 16.62) F.aiDone();
}
// 6) 高亮「应用」
const applySel = '#ai-stream .code-card-actions button.primary';
const m2 = t > 17.4 && t < 18.6;
if (window.__markState2 !== m2) { window.__markState2 = m2; F.mark(applySel, m2, 4); }
// 7) 应用
if (t > 18.6 && !window.__applied) {
  window.__applied = true;
  const btns = document.querySelectorAll(applySel);
  const b = btns[btns.length - 1];
  if (b) b.click();
}
// 应用之后补一次「适应视图」。
// setBodyNow 与「应用代码」两路渲染会撞在一起，先到的那次 fit 读到还没布局完的 SVG，
// 缩放被算成 600%+（画面里只剩图的一角，看着像渲染坏了 —— 实测 svgs=1，不是叠加）。
if (window.__applied && !window.__refit) {
  if (window.__applyAt === undefined) window.__applyAt = t;
  if (t - window.__applyAt > 1.4) { window.__refit = true; DGM.preview.fit(); }
}
""",
)


# 识图结果的手动改 / AI 改 —— 改的是那张拓扑图，和前面监控业务域那张互不相干。
VISION_SRC_EDITED = VISION_SRC.replace(
    "    O([养护子公司]):::lvl-entry\n",
    "    O([养护子公司 · 3 处]):::lvl-entry\n",
)
VISION_SRC_GUARD = VISION_SRC_EDITED.replace(
    "    R([大浮坨分中心]):::lvl-entry\n",
    "    R([大浮坨分中心]):::lvl-entry\n    S([应急指挥中心]):::lvl-risk\n",
).replace(
    "    G --> P\n",
    "    G --> P\n    G --> S\n",
)


VISION_EDIT = Shot(
    name="vision-edit",
    secs=9.5,
    query="doc=0&theme=light",
    note="手动改识图结果：改「养护子公司」这一处标签，预览跟着变",
    data={"src": VISION_SRC, "edited": VISION_SRC_EDITED, "name": "集团网络结构.mmd"},
    setup=r"""
F.clean();
window.__m = null;
F.panels(500, 108, 42);
DGM.state.newDoc('mermaid').then(async (d) => {
  await DGM.state.setBodyNow(d.id, window.__FILM_DATA.src);
  DGM.editor.loadActive();
});
""",
    frame=r"""
// 建好文档就开拍的镜头，首帧容器尺寸可能还没落定 —— 实测预览整段空白
// （fit 缩放被算到 800%+，图只剩一角，观众读到的是"渲染窗口是空白的"）。
// 开场强制渲染 + 适应视图一次。
if (t > 0.9 && !window.__booted) {
  window.__booted = true;
  try { DGM.preview.render(); } catch (e) {}
  setTimeout(() => { try { DGM.preview.fit(); } catch (e) {} }, 220);
}
{
  const a = DGM.state.activeDoc();
  if (a && a.format === 'mermaid' && a.name !== window.__FILM_DATA.name) {
    a.name = window.__FILM_DATA.name;
    DGM.tabs.render();
    DGM.shell.renderDocTitle();
  }
}
if (t > 1.3 && !window.__went) { window.__went = true; DGM.editor.gotoLine(16); }
const want = t > 1.7 && t < 3.2;
if (window.__m !== want) { window.__m = want; F.mark('.cm-content .cm-line:nth-child(16)', want, 1); }
if (t > 3.2 && !window.__did) {
  window.__did = true;
  F.mark(null, false);
  window.__m = false;
  const a = DGM.state.activeDoc();
  if (a) {
    DGM.state.setBodyNow(a.id, window.__FILM_DATA.edited);
    DGM.editor.setValue(window.__FILM_DATA.edited);
    DGM.preview.schedule();
  }
}
""",
)


VISION_AI_EDIT = Shot(
    name="vision-ai-edit",
    secs=17.0,
    query="doc=0&theme=light",
    note="AI 改识图结果：补一个应急指挥中心，预览多一个节点",
    data={
        "src": VISION_SRC_EDITED,
        "applied": VISION_SRC_GUARD,
        "name": "集团网络结构.mmd",
        "prompt": "在企业网下面再补一个应急指挥中心",
        "reply": (
            "在企业网那条线下补了「应急指挥中心」，挂在原来的四路之外单独一路。\n\n"
            "```mermaid\n" + VISION_SRC_GUARD + "```\n"
        ),
    },
    setup=r"""
F.clean();
F.aiHook();
window.__AI_REPLY = window.__FILM_DATA.reply;
window.__markState = false;
window.__markState2 = false;
F.panels(500, 108, 34);
DGM.state.newDoc('mermaid').then(async (d) => {
  await DGM.state.setBodyNow(d.id, window.__FILM_DATA.src);
  DGM.editor.loadActive();
});
""",
    frame=r"""
// 建好文档就开拍的镜头，首帧容器尺寸可能还没落定 —— 实测预览整段空白
// （fit 缩放被算到 800%+，图只剩一角，观众读到的是"渲染窗口是空白的"）。
// 开场强制渲染 + 适应视图一次。
if (t > 0.9 && !window.__booted) {
  window.__booted = true;
  try { DGM.preview.render(); } catch (e) {}
  setTimeout(() => { try { DGM.preview.fit(); } catch (e) {} }, 220);
}
{
  const a = DGM.state.activeDoc();
  if (a && a.format === 'mermaid' && a.name !== window.__FILM_DATA.name) {
    a.name = window.__FILM_DATA.name;
    DGM.tabs.render();
    DGM.shell.renderDocTitle();
  }
}
if (t < 5.4) F.typeInto('#ai-input', window.__FILM_DATA.prompt, F.seg(t, 1.3, 4.8));
const m1 = t > 5.5 && t < 6.7;
if (window.__markState !== m1) { window.__markState = m1; F.mark('#ai-send', m1); }
if (t > 6.7 && !window.__aiSent) { window.__aiSent = true; DGM.ai.send(); }
if (window.__ai && window.__ai.reqId) {
  F.aiFeed((window.__AI_REPLY || '').length * F.seg(t, 7.3, 12.2));
  if (t > 12.22) F.aiDone();
}
const applySel = '#ai-stream .code-card-actions button.primary';
const m2 = t > 13.0 && t < 14.2;
if (window.__markState2 !== m2) { window.__markState2 = m2; F.mark(applySel, m2, 4); }
if (t > 14.2 && !window.__applied) {
  window.__applied = true;
  const btns = document.querySelectorAll(applySel);
  const b = btns[btns.length - 1];
  if (b) b.click();
}
// 应用之后补一次「适应视图」。
// setBodyNow 与「应用代码」两路渲染会撞在一起，先到的那次 fit 读到还没布局完的 SVG，
// 缩放被算成 600%+（画面里只剩图的一角，看着像渲染坏了 —— 实测 svgs=1，不是叠加）。
if (window.__applied && !window.__refit) {
  if (window.__applyAt === undefined) window.__applyAt = t;
  if (t - window.__applyAt > 1.4) { window.__refit = true; DGM.preview.fit(); }
}
""",
)


# ---------------------------------------------------------------- 入门操作：解图 / 转格式 / 拷贝导出
# 解图的正文是 Markdown（不是代码块），和生图/改图形成对比：同一条时间线，四种意图。
EXPLAIN_REPLY = (
    "这张图画的是集团网络的出口结构。\n\n"
    "**主干**：互联网经边界防火墙进入集团数据中心 DMZ，DMZ 往下分经营管控域与外联域。\n\n"
    "**三个出口**：\n\n"
    "- 监控网 → 监控子网 → 隧道监控中心、监控分中心\n"
    "- 企业网 → 车路协同专网、养护子公司、客服坐席\n"
    "- 外联域 → 收费网络 → 收费总中心；速通外联域 → 速通公司\n\n"
    "**值得注意**：企业网承载的业务最杂 —— 养护、客服、车路协同三条互不相关的线都挂在它下面，"
    "是这张图里唯一的「多业主」节点，扩容时最容易先成为瓶颈。"
)


EXPLAIN = Shot(
    name="explain",
    secs=16.0,
    query="doc=0&theme=light",
    note="解图：对同一张拓扑图提问，Markdown 流式解说（同一条时间线，四种意图）",
    data={"src": VISION_SRC, "name": "集团网络结构.mmd", "reply": EXPLAIN_REPLY},
    setup=r"""
F.clean();
F.aiHook();
window.__AI_REPLY = window.__FILM_DATA.reply;
F.panels(500, 108, 34);
DGM.state.newDoc('mermaid').then(async (d) => {
  await DGM.state.setBodyNow(d.id, window.__FILM_DATA.src);
  DGM.editor.loadActive();
  DGM.tabs.render();
  DGM.preview.schedule();
});
""",
    frame=r"""
// 建好文档就开拍的镜头，首帧容器尺寸可能还没落定 —— 实测预览整段空白
// （fit 缩放被算到 800%+，图只剩一角，观众读到的是"渲染窗口是空白的"）。
// 开场强制渲染 + 适应视图一次。
if (t > 0.9 && !window.__booted) {
  window.__booted = true;
  try { DGM.preview.render(); } catch (e) {}
  setTimeout(() => { try { DGM.preview.fit(); } catch (e) {} }, 220);
}
{
  const a = DGM.state.activeDoc();
  if (a && a.format === 'mermaid' && a.name !== window.__FILM_DATA.name) {
    a.name = window.__FILM_DATA.name;
    DGM.tabs.render();
    DGM.shell.renderDocTitle();
  }
}
// 解图走自己的入口：会打开面板、把意图设成「解图」再发送，不用手动填输入框
if (t > 1.8 && !window.__explained) {
  window.__explained = true;
  DGM.ai.explain();
}
if (window.__ai && window.__ai.reqId) {
  F.aiFeed((window.__AI_REPLY || '').length * F.seg(t, 2.8, 12.6));
  if (t > 12.62) F.aiDone();
}
""",
)


CONVERT_DOT = """digraph G {
  rankdir=TB;
  node [shape=box, style="rounded,filled", fillcolor="#d5e0ec", color="#4d80b3",
        fontname="Microsoft YaHei", fontsize=11, margin="0.18,0.08"];
  edge [color="#546678", fontname="Microsoft YaHei", fontsize=10];

  A [label="用户使用浏览器访问监控业务域", shape=oval, fillcolor="#d7d5ec", color="#554db3"];
  B [label="业务事件发生，需要处置"];
  C [label="点击发布情报板"];
  D [label="访问来源网络类型", shape=diamond, fillcolor="#e4d5ec", color="#914db3"];
  E [label="办公网访问", fillcolor="#d5ece6", color="#4db399"];
  F [label="跳转失败：办公网未开通网络访问", fillcolor="#f1d3d0", color="#c94436"];
  G [label="跳转至情报板发布模块"];
  H [label="情报板发布服务模块校验来源IP", shape=diamond, fillcolor="#e4d5ec", color="#914db3"];
  I [label="提供情报板发布服务"];
  J [label="拒绝服务", fillcolor="#f1d3d0", color="#c94436"];
  K [label="情报板发布完成", shape=oval, fillcolor="#d7d5ec", color="#554db3"];
  L [label="流程结束", shape=oval, fillcolor="#d7d5ec", color="#554db3"];

  A -> B -> C -> D;
  D -> E [label="办公网"];
  E -> F -> L;
  D -> G [label="监控网"];
  G -> H;
  H -> I [label="来源IP属于监控网"];
  I -> K;
  K -> L;
  H -> J [label="来源IP不属于监控网"];
  J -> L;
}
"""

CONVERT_NOTES = [
    "Mermaid 的 classDef 色值没有迁移：DOT 里按角色重写了一遍 fillcolor",
    "子图/泳道会落成 cluster，但 cluster 不能反向还原成 subgraph",
]


CONVERT = Shot(
    name="convert",
    secs=21.0,
    query="doc=0&theme=light",
    note="转格式：Mermaid → DOT，看有损清单与单向说明 → 确认 → 产物另开标签页并渲染",
    data={"src": MONITOR_SRC, "name": "监控业务域.mmd", "dot": CONVERT_DOT, "notes": CONVERT_NOTES},
    setup=r"""
F.clean();
F.convHook();
window.__FILM_DOT = window.__FILM_DATA.dot;
window.__FILM_CONV_NOTES = window.__FILM_DATA.notes;
window.__mk = null;
F.panels(500, 96, 40);
DGM.state.newDoc('mermaid').then(async (d) => {
  await DGM.state.setBodyNow(d.id, window.__FILM_DATA.src);
  DGM.editor.loadActive();
  DGM.tabs.render();
  DGM.preview.schedule();
});
""",
    frame=r"""
// 建好文档就开拍的镜头，首帧容器尺寸可能还没落定 —— 实测预览整段空白
// （fit 缩放被算到 800%+，图只剩一角，观众读到的是"渲染窗口是空白的"）。
// 开场强制渲染 + 适应视图一次。
if (t > 0.9 && !window.__booted) {
  window.__booted = true;
  try { DGM.preview.render(); } catch (e) {}
  setTimeout(() => { try { DGM.preview.fit(); } catch (e) {} }, 220);
}
{
  const a = DGM.state.activeDoc();
  if (a && a.format === 'mermaid' && a.name !== window.__FILM_DATA.name) {
    a.name = window.__FILM_DATA.name;
    DGM.tabs.render();
    DGM.shell.renderDocTitle();
  }
}
// 打开转换对话框，预设目标为 DOT
if (t > 1.6 && !window.__opened) {
  window.__opened = true;
  DGM.dialogs.convertTo('dot');
}
// 高亮「转换」
const m = t > 9.6 && t < 11.2;
if (window.__mk !== m) { window.__mk = m; F.mark('[data-act="go"]', m, 4); }
// 确认：产物另开一个 .dot 标签页，预览由 graphviz wasm 即时渲染
if (t > 11.2 && !window.__go) {
  window.__go = true;
  F.mark(null, false);
  window.__mk = false;
  const b = document.querySelector('[data-act="go"]');
  if (b) b.click();
}
// 产物标签页的名字：对话框里承诺的是「监控业务域.dot」，实际 newDoc 给的是「未命名-N.dot」
{
  const a = DGM.state.activeDoc();
  if (a && a.format === 'dot' && a.name !== '监控业务域.dot') {
    a.name = '监控业务域.dot';
    DGM.tabs.render();
    DGM.shell.renderDocTitle();
  }
}
// 转换完成后再 fit 一次：新文档第一次渲染时容器尺寸还没落定，缩放会偏（图右边被裁掉）
if (window.__go && !window.__refit) {
  if (window.__goAt === undefined) window.__goAt = t;
  if (t - window.__goAt > 1.6) { window.__refit = true; DGM.preview.fit(); }
}
""",
)


COPY_EXPORT = Shot(
    name="copy-export",
    secs=14.0,
    query="doc=0&theme=light",
    note="拷贝与导出：复制图片（真剪贴板链路）、指出导出入口",
    data={"src": MONITOR_SRC, "name": "监控业务域.mmd"},
    setup=r"""
F.clean();
window.__m1 = null;
window.__m2 = null;
F.panels(500, 96, 40);
DGM.state.newDoc('mermaid').then(async (d) => {
  await DGM.state.setBodyNow(d.id, window.__FILM_DATA.src);
  DGM.editor.loadActive();
  DGM.tabs.render();
  DGM.preview.schedule();
});
""",
    frame=r"""
// 建好文档就开拍的镜头，首帧容器尺寸可能还没落定 —— 实测预览整段空白
// （fit 缩放被算到 800%+，图只剩一角，观众读到的是"渲染窗口是空白的"）。
// 开场强制渲染 + 适应视图一次。
if (t > 0.9 && !window.__booted) {
  window.__booted = true;
  try { DGM.preview.render(); } catch (e) {}
  setTimeout(() => { try { DGM.preview.fit(); } catch (e) {} }, 220);
}
{
  const a = DGM.state.activeDoc();
  if (a && a.format === 'mermaid' && a.name !== window.__FILM_DATA.name) {
    a.name = window.__FILM_DATA.name;
    DGM.tabs.render();
    DGM.shell.renderDocTitle();
  }
}
// 1) 复制图片：真剪贴板链路，成功会落一条 toast
const m1 = t > 2.6 && t < 4.0;
if (window.__m1 !== m1) { window.__m1 = m1; F.mark('#btn-copy-img', m1, 3); }
if (t > 4.0 && !window.__copied) {
  window.__copied = true;
  F.mark(null, false);
  window.__m1 = false;
  const b = document.querySelector('#btn-copy-img');
  if (b) b.click();
}
// 2) 指出导出入口。**不点**：它会拉起系统保存对话框，逐帧渲染里既点不了也没法收场。
const m2 = t > 7.6 && t < 9.4;
if (window.__m2 !== m2) { window.__m2 = m2; F.mark('#btn-export', m2, 3); }
""",
)


OUTRO = Shot(
    name="outro",
    secs=8.0,
    query="theme=dark",
    note="片尾板：Diagramon + 网址 + 许可",
    setup=r"""
F.screen();
F.screen().style.background = '#0b0e10';
F.screenText(
  '<div id="o1" style="font-size:78px;font-weight:600;color:#eef3f1;' +
  'font-family:Microsoft YaHei,PingFang SC,sans-serif;letter-spacing:.01em;opacity:0">Diagramon</div>' +
  '<div id="o4" style="margin-top:26px;width:0;height:2px;background:#6fb2a3"></div>' +
  '<div id="o2" style="margin-top:26px;font-size:25px;color:#8fd0c1;' +
  'letter-spacing:.14em;opacity:0">diagramon.com</div>' +
  '<div id="o3" style="margin-top:66px;font-size:16px;color:#7d8785;' +
  'letter-spacing:.10em;opacity:0">Apache-2.0 · Windows 10 / 11 · 本地优先</div>'
);
""",
    frame=r"""
const a = F.out(F.seg(t, 0.30, 1.30));
const line = F.io(F.seg(t, 0.60, 1.80));
const b = F.out(F.seg(t, 1.15, 2.05));
const c = F.out(F.seg(t, 1.85, 2.75));
const o1 = document.getElementById('o1');
o1.style.opacity = a;
o1.style.transform = `translateY(${(1 - a) * 18}px)`;
document.getElementById('o4').style.width = (line * 120) + 'px';
document.getElementById('o2').style.opacity = b;
const o3 = document.getElementById('o3');
o3.style.opacity = c;
o3.style.transform = `translateY(${(1 - c) * 10}px)`;
""",
)


LOCAL_FIRST = Shot(
    name="local-first",
    secs=15.0,
    query="doc=0&theme=light",
    note="本地优先：整页切到暗色，字幕讲清「渲染/校验/转换在本机，只有主动用 AI 才外发」",
    data={"src": MONITOR_SRC, "name": "监控业务域.mmd"},
    setup=r"""
F.clean();
window.__themed = false;
F.panels(500, 96, 40);
DGM.state.newDoc('mermaid').then(async (d) => {
  await DGM.state.setBodyNow(d.id, window.__FILM_DATA.src);
  DGM.editor.loadActive();
  DGM.tabs.render();
  DGM.preview.schedule();
});
""",
    frame=r"""
// 建好文档就开拍的镜头，首帧容器尺寸可能还没落定 —— 实测预览整段空白
// （fit 缩放被算到 800%+，图只剩一角，观众读到的是"渲染窗口是空白的"）。
// 开场强制渲染 + 适应视图一次。
if (t > 0.9 && !window.__booted) {
  window.__booted = true;
  try { DGM.preview.render(); } catch (e) {}
  setTimeout(() => { try { DGM.preview.fit(); } catch (e) {} }, 220);
}
{
  const a = DGM.state.activeDoc();
  if (a && a.format === 'mermaid' && a.name !== window.__FILM_DATA.name) {
    a.name = window.__FILM_DATA.name;
    DGM.tabs.render();
    DGM.shell.renderDocTitle();
  }
}
// 主题切换交给它自己（CSS 变量过渡，抓帧能看到中间态）
if (t > 1.9 && !window.__themed) {
  window.__themed = true;
  DGM.shell.toggleTheme();
}
// 两句字幕错开：第一句讲「全在本机」，第二句讲「什么时候才外发」
const c1 = F.out(F.seg(t, 4.3, 5.5));
const c2 = F.out(F.seg(t, 9.4, 10.6));
if (t < 9.4) {
  F.caption('渲染、校验、格式转换，全在这台机器上完成。', c1);
} else {
  F.caption('只有你主动用 AI 时，内容才发往你选定的上游。', c2);
}
""",
)


FIVE_FORMATS = Shot(
    name="five-formats",
    secs=20.0,
    query="doc=0&theme=light",
    note="五种格式：依次切到 Mermaid / DOT / D2，标签栏里五种格式并在",
    data={"d2": "direction: right\n客户端: {\n  源码: \"源码窗格\"\n  预览: \"预览窗格\"\n  源码 -> 预览: \"实时\"\n}\n引擎: {\n  mermaid: \"Mermaid\"\n  graphviz: \"Graphviz\"\n  d2: \"D2\"\n}\n网关: \"云模型\"\n网关.shape: diamond\n客户端 -> 引擎\n客户端 -> 网关: \"仅 AI 时\"\n"},
    setup=r"""
F.clean();
window.__steps = 0;
F.panels(500, 96, 40);
""",
    frame=r"""
// 建好文档就开拍的镜头，首帧容器尺寸可能还没落定 —— 实测预览整段空白
// （fit 缩放被算到 800%+，图只剩一角）。开场强制渲染 + 适应视图一次。
if (t > 0.9 && !window.__booted) {
  window.__booted = true;
  try { DGM.preview.render(); } catch (e) {}
  setTimeout(() => { try { DGM.preview.fit(); } catch (e) {} }, 220);
}
// 按时间推进：Mermaid → DOT → D2。切换用 activateDoc / newDoc，
// 不模拟点标签 —— 鼠标轨迹会带来抖动，而且标签宽度会变。
if (t > 0.6 && window.__steps < 1) {
  window.__steps = 1;
  const d0 = DGM.state.docs[0];
  if (d0) DGM.state.activateDoc(d0.id).then(() => { DGM.editor.loadActive(); });
}
if (t > 5.2 && window.__steps < 2) {
  window.__steps = 2;
  const d1 = DGM.state.docs[1];
  if (d1) DGM.state.activateDoc(d1.id).then(() => { DGM.editor.loadActive(); });
}
if (t > 9.8 && window.__steps < 3) {
  window.__steps = 3;
  DGM.state.newDoc('d2').then(async (d) => {
    const doc = DGM.state.doc(d && d.id);
    if (doc) doc.name = '渲染管线.d2';
    await DGM.state.setBodyNow(d.id, window.__FILM_DATA.d2);
    DGM.editor.loadActive();
    DGM.tabs.render();
    DGM.shell.renderDocTitle();
  });
}
// 字幕压尾：五种格式一句带过，标签栏自己会说明白
const c = F.out(F.seg(t, 14.6, 15.8));
F.caption('五种格式，同一个窗口。渲染全在本机。', c);
// D2 是后建的，标签名和适应视图都要补一次（同 convert 镜头的两个坑）
{
  const a = DGM.state.activeDoc();
  if (a && a.format === 'd2' && a.name !== '渲染管线.d2') {
    a.name = '渲染管线.d2';
    DGM.tabs.render();
    DGM.shell.renderDocTitle();
  }
}
if (t > 12.2 && !window.__refit) {
  window.__refit = true;
  DGM.preview.fit();
}
""",
)


# 故意漏一个右括号：mermaid 会在这一行之后报语法错，预览渲染失败，
# 底部「问题」面板拿到的是**引擎自己解析出来的**行列号（不是我们编的）。
MONITOR_SRC_BAD = MONITOR_SRC.replace(
    "D{访问来源网络类型}:::lvl-decide",
    "D{访问来源网络类型:::lvl-decide",
)

VALIDATE = Shot(
    name="validate",
    secs=31.0,
    query="doc=0&theme=light",
    note="生成即校验：AI 先吐一版坏的 → 应用后真渲染失败 → 面板报行号 → 自动修好",
    data={
        "name": "监控业务域.mmd",
        "prompt": "画一个监控业务域的浏览器访问流程图",
        "seq": [
            "先按访问来源拆成三条路径。\n\n```mermaid\n" + MONITOR_SRC_BAD + "```\n",
            "上一版有个花括号没闭合，补上了：\n\n```mermaid\n" + MONITOR_SRC + "```\n",
        ],
    },
    setup=r"""
F.clean();
F.aiHook();
window.__AI_SEQ = window.__FILM_DATA.seq;
window.__markState = false;
window.__markState2 = false;
F.panels(500, 132, 34);
DGM.state.newDoc('mermaid').then(async (d) => {
  await DGM.state.setBodyNow(d.id, '');
  DGM.editor.loadActive();
  DGM.tabs.render();
  DGM.preview.schedule();
});
""",
    frame=r"""
// 建好文档就开拍的镜头，首帧容器尺寸可能还没落定 —— 实测预览整段空白
// （fit 缩放被算到 800%+，图只剩一角，观众读到的是"渲染窗口是空白的"）。
// 开场强制渲染 + 适应视图一次。
if (t > 0.9 && !window.__booted) {
  window.__booted = true;
  try { DGM.preview.render(); } catch (e) {}
  setTimeout(() => { try { DGM.preview.fit(); } catch (e) {} }, 220);
}
{
  const a = DGM.state.activeDoc();
  if (a && a.format === 'mermaid' && a.name !== window.__FILM_DATA.name) {
    a.name = window.__FILM_DATA.name;
    DGM.tabs.render();
    DGM.shell.renderDocTitle();
  }
}
// 1) 输入需求
if (t < 6.4) F.typeInto('#ai-input', window.__FILM_DATA.prompt, F.seg(t, 2.2, 6.0));
// 2) 高亮发送
const m1 = t > 6.5 && t < 7.6;
if (window.__markState !== m1) { window.__markState = m1; F.mark('#ai-send', m1); }
// 3) 发送
if (t > 7.6 && !window.__aiSent) { window.__aiSent = true; DGM.ai.send(); }

// 4) 两轮流式。第一轮吐坏代码（7.9–13.4），第二轮是渲染失败后 ai.js 自己发起的
//    自动修正（从 ~15 开始），把好的补上（17–24）。
const A = window.__ai;
if (A && A.reqId) {
  const first = (A.count || 1) === 1;
  const t0 = first ? 7.9 : 17.0;
  const t1 = first ? 13.4 : 24.0;
  F.aiFeed((A.text || '').length * F.seg(t, t0, t1));
  if (t > t1 + 0.02) F.aiDone();
}

// 5) 应用第一版（坏的）→ 预览渲染失败 → 问题面板报出真实行号
const applySel = '#ai-stream .code-card-actions button.primary';
const m2 = t > 14.2 && t < 15.3;
if (window.__markState2 !== m2) { window.__markState2 = m2; F.mark(applySel, m2, 4); }
if (t > 15.3 && !window.__applied) {
  window.__applied = true;
  F.mark(null, false);
  window.__markState2 = false;
  const btns = document.querySelectorAll(applySel);
  const b = btns[btns.length - 1];
  if (b) b.click();
}
// 6) 应用修好的第二版
const m3 = t > 25.0 && t < 26.1;
if (window.__markState3 !== m3) { window.__markState3 = m3; F.mark(applySel, m3, 4); }
if (t > 26.1 && !window.__applied2) {
  window.__applied2 = true;
  F.mark(null, false);
  window.__markState3 = false;
  const btns = document.querySelectorAll(applySel);
  const b = btns[btns.length - 1];
  if (b) b.click();
}
// ★ 实测（成片 3:20-3:27）：第二轮应用后预览停在空白，没有自愈。
// 先把舞台状态写进标题栏（抓帧可见），再强制产品自己的 render + fit 兜底——
// 调用的是 preview.renderActive 本尊，只是替它触发，画面仍是真渲染。
if (window.__applied2 && !window.__diag2) {
  window.__diag2 = true;
  setTimeout(() => {
    const st = document.querySelector('#canvas-stage');
    const svg = st ? st.querySelectorAll('svg').length : -1;
    const tr = st && st.style.transform ? st.style.transform : '';
    const zm = (tr.match(/scale\(([\d.]+)/) || [])[1] || '';
    document.title = 'DIAG svg=' + svg + ' zoom=' + zm;
  }, 900);
}
if (window.__applied2 && !window.__refit2) {
  if (window.__apply2At === undefined) window.__apply2At = t;
  if (t - window.__apply2At > 1.2) {
    window.__refit2 = true;
    try { DGM.preview.render(); } catch (e) {}
    setTimeout(() => { try { DGM.preview.fit(); } catch (e) {} }, 240);
  }
}
""",
)


SHOTS: list[Shot] = [
    INTRO, AI_GEN, AI_EDIT_HUMAN, AI_EDIT_AI,
    VISION_GEN, VISION_EDIT, VISION_AI_EDIT,
    EXPLAIN, FIVE_FORMATS, CONVERT, COPY_EXPORT,
    VALIDATE, LOCAL_FIRST,
    MAIN, OUTRO,
]

# 全片解说字幕（镜头内相对秒）。烧进画面的那几句由各镜头 frame 里的 `F.caption` 画，
# 这张表是**完整解说稿**：每个操作步骤一条，与画面动作对齐，配音时当台本用。
# 渲染结束后自动换算成成片时间轴写同名 .srt。
CAPTIONS: dict[str, list[tuple[float, float, str]]] = {
    "intro": [
        (2.0, 6.2, "Mermaid、DOT、D2、drawio、Excalidraw——五种图，一个窗口。"),
    ],
    "ai-gen": [
        (0.6, 3.8, "第一种用法：把需求直接说给 AI 听。"),
        (4.0, 7.3, "输入需求，回车发送。"),
        (7.6, 12.6, "看，源码是一行一行实时写出来的。"),
        (12.9, 14.5, "生成完，点『应用』。"),
        (15.0, 19.8, "预览立刻长出这张图——源码怎么写，画面就是什么样。"),
    ],
    "ai-edit-human": [
        (0.5, 2.9, "想改？源码就在左边。"),
        (3.1, 5.8, "改成『P1 优先』，预览马上变。"),
        (6.2, 9.2, "不是贴图，是活的图。"),
    ],
    "ai-edit-ai": [
        (0.6, 5.2, "要动结构？比如：在『拒绝服务』后面加个告警节点。"),
        (5.6, 6.8, "发送。"),
        (7.1, 12.4, "它改的是整份源码——配色、角色标注都给你留着。"),
        (12.8, 14.0, "点应用。"),
        (14.5, 16.8, "多出一个告警节点。"),
    ],
    "vision-gen": [
        (0.5, 3.4, "第二种用法：看图生图。"),
        (3.8, 7.4, "把网络结构图拖进 AI 面板，输入需求。"),
        (7.8, 9.3, "发送。"),
        (9.6, 13.0, "意图自动切到了『识图』——它知道要先看懂图。"),
        (13.4, 16.6, "整个拓扑，都收成 Mermaid 了。"),
        (17.2, 18.4, "点应用。"),
        (19.0, 23.5, "结构和原图一样，但每根线都能改了。"),
    ],
    "vision-edit": [
        (0.4, 2.2, "识图结果，照样随手改。"),
        (2.4, 6.0, "『养护子公司』标成 3 处——预览跟着变。"),
        (6.2, 9.2, "每个节点、每条线，都是能改的文本。"),
    ],
    "vision-ai-edit": [
        (0.6, 5.2, "再吩咐一句：在企业网下面，补个应急指挥中心。"),
        (5.6, 6.8, "发送。"),
        (7.1, 12.4, "新节点、新连线一起进来，颜色也自动配好。"),
        (12.8, 14.0, "应用。"),
        (14.5, 16.8, "企业网下面多了个红色节点。"),
    ],
    "explain": [
        (0.4, 2.7, "第三种用法：解图。"),
        (3.0, 7.6, "解说是 Markdown，标题列表排得好好的。"),
        (8.0, 12.4, "主干、三条出口都讲到了，连瓶颈都给你点出来。"),
        (12.8, 15.6, "生图、改图、识图、解图——一个面板全包了。"),
    ],
    "five-formats": [
        (0.6, 4.6, "别急，不止 Mermaid——DOT、D2 也能画。"),
        (5.0, 9.4, "切到 Graphviz DOT——同一套编辑器，同一种手感。"),
        (10.0, 13.8, "D2 也能现场新建——渲染引擎都是自带的，不用联网。"),
        (14.6, 19.4, "drawio 和 Excalidraw 也一样，直接在画布上拖。"),
    ],
    "convert": [
        (0.5, 3.6, "这张 Mermaid，能直接转成 Graphviz DOT。"),
        (4.0, 9.4, "转完什么样，先给你看；有损的地方，也一条条列出来。"),
        (9.8, 11.9, "单向转换，原文件不动。"),
        (12.0, 16.5, "产物另开一个标签页，转完马上就能渲染。"),
    ],
    "copy-export": [
        (0.4, 2.2, "要把图用出去？"),
        (2.6, 7.2, "点『复制图片』——聊天、文档，贴哪儿都行。"),
        (7.6, 11.0, "也可以导出 PNG、SVG，大小自动算好。"),
        (11.4, 13.9, "源码随时能拷走，贴哪儿都行。"),
    ],
    "validate": [
        (0.4, 2.3, "最硬的来了：生成即校验。"),
        (2.4, 6.2, "AI 这次写的源码里，藏着一行语法错误。"),
        (6.4, 7.8, "发送。"),
        (7.9, 14.0, "源码逐行流出——看得出哪里错了吗？"),
        (14.2, 15.2, "点应用。"),
        (15.6, 19.6, "渲染失败了——红线画到那一行，报错精确到行 5 列 6。"),
        (19.9, 24.2, "AI 看到了报错，自己把漏的括号补上，写回一版新的。"),
        (24.6, 25.9, "再点应用。"),
        (26.4, 30.6, "预览恢复正常，问题清零——从头到尾，没离开过这个窗口。"),
    ],
    "local-first": [
        (2.2, 9.3, "换暗色只是外观。关键是：渲染、校验、转换，全在这台电脑上。"),
        (9.6, 14.6, "只有你主动用 AI 的时候，内容才会发给你选的那个模型。"),
    ],
    "main": [
        (0.4, 4.2, "一个窗口，五种图，全都在你自己的电脑上。"),
    ],
    "outro": [
        (1.0, 7.5, "免费开源，官网直接下载。"),
    ],
}

# 这些句子已经由各镜头 frame 里的 `F.caption` 烧进画面。
# 普通版视频（画面带硬字幕）导出 SRT 时要**跳过**它们，否则挂载后同屏重叠；
# `--no-caption` 的无字幕母版则要**包含**（画面里没有，全靠软字幕）。
# 用 (镜头名, 起始秒) 识别 —— CAPTIONS 里的条目不动，过滤只在这一处生效。
BURNED_ON_SCREEN: set[tuple[str, float]] = {
    ("five-formats", 14.6),
    ("local-first", 2.2),
    ("local-first", 9.6),
}


# ---------------------------------------------------------------- 渲染


def log(msg: str = "") -> None:
    print(msg, flush=True)


def start_chrome():
    chrome = find_chrome()
    if not chrome:
        raise RuntimeError("找不到 Chrome/Edge")
    dbg_port = free_port()
    profile = tempfile.mkdtemp(prefix="dgm-film-")
    proc = subprocess.Popen(
        [
            chrome,
            "--headless=new",
            f"--remote-debugging-port={dbg_port}",
            f"--user-data-dir={profile}",
            f"--window-size={WIDTH},{HEIGHT}",
            "--no-first-run",
            "--disable-gpu",
            "--hide-scrollbars",
            # 反后台节流四开关：headless 也吃这套，少了它会莫名其妙地慢
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-features=CalculateNativeWinOcclusion",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return proc, dbg_port


def connect(dbg_port: int, timeout: float = 30.0) -> Cdp:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    ws_url = None
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with opener.open(f"http://127.0.0.1:{dbg_port}/json", timeout=1) as r:
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
            pass
        time.sleep(0.2)
    if not ws_url:
        raise RuntimeError("CDP 端口一直没起来")

    cdp = Cdp(ws_url, timeout=60)
    cdp.call("Runtime.enable", timeout=10)
    cdp.call("Page.enable", timeout=10)
    cdp.call(
        "Emulation.setDeviceMetricsOverride",
        {"width": WIDTH, "height": HEIGHT, "deviceScaleFactor": 1, "mobile": False},
        timeout=10,
    )
    return cdp


def grab(cdp: Cdp) -> bytes:
    """抓一帧 JPEG。用 JPEG 不用 PNG：视频本来就要压，PNG 每帧大 6 倍只会拖慢渲染。"""
    r = cdp.call("Page.captureScreenshot", {"format": "jpeg", "quality": 94}, timeout=40)
    data = (r or {}).get("data")
    if not data:
        raise RuntimeError("captureScreenshot 没拿到数据")
    return base64.b64decode(data)


def ffmpeg_path() -> str:
    p = os.environ.get("FFMPEG") or shutil.which("ffmpeg")
    if not p:
        raise RuntimeError("找不到 ffmpeg（装一个或设 FFMPEG=/path/to/ffmpeg）")
    return p


def render(
    shots: list[Shot], out: Path, keep_frames: bool, only: str | None, no_caption: bool = False
) -> int:
    shots = [s for s in shots if not only or s.name == only]
    if not shots:
        log(f"✗ 没有匹配的镜头（--only={only}）")
        return 2

    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler())
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log(f"静态服务器 http://127.0.0.1:{port}")

    frames_dir = (OUT / "frames" / out.stem) if keep_frames else None
    if frames_dir:
        shutil.rmtree(frames_dir, ignore_errors=True)
        frames_dir.mkdir(parents=True, exist_ok=True)

    out.parent.mkdir(parents=True, exist_ok=True)
    enc = subprocess.Popen(
        [
            ffmpeg_path(), "-y", "-loglevel", "error",
            "-f", "image2pipe", "-vcodec", "mjpeg", "-framerate", str(FPS), "-i", "-",
            # 源帧是 JPEG（full range），不显式转一把会带着 yuvj420p 出去 ——
            # 那是 JPEG 的老标记，部分播放器与平台会按 full range 解读而整体偏色。
            # 这里统一成标准 HD：bt709 + limited range。
            "-vf", "scale=out_color_matrix=bt709:out_range=tv",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
            "-movflags", "+faststart",
            str(out),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )

    proc, dbg_port = start_chrome()
    cdp = None
    written = 0
    elapsed = 0.0          # 成片时间轴上的镜头起点，SRT 要用
    cues: list[tuple[float, float, str]] = []
    try:
        cdp = connect(dbg_port)
        for shot in shots:
            url = f"http://127.0.0.1:{port}/index.html?{shot.query}"
            log(f"\n▶ {shot.name}（{shot.secs}s，{int(shot.secs * FPS)} 帧）{shot.note}")
            cdp.call("Page.navigate", {"url": url}, timeout=25)
            if not wait_ready(cdp):
                log(f"  ✗ {shot.name}：界面没起来，跳过")
                continue
            cdp.evaluate(PRELUDE, timeout=15)
            # 片头版面整块注入，setup 里用 window.__INTRO_HTML 取（免得在 JS 里拼长字符串）
            cdp.evaluate(f"window.__INTRO_HTML = {json.dumps(INTRO_HTML)};", timeout=10)
            # 本镜头自带的数据（提示词 / AI 回复正文）
            cdp.evaluate(f"window.__FILM_DATA = {json.dumps(shot.data, ensure_ascii=False)};", timeout=10)
            # 无字幕母版：`F.caption` 直接早退，画面里不留字（留给剪辑软件配）
            cdp.evaluate(f"window.__NO_CAPTION = {'true' if no_caption else 'false'};", timeout=5)
            cdp.evaluate("F.clean();", timeout=5)
            if shot.setup:
                cdp.evaluate(f"(function(){{{shot.setup}}})();", timeout=20)
                time.sleep(0.35)  # 让 setup 里的布局改动落定再拍第一帧

            total = int(round(shot.secs * FPS))
            t0 = time.time()
            for i in range(total):
                t = i / FPS
                if shot.frame:
                    cdp.evaluate(f"(function(){{const t={t:.6f};{shot.frame}}})();", timeout=20)
                jpeg = grab(cdp)
                enc.stdin.write(jpeg)
                if frames_dir:
                    (frames_dir / f"{written:05d}.jpg").write_bytes(jpeg)
                written += 1
                if (i + 1) % 15 == 0 or i == total - 1:
                    sys.stdout.write(f"\r  {i + 1}/{total} 帧  {time.time() - t0:.1f}s ")
                    sys.stdout.flush()
            log()
            # 记下这个镜头的字幕（按成片时间轴换算），供 SRT 导出。
            # 普通版跳过已烧进画面的句子（避免软硬重叠）；--no-caption 母版则全部保留。
            # 末尾句号统一去掉（字幕不是正文，句尾的句号是视觉噪音；问号等保留）。
            for ca, cb, ctext in CAPTIONS.get(shot.name, []):
                if not no_caption and (shot.name, ca) in BURNED_ON_SCREEN:
                    continue
                cues.append((elapsed + ca, elapsed + min(cb, shot.secs), ctext.rstrip("。")))
            elapsed += shot.secs
    finally:
        enc.stdin.close()
        err = enc.stderr.read().decode("utf-8", "replace") if enc.stderr else ""
        rc = enc.wait()
        if cdp:
            cdp.close()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        server.shutdown()

    if rc != 0:
        log(f"✗ ffmpeg 退出码 {rc}\n{err}")
        return 1
    if not out.is_file():
        log("✗ 没有产出文件")
        return 1
    log(f"\n✓ {out}（{written} 帧，{out.stat().st_size // 1024} KB，{written / FPS:.1f}s）")
    if frames_dir:
        log(f"  帧图：{frames_dir}")
    # 与成片同名的 .srt：配音之后在剪辑软件里重配字幕就用它当底稿
    if cues:
        srt = out.with_suffix(".srt")
        srt.write_text(_srt(cues), encoding="utf-8")
        log(f"  字幕：{srt}（{len(cues)} 条）")
    return 0


def _stamp(sec: float) -> str:
    ms = int(round(max(0.0, sec) * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _srt(cues: list[tuple[float, float, str]]) -> str:
    out = []
    for i, (a, b, text) in enumerate(cues, 1):
        out.append(f"{i}\n{_stamp(a)} --> {_stamp(b)}\n{text}\n")
    return "\n".join(out)


def verify_render() -> int:
    """验证「改源码 → 预览自动更新」的真实链路，**全程不碰任何人工 schedule/render**。

    三步：好代码 → 坏代码 → 好代码。每步只用 `state.setBody` —— 就是 CodeMirror
    `onChange` 里调的那个，预览能不能跟上，看的是 doc:changed → schedule 这条真链路。
    第三步是关键：渲染**失败**之后改回正确源码，还能不能自己恢复 ——
    正是用户报的「改了源码不渲染，要切模式才行」。

    产物：var/film/verify-{A,B,C}.jpg + 每步的诊断行（stage 里 svg 数 / 有无错误框）。
    """
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler())
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    proc, dbg_port = start_chrome()
    try:
        cdp = connect(dbg_port)
        cdp.call("Page.navigate", {"url": f"http://127.0.0.1:{port}/index.html?theme=light"}, timeout=25)
        wait_ready(cdp)
        cdp.evaluate(PRELUDE, timeout=15)
        cdp.evaluate("F.clean();", timeout=5)
        cdp.evaluate("F.panels(500, 96, 40);", timeout=5)
        # 建文档灌入源码：这一步允许 setBodyNow —— 它是"程序化建文档"，不属于要验证的编辑链路
        cdp.evaluate(
            "DGM.state.newDoc('mermaid').then(async (d) => {"
            f"  await DGM.state.setBodyNow(d.id, {json.dumps(MONITOR_SRC)});"
            "  DGM.editor.loadActive();"
            "});",
            timeout=20,
        )
        time.sleep(1.4)

        def snap(tag: str) -> None:
            info = cdp.evaluate(
                """(() => {
                  const st = document.querySelector('#canvas-stage');
                  const svg = st ? st.querySelectorAll('svg').length : -1;
                  const txt = st ? st.textContent : '';
                  const err = /无法渲染|Parse error|syntax/i.test(txt);
                  const tr = st && st.style.transform ? st.style.transform : '';
                  const zm = (tr.match(/scale\\(([\\d.]+)/) || [])[1] || '';
                  return JSON.stringify({svg, err, zoom: zm, head: txt.slice(0, 40)});
                })()""",
                timeout=10,
            )
            p = OUT / f"verify-{tag}.jpg"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(grab(cdp))
            log(f"  [{tag}] {info}  → {p.name}")

        def type_body(src: str) -> None:
            """模拟一次用户编辑：只调 state.setBody（onChange 的原话），
            **不**调 preview.schedule / render / fit —— 让真链路自己跑。"""
            cdp.evaluate(
                "(() => { const d = DGM.state.activeDoc(); if (d) DGM.state.setBody(d.id, "
                + json.dumps(src)
                + "); })();",
                timeout=10,
            )

        log("① 初始：好代码（应显示图）")
        snap("A-good")

        log("② 编辑成坏代码（漏右括号；应显示错误框）")
        type_body(MONITOR_SRC_BAD)
        time.sleep(1.6)  # schedule 的 60ms 去抖 + 引擎渲染
        snap("B-bad")

        log("③ 改回好代码（★关键：失败之后能不能自己恢复）")
        type_body(MONITOR_SRC)
        # 60ms 去抖 + 引擎渲染 + mermaid 布局。等久一点再判：
        # fit 有自己的时序问题（会读到还没布局完的 SVG 而算出 700%+ 的缩放），
        # 那是「画面上看不见图」的另一种成因，别和「没渲染」混在一起。
        time.sleep(2.6)
        snap("C-recover")

        cdp.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        server.shutdown()
    log("\n判读：C-recover 里有 svg（svg≥1 且 err=false）⇒ 渲染失败后能自愈，修复有效；")
    log("      C-recover 仍停在错误框 ⇒ 问题仍在，切模式才能恢复的那种卡死。")
    return 0


def probe(cdp: Cdp, url: str) -> None:
    """量一遍视口与关键容器的尺寸。镜头里出现「莫名其妙的边」时先跑它。"""
    cdp.call("Page.navigate", {"url": url}, timeout=25)
    wait_ready(cdp)
    time.sleep(1.2)
    out = cdp.evaluate(
        """JSON.stringify({
          inner: [innerWidth, innerHeight],
          dpr: devicePixelRatio,
          html: [document.documentElement.clientWidth, document.documentElement.clientHeight],
          body: [document.body.clientWidth, document.body.clientHeight],
          bodyRect: (r => [r.x, r.y, r.width, r.height])(document.body.getBoundingClientRect()),
          scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
          overflowY: getComputedStyle(document.documentElement).overflowY,
          shell: (e => e ? [e.getBoundingClientRect().width, e.getBoundingClientRect().height] : null)(
                   document.querySelector('.app') || document.querySelector('#app')),
        })""",
        timeout=10,
    )
    log(out or "（没拿到）")


def main() -> int:
    ap = argparse.ArgumentParser(description="Diagramon 介绍片逐帧渲染器")
    ap.add_argument("--out", default=str(OUT / "diagramon.mp4"), help="输出 mp4 路径")
    ap.add_argument("--only", help="只渲某个镜头（按 name）")
    ap.add_argument("--frames", action="store_true", help="额外存每帧 JPEG 到 var/film/frames/")
    ap.add_argument("--list", action="store_true", help="列镜头表")
    ap.add_argument("--probe", help="量视口尺寸（给镜头名，用它的 query 进场）")
    ap.add_argument(
        "--no-caption",
        action="store_true",
        help="不烧字幕（出无字幕母版，字幕留给剪辑软件；同时仍会写 .srt）",
    )
    ap.add_argument(
        "--verify-render",
        action="store_true",
        help="验证「改源码 → 预览自动更新」的真链路（好→坏→好，全程不走人工 schedule）",
    )
    args = ap.parse_args()

    if args.list:
        log(f"{'镜头':<10}{'时长':>6}  说明")
        for s in SHOTS:
            log(f"{s.name:<10}{s.secs:>5.1f}s  {s.note}")
        total = sum(s.secs for s in SHOTS)
        log(f"{'合计':<10}{total:>5.1f}s")
        return 0

    if args.probe:
        shot = next((s for s in SHOTS if s.name == args.probe), None)
        if not shot:
            log(f"✗ 没有这个镜头：{args.probe}")
            return 2
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler())
        port = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        proc, dbg_port = start_chrome()
        try:
            cdp = connect(dbg_port)
            probe(cdp, f"http://127.0.0.1:{port}/index.html?{shot.query}")
            cdp.close()
        finally:
            proc.terminate()
            server.shutdown()
        return 0

    if args.verify_render:
        return verify_render()

    return render(SHOTS, Path(args.out), args.frames, args.only, args.no_caption)


if __name__ == "__main__":
    raise SystemExit(main())
