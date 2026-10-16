# Diagramon 客户端 AI 能力优化方案与计划（定稿）

> 范围：`client2/`（Rust + Tauri 2 + 系统 WebView）。
> 目标：**提高 AI 产出图表的一次可用率，并让 AI 具备跨会话记忆**；不更换框架。
> 状态：**确定执行**。五个阶段全部纳入计划，顺序固定为 一 → 二 → 三 → 四 → 五。
>
> 2026-10-15 定稿：由"建议/可选"改为"确定执行"；**记忆能力正式纳入，列为阶段四**；原先悬着的"历史会话文案不实"改为**补齐实现**（阶段三），不再走改文案绕过。

---

## 一、结论

1. **不重构、不换框架。** `crates/ai` 只有 739 行、零 Tauri 依赖、自带单测，是整条链路里最干净的一块 —— 换掉它是净亏。不引入 pi harness 之类的 agent 框架。
2. **不做"通用 Agent"。** 只做**受控工具循环**：工具限定 4 个、只作用于内存文档模型、绝不接触文件系统与 shell。
3. **记忆能力要做**，且**由客户端持有**（服务端保持无状态）。设计见 §六。
4. **五个阶段顺序固定**：一 渲染校验回环 → 二 多轮消息与上下文预算 → 三 会话持久化 → 四 记忆能力 → 五 受控工具循环。阶段二是后三者的结构前提，不能跳过。
5. **阶段一仍是最优先起点**：它的设置项、i18n、校验器、报错解析、诊断面板**都已存在**，缺的只是把它们接起来。

---

## 二、现状盘点（实测，附证据）

### 2.1 已经具备的（不要重复造）

| 能力 | 位置 | 说明 |
|---|---|---|
| 双路 provider | `crates/ai/src/provider.rs` | BYOK 直连 + 云网关，靠 `gw:` 前缀在 `src-tauri/src/commands.rs:358 resolve_target` 一处分流 |
| 流式 + 思考分离 | `provider.rs:128 stream_chat`、`Chunk::Text/Reasoning` | 思考型模型（GLM/DeepSeek/Qwen）不会"有 token 没字" |
| 密钥保护 | `crates/platform-windows`（DPAPI） | 密钥永不回前端 |
| 识图 | `ui/js/ai.js`、`src-tauri/src/vision.rs` | 图片压缩到 ≤1568px，只在内存不落盘 |
| 应用 / 撤销 | `ui/js/ai.js:573 applyBlock` / `:606 revertLast` | — |
| **语法校验器** | `ui/js/preview.js:371-378` | mermaid **先 `parse` 再 `render`**；DOT 走 wasm-graphviz（`preview.js:380`） |
| **报错解析（抠行号）** | `ui/js/preview.js:220 describeError` | 已导出为 `DGM.preview.describeError`（`preview.js:708`） |
| **诊断面板** | `preview.js:366` → `state.refreshIssues` → `doc_issues` → `ui/js/panels.js:66` | 渲染失败已进既有"问题"面板，可点击跳行 |
| **重试开关** | `crates/app-ipc/src/lib.rs:246 AiPrefs.render_retry`（默认 `true`） | 设置项 `dialogs.js:508` + 中英 i18n `i18n.js:650/1436` |
| **会话目录（已预留未使用）** | `crates/platform/src/lib.rs:54 conversations_dir()` | `data_dir/Diagramon/conversations/`；仅 `ensure()` 建目录，**全仓零读写** |

### 2.2 缺失的（本方案要补的）

