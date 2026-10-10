// Stage 3 验收：AI 助手（BYOK）。
//
// 场景自己在模块作用域起一个**本地 mock 供应商**（OpenAI 兼容），模型配置指向它，
// 于是"网络调用 → 载荷 → 响应解析 → 应用到编辑器 → 渲染失败自动回修 → 对话持久化"
// 整条链路被真实跑一遍，不依赖任何外部服务或密钥。
//
// 回复按**显式队列**下发（而不是靠时序改标志），这样"先坏后好"的回修路径是确定性的。

import { createServer } from "node:http";
import { writeFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** 收到的请求（供断言）。 */
export const requests = [];
/** 待下发的回复队列；用尽后回落到 DEFAULT_REPLY。 */
export const replies = [];

const DEFAULT_REPLY = "```mermaid\ngraph TD\n  DEF[默认] --> OK[完成]\n```";

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch (e) {
      body = null;
    }
    const content = replies.length ? replies.shift() : DEFAULT_REPLY;
    requests.push({ url: req.url, headers: req.headers, body, served: content });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const workdir = await mkdtemp(path.join(tmpdir(), "dgm-e2e-stage3-"));
const sample = path.join(workdir, "ai.mmd");
await writeFile(sample, "graph TD\n  A[开始] --> B[结束]\n", "utf8");

const MODEL = {
  id: "mock",
  name: "Mock",
  provider: "custom",
  // 故意带完整端点：验证 Base URL 清洗
  baseUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
  modelId: "mock-model",
  maxTokens: 2048,
  temperature: 0.3,
};

const AI_SETTINGS = {
  models: [MODEL],
  selectedModelId: "mock",
  conversationStoragePath: null,
  renderFeedbackRetry: true,
  visionNoticeAccepted: true,
};

const GOOD = "```mermaid\ngraph TD\n  AI[来自模型] --> OK[完成]\n```";
const BAD = "```mermaid\ngraph TD\n  A -- > B\n```";
const FIXED = "```mermaid\ngraph TD\n  FIXED[已修正] --> OK[完成]\n```";
const VISION = "```mermaid\ngraph TD\n  IMG[来自图片] --> OK[完成]\n```";

async function waitFor(cdp, expr, { timeout = 15000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`(async () => { try { return !!(${expr}); } catch (e) { return false; } })()`)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

const sendInstruction = (cdp, text) =>
  cdp.evaluate(`(() => {
    document.getElementById('ai-text').value = ${JSON.stringify(text)};
    document.getElementById('ai-send').click();
    return true;
  })()`);

const clickLastApply = (cdp) =>
  cdp.evaluate(
    "(() => { const lists = document.querySelectorAll('.ai-msg-actions'); lists[lists.length - 1].querySelector('button').click(); return true; })()",
  );

const activeBody = (cdp) =>
  cdp.evaluate("(async () => await DGM.invoke('read_document', { id: DGM.app.state.activeId }))()");

export default async function ({ cdp, check, sleep, log }) {
  const dirs = await cdp.evaluate("DGM.invoke('app_dirs')");

  // ---- 配置指向 mock 的模型 ----
  await cdp.evaluate(`DGM.invoke('ai_settings_save', { ai: ${JSON.stringify(AI_SETTINGS)} })`);

  const endpoints = await cdp.evaluate(`DGM.invoke('ai_endpoints', { model: ${JSON.stringify(MODEL)} })`);
  check("Base URL 清洗（去尾缀）", endpoints[0] === `http://127.0.0.1:${port}/v1`, JSON.stringify(endpoints));
  check("端点推导正确", endpoints[1] === `http://127.0.0.1:${port}/v1/chat/completions`, endpoints[1]);

  const stateAfter = await cdp.evaluate("DGM.invoke('ai_state')");
  check("AI 状态包含模型", stateAfter.models.length === 1 && stateAfter.selectedModelId === "mock");

  // ---- 打开真实文件（对话持久化需要稳定身份）并展开面板 ----
  await cdp.evaluate(`window.DGM.app.openPath(${JSON.stringify(sample)})`);
  await sleep(500);
  await cdp.evaluate("DGM.ai.open()");
  await sleep(300);

  // ---- 生成：真实 HTTP → mock ----
  requests.length = 0;
  replies.length = 0;
  replies.push(GOOD);
  await sendInstruction(cdp, "画一个 AI 流程图");
  check("生成返回并显示在面板", await waitFor(cdp, "document.querySelectorAll('.ai-msg.assistant').length >= 1"));
  check("mock 收到了请求", requests.length === 1, `n=${requests.length}`);

  const req = requests[0];
  check("请求打到清洗后的端点", req && req.url === "/v1/chat/completions", req && req.url);
  const sys = req && req.body && req.body.messages && req.body.messages[0];
  check(
    "系统提示词是 Mermaid 生成提示词",
    sys && sys.role === "system" && sys.content.includes("Mermaid 图表代码生成助手"),
    sys && sys.content.slice(0, 20),
  );
  check(
    "请求带上了当前代码",
    req && req.body.messages.some((m) => m.content && m.content.includes("当前 Mermaid 代码")),
  );
  check("参数随模型配置下发", req && req.body.max_tokens === 2048 && Math.abs(req.body.temperature - 0.3) < 0.001);

  // ---- 应用 / 回退 ----
  const before = await activeBody(cdp);
  await clickLastApply(cdp);
  check("应用把代码写进标签", await waitFor(cdp, `(async () => (await DGM.invoke('read_document', { id: DGM.app.state.activeId })).includes('来自模型'))()`));
  check("应用后预览渲染成功", await waitFor(cdp, "document.querySelector('#preview-content svg')"));

  await cdp.evaluate(
    "(() => { const lists = document.querySelectorAll('.ai-msg-actions'); lists[lists.length - 1].querySelectorAll('button')[1].click(); return true; })()",
  );
  check(
    "回退恢复原文",
    await waitFor(
      cdp,
      `(async () => { const b = await DGM.invoke('read_document', { id: DGM.app.state.activeId }); return b === ${JSON.stringify(before)}; })()`,
    ),
  );

  // ---- 对话持久化：按文档稳定身份落盘 ----
  const key = await cdp.evaluate(`DGM.invoke('ai_conversation_key', { path: ${JSON.stringify(sample)} })`);
  const stored = await cdp.evaluate(`DGM.invoke('ai_conversation_load', { key: ${JSON.stringify(key)} })`);
  check(
    "对话已按稳定身份存档，且只含真实消息",
    Array.isArray(stored) && stored.some((m) => m.role === "user") && !stored.some((m) => m.role === "system"),
    `n=${stored.length} roles=${JSON.stringify(stored.map((m) => m.role))}`,
  );

  // ---- 渲染失败自动回修：回复队列 = [坏代码, 修好的代码] ----
  requests.length = 0;
  replies.length = 0;
  replies.push(BAD, FIXED);

  await sendInstruction(cdp, "再来一个");
  check("第二次生成到达面板", await waitFor(cdp, "document.querySelectorAll('.ai-msg.assistant').length >= 2"));
  await clickLastApply(cdp);

  // 修复请求是 Node 侧（mock）观察到的，直接在 Node 侧等待，避免与页面轮询抢时序
  const nodeDeadline = Date.now() + 25000;
  while (Date.now() < nodeDeadline && requests.length < 2) {
    await sleep(200);
  }

  const repaired = await waitFor(
    cdp,
    `(async () => (await DGM.invoke('read_document', { id: DGM.app.state.activeId })).includes('已修正'))()`,
    { timeout: 20000, interval: 300 },
  );
  check("渲染失败触发自动回修并替换为可用代码", repaired === true);
  check("回修确实发生了第二次请求", requests.length >= 2, `n=${requests.length}`);
  check("回修后预览恢复渲染", await waitFor(cdp, "document.querySelector('#preview-content svg')"));

  // ---- 识图（截图 → 代码）----
  requests.length = 0;
  replies.length = 0;
  replies.push(VISION);
  const visionCode = await cdp.evaluate(`(async () => await DGM.invoke('ai_generate_from_image', {
    modelId: 'mock',
    format: 'mermaid',
    imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    history: [],
  }))()`);
  check("识图返回代码", typeof visionCode === "string" && visionCode.includes("IMG"), String(visionCode).slice(0, 30));

  const visionReq = requests[0];
  const parts = visionReq && visionReq.body && visionReq.body.messages[1] && visionReq.body.messages[1].content;
  const partTypes = Array.isArray(parts) ? parts.map((p) => p.type) : [`<${typeof parts}>`];
  check(
    "识图请求携带 image_url 内容块",
    Array.isArray(parts) && parts.some((p) => p.type === "image_url"),
    JSON.stringify(partTypes),
  );

  // ---- 密钥：进凭据库、不进 settings.json ----
  await cdp.evaluate("DGM.invoke('ai_key_set', { modelId: 'mock', key: 'sk-e2e-secret' })");
  const withKey = await cdp.evaluate("DGM.invoke('ai_state')");
  check("密钥登记后状态标记为已配置", withKey.modelsWithKey.includes("mock"));

  const settingsText = await readFile(dirs.settings, "utf8");
  check("settings.json 里没有明文密钥", !settingsText.includes("sk-e2e-secret"));

  await cdp.screenshot("target/e2e-stage3.png");
  log("screenshot -> target/e2e-stage3.png");
}
