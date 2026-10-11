# Diagramon dev3.0 剩余工作路线图

> 起点：**阶段零**（外壳 + 面板 + AI 面板）已交付 —— 五块工作区、标签页与会话、文件打开/保存/另存、  
> 语法校验与行内报错、大纲、当前作用域、mermaid 与 graphviz 预览与导出、AI 三页签 BYOK 流式、  
> 设置五页签与明暗主题、命令面板与九个对话框、内部 mock 后端。
>
> 本文只写**剩下的事**。每一步都给出「完成判据」——判据必须是**跑一遍就能看出真假**的东西，  
> 不接受「代码写完了」这种说法。

## 一把尺子

阶段零留下的最有价值的资产不是那 9000 行界面，而是**验收闭环**：

```bash
cargo test -p app-ipc -p app-core -p platform -p platform-windows -p ai   # Rust 纯逻辑
DIAGRAMON_SELFTEST=1 ./target/debug/diagramon.exe                         # 真机 IPC 断言 → JSON 报告
```

后续每一步都必须能挂进这两条通道里。挂不进去的，说明它的接口没设计好。

---

## 依赖总览

```
        ┌──────────────────────────────────────────────┐
        │ 1 闭环验收与开发环路（解锁一切）              │
        └───────────────┬──────────────────────────────┘
                        │
        ┌───────────────▼──────────────────────────────┐
        │ 2 画布承载 + dgm 资产协议   ← 关键路径        │
        └───────────────┬──────────────────────────────┘
                        │
        ┌───────────────▼──────────────────────────────┐
        │ 3 格式转换（转换中心真正能执行）              │
        └──────────────────────────────────────────────┘

   可并行（不与 2/3 抢同一批文件）：
     4 工作区与文件系统      5 AI 补齐       6 云网关（跨仓库）
                              │
        ┌─────────────────────▼────────────────────────┐
        │ 7 发布（更新器 / 三平台打包 / 签名）          │
        └──────────────────────────────────────────────┘

   贯穿全程：8 硬化与质量（真 AST / 画布大纲 / 大文档性能 / i18n 收口）
```

**关键路径 = 1 → 2 → 3**。它决定"四种格式是不是真的都能用"。其余四步谁先谁后按你的优先级排。

---

## 第 1 步 · 闭环验收与开发环路 ✅ 已完成

**为什么排在第一个**：现在改一行代码，没人能告诉你有没有把别的弄坏。先把"能验证"做出来，  
后面每一步才敢动手。

**要做的事**

- 重建 `cargo build -p diagramon`（当前 exe 停在 17:31，最后一次 `ui/js/main.js` 改动 17:32 没进包）。
- 跑通 `DIAGRAMON_SELFTEST=1`，报告全 PASS 落盘。
- 把"重建 → 杀占用进程 → 启动 → 跑自检 → 读报告 → 退出"合成**一条命令**（`tools/dev/check.mjs` 或  
  `check.ps1`），避免每次都手搓一遍。顺带自动处理 `Permission denied`（上一个实例占着 exe）。
- 提交当前工作树：`app-core/{lint,outline,scope,session}.rs`、`app-ipc/src/lib.rs`、  
  `src-tauri/src/{commands,lib}.rs`、`tauri.conf.json`、`ui/js/main.js`、`tools/dev/`。

**完成判据**

- `selftest-report.json` 存在，`failed: []`；
- 一条命令从干净状态跑到报告全绿；
- `git status` 干净。

**涉及面**：小。纯收尾，不新增功能。

**落地**：`tools/dev/check.mjs`（杀残留实例 → 构建 → 单测 → 真机自检 → 读报告）。  
真机自检 26/26、Rust 单测 80 项全绿。

---

## 第 2 步 · 画布承载 + `dgm` 资产协议 ★关键路径 ✅ 已完成

**为什么重要**：drawio / Excalidraw 现在**完全不可用** —— 承载页躺在 `tools/*-host/`，  
但 76MB / 22MB 的运行时既没进包、也没被 serve；dev2.0 有过的 `dgm` 自定义协议没重建。  
更关键的是：第 3 步的转换产物（XML）要靠这一步才有地方验证。

**要做的事**

1. **重建 `crates/assets`**：注册 `dgm` 自定义协议  
   （Win `http://dgm.localhost/`，其他 `dgm://localhost/`），  
   挂 `/drawio/ /excalidraw/ /graphviz/ /mermaid/`，其余请求落 `ui/`。
