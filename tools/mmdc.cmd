@echo off
setlocal

set "SCRIPT_DIR=%~dp0%"
set "PATH=%SCRIPT_DIR%node;%PATH%"
rem 使用随包发布的 Chrome for Testing（由 publish1-build.ps1 下载到 puppeteer-cache）
set "PUPPETEER_CACHE_DIR=%SCRIPT_DIR%puppeteer-cache"

node "%SCRIPT_DIR%node_modules\@mermaid-js\mermaid-cli\src\cli.js" %*
