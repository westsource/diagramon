# Tools 目录说明

此目录需要包含 Mermaid CLI 工具才能正常渲染图表。

## 安装步骤

1. 下载 Node.js 便携版 (Portable)
   - 访问 https://nodejs.org/en/download/
   - 下载 Windows Binary (.zip)
   - 解压到此目录，重命名文件夹为 `node`

2. 安装 Mermaid CLI
   ```cmd
   cd tools
   ..\tools\node\npm install @mermaid-js/mermaid-cli
   ```

## 目录结构

安装完成后，目录结构应该是：

```
tools/
├── mmdc.cmd          # Mermaid CLI 启动脚本
├── node/             # Node.js 便携版
│   ├── node.exe
│   └── npm.cmd
├── node_modules/     # Mermaid CLI 及依赖
│   └── @mermaid-js/
│       └── mermaid-cli/
└── puppeteer-cache/  # Chrome for Testing (headless shell)，随发布包内置
    └── chrome-headless-shell/
        └── win64-<版本号>/
            └── chrome-headless-shell-win64/
                └── chrome-headless-shell.exe
```

## Chrome for Testing (puppeteer-cache)

Mermaid CLI 通过 puppeteer 渲染图表，需要 Chrome for Testing 的 headless shell，
版本必须与 `node_modules/puppeteer-core` 固定的版本一致，否则会报
`Could not find Chrome (ver. ...)`。

- 发布时由 `publish1-build.ps1` 自动从 npmmirror 镜像
  （`https://registry.npmmirror.com/-/binary/chrome-for-testing/...`）下载对应版本并解压到本目录，
  失败时回退官方源 `https://storage.googleapis.com/chrome-for-testing-public/...`。
- `mmdc.cmd` 通过 `PUPPETEER_CACHE_DIR` 环境变量指向本目录，发布包无需联网即可渲染。
- 本地开发时若缺失，可手动执行：
  ```cmd
  tools\mmdc.cmd --version   :: 首次会失败
  ```
  或运行 `publish1-build.ps1` 生成。也可以手动下载解压：
  ```cmd
  curl -L -o %TEMP%\shell.zip https://registry.npmmirror.com/-/binary/chrome-for-testing/131.0.6778.204/win64/chrome-headless-shell-win64.zip
  ```
  解压后按上述目录结构放到 `tools\puppeteer-cache\chrome-headless-shell\win64-131.0.6778.204\`。
  版本号以 `node_modules\puppeteer-core\lib\cjs\puppeteer\revisions.js` 中的
  `chrome-headless-shell` 为准。

## 测试

运行以下命令测试是否安装成功：

```cmd
tools\mmdc.cmd --version
```