| # | 缺口 | 证据 | 由哪个阶段补 |
|---|---|---|---|
| 1 | **`render_retry` 没有任何消费者** | 全仓 `grep render_retry` 只命中：定义（`app-ipc`）、UI 写值（`dialogs.js:508/579`）、i18n、mock 默认（`ipc.js:483`）。**没有一处读它去真的重试。** | 阶段一 |
| 2 | **渲染失败没有对外事件** | `preview.js:359-368` 只做 `errorBox` + `status` + `refreshIssues`，`ai.js` 无从得知 | 阶段一 |
| 3 | **`X-Diagramon-Retry-Of` 客户端从未发送** | 全仓 `grep "Retry-Of\|retry_of"` 在客户端源码中**零命中** | 阶段一（见 §3.4） |
| 4 | **消息组装是单轮的** | `prompt.rs:65 build_messages` 只产出 `system` + **一条** `user`；`ai.js:24 msgs` **仅用于显示**，不参与请求 | 阶段二 |
| 5 | **会话未持久化，但文案宣称已持久化** | `dlg.history.note`（`i18n.js:723/1508`）写"对话按文档稳定身份持久化（真实实现里路径 SHA256）"，而 `conversations_dir()` 从未被读写 | 阶段三 |
| 6 | **"历史会话"对话框内容不符名** | `dialogs.js:766 history()` 实际渲染 `state.settings.recent`（最近文档）+ `state.usage.calls`（**内存态，重启归零**） | 阶段三 |
| 7 | **`DGM.ai.clear()` 语义与文案不符** | 文案"清空当前文档的对话"，实际 `msgs[tab()] = []`，清的是当前 tab 内存消息 | 阶段三 |
| 8 | **无跨会话记忆** | 全仓 `记忆/memory/remember` 无相关实现（仅 `remember_recent` 是最近文件列表） | 阶段四 |
| 9 | 无工具调用 | `crates/ai` 全仓 `tools`/`tool_calls` 零命中 | 阶段五 |

> 缺口 1–3 合起来意味着：**设置里那个"渲染失败时把报错原文发回模型修正一次"的开关，现在是个骗人的开关** —— UI 上是开的，行为上什么都不做。

---

## 三、阶段一：渲染校验回环

**目标**：AI 产出的代码渲染失败时，自动把**报错原文 + 行号**回喂模型修正**一次**。

**为什么第一位**：零件齐（校验器 + 报错解析 + 诊断面板 + 开关 + i18n），只需接线；不改服务端；不改 `crates/ai` 公开签名。

**改动文件**：`ui/js/preview.js`、`ui/js/ai.js`、`ui/js/i18n.js`（如需新键）、`crates/app-ipc`（仅当需新增设置透传字段）。

### 3.1 让渲染失败成为事件（`ui/js/preview.js`）

在 `renderActive` 的 catch 分支（`preview.js:359-368`）**追加**事件广播，不改现有行为：

- 新增 bus 事件 `doc:render-error`，载荷 `{ docId, format, line, raw }`。
- **`raw` 必须是上游原文**（`err.message` 原样）。不复用 `described.text` —— 后者是给人看的中文 UI 串（`t("preview.noRender", …)`），喂模型会丢关键信息。
- `renderMermaid` 已经先 `parse` 再 `render`，报错天然带行号；DOT 同理。

### 3.2 `ai.js` 订阅并判定是否重试

判定条件（**全部满足才重试**）：

1. `state.ai().render_retry === true`
2. 该 `docId` 正是**本次刚应用** AI 结果的那份文档（否则用户手改出错也会触发重试）
3. **本轮尚未重试过** —— 每轮最多一次，与 i18n 文案"修正一次"一致，也是防死循环的硬闸

### 3.3 组装第二次请求

- `intent: "review"`（系统提示词已是"只做局部修改，不重写整张图"，`prompt.rs:49-53`）
- `context`：刚应用的那段代码
- `prompt`：报错原文 + 行号 + "请只修正语法，不要改动结构"
- `format`：不变

### 3.4 重试遥测：本阶段不等服务端

`X-Diagramon-Retry-Of` 要填的是**服务端 `ai_usage` 行的 id**，而它只在**非流式**响应的 `x_diagramon.requestId` 里给（`gateway.py:784-790` 的作者注释已明说"**没有它这个字段就永远填不上**"）。客户端永远走流式 ⇒ 拿不到。

**决定**：**阶段一不发这个头**。重试修正功能本身完全可用，只是运营侧统计不到重试率。补齐"流式响应携带 requestId"这件事**并入阶段五的服务端改动一并处理**，不阻塞本阶段。

> 顺带澄清：响应头 `X-Request-Id`（`api/v1/ai.py:261`）装的是 **`trace_id`**（日志用），不是 `ai_usage` 行 id。两者不是一个东西。

### 3.5 验收

- `node tools/dev/check.mjs` 全绿（单测 / i18n / 探针 / 真机自检）。
- 新增断言：构造必失败的 mermaid（如 `flowchart TD` + `A --> B{`），断言**重试恰好发生一次**；再断言 `render_retry=false` 时不重试。
- 新增 i18n 键必须在 ZH/EN 都存在（门禁查引用完整性）。

**规模**：约 150–250 行。

---

## 四、阶段二：多轮消息 + 上下文预算