2. **资产入包或首启获取**：drawio 76MB / Excalidraw 22MB。要么随包（体积大、但离线稳定），  
   要么首启下载 + 校验（体积小、但要处理失败与代理）。**这条要你拍板**（见文末 P1）。
3. **宿主桥**：承载页的契约已经写在 `tools/drawio-host/host.html` 的注释里 ——  
   向外暴露 `window.__hostQueue`（宿主轮询取走）与 `window.__apply(str)`（宿主执行注入）。  
   这是 dev2.0 验证过的"不依赖 WebView 包装层消息事件"的路子，照它接，别另发明。  
   原生侧负责轮询队列 + `eval` 注入，方向是 `画布 ↔ 正文` 两个来回。
4. **双向搬运**：打开时喂入正文 → 画布编辑后回流 → 脏标 → 保存（沿用现有的 `Entry { doc, saved }`  
   正文比对脏标机制，不要新加布尔位）。
5. **主题下发**：首载走 URL 参数，之后走 postMessage 增量 —— 避免换色时画布重建闪烁（待拍板 P4 里的底色策略）。
6. **画布态 UI**：浮动导出、缩放读数、"画布即编辑器"胶囊（原型里已设计好，直接实现）。

**完成判据**

- 新建 drawio / Excalidraw 文档 → 能画 → 能存 → 关掉重开内容还在；
- 切明暗主题，画布跟着变且**不闪断**（不重建实例）；
- 导出 PNG / SVG 落盘正确；
- 画布编辑后标签页出现脏标，"保存"能清掉。

**涉及面**：大。新增一个 crate + 打通 98MB 资产链路 + 一个新的事件通道。

**落地**：`crates/assets`（协议路径解析，8 项单测）+ `src-tauri` 的 `dgm` 协议注册  
（`WebviewUrl` 三平台差异处理）+ `ui/js/canvas.js`（搬运与协议翻译）+  
宿主桥复用承载页既有的 `__hostQueue` / `__apply` 契约 +  
`tools/fetch-assets.mjs`（打包前汇出 `assets/`，开发期走源工作树不复制）。  
验证：`check.mjs` 26/26；`tools/dev/canvas_probe.py` 真 drawio 9/9 + 截图。  
**P1 已按倾向落地**：随包（`assets/` 由脚本汇出，仓库不存 98MB）。  
**P4 部分落地**：Excalidraw 走自己的 `appState.theme`；drawio 只换画布底色，  
不动图形配色 —— 「导出底色三选」仍未定，留到第 3 步之后一起收。

---

## 第 3 步 · 格式转换（转换中心真正能执行）✅ 已完成

**要做的事**

1. **契约补 `convert`**：现在契约里**连命令都没有**，只有 `FormatInfo.convert_to` 这份能力数据。  
   按 §9.1 的分工拆两条：`convert_preview`（预览文本）与 `convert_execute`（产出新文档）。
2. **Mermaid → DOT**（纯 Rust，放 `app-core`）：AST 映射器。`subgraph → cluster`，注意 classDef 样式会丢，  
   必须在转换记录里注明（见拍板 P2）。
3. **Mermaid → drawio**（JS 库，走 drawio 解析器）：执行处按 §9.1 的倾向放**隐藏 offscreen WebView worker**，  
   结果经事件回传 —— 不要在主 WebView 里跑，大文档会卡。
4. **Mermaid → Excalidraw**（JS 库，同上）。
5. **前端**：把转换对话框里的"本地预演"换成真实预览；执行后**另开标签页**（单向语义，原文件不动）；  
   不可用方向继续列出来 + 给理由（这条原型已定，别丢）。

**前置**：第 2 步（否则 drawio / Excalidraw 的产物没地方验证渲染）。

**完成判据**

- 三个方向都能产出、新标签页里能渲染、原文件字节不变；
- 转换记录面板出现条目；
- classDef 丢失这类信息在界面上有明说（不是静默）。

**涉及面**：中—大。

**落地**：`crates/app-core/src/convert.rs`（17 项单测）+ 契约 `ConvertRequest`/`ConvertOutcome`

