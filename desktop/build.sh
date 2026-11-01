#!/usr/bin/env bash
# 构建独立桌宠壳：纯 Swift + 系统 WebKit，无第三方依赖。
# 产物：desktop/build/maoxuan-pet（单文件可执行，pet.html 同目录随行）。
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p desktop/build
# 模块缓存放进项目内：系统默认缓存目录（/var/folders/.../C/clang）可能不可写
swiftc -O \
  -module-cache-path desktop/build/.module-cache \
  -o desktop/build/maoxuan-pet \
  desktop/maoxuan-pet.swift \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker desktop/Info.plist
cp desktop/pet.html desktop/build/pet.html

echo "built: desktop/build/maoxuan-pet"
echo "run:   ./desktop/build/maoxuan-pet [--origin=http://127.0.0.1:3081] [--token=…] [--reset] [--verbose]"