**为什么必须先做**：工具循环本质是"多轮 messages"，而现在每轮都**从零重建**（`build_messages`），循环无从表达；阶段三/四也都建立在"轮次可表达"之上。同时长文档 + 多轮会让 token 线性膨胀，而服务端有 `messages max_length=64` 与 `ai_max_body_bytes=256KB` 两道墙。

**改动文件**：`crates/ai/src/prompt.rs`、`crates/app-ipc/src/lib.rs`、`src-tauri/src/commands.rs`、`ui/js/ai.js`、`ui/js/state.js`。

### 4.1 请求形态

- `crates/ai` 新增 `build_messages_with_history(...)`；**`build_messages` 的现有签名保持不动**（它已有完整单测，且 BYOK / 云网关共用）。
- `AiChatRequest` 增加前序轮次字段（**类型定义只在 `crates/app-ipc`**）。

### 4.2 预算与截断

- 只带最近 N 轮；超限时**截尾而不是拒绝** —— 对齐服务端 `tokens.output_budget` 的既定取向（"压缩得到有用答案，报错得到废答案"，`service/app/services/ai/tokens.py:92`）。
- 图片与长文按策略裁剪后再上行，避免撞服务端 body 上限。

### 4.3 前端 `msgs` 升级为真源

`ai.js:24` 的 `msgs` 从"仅显示"升级为"真源"，只取必要字段上行。三个 tab（chat / vision / review）各自独立。

### 4.4 与既有设置的关系

`context_from_doc`（`app-ipc:247`，默认 `true`）含义不变：改图仍以**选区优先**（`ai.js:420 selectionCtx`）。

**规模**：约 300–450 行。

---

## 五、阶段三：会话持久化

**目标**：把 `conversations_dir()` 真正用起来，让"历史会话"对话框与 `DGM.ai.clear()` 的行为**与它们自己的文案一致**（缺口 5–7）。

**为什么放在阶段二之后**：持久化的对象就是阶段二升级后的轮次结构。

**隐私边界（沿用现有对外承诺）**：**图片永不落盘**（`i18n.js:1283/1356` 已对外承诺"images stay in memory, never on disk"）；只持久化文本轮次。

### 5.1 存储

- 路径：`data_dir/Diagramon/conversations/<文档稳定身份>.json`。
- 文档稳定身份 = **路径 SHA256** —— 与 `dlg.history.note` 原本宣称的口径一致，让那句话变成真的。
- 内容：该文档的轮次数组（role / text / 时间戳 / 使用的模型别名 / 用量）。**不含图片**。
- 未保存文档（无路径）落一个会话级临时键，退出即丢弃，并在界面上如实标注"本次会话有效"。

### 5.2 读写接入

- 新增 IPC：`conversation_load` / `conversation_save` / `conversation_clear`（类型定义在 `crates/app-ipc`）。
- 打开文档时加载该文档会话；轮次结束后落盘（复用现有 `autosave` 的节流节奏）。

### 5.3 修正界面使其为真

- `dialogs.js:766 history()` 改为渲染**该文档的真实会话轮次**，不再是 `state.settings.recent` 列表。
- `DGM.ai.clear()` 语义改为"清空当前文档的会话"，并为**无路径文档**给出如实的临时提示。
- `state.usage.calls` 不再冒充"轮次"，改用持久化的轮次数。

### 5.4 验收

- 打开文档 → 对话 → 关闭 → 重开：会话仍在。
- 切到另一文档：会话互不串。
- 清空：只清当前文档。
- 断言 `conversations/<hash>.json` **不含 base64 图片内容**。

**规模**：约 350–500 行。

---

## 六、阶段四：记忆能力（确定要做）

> **状态：决策已锁定，待开工。** 本节记录的是**已定的设计**，不是候选方案 —— 实施时按此执行，不再重新选型。
> 开工前不改动任何源码。

**设计原则**：客户端持有，服务端保持无状态。云网关路径因此**不需要任何服务端改动**（记忆只是 prompt 的一部分）。

### 6.1 记忆的价值定位

对**图表工具**，跨会话记忆的价值不是"记住聊过什么"，而是**风格与术语**：默认配色/主题、默认流向（LR/TD）、"我们的 X 叫 Y"、哪些表述是用户的专有名词。

### 6.2 存储

- 路径：`data_dir/Diagramon/memory/memory.json`（与 `conversations/` 平级）。
- **不得**混进 DPAPI 凭据库（`credentials_dir()` 只放密钥）。
- 条数上限（初值 200），超限时在界面上提示并停止自动入库。