- 命令 `convert_text` + `ui/js/canvas.js` 的 `setPendingConversion` / `waitForBody`
- Excalidraw 承载页新增 `getScene`（`scene` 事件在外部载入后被 `suppressEchoes` 挡掉，取不到结果）。  
  验证：`check.mjs` 35/35；`canvas_probe.py` 10/10（含 drawio 导入 Mermaid 产出 5773 字节 mxfile）。  
  **P2 已落地**：notes 逐条列出未迁移项，对话框直接显示。  
  **计划外的发现（比原方案更好）**：不需要 offscreen WebView worker ——  
  两个目标格式的引擎**已经在同源 iframe 里**了，直接把源码交给它们即可。  
  原方案担心的「在主 WebView 里按需跑会卡大文档」在这个结构下不成立：  
  解析发生在承载页自己的 realm 里。

---

## 第 4 步 · 工作区与文件系统 ✅ 已完成

四件事共享同一套"工作区根 + watcher"机制，放一起做，省一轮重复。

**要做的事**

- **工作区扫描**：打开目录 → 资源管理器树（新增 `workspace.tree` 命令）。  
  现在侧栏自陈"完整工作区扫描尚未接入"。
- **文件 watcher**：装 `notify` → `fs.changed` 事件 → 界面增量更新；外部改动与本地未保存冲突时给提示。
- **全工作区搜索**：新增 `search.run`，Rust 流式回结果。  
  现在侧栏搜索**只搜已打开文档**，这是最明显的短板。
- **单实例 + 文件关联**：双击 `.mmd` 由已有窗口打开，不新起进程。
- **autosave 计时**：可配阈值，归 Rust。
- **收紧 fs scope**：capabilities 限制在工作区目录内（现在还没限）。

**完成判据**

- 打开一个真实目录能看树、能全库搜到结果并跳行；
- 在编辑器外改文件，界面自动跟上；
- 双击第二个图文件，不新开进程；
- 关掉窗口再开，未保存内容能恢复（autosave）。

**涉及面**：中—大。

**落地**：

- `crates/app-core/src/workspace.rs` —— 扫描 / 全库搜索 / 路径守卫，**纯函数 + 21 项单测**  
  （跳过 `.git`/`node_modules`/`target`，只收本应用认的扩展名，不含图表文件的目录不出现）；
- `crates/app-core/src/recovery.rs` —— 未落盘文档的草稿仓（一个文档一个 JSON，坏一个不连累别的）；
- 契约新增 `WorkspaceNode`/`WorkspaceInfo`/`SearchRequest`/`SearchHit`/`SearchDone`/`FsChange`，  
  命令 `workspace_{open,get,close,new_file,rename,delete}`、`search_{run,cancel,once}`、`doc_reload`，  
  事件 `fs://changed`、`search://hit|done`、`open://paths`、`doc://autosaved`；
- `src-tauri/src/watcher.rs` —— `notify` 递归监视 + 350ms 去抖 + **回声抑制**  
  （比对磁盘内容与文档正文，自己写出去的不上报）+ 冲突判定；
- autosave **归 Rust**：后台线程每秒醒一次，到期就落盘 —— 前端定时器在后台窗口  
  会被 WebView2 节流到 ~1 次/秒，靠不住；
- 单实例：`tauri-plugin-single-instance`，第二个进程把命令行里的图表文件转交给前端；
- 冲突 UI：编辑区顶上一条横幅（「用磁盘版本」/「保留我的」）—— 需要决策的状态不做成会自己消失的 toast。

**fs scope 的真实落点（如实说明，别被名字带偏）**：

- 由工作区界面发起的写操作（新建/重命名/删除）**永远**经 `workspace::resolve_in_root`，  
  `..`、绝对路径一律拒绝 —— 这条不受任何开关影响；
- 「另存为 / 导出」的路径来自系统对话框，那是**用户本人的授权**，默认放行；  
  想收紧就开 设置 → 编辑器 →「只允许在工作区内读写文件」（默认关，开了才会拦）。

**验证**：`check.mjs` 自检新增 11 条工作区断言（扫描/守卫/搜索行列号/重命名/删除/多词参数一致性）；  
`cargo test -p app-core` 新增 33 项单测。

---

## 第 5 步 · AI 补齐 ✅ 已完成

**要做的事**

- **识图的屏幕区域截图**：无边框 overlay 窗口 + 屏幕捕获（`vision.capture`），处理多屏与 DPI。  
  现在识图只有"选文件 + canvas 压到 ≤1568px"。
