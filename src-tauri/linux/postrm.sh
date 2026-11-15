#!/bin/sh
# 卸载后刷新 MIME 数据库，别让系统留下指向已删定义的条目。
set -e
if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime || true
fi
exit 0
