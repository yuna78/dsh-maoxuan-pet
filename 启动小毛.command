#!/bin/bash
# 双击这个文件 = 让小毛站到桌面上（独立窗口，可以拖到 DSH 窗口外面）。
# 不用记命令、不用 token：自动连最近启动的那个 DSH 实例，走插件自己的公开路由。
# 关掉她：右键小毛 → 退出小毛。
set -u
cd "$(dirname "$0")" || exit 1

BIN="./desktop/build/maoxuan-pet"
if [ ! -x "$BIN" ]; then
  echo "第一次运行，先编译桌宠壳（几秒钟）…"
  bash desktop/build.sh || { echo "编译失败，把上面的报错发给 Yuna"; read -r -p "按回车关闭"; exit 1; }
fi

# 只留一只：重复双击时先送走旧的
pkill -f "desktop/build/maoxuan-pet" 2>/dev/null || true
sleep 0.3

# 自动发现当前 DSH：插件把 origin 写在 ~/.dsh/agent-tree-dock-<port>.json，取最新的一个
DOCK="$(ls -t "$HOME"/.dsh/agent-tree-dock-*.json 2>/dev/null | head -1 || true)"
ORIGIN=""
if [ -n "${DOCK:-}" ]; then
  ORIGIN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("origin",""))' "$DOCK" 2>/dev/null || true)"
fi
if [ -z "${ORIGIN:-}" ]; then
  ORIGIN="http://127.0.0.1:3081"
  echo "没找到运行中的 DSH 记录，按默认地址试：$ORIGIN"
fi

nohup "$BIN" --origin="$ORIGIN" --public >/tmp/maoxuan-pet.log 2>&1 &
sleep 1.2

if pgrep -f "desktop/build/maoxuan-pet" >/dev/null 2>&1; then
  echo "小毛已站上桌面 ✓  连着：$ORIGIN"
  echo "拖她到哪都行；右键她 = 复位位置 / 退出。这个终端窗口可以直接关掉。"
else
  echo "启动失败，最后的日志："
  tail -5 /tmp/maoxuan-pet.log
  read -r -p "按回车关闭"
fi
