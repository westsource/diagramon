# Diagramon - Mermaid 图表编辑器

一个基于 C# Avalonia 构建的本地 Mermaid 图表编辑器。支持代码编辑与语法高亮、实时预览（拖拽平移/滚轮缩放/双击适应）、语法检测、高清 PNG 导出与剪贴板复制，集成 AI 助手通过自然语言生成图表。**数据本地渲染，不上传**。

版本 **v2.0.260513.0**

## 界面截图

![主界面](screenshots/Diagramon_NELcF3ITQN.png)

![AI助手](screenshots/Diagramon_fxJXInfYWk.png)

## 功能特性

### 代码编辑
- **语法高亮** - 内置自定义 Mermaid 语法高亮定义（Xshd），覆盖关键字、指令、节点ID、边标签、参与者名、类成员等
- **查找替换** - 集成 SearchPanel，支持代码查找/替换
- **多标签页** - 支持多文件独立编辑，每个标签页带关闭按钮，标签页间支持鼠标滚轮切换
- **智能防抖** - 输入后自动延迟 350ms 渲染，避免频繁刷新
- **右键上下文菜单** - 编辑器右键菜单含撤销/重做/剪切/复制/粘贴/全选
- **标签关闭确认** - 关闭未保存标签时弹出保存/不保存/取消对话框；退出程序时逐个确认所有未保存修改
- **崩溃保护** - 自动捕获未处理异常，写入 `%LOCALAPPDATA%/Diagramon/crash.log`

### 实时预览
- **JavaScript 注入更新** - 首次通过 WebView 加载 HTML，后续使用 CoreWebView2.ExecuteScriptAsync 注入 JS 直接更新，无文件导航延迟
- **离屏渲染** - 使用绝对定位离屏容器渲染 SVG，避免影响页面布局
- **拖拽平移** - 按住鼠标左键拖拽移动图表
- **滚轮缩放** - 鼠标滚轮缩放（以光标为中心），缩放范围 20% ~ 3000%，状态栏同步显示百分比
- **双击适应** - 双击预览区自动适配视口
- **错误显示** - 预览区友好显示语法错误信息
- **状态栏** - 底部状态栏左侧显示状态信息（就绪/渲染中/已保存/错误提示等），右侧显示缩放百分比
- **编辑器切换** - 点击分隔条中的三角形按钮（▶/◀）隐藏/显示编辑器，获得全屏预览
- **渲染缓存** - LRU 缓存（最多 32 条）+ 预览后后台自动生成 PNG 图片
- **WebView 快捷键** - 预览区获得焦点时 Ctrl+S 仍然触发保存

### 图片操作
- **保存图片** - 点击预览区右上角浮动保存按钮，导出高清 PNG 图片（支持 PNG/JPEG）
- **复制图片** - 点击预览区右上角浮动复制按钮，将图表以 PNG 格式复制到系统剪贴板
- **自适应缩放** - 导出时根据图表复杂度（节点、边、子图数量）自动计算最优缩放比例（1.5x ~ 5.0x）

### 文件操作
- 新建 / 打开 / 保存 Mermaid 文件（`.mmd` / `.mermaid`）
- 支持命令行参数打开文件（`Diagramon.exe example.mmd`）
- 最近文件记录（最多 10 个），支持**最近历史对话框**（File → Recent Files → More...），含搜索过滤和双击打开
- 关闭未保存标签时弹出保存确认（保存/不保存/取消）
- 退出程序时检测所有未保存修改，逐个提示确认
- 首次打开文件后自动保存至最近文件历史

### AI 助手
- **自然语言生成** - 描述你想要的图表，AI 自动生成 Mermaid 代码
- **多模型支持** - OpenAI、Azure OpenAI、Ollama（本地 LLM）、自定义 API（兼容 OpenAI 协议的任意后端）
- **模型快速切换** - 输入框旁的下拉菜单可快速切换已配置的 AI 模型
- **一键应用与回退** - AI 生成的代码可直接应用到编辑器，支持回退撤销
- **对话历史持久化** - 按文件（文件路径 SHA256 哈希）保存对话记录，支持连续多轮对话；存储路径可配置
- **可配置参数** - 每个模型可独立配置 Temperature、MaxTokens（最高 2000000）等参数
- **消息可选中** - 聊天消息文字（含代码）可选中复制
- **多行输入** - Shift+Enter 换行，Enter 发送
- **输入框右键菜单** - 输入框右键支持剪切/复制/粘贴/全选
- **可拖拽分隔** - 聊天历史与输入区之间可拖拽调整高度（80px ~ 320px）
- **设置图标（⚙）** - 打开 AI 设置对话框管理模型
- **清空对话（🗑）** - 一键清空当前对话
- **API Key 安全存储** - API Key 使用 AES 加密独立存储于 `secure.config`，不与主设置混存