- **剪贴板写 PNG 走原生**（arboard），不再赌 `navigator.clipboard` —— WebView2 各版本不稳。
- **用量与成本统计**：现在只有本地 token 计数；要与云网关口径对齐（拍板 P3）。
- **模型档位 UI 与"重试 / 取消"细节打磨**。

**完成判据**

- 框选屏幕一块区域，直接进识图 tab 并拿到代码；
- 复制图片到系统剪贴板，能在别的程序里粘贴；
- 用量记录与网关对得上。

**涉及面**：中。

**落地**：

- **截屏 = "冻结帧"方案**（`src-tauri/src/vision.rs` + `ui/capture.html` + `ui/js/capture.js`）：  
  先把鼠标所在的那块屏截成一张 PNG 存进内存，再在它上面开一个无边框、置顶、贴满整屏的  
  overlay 窗口；overlay 把这张图**当背景**铺开，用户拖出的矩形是在"图"上量，  
  量完乘 `img.naturalWidth / img.clientWidth` 换回物理像素 —— DPI 虚拟化、缩放、  
  多屏偏移全都不用碰。裁剪用**缓存的原图**（不截第二次：屏幕上的弹窗/光标会变）。  
  取舍：只截鼠标所在的那块屏，跨屏一次框选不做（收益配不上复杂度，代码里有注释）。
- **像素算法下沉到 `app-core::pixels`**（裁剪越界夹取 / PNG 编码，5 项单测）。  
  装配层（src-tauri）的测试二进制链上 tauri/wry 后启动即  
  `STATUS_ENTRYPOINT_NOT_FOUND`（WebView2 的 DLL 不在 deps 目录旁），跑不起来，  
  所以凡想被单测钉住的都必须下沉 —— 这条写进了 `src-tauri/Cargo.toml` 的注释。
- **剪贴板走原生**：`clip_write_image`（arboard → win32 剪贴板），`clip_read_image`  
  读回尺寸供自检比对。`copyImageDataUrl` 优先原生，失败才落回 `navigator.clipboard`。
- **用量口径（P3 落地）**：`AiDone.usage_source` = `server` / `none`；token **只累计供应商  
  实报的调用**，没回报的显示 `—` 并给 title 说明，绝不显示 0，也不掺本地估算。
- **重试 / 取消**：沿用既有 `ai_cancel`；顺带修了 `ai_cancel` 的参数命名（见第 4 步）。

**验证**：自检新增 4 条断言（显示器枚举、剪贴板写图、读回尺寸、工作区残留）；  
`cargo test` 133 项全绿（新增 5 项像素单测）；i18n 中英各 626 键一致。

> **如实说明**：本机自检当前**间歇性跑不出报告** —— WebView2 会挂起"不被前台"的窗口，  
> 定时器全停、invoke 响应偶发被丢（见下），与第 4/5 步的代码无关。17:35 的一次完整运行  
> 已把第 4/5 步的全部新断言跑绿（工作区 11 条、显示器、ai_cancel、关工作区），  
> 剩下没跑到的只有剪贴板两条（其正确性由 `app-core::pixels` 的 PNG 往返单测 +  
> `clip_read_image` 的尺寸断言覆盖）。check.mjs 已加整场重试与前置语法检查，  
> 在能真正前台运行的机器上可直接复跑。

**额外修掉的一个真 bug（比本步内容更重要）**：`async` 命令返回 `Result<(), String>`  
时，响应会被 WebView2/wry **静默丢弃** —— 前端 `await` 永不结算，无报错、无 pagehide、  
每次卡的位置还不一样。排查花了一下午（`sync + ()` 正常，`async + ()` 必丢）。  
`ai_chat` 正是这个签名，等于 AI 对话在真机上整条链路是坏的。  
规矩写进了 `commands.rs` 头注释：**async 命令一律返回有意义的值**。  
顺带把自检里唯一的定时器等待（`__hostQueue` 20×1s）改成同步断言 ——  
定时器在后台窗口会被整体挂起，等待循环会变成"永远卡在第一格"；  
自检的草稿也改写到临时目录（曾滚到 13 份未命名文档，负载不可控）；  
`check.mjs` 前置了 `node --check` 语法检查。

---

## 第 6 步 · 云网关（跨仓库）✅ 已完成（客户端侧）

**要做的事**

- **服务端**（`service/`，FastAPI）：登录、额度、云文档、AI 网关（与既有 `/v1/ai/*` 口径对齐）。
- **客户端**：登录态；云端视图接真实数据（现在只有说明文字，**不伪造余额**这点要一直保持）；  
  "保存到云端"；云文档列表与打开。
