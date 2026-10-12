# AGENTS.md — Diagramon `client2` 的项目规则

> 给**任何**在这个仓库里干活的 agent（也包括人）。这里的规则是**可执行**的：
> 违反它们，脚本会拒绝、门禁会红 —— 不靠自觉。
>
> 相关文档：`docs/发布检查单.md`（发版细节与仍未办的手续）、`docs/roadmap-dev3.0.md`（实现沿革）。

## 0. 先搞清楚这是哪个仓库

- `client2/` = **Diagramon 3.0 客户端**（Rust + Tauri 2 + 系统 WebView）。`main` 自 2026-10-12 起就是 3.0（此前是 v2.0 的 C# 客户端，已快进合并覆盖）。开发线在分支 `dev3.0`。
- 同一工作区下另有 `../client`（C# 旧客户端，迁移期行为参照）与 `../service`（FastAPI 服务端）——**三个独立 git 仓库，提交各进各的目录**。
- 契约单一真源：IPC 类型只在 `crates/app-ipc`；格式注册表只在 `crates/app-core/src/format.rs`（前端经 `formats` 命令取）。**不要在前端另抄一份**。
- 签名密钥在**仓库之外** `../keys/`，公钥在 `src-tauri/tauri.conf.json`。**永远不要把这些文件提交进来。**

## 1. 发布：只走 `node tools/release.mjs <版本>`

**这是唯一的发版入口。不要手工拼流程，也不要在它之外打 tag / 建 Release / 传附件。**

```bash
node tools/release.mjs 3.0.1              # 全流程
node tools/release.mjs 3.0.1 --from=build # 构建断了从这步续（首次构建约 25 分钟）
node tools/release.mjs 3.0.1 --dry-run    # 只打印计划，不改任何东西
node tools/release.mjs --help
```

步骤：`preflight → prepack → build → portable → manifest → tag → branches → push → publish → verify`

**发版前你必须准备好的两样东西**（脚本会拒绝，不会替你写）：

1. `src-tauri/tauri.conf.json` 的 `version` 改成目标版本**并提交**（版本号唯一真源，Workspace 继承它）；
2. `docs/release-notes/v<版本>.md` —— 从 `docs/release-notes/TEMPLATE.md` 复制，**必须含 `# 中文` 与 `# English` 两段**，且正文里要有 `{{setup_url}}`（Gitee 不传附件，正文必须有能点的链接）。

### 七条红线（脚本逐条校验，别绕过）

1. **打包前必跑 `node tools/prepack.mjs`** —— `bundle.resources` 是**按目录整体映射**、tauri glob 无排除语法、打包**不看 `.gitignore`**，所以工作树 `ui/` 里的杂物一定会进包（且因为 `build.frontendDist = "../ui"`，还会**再嵌进 exe 一份**）。漏清过的实测：安装包 60.64 MiB / exe 13.0MB；清后 51.80 MiB / 8.48MB。
2. **`latest.json` 每次都要重新生成** —— 它是 `target/` 下的构建产物、不入库，最容易把上一次的拿上去。`platforms.windows-x86_64.signature` 必须是本次 `.sig` 的**内容**，`url` 必须指向**本次**安装包。
3. **更新清单里绝不能放便携 ZIP** —— 更新器只认 PE/MSI，且**不要为此打开 `tauri-plugin-updater` 的 `zip` feature**（我们 `default-features=false`，开着反而更糟：它会把解压目录里的 `diagramon.exe` 当安装器执行）。
4. **README 两条分支都要改、内容一字不差** —— `main` 上 `README.md`=英文 / `README.zh-CN.md`=中文；`gitee-master` 上 `README.md`=中文 / `README_EN.md`=英文（只换命名与顶部互链）。`gitee-master` 由脚本用 `checkout -B` 重建，**别用手工 `rebase`**。
5. **Release 说明一律中英双语**，结构 `> 本页中英双语…` + `---` + `# 中文` + `---` + `# English`。
6. **附件共四个**：`Diagramon_<版本>_x64-setup.exe` + `.sig` + `latest.json` + `Diagramon-<版本>-win-x64.zip`（**只传 GitHub**）。换产物要**先删旧同名附件**再传。Gitee 那边**不上传任何二进制**，正文放 GitHub 下载链接即可 —— 你在 Gitee Release 上看到的那 2 个附件（`v<版本>.zip` / `.tar.gz`）是**平台自动生成的源码包**，不是我们传的。**正文里必须有两个可点链接**（`{{setup_url}}` 与 `{{zip_url}}`）—— Gitee 不托管附件，正文缺哪个链接，Gitee 访客就拿不到哪个产物；脚本对这两条都会 `die()`。写说明请**从 `docs/release-notes/TEMPLATE.md` 复制**，别凭记忆写（v3.0.1/3.0.2 都曾因为漏抄「下载」表那两行而缺便携包链接）。
7. **发完必须回读**：`https://github.com/westsource/diagramon/releases/latest/download/latest.json` 的 `signature` 要与本地 `.sig` **逐字节一致**（`releases/latest` 只认**已发布**的 Release）。

### 双远端

`origin` = GitHub，`gitee` = https://gitee.com/westsource/diagramon.git。分支映射 **GitHub `main` ↔ Gitee `master`**，另外 Gitee 的 `main` 同步 `main`；tag 两端都要推。推 GitHub 走 socks5（`socks5h://127.0.0.1:1080`），推 Gitee 不用代理；两边都要 `-c credential.helper=store`。Gitee 的 master 常**不是快进**，覆盖前先取当前 tip 做 `--force-with-lease`。