### 设置
- **语言切换** - 文件 → 设置 → 语言 子菜单切换界面语言；首次启动自动检测系统语言（en-US / zh-CN）
- **AI 模型管理** - 文件 → 设置 → AI 设置（或点击 AI 面板 ⚙ 图标），可添加/编辑/删除 AI 模型配置：
  - 名称、提供商（OpenAI / Azure OpenAI / Ollama / 自定义）
  - API Key（AES 加密存储）、Base URL（自动清理末尾路径，如 `/chat/completions`）
  - Model ID、Max Tokens（默认 4096，最高 2000000）、Temperature（默认 0.7）
  - Azure OpenAI 专属：Endpoint、Deployment Name
- **对话历史存储路径** - 可配置 AI 对话历史的磁盘存储位置（默认 `%APPDATA%/Diagramon/Conversations`）
- **自动保存布局** - 编辑器宽度、预览缩放、AI 面板展开状态与高度等自动保存至 `%APPDATA%/Diagramon/settings.json`

### 更新
- **启动时自动检查更新** - 程序启动时自动检测新版本（间隔 24 小时，可在设置中关闭），更新清单 URL 可配置
- **下载更新** - 支持直接下载（含实时进度条）或使用默认浏览器下载
- **跳过版本** - 跳过特定版本后不再提示
- **手动检查更新** - 帮助 → 检查更新（与"关于"同组）

### 关于
- **帮助 → 关于** - 显示应用名称、功能描述、作者（道荣 & 黄超）、当前版本号
- **帮助 → Mermaid 文档** - 在浏览器中打开 https://mermaid.js.org/intro/

### 界面特性
- **拖拽分隔条** - 编辑器与预览区比例可拖拽调节（编辑器 320px ~ 860px；预览区最小 480px）
- **一键切换按钮** - 分隔条中点击三角形按钮（▶/◀）隐藏/显示编辑器
- **Fluent 主题** - 现代化界面风格
- **自动保存布局** - 编辑器比例、缩放级别、AI 面板状态等自动保存
- **底部状态栏** - 左侧状态信息 + 右侧缩放百分比
- **访问键（Access Keys）** - 菜单与按钮支持 Alt+下划线字母快捷键
- **标签页关闭按钮** - 每个标签页带 × 关闭按钮，可单独关闭

### 技术细节
- 预览渲染使用 `CoreWebView2.ExecuteScriptAsync` 注入 JavaScript，绕过 file:// URL 缓存与导航限制，首次加载使用 Navigate 打开本地 HTML 文件
- AI 配置的 Base URL 自动清洗（自动移除末尾的 `/chat/completions`、`/v1/chat/completions`、`/api/chat` 等路径）
- 预览临时文件启动时自动清理（仅保留最近 7 天）
- API Key 使用 AES 加密独立存储于 `secure.config` 文件，不与主设置混存
- 渲染缓存采用 LRU 策略，最多 32 条，基于内容 SHA256 哈希
- 导出缩放根据图表元素数量自适应（节点/边/子图计数决定 1.5x ~ 5.0x 倍率）
- 代码编辑器使用 AvaloniaEdit，集成自定义 Mermaid 语法高亮（Xshd 定义）
- Mermaid CLI 工具已嵌入项目 `tools/` 目录，无需额外安装 Node.js
- 构建时自动处理 Avalonia 路径分隔符兼容性（.NET 10 SDK Workaround）
- 调试构建自动复制 WebView2Loader.dll 到输出目录

## 技术栈

- **语言**: C# (.NET 10)
- **UI 框架**: Avalonia UI 11.3.0、Fluent Theme
- **架构模式**: MVVM (CommunityToolkit.Mvvm 8.4.0)
- **代码编辑器**: AvaloniaEdit 11.4.1
- **预览渲染**: Mermaid.js（通过 WebView（WebView.Avalonia 11.0.0.1）实时渲染）
- **图片导出**: Mermaid CLI（嵌入式 Node.js 工具，用于高清 PNG 导出）
- **WebView**: WebView.Avalonia 11.0.0.1（CoreWebView2）
- **图标字体**: Inter Font

## 环境要求

### 开发环境
- .NET 10 SDK（含 WebView2 运行时）

### 运行打包版本
- Windows 系统（需内置 WebView2 运行时，Windows 10/11 已预装）
- 无需安装 Node.js 或其他依赖，Self-Contained 双击即可运行

## 构建项目

### 开发模式

```bash
dotnet restore
dotnet run
```

支持命令行参数打开文件：

```bash
dotnet run -- example.mmd
```

### 发布 Self-Contained 版本

使用项目自带的发布脚本：

```powershell
.\publish1-build.ps1   # 构建步骤
.\publish2-release.ps1 # 打包步骤
```

或手动执行 dotnet publish：

```bash
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
```

## 使用说明

### 打开文件
- 菜单栏：文件 → 打开（Ctrl+O）
- 命令行参数：`Diagramon.exe example.mmd`
- 最近文件：文件 → 最近文件，底部 **More...** 按钮打开最近历史搜索框，支持搜索过滤与双击打开
- 支持 `.mmd` 和 `.mermaid` 扩展名