- 契约补 cloud 相关命令。

**完成判据**

- 能登录、能看到真实额度、能存/取云文档；
- 未登录时界面仍是"如实说明"，不出现假数据。

**涉及面**：大，且依赖 `service/` 仓库的进度。

**落地**：

- **服务端不用动**：`service/` 仓库已具备 `POST /v1/auth/login`、`GET/PUT/DELETE /v1/documents`、  
  `GET /v1/auth/me` 与 AI 网关 —— 客户端直接对上这些口径（camelCase JSON，见下）。
- **客户端新增 `src-tauri/src/cloud.rs`**（7 条 async 命令）：  
  `cloud_login / cloud_logout / cloud_status / cloud_docs_list / cloud_doc_save / cloud_doc_open / cloud_doc_delete`。
  - **令牌永不回前端**：access/refresh 存凭据库（Windows 上 DPAPI），前端只拿账户快照与文档列表  
    —— "已登录"是一个事实陈述，不是页面可伪造的状态；
  - **设备标识**首登生成一次并持久化（服务端用它识别会话）；
  - `PUT /documents/{id}` **新建与更新同一入口**（`If-Match: 0` = 仅当不存在时创建），  
    客户端因此要记住每个文档的 `cloudId`，否则"保存到云端"会一直建新份；
  - `cloud_status` 登录着就去 `/auth/me` 校验一遍 —— 令牌过期/换密码时如实报"掉线了"，  
    不假装还登录着；
  - 全部命令 **async + 返回有意义的值**（第 5 步发现的 `async + Ok(())` 丢响应坑）。
- **契约**：`CloudAccount / CloudStatus / CloudDoc / CloudDocList / CloudDocBody`，  
  事件 `cloud://changed`；设置新增 `cloud.{base_url, device_id}`。
- **前端云端视图三态如实呈现**：未配置（"去配置"按钮）/ 未登录（内联邮箱密码表单）/  
  已登录（账户 + 额度条 + 文档列表 + 存 / 开 / 删）。配额条用 `<progress>`，数字全部来自服务端。  
  **base_url 留空 = 云端整体关闭**，一切照旧离线工作 —— 离线优先是产品底色。
- mock 后端同步实现（浏览器原型里能走通登录 → 列表 → 存 → 开 → 删）。

**验证**：`cargo test` 133 项全绿；i18n 中英各 643 键一致。  
端到端（连真实服务端）需要跑起来的 `service/`，本机未做 —— 客户端到服务端的字段口径  
以 `app/schemas/__init__.py` 的 pydantic 模型为准逐字段对齐（camelCase）。

### 第 6 步补充 · 云端界面拆分（2026-10-11）

原「云端」是一个视图把三件事挤在一起：账户头 + **内联登录表单** + 扁平文档列表；
而且活动栏的「云端文档」(Alt+4) 与底部的「账户与云端」按钮**指向同一个视图**。现在拆开：

| 界面 | 入口 | 只做 |
|---|---|---|
| **账户**（侧栏视图 `account`，只读） | 活动栏底部「账户」(title 从「账户与云端」改为「账户」) | 邮箱 / 昵称 / 套餐 / 角色 / 存储用量；未登录时点它**直接弹登录窗口**，登录成功**落到本视图** |
| **云端文档**（侧栏视图 `cloud`，目录树） | 活动栏「云端文档」Alt+4 | 筛选 + 目录树（目录可展开、文档是叶子）+ 打开；底部配额条 |
| **保存到云端**（对话框） | 文件菜单 →「保存到云端…」（原来是 disabled 的说明项） | 文档名 + **单选目录树**（含「根目录」）+ 新建子目录 |
| **登录**（独立对话框） | 未登录时点「账户」；各视图里的「登录」按钮 | 登录、重发激活邮件、跳官网注册 |

- **登录状态全客户端唯一**：真源仍是 `cloud_status`（令牌在凭据库、不回前端）。
  上面四个界面都只读 `state.cloud.status`，**不各自另存副本** —— 在一处登录成功后
  另一处立刻是"已登录"，不会再要求登录一次。守卫见 `ui_probe.py` 断言 16 的 `signIn` 检查。
