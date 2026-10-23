; D-3.8.15-01 修复：升级时安装程序杀 diagramon 进程失败。
;
; 根因：安装程序的 CheckIfAppIsRunning 宏走 Windows RestartManager 的
; RmShutdown(RmForceShutdown) 强杀，当运行中的 diagramon（及 WebView2 子进程）与安装程序
; 提权/令牌级别不一致时，RmShutdown 返回非零，弹「安装程序杀 diagramon 进程失败」并 Abort，
; 升级中止。
;
; 修复：用 NSIS_HOOK_PREINSTALL 在 Section Install **复制文件之前**、`CheckIfAppIsRunning`
; 运行**之前**先把 diagramon 整个进程树强杀（taskkill /F /T 连子进程一起），随后
; RestartManager 的 RmGetList 找不到运行中的进程就直接跳过，不再因提权不一致而失败。
; 该宏由 tauri.conf.json 的 bundle.windows.nsis.installerHooks 引用。
!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'taskkill /F /T /IM diagramon.exe'
  Sleep 500
!macroend
