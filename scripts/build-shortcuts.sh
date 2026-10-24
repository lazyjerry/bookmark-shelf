#!/bin/bash
# 把 shortcuts/*.plist（XML 原始檔）轉成簽署過的 .shortcut，輸出到 build/shortcuts/。
# 只能在 Mac 上執行，且要登入 iCloud（shortcuts sign 的要求）。
#
# 用法：scripts/build-shortcuts.sh [--mode anyone|people-who-know-me] [--open]
#   --mode  簽署模式，預設 anyone（任何人都能匯入；Apple 會收到一份副本做驗證）
#   --open  簽完直接用「捷徑」App 開啟，跳出「加入捷徑」視窗
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/shortcuts"
OUT="$ROOT/build/shortcuts"
MODE=anyone
OPEN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --open) OPEN=1; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "不認得的參數：$1" >&2; exit 2 ;;
  esac
done

command -v shortcuts >/dev/null || { echo "找不到 shortcuts 指令，這支腳本只能在 macOS 12 以上執行" >&2; exit 1; }
mkdir -p "$OUT"

for plist in "$SRC"/*.plist; do
  name=$(basename "$plist" .plist)
  unsigned="$OUT/$name.unsigned.shortcut"
  signed="$OUT/$name.shortcut"
  plutil -lint "$plist" >/dev/null
  plutil -convert binary1 -o "$unsigned" "$plist"
  shortcuts sign --mode "$MODE" --input "$unsigned" --output "$signed"
  rm -f "$unsigned"
  echo "已簽署：build/shortcuts/$name.shortcut"
done

if [ "$OPEN" = 1 ]; then
  for signed in "$OUT"/*.shortcut; do open "$signed"; done
fi
