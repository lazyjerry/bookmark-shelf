#!/bin/sh
# 互動式更換登入密碼：以 wrangler secret put AUTH_PASS 寫進已部署的 Worker，舊密碼立即失效。
# 需先 npx wrangler login。帳號（AUTH_USER）在 wrangler.jsonc 的 vars，要改帳號直接改那裡再部署。
#
# 用法：sh scripts/change-password.sh
set -eu

MIN_LENGTH=8

cd "$(dirname "$0")/.."

fail() {
  printf '錯誤：%s\n' "$1" >&2
  exit 1
}

[ -t 0 ] || fail '請在終端機執行，這支腳本需要互動輸入'
command -v npx >/dev/null 2>&1 || fail '找不到 npx，請先安裝 Node.js'
[ -f wrangler.jsonc ] || fail '找不到 wrangler.jsonc'

# 輸入密碼時關掉回顯；中途按 Ctrl+C 也要恢復，否則終端機之後打字都看不到
trap 'stty echo 2>/dev/null; printf "\n" >&2; exit 130' INT TERM

# 讀一行不回顯的輸入，結果放在 secret
read_secret() {
  printf '%s' "$1" >&2
  stty -echo
  IFS= read -r secret || secret=''
  stty echo
  printf '\n' >&2
}

worker=$(sed -n 's/^[[:space:]]*"name":[[:space:]]*"\([^"]*\)".*/\1/p' wrangler.jsonc | head -n 1)
printf '更換 Worker「%s」的登入密碼（AUTH_PASS）\n\n' "$worker"
printf '  1) 自行輸入新密碼\n'
printf '  2) 自動產生隨機密碼\n'
printf '請選擇 [1/2]（預設 1）：'
IFS= read -r choice || choice=''

case "$choice" in
  1 | '')
    read_secret "新密碼（至少 $MIN_LENGTH 個字元）："
    pass=$secret
    [ "${#pass}" -ge "$MIN_LENGTH" ] || fail "密碼至少 $MIN_LENGTH 個字元"
    read_secret '再輸入一次：'
    [ "$secret" = "$pass" ] || fail '兩次輸入的密碼不一致'
    generated=0
    ;;
  2)
    command -v openssl >/dev/null 2>&1 || fail '找不到 openssl，請改選 1 自行輸入'
    pass=$(openssl rand -base64 24)
    generated=1
    ;;
  *)
    fail '請輸入 1 或 2'
    ;;
esac

printf '\n即將更新線上的 AUTH_PASS，舊密碼立即失效。確定要更新？[y/N]：'
IFS= read -r answer || answer=''
case "$answer" in
  y | Y | yes | YES) ;;
  *)
    printf '已取消，沒有變更。\n'
    exit 0
    ;;
esac

# 密碼走 stdin 交給 wrangler，不出現在指令參數與 shell 歷史裡
if ! printf '%s' "$pass" | npx wrangler secret put AUTH_PASS; then
  fail 'wrangler secret put 失敗，密碼沒有變更。確認已 npx wrangler login，且 Worker 已部署'
fi

printf '\n已更新登入密碼。\n'
if [ "$generated" = 1 ]; then
  printf '新密碼只顯示這一次，請存進密碼管理器：\n\n  %s\n\n' "$pass"
fi
printf '已登入的瀏覽器與 App 不會被登出，要的話到設定頁「登入方式」按「登出其他裝置」。\n'
printf '本機開發用的 .dev.vars 不會跟著改；要同步時把值用雙引號包起來，否則 # 之後會被當成註解截斷。\n'