命令一律用 `.exe` 直调、**不要 `shell:true`**（Windows 上 node 在 shell 模式下把参数 join 成串丢给 cmd.exe、不加引号，`-c "…"` 这类参数会被切碎）；需要命令行里的多行/含反引号的文本（比如提交信息）**写进文件**再 `-F`。令牌按 **host** 从 `~/.git-credentials` 取（该文件行序会被 git 自己重排，不能靠行序），任何要打印的 URL 先脱敏（Gitee 把令牌放在 query 里）。

### 三个只在实战里才会遇到的坑（脚本已挡住，别绕）

- **`prepack` 会删掉真机自检报告**（那玩意就在 `ui/.shots/` 里）⇒ **每次发版前都要重新跑一次 `check.mjs`**；preflight 的"报告比源码新"门禁本质上就是这么用的。
- **已发布的 tag 不要随手前移**。发新版时 `tag`/`push` 会 force 前移 `v<版本>`，这**必须显式 `--move-tag`**；而**只改文档/README 的重发版**压根不该跑这两步（tag 留在发布提交上，主线照常前进）。脚本在 tag 已存在且不指向当前 `main` 时会拒绝，`push` 也会自动跳过 tag 推送。
- **脚本对分支用普通 `push`（不 force）**。所以如果你 **amend 了已经推过的提交**，再推会被拒（`non-fast-forward`）—— 这是有意的提醒，不是脚本坏了。收拾办法：手工 `git push --force-with-lease=<远端当前 sha> <remote> <branch>`；更省事的是**别在推送之后 amend**。

## 2. 验收：一条命令 `node tools/dev/check.mjs`

七步（任一步失败即退出）：杀残留实例 → 前端语法 → **i18n 引用完整性**（`t()` 用到的键必须在 ZH/EN 都存在）→ **UI 交互冒烟 `ui_probe`** → 构建 → **Rust 单测** → **真机自检**。

```powershell
$env:DGM_PYTHON="C:\Users\rong\.workbuddy\binaries\python\versions\3.13.12\python.exe"; node tools/dev/check.mjs
```

- `--test-only` 只跑非自检部分；`--skip-test` 只跑真机自检。
- **真机自检要在前台桌面跑**（WebView2 对后台窗口会节流、丢 IPC 响应，沙箱里拿不到报告）。报告落 `ui/.shots/selftest-report.json`，整场日志 `ui/.shots/check.log`。
- 判断"整场有没有走到第 7 步"**看报告时间戳**：脚本进循环前会先删报告，所以**时间戳还是旧的 = 前六步里有人 `exit(2)`**。
- `DGM_PYTHON` 指向的解释器必须能 `import websocket`；本机唯一满足的是上面那条路径（机器上没有 `py` 启动器）。这个环境变量**曾经因为 `findPython()` 的 `shell:true` 从来没生效过**，别再把失败归因成"环境缺件"。
- 单测当前 163 项、探针 20 条断言、自检 51 条 —— 数量会随开发变，**全绿才是要求**。

改 `ui/**` 之后跑本地应用**必须先 `cargo build`**（或把改动 `cp` 到 `target/debug/ui/` 同路径），否则跑的是旧副本。

## 3. 什么时候不要动

- 别改 `third-party/schemars-0.8.22-order-fix/`（上游 bug 的临时补丁，上游修好后整体删掉）。
- 别把 `ui/vendor/`（CodeMirror6 / mermaid / wasm-graphviz）当成普通源码改；那是随包资产。
- 别把 98MB 的画布资产提交进仓库（`client/tools/**` 与 `client/Assets/mermaid.min.js`；打包前由 `node tools/fetch-assets.mjs` 汇到 `assets/`）。
- 改承载页（drawio / Excalidraw 的 `host.html`）**先读它顶部的契约注释块**（`__hostQueue` / `__apply` / `__hostZoom*`），那是 shell 与页面之间唯一的接口真源。

## 4. 什么改动要重打包，什么只要推 git

打包范围**只有两处**（都在 `src-tauri/tauri.conf.json`）：`build.frontendDist = "../ui"`（所以 `ui/` 还会**被嵌进 exe**）与 `bundle.resources = {"../ui/": "ui/", "../assets/": "assets/"}`。**其它目录一律不进包。**

| 改了什么 | 重新编译打包 | 换 Release 产物（发新版） | 只要推 git |
|---|:--:|:--:|:--:|
| `crates/**`、`src-tauri/**`、`Cargo.toml` / `Cargo.lock` | ✅ | ✅（否则已装用户拿不到） | |
| `ui/**` | ✅ | ✅ | |
| `assets/**`（`fetch-assets.mjs` 汇出的画布资产） | ✅ | ✅ | |
| `src-tauri/tauri.conf.json`（`endpoints` / `version` / `bundle`） | ✅ | ✅ | |
| `tools/**`（脚本、探针、打包工具） | | | ✅ |
| `docs/**`、`AGENTS.md`、`README*`、`screenshots/**` | | | ✅（README 两条分支都要改） |

判断口诀：**改的东西会不会进 exe / `ui/` / `assets/`？会 → 重打包发版；不会 → 推 git 就够。**

一个例外：`latest.json` 的 `notes` 文案已经挂在 Release 上了，改它要**重传那个附件**（不是重编译）。
还有一条容易漏：**版本号没变时，已装用户不会认为有新版** —— 所以"内容变了但版本没变"的重打包，
老用户只能靠重新安装拿到（2026-10-12 的 endpoints 统一就是这么个情况）。
