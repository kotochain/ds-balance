#!/bin/bash
# 双击这个文件即可启动网页版余额查询
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 Node.js。请先安装：https://nodejs.org/"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

exec node ds-balance.mjs --serve --open
