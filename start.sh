#!/usr/bin/env bash
# 一键启动：本地服务 + 公网隧道，并把可扫码的大屏地址打印出来
set -uo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
SERVER_LOG=/tmp/danmaku-server.log
TUNNEL_LOG=/tmp/danmaku-tunnel.log
CF="$(command -v cloudflared || true)"
[ -z "$CF" ] && [ -x "$HOME/.local/bin/cloudflared" ] && CF="$HOME/.local/bin/cloudflared"

cleanup() {
  [ -f /tmp/danmaku-server.pid ] && kill "$(cat /tmp/danmaku-server.pid)" 2>/dev/null
  [ -f /tmp/danmaku-tunnel.pid ] && kill "$(cat /tmp/danmaku-tunnel.pid)" 2>/dev/null
  rm -f /tmp/danmaku-server.pid /tmp/danmaku-tunnel.pid
}
trap cleanup EXIT INT TERM

if curl -sf "http://localhost:${PORT}/api/info" >/dev/null 2>&1; then
  echo "服务已在 ${PORT} 端口运行，复用现有进程"
else
  echo "启动弹幕服务 ..."
  node server.js > "$SERVER_LOG" 2>&1 &
  echo $! > /tmp/danmaku-server.pid
  for _ in $(seq 1 30); do
    curl -sf "http://localhost:${PORT}/api/info" >/dev/null 2>&1 && break
    sleep 0.3
  done
fi

if [ -z "$CF" ]; then
  echo "未找到 cloudflared，无法建立公网隧道。"
  echo "安装：brew install cloudflared"
  echo "仅局域网使用：http://$(ipconfig getifaddr en0 2>/dev/null || echo 127.0.0.1):${PORT}"
  exit 1
fi

echo "建立公网隧道 ..."
: > "$TUNNEL_LOG"
"$CF" tunnel --url "http://localhost:${PORT}" --no-autoupdate --protocol http2 > "$TUNNEL_LOG" 2>&1 &
echo $! > /tmp/danmaku-tunnel.pid

URL=""
for _ in $(seq 1 60); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
  [ -n "$URL" ] && break
  sleep 0.5
done

echo
if [ -n "$URL" ]; then
  echo "  大屏打开   ${URL}"
  echo "  手机扫码   二维码就在大屏右侧，自动指向 ${URL}/send"
  if [ -f .admin-key ]; then
    echo "  管理台     ${URL}/admin?key=$(cat .admin-key)"
  fi
else
  echo "  隧道没起来，详情看 ${TUNNEL_LOG}"
  exit 1
fi
echo
echo "  保持本窗口开着；按 Ctrl+C 同时关闭服务和隧道。"
echo

wait