### 编辑代码

在左侧代码编辑器中输入或修改 Mermaid 代码，右侧预览区会实时更新图表（防抖延迟 350ms）。支持 Ctrl+F 查找/替换。

- 右键编辑器弹出上下文菜单：撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选
- 关闭未保存标签时弹出保存确认对话框（保存 / 不保存 / 取消）

### 保存文件

- 保存：文件 → 保存（Ctrl+S）
- 另存为：文件 → 另存为（Ctrl+Shift+S）

### 导出图片

- 点击预览区右上角浮动**保存**按钮保存 PNG/JPEG 图片文件
- 点击预览区右上角浮动**复制**按钮复制图片到剪贴板
- 导出缩放根据图表复杂度自动适配

### 预览操作

- **拖拽平移**：在预览区按住鼠标左键拖拽
- **缩放**：鼠标滚轮缩放（以光标为中心），底部状态栏同步显示百分比
- **双击适应**：双击预览区自动适应视口
- **隐藏/显示编辑器**：点击分隔条中的三角形按钮（▶/◀）获得全屏预览

### AI 助手

1. 点击底部的"AI 助手"按钮展开面板
2. 在输入框中描述你想要的图表（如"画一个用户登录流程图"），Shift+Enter 换行，Enter 发送
3. 通过输入框旁的下拉菜单选择已配置的 AI 模型
4. AI 会生成对应的 Mermaid 代码
5. 点击"应用代码"将生成的代码插入编辑器，点击"回退"可撤销
6. 点击设置图标（⚙）进入 AI 设置，管理模型配置（添加/编辑/删除）
7. 输入框右键可弹出菜单：剪切/复制/粘贴/全选
8. 对话消息均可选中复制，聊天历史与输入区高度可拖拽分隔条调整
9. 点击垃圾桶图标（🗑）清空当前对话历史

### 设置

- **语言切换**：文件 → 设置 → 语言，选择界面语言。首次启动自动检测系统语言
- **AI 模型管理**：文件 → 设置 → AI 设置（或点击 AI 面板中的 ⚙ 图标），可添加、编辑、删除 AI 模型配置，配置项包括：
  - 模型名称、提供商（OpenAI / Azure OpenAI / Ollama / 自定义 API）
  - API Key（AES 加密）、Base URL（自动清理多余路径后缀）、Model ID
  - Max Tokens（1~2000000）、Temperature（0.0~2.0）
  - Azure OpenAI 专属：Endpoint、Deployment Name
- **对话历史路径**：在 AI 设置中配置对话历史文件的存储位置
- **布局自动保存**：编辑器宽度、预览缩放、AI 面板展开状态与高度等自动保存

### 更新

- **自动检查**：程序启动时自动检查更新（每 24 小时检测一次，可在设置中关闭）
- **手动检查**：帮助 → 检查更新
- **下载更新**：发现新版本后，可选择直接下载（含实时进度条）或使用默认浏览器下载
- **跳过版本**：可跳过特定版本，之后不再提示

### 关于

- 帮助 → 关于：查看应用名称、功能描述、作者（道荣 & 黄超）、当前版本号
- 帮助 → Mermaid 文档：在浏览器中打开 Mermaid 官方文档

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| Ctrl+N | 新建文件 |
| Ctrl+O | 打开文件 |
| Ctrl+S | 保存文件 |
| Ctrl+Shift+S | 另存为 |
| Ctrl+F | 查找/替换 |
| Ctrl+W | 关闭当前标签 |
| Ctrl+Q | 退出程序 |
| Ctrl+Z | 撤销 |
| Ctrl+Y / Ctrl+Shift+Z | 重做 |
| Ctrl+X | 剪切 |
| Ctrl+C | 复制 |
| Ctrl+V | 粘贴 |
| Ctrl+A | 全选 |

## 许可证

本项目采用 Apache License 2.0 许可证。详见 [LICENSE](LICENSE) 文件。

## 致谢

本项目使用了以下开源项目：

- [Avalonia UI](https://avaloniaui.net/) - 跨平台 UI 框架
- [AvaloniaEdit](https://github.com/AvaloniaUI/AvaloniaEdit) - 代码编辑器控件（含 SearchPanel）
- [Mermaid.js](https://mermaid.js.org/) - Mermaid 图表渲染引擎（预览）
- [Mermaid CLI](https://github.com/mermaid-js/mermaid-cli) - Mermaid 图表渲染引擎（高清 PNG 导出）
- [WebView.Avalonia](https://github.com/AvaloniaUI/AvaloniaWebView) - WebView 控件
- [CommunityToolkit.Mvvm](https://learn.microsoft.com/dotnet/communitytoolkit/mvvm/) - MVVM 工具包
- [Inter Font](https://rsms.me/inter/) - 界面字体