### 6.3 两层条目：`confirmed` 与 `pending`

| 层 | 来源 | 是否注入 prompt |
|---|---|---|
| `confirmed` | 用户手写，或用户确认过的自动候选 | ✅ 注入 |
| `pending` | 模型自动提取的候选 | ❌ **不注入** |

**`pending` 不注入是关键设计**：它让"自动提取"低摩擦（用户不必逐条编写），同时又不会让一条错的记忆**静默污染**后续所有输出 —— 这与仓库既有规矩"界面如实写未配置，不伪造状态"同源。

### 6.4 作用域

- `global`：跨文档生效（风格偏好多半属于这层）。
- `doc:<文档稳定身份>`：仅该文档生效（术语多半属于这层）。

### 6.5 自动提取流程

1. 一轮对话结束后（仅在 `memory_auto` 打开时），把该轮轮次交给模型总结 0–3 条候选。
2. 候选写入 `pending`。
3. AI 面板出现一条轻量提示条："记住了 N 条，查看"。
4. 用户确认 → 进 `confirmed` 并**立即对后续请求生效**；丢弃 → 删除。

### 6.6 注入方式

- **不修改 `system_prompt()`**（它有单测且被 BYOK/网关共用）。改为在 `build_messages_with_history()` 之后**追加一段独立的记忆块**（作为 system 消息后的补充段或独立 system 消息）。
- 注入**体积上限**（初值 2000 字符）：超限时按"最近使用 / 最近确认"截断，并在记忆面板显示"已达上限"。
- 注入时必须带清晰边界，避免与格式规则冲突；记忆内容**不得**覆盖 `format_rules`（`prompt.rs:17-35`）。

### 6.7 开关与可见性

- `AiPrefs` 新增：`memory_enabled`（默认 `true`）、`memory_auto`（默认 `true`）。
- 「AI 设置 → 记忆」面板：列出全部条目（含 `pending`），可编辑 / 删除 / 单条停用 / 一键清空；显示每条的作用域与来源。
- **如实告知**：记忆是**第一个持久化用户内容的存储**。首次启用时给一次明确说明，并在设置里写明存储位置。不得默默开始记。

### 6.8 验收

- 关闭 `memory_enabled` 后：请求体与现在**完全一致**（用单测断言 messages 无记忆块）。
- `pending` 条目不进入任何请求体（单测断言）。
- 体积上限生效：超限后 messages 大小不再增长。
- 端到端：手写一条"配色一律暗色" → 新开文档生成 → 输出遵循该偏好。

**规模**：约 800–1000 行（含设置面板）。

---

## 七、阶段五：受控工具循环

**前提**：阶段二（多轮）落地 + 服务端放行 `tools`。

**改动文件**：`crates/ai/src/agent.rs`（新增）、`crates/ai/src/lib.rs`、`src-tauri/src/commands.rs`、`ui/js/ai.js` + `service/` 侧改动。

### 7.1 模块

`crates/ai` 新增 `agent` 模块：`trait Tool { name, schema, call(args) }` + 有**步数上限（初值 5）**的循环，取消复用现有 `AtomicBool` 机制（`provider.rs:132`）。

### 7.2 首批工具（4 个，全部只作用于内存文档模型）

| 工具 | 复用 |
|---|---|
| `read_document` | 当前正文（分段 / 裁剪） |
| `format_grammar` | `prompt.rs::format_rules`（语法要点已写好） |
| `validate` | 前端 `DGM.preview` 的 parse/describeError；Rust 侧 `app-core::convert` 的解析器 |
| `apply_patch` | `applyBlock`（`ai.js:573`）的落盘路径 |

**硬约束：这四个工具都不碰文件系统、不执行 shell、不发起网络请求。** 这是本方案与 pi harness 最本质的分歧点 —— pi 默认带 `read/write/edit/bash` 且不内置权限系统，那是通用编码 agent 的假设，不是消费级图表工具该有的攻击面。

### 7.3 参数上行规则

- BYOK：`max_tokens` / `temperature` 用用户配置值。
- 云网关：**继续传 `None`** —— 服务端按"候选 × 档位"钳制，客户端填值反而会截短用户档位允许的长回答（`provider.rs:17-23` 注释已说明）。

**规模**：约 500–800 行（不含服务端）。

---

## 八、明确不做（红线）

