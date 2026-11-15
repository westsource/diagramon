#!/bin/sh
# Diagramon deb 维护脚本：让新装的 MIME 定义与图标缓存立即可用。
# 失败一律不阻断安装（缺 shared-mime-info/gtk 工具的老系统也该装得上）。
set -e
if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t /usr/share/icons/hicolor || true
fi
exit 0