- **登录是中途一站，不是终点**：登录窗口收 `openLogin({ onSuccess })`，登录成功后把"然后呢"续上 ——
  从「账户」进来的切到账户视图、从「保存到云端」进来的接着开保存窗口。
  原型里本来就有这一步（`cloud-proto.js` 登录成功时设 `S.view = "account"`），实现时漏了，
  于是出现"登录完仍停在资源浏览器，再点「账户」只弹一句已登录"（用户实测反馈，见下）。
- **活动栏不许拿 render 时的快照判云状态**（同一反馈的第二个成因）：`cloud:changed` 原来只喂侧栏，
  活动栏不跟着重渲染，快照会让账户钮**永远**停在"未登录"那一支上 —— 症状就是"怎么点都切不过去，
  换个侧栏面板再点又好了"（换面板会触发整屏重渲染，快照被刷新）。两条都改了：
  (a) 点击时**现读** `state.panels()` / `state.cloud.status`；(b) 订阅 `cloud:changed → renderActivity`。
  守卫见断言 18，它复现的正是这条实测路径。
- **注册不在客户端做**（与旧客户端 `client/Views/LoginDialog.cs` 同口径）：页脚只有
  「没有账号？去官网注册」这一个**导航动作**，按 `{cloud.base_url}/register` 打开系统浏览器；
  打不开浏览器时把地址回显成**可复制的只读输入框**（不是一句纯文本）。
- **新增契约**：`CloudFolder / CloudFolderList` + 命令 `cloud_folders`（镜像 `GET /v1/folders`）、
  `cloud_folder_create`（`POST /v1/folders`，可为空目录）；`CloudDoc`/`CloudDocBody` 增加 `path`，
  `cloud_doc_save` 显式带 `path`（服务端口径：省略/null = 原地不动，所以必须显式给）。
  映射与单测在 `crates/app-core/src/cloudmap.rs`（夹具是真实服务端响应片段）。
- **账户页含 AI 权益**：`CloudAccount.ai: Option<CloudAiCredit>` 映射 `membership.ai`
  （服务端一直在返回，只是客户端原先没映射）。三条口径：
  ① **整块缺失/为 null = 未知**（显示「—」），**不是** `enabled:false`（未开通）—— 混起来就是让老后端被显示成"没开通"；
  ② **额度单位是「信用点」不是人民币**（服务端给整数微信用点、明确不锚定货币）；
  ③ 剩余是 `总额 - 已用` **减出来的**（服务端只给这两个数：充值加在总额上，减法恒成立），
  周期用服务端的 `periodEnd` 说"至 X 重置"，不猜下月 1 日。
- **为什么非加 `cloud_folders`**：`cloud_docs_list` 只在文档项里带 `path`，**空目录根本不会出现**，
  树就建不起来（缺层、空目录看不见）。服务端的 folders 路由正是"显式目录 ∪ 文档路径隐含的目录"。

**验证**：`cargo test` 155 项全绿；i18n 中英各 717 键一致（`check.mjs` 的引用完整性步骤）；
`ui_probe.py` **19 条断言全绿**（14 改写 / 15 登录窗口 / 16 云端树+保存窗口+AI 徽标 /
17 AI 额度块 / 18 从「账户」登录后续做落点）。断言 18 做过红绿对照：
把活动栏逻辑改回旧写法后，它报出的正是用户所述的现象（`viewAfter: "explorer"`、
第二次点击毫无反应），改回修复版即全绿。  
真机自检（`tools/dev/check.mjs`）本机沙箱跑不出报告 —— 需在用户前台跑一次确认。

### 第 6 步补充② · 云网关 AI 接线（2026-10-11）

**病根是接线缺失，不是显示 bug。** 模型曾经只有 `settings.ai.models`（本地 BYOK）一个来源，
设置页自己就写着「云网关未接入：本版本只能用 BYOK」—— 所以**登录成会员也一样没有模型**。
服务端其实全都有（`GET /v1/ai/models` + `POST /v1/ai/chat/completions`），客户端缺的是 adapter。

**做法：网关在客户端眼里就是一个 OpenAI 兼容 provider。** 于是整条流式路径（SSE 解析 / 取消 /
usage / 失败帧）一行都不用改，只有"参数从哪来"是新的：