- ❌ 不引入 Node / TypeScript 运行时（pi 全家桶是 TS；在 Tauri 里塞 Node 是打包体积 + 进程管理 + 供应链审计三重税）
- ❌ 不替换 `crates/ai`
- ❌ 不引入 `pi-tui` / `pi-web-ui`（现有 `ui/js/ai.js` 与 `DGM.editor` / apply-revert 流程深绑）
- ❌ 不给 AI 开文件系统 / shell / 网络工具
- ❌ 不改 `crates/ai` 现有公开签名（只做**加法**：`agent` 模块 + `build_messages_with_history`）
- ❌ 不在前端另抄契约（IPC 类型唯一真源在 `crates/app-ipc`）
- ❌ **记忆不做服务端存储**（新表 + 接进 12 步闸门会打破服务端无状态、复杂化计价与额度口径，而收益用客户端注入 prompt 即可拿到）
- ❌ **记忆不含图片**、不落 DPAPI 凭据库

---

## 九、执行顺序（确定）

1. **阶段一**：渲染校验回环。不改服务端、不改 `crates/ai` 公开签名，风险最低，把"骗人的开关"变成真功能。
2. **阶段二**：多轮消息 + 上下文预算。后三个阶段的共同前提。
3. **阶段三**：会话持久化。用起 `conversations_dir()`，让"历史会话"与清空动作变成真的。
4. **阶段四**：记忆能力。显式条目 + 自动提取候选（`pending` 不注入）。
5. **阶段五**：受控工具循环。需服务端先放行 `tools`。

服务端那条线（放行 `tools`、流式携带 `requestId`）与阶段五并行推进，不阻塞一至四。

---

## 十、里程碑与验收

| 阶段 | 交付物 | 验收标准 | 规模 | 依赖 |
|---|---|---|---|---|
| **一** | 渲染校验回环 | `check.mjs` 全绿；"必失败 → 自动重试一次"与"关闭开关 → 不重试"两条断言通过 | 150–250 行 | 无 |
| **二** | 多轮消息 + 上下文预算 | 单测覆盖截断策略；长文档多轮不触发服务端 400 | 300–450 行 | 阶段一 |
| **三** | 会话持久化 | 重开后会话仍在；跨文档不串；清理只影响当前文档；**落盘不含图片** | 350–500 行 | 阶段二 |
| **四** | 记忆能力 | 关闭后请求体与现状一致；`pending` 不注入；体积上限生效；偏好端到端生效 | 800–1000 行 | 阶段二、三 |
| **五** | 受控工具循环 | 服务端放行 `tools` 后端到端跑通；步数上限与取消有测试 | 500–800 行 + 服务端 | 阶段二 + 服务端 |

**合计**：客户端约 2100–3000 行 + 服务端改动一处。

### 跨仓库依赖（`service/`）

| 事项 | 阻塞谁 | 说明 |
|---|---|---|
| 放行 `tools` / `tool_calls` | **阻塞阶段五** | `gateway.py:45 UNSUPPORTED_FIELDS`；`normalize_messages` 必须保住 `tool_calls` / `tool_call_id`（否则多轮静默丢字段） |
| 流式响应携带 `requestId` | 只影响**重试率遥测** | 不阻塞任何阶段；与上一条一并做 |
| `messages max_length=64`、`ai_rpm_per_user=10`、`ai_max_concurrency_per_user=2` | 会挤压阶段五 | 循环把"每请求"限额放大成 N 倍 |

---

## 十一、风险与取舍

1. **多步 = 更多 token / 更高延迟。** 服务端有 `ai_rpm_per_user=10`、`ai_max_concurrency_per_user=2`、单请求成本上界；循环会把"每请求"限额放大成 N 倍。
2. **`render_retry` 与记忆提取都是额外真实调用，会计入用量**。因此两者都必须用户可关，重试还必须**每轮最多一次**。
3. **校验能力对格式不对称。** 只有 mermaid / DOT 有页内校验器；drawio / Excalidraw 走承载页（`canvas.js` 的 `__apply`），只能拿到承载页回报的东西。**阶段一对这两格式收益有限，设置项说明里必须如实写出来**，不要暗示它对所有格式都有效。
4. **记忆的失效风险。** 一条错的记忆会**静默降质**后续所有输出。这正是 §6.3 把自动候选放 `pending`（不注入）、把注入体积设上限、并把每条记忆做成用户可见可删的原因。
5. **会话与记忆是第一批持久化用户内容的存储。** 客户端此前只对外承诺"图片不落盘"。阶段三、四上线时必须同步更新对外说明，不能让承诺与实际脱节。
