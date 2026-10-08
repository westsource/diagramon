## 打开与保存

- 新建：文件 → 新建 → 选择格式（Mermaid / Graphviz DOT / drawio / Excalidraw）
- 打开：文件 → 打开（Ctrl+O），或从"最近打开"里选（带路径提示，常用文件可置顶）
- 命令行打开：`Diagramon.exe 示例.mmd`（支持 `.mmd` `.mermaid` `.dot` `.gv` `.drawio` `.excalidraw`）
- 保存：Ctrl+S；另存为：Ctrl+Shift+S；标签页标题带 `*` 表示尚未保存
- 关闭标签（Ctrl+W）或退出（Ctrl+Q）时若有未保存改动，会先询问保存/放弃/取消
- 保存过的文件会进入"最近打开"，也决定后续 Ctrl+S 的落盘路径

## 编辑

- 文本面是唯一的真相：Mermaid / DOT / drawio / Excalidraw 的源码就是磁盘上的文件，画布只是视图
- 语法高亮随格式切换；Ctrl+F 打开查找替换；Ctrl+Z / Ctrl+Y 撤销重做；Ctrl+X / C / V / A 剪贴/复制/粘贴/全选
- 分隔条上的三角按钮（▶/◀）收起编辑器获得全屏预览；编辑器下沿的条可展开/收起 AI 助手

## 画布手势（四处视图完全一致）

- 滚轮 = 平移；Shift+滚轮 = 横向平移
- Ctrl+滚轮 = 缩放（以光标为锚点）；触控板捏合同样走这一条
- 拖拽 = 平移（预览面是只读的，左键即平移；画布内左键用于选择，平移请用中键拖拽或空格+拖拽）
- 双击 = 适应视图；Ctrl+0 = 适应视图；Ctrl+= 放大一档；Ctrl+- 缩小一档
- 适应视图的口径按各格式的"整幅图"来：预览面与 Excalidraw 铺满内容，drawio 铺满整页
- 底部状态栏右侧显示当前视图的缩放百分比；Ctrl+滚轮与上面的快捷键都会同步它

## 图片导出与复制

- 预览区右下角的浮动按钮：上=保存预览图（PNG），下=复制预览图（到系统剪贴板）
- 倍率在 设置 → 图片倍率设置 里：可固定倍率，也可按图表复杂度自动选择（1.5× ~ 5×）
- Mermaid 走 Mermaid CLI（mmdc）导出；DOT 在预览页内完成栅格化（零子进程，输出透明底 PNG）；
  drawio / Excalidraw 由画布在页面内栅格化（同样零子进程）

## 各格式要点

- Mermaid：渲染与"保存预览图"依赖随包内置的 Node 与 Chrome headless，无需另行安装
- Graphviz DOT：渲染在预览页内由 Graphviz WASM 完成；状态栏右侧可选布局引擎（dot / neato / fdp / sfdp / twopi / circo），切换不重载引擎
- drawio：画布即编辑器，编辑器与预览区自动让位；画布改动 1.5 秒去抖后自动回写正文；保存/另存为前会先向画布取一次最新 XML，
  因此"刚画完就保存"不会丢改动；画布内的 Save 按钮已关闭，保存入口统一是应用自己的保存（Ctrl+S）；
  文件 → 转换为 drawio 图：把当前 Mermaid 源码交给 drawio 自己的解析器，结果另开新标签页（单向）
- Excalidraw：库型集成（我方承载页内实例化）；文档只持久化少量 appState，视口是页面级瞬态 ——
  切回标签页时若视口看不到内容会自动拉回；文件 → 转换为 Excalidraw 图：走 mermaid-to-excalidraw（单向）

## AI 助手

- 设置 → AI 设置 里选择 provider：直连（OpenAI / Azure OpenAI / Ollama / 自定义 OpenAI 兼容接口）或会员云网关
- 直连用你自己的 API Key（仅保存在本机）；会员走 Diagramon 云网关，按额度计费，凭据是当前登录令牌、按请求获取、不落盘
- 支持图片识别：把截图或本地图片交给模型，得到当前格式的图表代码（一次生成、可撤回）
- 渲染报错时可以让 AI 自动修正一次；只有你主动发起时才会把代码/图片发往模型服务

## 会员与云端文档

- 账户 → 登录 / 退出；登录后可保存到云端、从云端打开
- 云端文档是"逐文档显式上传"的：不会自动把你打开的每个文件传上去；同名并发写入会提示冲突而不是静默覆盖

## 快捷键总表

- Ctrl+N 新建 / Ctrl+O 打开 / Ctrl+S 保存 / Ctrl+Shift+S 另存为 / Ctrl+W 关闭标签 / Ctrl+Q 退出
- Ctrl+Z 撤销 / Ctrl+Y（或 Ctrl+Shift+Z）重做 / Ctrl+X 剪切 / Ctrl+C 复制 / Ctrl+V 粘贴 / Ctrl+A 全选 / Ctrl+F 查找替换
- Ctrl+0 适应视图 / Ctrl+= 放大一档 / Ctrl+- 缩小一档
- 焦点在预览区或画布内时（键先落在 WebView 上），承载页会把上述"应用级"快捷键转回宿主执行；
  撤销/剪切这类编辑键仍然归画布自己，以保住画布自身的编辑历史

## 离线与隐私

- 渲染（Mermaid / Graphviz / drawio / Excalidraw）全部在本机完成：运行时随包分发，页面由进程内 loopback 提供，全程零外部请求
- 只有你主动使用 AI 时，相关代码或图片才会发送到所选模型服务；离线守卫会拦截页面里任何意料之外的联网并显示在状态栏

## 遇到问题时

- 未处理异常会写到 `%LOCALAPPDATA%\Diagramon\crash.log`（含时间与调用栈）
- 需要 WebView2 运行时（Windows 10/11 通常已内置）；缺失时会在状态栏给出明确提示
- 画布/预览区空白或提示资源缺失时：drawio、Excalidraw、Graphviz 资源由 `tools\` 下的 fetch 脚本获取
  （`fetch-drawio.ps1` / `fetch-excalidraw.ps1` / `fetch-graphviz.ps1`），缺失的资源不会静默降级
- 状态栏的错误文案按"谁的问题"区分：语法/渲染错误、资源缺失、AI 上游错误、网络与离线拦截