| 层 | 内容 |
|---|---|
| `app-ipc` | `GatewayModel{id,display_name,supports_vision,max_output}` / `GatewayModelList`、`AI_GATEWAY_MODELS`、**`GATEWAY_MODEL_PREFIX = "gw:"`** |
| `app-core::cloudmap` | `gateway_model_of()`（缺显示名退回别名，缺 `maxOutput` 容忍；`data:[]` 不是错误） |
| `src-tauri/cloud.rs` | `ai_gateway_models()`（`GET /ai/models`）、`gateway_resolved(alias)`：base_url = `{api_base}/ai`、key = **当前 access token 现取** |
| `src-tauri/commands.rs` | `resolve_target()` **唯一分流点**：`gw:` 前缀 → 网关，否则本地 BYOK |
| `crates/ai` | `Resolved.max_tokens/temperature` 改 **`Option`**：网关一律 `None`（见下） |
| 前端 | `state.aiGateway` + `modelChoices()`（合并 + `group` 标记）；登录/登出/启动同步 |

- **`gw:` 前缀而不是加 `kind` 字段**：模型 id 是**一个**用户偏好（`ai.default_model`），
  加字段就得在每个"当前模型是谁"的地方比对两个值；而分流点其实只有一处，前缀让下游变成一件事。
- **网关下发 `max_tokens` 一律省略**：服务端按"所选候选 × 档位"钳
  （`max_tokens = min(max(requested, MIN_OUTPUT_TOKENS), ceiling)`）。客户端填一个数只会
  把档位允许的长回答**截短** —— 它知道 ceiling，我们不知道。BYOK 那两个值是用户自己配的，照旧下发。
- **分组显示**（用户拍板）：两组的"凭据从哪来"完全不同 —— 网关用当前登录令牌（用户没填过任何东西），
  本地那组是用户自己填的密钥。混排会让人以为网关模型也要去 AI 设置里填 key。
  分组条用**已有的** `label2` → `.pop-label`，两处选择器共用 `DGM.ai.modelItems()`。
- **登录后自动选第一个网关模型为默认**（用户拍板）：`autoPickGatewayModel("always")`。
  启动/回连走 `"ifMissing"` —— 只在默认**空或悬空**时补，否则每次开应用都把用户挑的模型拽回第一个。
- **登出必须清空**：模型别名是"当前账号能用什么"，留着旧的等于让用户对着一个已经被服务端拿掉的
  别名点半天；默认若指向网关别名则清掉，交给 `currentModel()` 回落到本地模型。
- **文案跟着状态走**：`ai.noModels.descSignedIn/descSignedOut`（原句在网关接通后就是半句假话）、
  `set.ai.gatewayOn/gatewayNoEntitlement/gatewaySignedOut`（替换掉「未接入」）。

**顺带修掉的真 bug（探针报出来的）**：`#ai-model` 与 `#btn-export` 点下去**弹了又立刻关** ——
文档级"点外面就关掉弹出物"的监听把**打开它的那一次点击**也算成了"外面"。
约定：锚点必须 `e.stopPropagation()`（`#menubar` 早就这么做，只是没写成规矩，已写进 `showPop` 的注释）。

**验证**：`cargo test` 161 项全绿；i18n 中英各 724 键一致（489 个静态引用零缺键）；
`ui_probe.py` **20 条断言全绿**（新增 20：未登录无网关模型 / 登录后拿到别名且默认被自动选中 /
**两处**选择器都有分组小标题 / 登出清空）。



---

## 第 7 步 · 发布 ✅ 已完成（代码侧；签名与更新源是发布方手续）

**要做的事**


- **updater 插件 + 更新源**；把"检查更新"从本地 toast 换成真实检查。
- **三平台打包**：`bundle.active = true`；Windows（msi/nsis）、macOS（dmg）、Linux（AppImage/deb）。
- **签名与公证**：Windows 代码签名、macOS notarize（Linux 可免）。
- 崩溃与日志上报（可选）。

**完成判据**

- 干净机器上能装、能启动；
- 能收到一个真实更新并应用；
- 装完不被 SmartScreen / Gatekeeper 拦。

**涉及面**：中，但大量外部账号与证书手续。

**落地**：

- `bundle.active = true`、`targets: "all"`、`createUpdaterArtifacts: true`，  
  并补齐 `category / shortDescription / longDescription`（打包元数据一次给全）。
- **updater 插件接入**（`tauri-plugin-updater` + `tauri-plugin-process`），  
  更新源模板 `https://updates.diagramon.app/{{target}}/{{arch}}/{{current_version}}`；  
  能力位加 `updater:default` 与 `process:allow-restart`。  
  **注意**：updater 默认走 rustls→`ring`，在 **windows-gnu** 工具链上 `ar` 编不过  
  （binutils 的老坑）—— 改用 `--no-default-features --features native-tls`，与 reqwest 同一套 TLS。
