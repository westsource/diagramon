# Diagramon dev3.0 —— 界面原型

新客户端（Rust + Tauri 2 + WebView2）的**高保真可交互界面原型**。
纯静态 HTML/CSS/JS：无框架、无构建链、无 CDN、无外部请求，双击 `index.html` 即可评审。

- `index.html` —— 设计说明：原则、布局解剖、格式与转换矩阵、键位、配色、截图索引、实施映射、待拍板
- `app.html` —— 主界面原型（全部交互可点）
- `ai-intent-proto.html` —— 档位 3 交互原型：无页签、单时间线、胶囊滑块；可模拟配置 Jev 与回退
- `ai-intent-settings-proto.html` —— 设置窗口原型：AI 页里的「智能判断 / 意图判定」配置、测试与未配置回退
- `ai-settings-optimized-proto.html` —— AI 设置重组原型：图文模型 / 意图识别 / 对话行为 / 记忆四组，含官方/自定义意图切换
- `palette-proto.html` —— 自动配色的色系原型：模型只写角色、色值本地按色系展开；6 色系 × 6 角色 × 明暗两阶，菜单/换色/主题切换都可点（色值由 `crates/app-core/src/palette.rs` 直接导出，与实现逐字节一致）
- `proto.css` —— 设计系统（明暗双主题全走 CSS 变量）+ 全部组件样式
- `proto-data.js` —— 数据层：格式注册表 / 转换矩阵 / 文档 / 命令表 / 菜单 / AI 会话（对应 `crates/app-core/src/format.rs` 的镜像）
- `proto-icons.js` —— 内联 SVG 图标精灵（不引图标库）
- `proto.js` —— 交互：布局状态机、命令面板、对话框、菜单、拖拽、快捷键
- `shots/` —— 21 张无头 Chrome 实截（1680×1000），`index.html` 的截图索引逐张可点回对应状态

## 打开方式

直接双击 `index.html`，或：

```
file:///E:/OpenCode/diagramon/client2/design/ui-proto/index.html
```

不需要起服务（`file://` 下全部功能可用）。

## URL 状态（直达任意评审状态）

```
?theme=dark            明/暗主题
&doc=d1|d2|d3|d4       打开的文档（mermaid / dot / drawio / excalidraw）
&mode=source|split|preview   视图模式（仅文本型格式）
&view=explorer|search|convert|cloud|outline   侧栏视图
&panel=problems|output|convert|usage          底部面板页
&ai=chat|vision|review AI 面板 tab
&open=palette|convert|vision|settings|keys|new|history|guide|about   打开弹层
&zen=1                 全屏预览（隐藏所有面板）
&nosidebar=1 &noai=1 &nopanel=1   单独隐藏某块
&close=all             清空标签页（看欢迎页）
&notoast=1             不弹启动提示（截图用）
```

例：`app.html?theme=dark&doc=d3` = 暗色下打开 drawio 画布。

## 交互自检（18 项，全 PASS）

用真实事件（click / mouseenter / keydown）驱动页面并断言 DOM：

```
菜单：文件 → 转换为 → DOT（二级菜单悬停展开）→ 新建标签页且激活
视图：Ctrl+3 隐藏源码 / Ctrl+2 回分屏
主题：标题栏按钮切换 data-theme
面板：Ctrl+B 侧栏开合（body.no-sidebar）
命令面板：Ctrl+Shift+P 打开、输入过滤、Esc 关闭
AI：Ctrl+I 聚焦输入框、发送后出现用户消息
问题面板：点击 issue 跳转到源码行（当前行高亮）
保存：Ctrl+S 清掉标签页脏标
```

复跑方式（把断言脚本贴进页面尾部后无头跑）：见 `shots/` 的同名截图流程，
或直接 `node --check proto.js` 做语法门禁。

## 截图复跑

```bash
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1680,1000 --virtual-time-budget=3000 \
  --screenshot="E:/OpenCode/diagramon/client2/design/ui-proto/shots/01-light-split.png" \
  "file:///E:/OpenCode/diagramon/client2/design/ui-proto/app.html?notoast=1"
```

注意：`--screenshot` 必须给 Windows 绝对路径（相对路径报 0x5）。

## 实施映射（原型 → dev2.0）

| 原型块 | 落点 |
|---|---|
| FORMATS / CONVERSIONS | `crates/app-core/src/format.rs`（新增 Mermaid→DOT 映射器） |
| 命令 id / act 分发 | `crates/app-ipc` 命令 + `ui/app.js` |
| 源码编辑 | CodeMirror 6（`ui/vendor/editor.bundle.js`），语法校验行号已有（stage1e） |
| 预览 / 画布 | `ui/preview.js`、`ui/canvas.js`；主题变量需下发四个承载页（新增） |
| AI 面板 | `ui/ai.js` + `crates/ai`；识图档/用量回报接服务端 `/v1/ai/*` |
| 侧栏五视图 | 新增 `ui/sidebar.js`（转换中心是新视图，其余在 main 有行为参照） |
| 底部面板 | 新增 `ui/panel.js`（问题=校验结果，输出=渲染日志，转换记录/用量为新数据面） |
| 主题与布局记忆 | `ui/styles.css` 变量 + `settings.json` |

实施时把 `proto.css` / `proto.js` 并入 `ui/` 后删除本目录；`proto-data.js` 的数据面
应改由 `formats` 命令从 app-core 取，不在前端维护第二份清单。

## 两个硬约束（原型里踩过，实施时同样成立）

1. **grid 子项必须显式占位。** `display:none` 不参与 grid 自动布局：隐藏侧栏/AI 面板后
   编辑区会掉进第一列（宽 0）整块空白；分屏三列同理。`.body-row > *` 与 `.split > *`
   都写死了 `grid-column`，别删。
2. **grid 子项必须 `min-height: 0`。** 否则内容（SVG 的 min-content 高度）会把列撑出视口，
   底部面板被顶到屏幕外。`.body-row > * { min-height: 0 }` 是这条的兜底。

## 已知边界（原型有意不做）

- 编辑器不可真编辑（行是渲染出来的 span）；真实实现走 CodeMirror。
- 图形是手绘 SVG 示意，不跑 mermaid/graphviz/drawio/excalidraw 真实运行时。
- 文件 IO、云、更新器、DPAPI 一律不接；点到时给 toast 说明真实行为。
- i18n 只有中文文案（原型）；实施时走 `ui/i18n.js` 的 zh-CN/en-US 双表。
