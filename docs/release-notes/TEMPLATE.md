# Release 说明模板

> 用法：`cp docs/release-notes/TEMPLATE.md docs/release-notes/v<版本>.md`，然后改写。
> **`release.mjs` 会拒绝发版，如果这个文件不存在、或缺少 `# 中文` / `# English` 两段、或正文里没有 `{{setup_url}}`。**
> 写成后它同时用于 GitHub 与 Gitee 两端的 Release 说明（Gitee 不上传附件，所以正文里必须有能点的下载链接）。
>
> 可用占位符（脚本会替换，别手写死版本号）：
> `{{version}}` `{{date}}` `{{setup_url}}` `{{zip_url}}` `{{appimage_url}}` `{{deb_url}}`
> `{{setup_size_mb}}` `{{zip_size_mb}}` `{{appimage_size_mb}}` `{{deb_size_mb}}`
>
> 第一行 `摘要：` 的内容会进 `latest.json` 的 `notes` 字段（更新对话框里显示的那句话），写一句话就够。

摘要：一句话说清这个版本是什么（会进 latest.json 的 notes）。

> 本页中英双语：中文在前，英文在后。 / Bilingual release notes: Chinese first, English below.

---

# 中文

**Diagramon {{version}}** 是……（一句话定位这个版本）

### 下载

| 方式 | 文件 | 说明 |
|---|---|---|
| **安装版**（推荐） | [`Diagramon_{{version}}_x64-setup.exe`]({{setup_url}})（约 {{setup_size_mb}} MiB） | 装完可用**内置自动更新**；缺 WebView2 时安装器会自动下载运行时 |
| **便携版**（免安装） | [`Diagramon-{{version}}-win-x64.zip`]({{zip_url}})（约 {{zip_size_mb}} MB） | 解压到任意位置，双击 `diagramon.exe` 即用；卸载 = 删文件夹 |
| **Linux AppImage**（免安装） | [下载 AppImage]({{appimage_url}})（约 {{appimage_size_mb}} MB） | `chmod +x` 后直接运行；AppImage 支持应用内自动更新 |
| **Linux deb**（Debian / Ubuntu） | [下载 deb]({{deb_url}})（约 {{deb_size_mb}} MB） | 系统包管理器安装；需 WebKitGTK 4.1；**不做**应用内自动更新 |

便携版说明：包里是 `diagramon.exe` + `WebView2Loader.dll` + `ui\` + `assets\`，**必须放在一起**
（`ui\` 与 `assets\` 是从磁盘读的，不在 exe 里）。它**不依赖额外要装的东西**：不需要 Node.js、
不需要 Chrome、不需要 VC++ 运行库（exe 已静态链接 CRT），只需要 Windows 10/11 自带的 WebView2 运行时。
便携版的「检查更新」照常能发现新版，但更新走的是**安装包**（不会就地替换便携目录）——
要继续用便携形态，就手动下载新的 ZIP 覆盖。

### 本次亮点

- …（3-7 条，说人话，别抄 changelog）

### 修复

- …（没有就删掉这一节）

### 关于 Diagramon

Diagramon 是一款**本地优先**的多格式图表编辑器：Mermaid / Graphviz DOT / drawio / Excalidraw
都可编辑并实时预览，AI 可辅助生成、评审与识图。渲染与校验不联网也能用 ——
只有你主动使用 AI 时，相关代码或图片才会发往你选择的上游。

官网：<https://www.diagramon.com>

### 系统要求

- Windows 10 / 11 64 位；或 Linux x64（Ubuntu 22.04+ / Debian 12+，需 WebKitGTK 4.1）
- Windows：WebView2 运行时（通常已预装；缺失时安装器会现场下载）
- Linux：AppImage 免安装，或 deb 经系统包管理器安装；Wayland 下应用内截屏默认关闭（X11 正常）
- **不需要** Node.js、Chrome 或 VC++ 运行库 —— 画布运行时与前端资源都随包分发

### 安装与更新

下载 [`Diagramon_{{version}}_x64-setup.exe`]({{setup_url}}) 直接安装。已装旧版的用户可在
**帮助 → 检查更新** 里收到本版本（更新包即本安装包，签名见 `latest.json`）。

> 本安装包**尚未做 Authenticode 代码签名**，Windows SmartScreen 可能给出提示。

---

# English

**Diagramon {{version}}** is …（one sentence）

### Downloads

| Type | File | Notes |
|---|---|---|
| **Installer** (recommended) | [`Diagramon_{{version}}_x64-setup.exe`]({{setup_url}}) (~{{setup_size_mb}} MiB) | Enables the **built-in auto-update**; if WebView2 is missing the installer downloads the runtime |
| **Portable** (no install) | [`Diagramon-{{version}}-win-x64.zip`]({{zip_url}}) (~{{zip_size_mb}} MB) | Unzip anywhere and run `diagramon.exe`; uninstall = delete the folder |
| **Linux AppImage** (no install) | [Download AppImage]({{appimage_url}}) (~{{appimage_size_mb}} MB) | `chmod +x` and run; AppImage supports in-app auto-update |
| **Linux deb** (Debian / Ubuntu) | [Download deb]({{deb_url}}) (~{{deb_size_mb}} MB) | Install with your package manager; needs WebKitGTK 4.1; **no** in-app auto-update |

About the portable build: it ships `diagramon.exe` + `WebView2Loader.dll` + `ui\` + `assets\`, and those
**must stay together** (the `ui\` and `assets\` trees are read from disk, not embedded in the exe).
It needs **nothing extra installed**: no Node.js, no Chrome, no VC++ redistributable (the CRT is
statically linked) — only the system WebView2 runtime that comes with Windows 10/11.
"Check for updates" still finds new versions, but updating downloads the **installer**
(it does not replace the portable folder in place) — to stay portable, grab the new ZIP manually.

### Highlights

- …(3-7 items)

### Fixes

- …(drop this section if empty)

### About Diagramon

Diagramon is a **local-first** multi-format diagram editor: Mermaid, Graphviz DOT, drawio and Excalidraw
can all be edited with live preview, with AI assistance for generation, review and image recognition.
Rendering and validation work with no network at all — code or images reach a model only when you
actively use AI, and then only the endpoint you chose.

Official website: <https://www.diagramon.com>

### Requirements

- Windows 10 / 11 64-bit, or Linux x64 (Ubuntu 22.04+ / Debian 12+, WebKitGTK 4.1 required)
- Windows: WebView2 runtime (normally pre-installed; the installer downloads it if missing)
- Linux: AppImage (nothing to install) or deb via your package manager; in-app screenshot is off by default on Wayland (X11 is unaffected)
- **No** Node.js, Chrome or VC++ redistributable needed — the canvas runtimes and front-end assets all
  ship inside the installer

### Install and update

Download [`Diagramon_{{version}}_x64-setup.exe`]({{setup_url}}) and run it. Users on an older version
will be offered this release via **Help → Check for updates** (the update package is this same
installer; its signature is in `latest.json`).

> This installer is **not yet Authenticode-signed**, so Windows SmartScreen may show a warning.