- **"检查更新"从本地 toast 换成真实检查**（shell.js `checkUpdate`）：  
  已最新 / 有新版（确认 → 下载 → 自动重启）/ 出错，三种结果都如实呈现；  
  updater 抛错绝不装作"已最新"。便携版/浏览器原型没有更新器，也如实说。
- **文件关联**已在第 4 步写进 `bundle.fileAssociations`（6 个扩展名）。

**发布方仍需办理的手续（代码之外，本机做不了）**：

1. 生成签名密钥对：`cargo tauri signer generate`，私钥进 `TAURI_SIGNING_PRIVATE_KEY` 环境变量，  
   **公钥填进 `tauri.conf.json` 的 `plugins.updater.pubkey`**（现在是空串 —— 填之前  
   updater 会报错，界面会如实显示"更新失败"，不会装作没更新）；
2. 更新源域名 `updates.diagramon.app` 落地（静态 JSON + 各平台产物）；
3. Windows 代码签名证书 / macOS 开发者账号与 notarize。

---

## 第 8 步 · 硬化与质量（贯穿全程）— 部分落地

**要做的事**

- **语法校验换真 AST**（未做）：现在是手写扫描器（括号/引号/标签配对 + JSON 解析），  
  只能报"能确证"的问题。换成真 Mermaid / DOT 解析器后，能报真实行列与语义问题。  
  这是剩余项里最大的一块，需要引入/绑定上游解析器，单独立项做。
- **画布型大纲**（未做）：现在写着"由图形引擎解析，接线在下一步"（依赖第 2 步的画布实例，  
  drawio 侧要经 `getScene`/mxfile 反解，Excalidraw 侧要遍历 elements）。
- **大文档性能**（部分 ✅）：渲染防抖已有、护栏已加；**虚拟滚动与 WASM 实例复用**未做  
  —— 万行图即使点了"仍要渲染"也仍会卡，护栏只是把"不知道会卡"变成"知道且可选"。
- **i18n 收口 ✅**：中英各 643 键完全一致（每步新增词条两侧同步加，用脚本比对键集）。
- **大文档护栏 ✅**：`app-core::guard`（4 项单测）—— 行数/字节超阈值时预览**先问一句**  
  （"仍要渲染"放行），不默默把 WASM 引擎拖死。阈值经 `app_info.limits` 下发，  
  数字只存一份（app-core），前端不藏第二份。
- **无障碍与键盘全通路**：所有交互可键盘到达。

**完成判据**

- 万行图滚动/编辑不卡；
- 错误定位到真实行列；
- 英文界面无中文残留。

**涉及面**：中，可长期滚动，不必一次做完。

---

## 需要你拍板

| #  | 问题                                                | 影响               | 我的倾向                                                 |
| -- | ------------------------------------------------- | ---------------- | ---------------------------------------------------- |
| P1 | drawio/Excalidraw 运行时（98MB）随包还是首启下载？              | 第 2 步的实现方式与安装包体积 | **随包**。离线优先是这个产品的底色，且本机代理环境下载不可靠                     |
| P2 | Mermaid→DOT 时 `subgraph → cluster` 会丢 classDef 样式 | 第 3 步            | 转换记录里**注明"样式未迁移"**，不静默丢                              |
| P3 | AI 用量口径（本地 token 计数 vs 网关信用点）                     | 第 5 / 6 步        | 两者都留，但**标明来源**，别混成一个数                                |
| P4 | 暗色下画布底色                                           | 第 2 步            | 承载页注入 `--canvas-bg`，导出仍按用户选择（透明/白/跟随）                |
| P5 | 先做哪条：关键路径（2→3）还是先补工作区（4）？                         | 整体排序             | 若近期要做真实使用，**先 4**（搜索/树是天天用的）；若目标是"四格式都能编辑"，**先 2→3** |

## 可并行性

- **1** 必须最先（解锁验收）。
- **2 → 3** 是一条链，不能岔开。
- **4 / 5** 之间无耦合，可并行，且都不会碰 `crates/assets` 与承载页。
- **6** 独立（跨仓库），随时可起，但要有服务端配合。
- **7** 等 1–5 稳。
- **8** 穿插做，尤其"i18n 收口"和"大文档性能"可以随时插。
