#!/usr/bin/env bash
set -euo pipefail

LABEL="com.xhuang.yt-explain-go"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
PROJECT_DIR="/Users/xhuang/work/workspace/yt-subtitle-ai-tools/yt-explain-go"
BIN="$PROJECT_DIR/yt-explain-go"
GUI_DOMAIN="gui/$(id -u)"

build_bin() {
  mkdir -p "$(dirname "$BIN")"
  cd "$PROJECT_DIR"
  /usr/local/go/bin/go build -o "$BIN" .
}

install_plist() {
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.xhuang.yt-explain-go</string>
    <key>ProgramArguments</key>
    <array>
      <string>/Users/xhuang/work/workspace/yt-subtitle-ai-tools/yt-explain-go/yt-explain-go</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/xhuang/work/openclaw/workspace</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PORT</key>
      <string>18794</string>
      <key>BASE_URL</key>
      <string>http://127.0.0.1:18794</string>
      <key>SESSION_KEY</key>
      <string>ext-transcript</string>
      <key>OPENCLAW_BIN</key>
      <string>/opt/homebrew/bin/openclaw</string>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/xhuang/Library/Logs/yt-explain-go.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/xhuang/Library/Logs/yt-explain-go.err.log</string>
  </dict>
</plist>
EOF
}

start_service() {
  launchctl print "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1 || launchctl bootstrap "$GUI_DOMAIN" "$PLIST"
  launchctl enable "$GUI_DOMAIN/$LABEL" || true
  launchctl kickstart -k "$GUI_DOMAIN/$LABEL"
}

stop_service() {
  launchctl bootout "$GUI_DOMAIN" "$PLIST" >/dev/null 2>&1 || launchctl bootout "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1 || true
}

status_service() {
  launchctl print "$GUI_DOMAIN/$LABEL" | sed -n '1,80p'
  echo
  curl -sS --max-time 3 http://127.0.0.1:18794/health || true
}

logs_service() {
  tail -n 80 "$HOME/Library/Logs/yt-explain-go.log" "$HOME/Library/Logs/yt-explain-go.err.log" 2>/dev/null || true
}

case "${1:-}" in
  install)
    build_bin
    install_plist
    start_service
    status_service
    ;;
  start)
    start_service
    status_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    build_bin
    start_service
    status_service
    ;;
  status)
    status_service
    ;;
  logs)
    logs_service
    ;;
  uninstall)
    stop_service
    rm -f "$PLIST"
    echo "Uninstalled $LABEL"
    ;;
  *)
    cat <<USAGE
Usage: ./service.sh {install|start|stop|restart|status|logs|uninstall}

install   Build binary + write LaunchAgent plist + start service
start     Start/kickstart service
stop      Stop service
restart   Rebuild binary + restart service
status    Show launchctl status + /health
logs      Tail helper logs
uninstall Stop service and remove plist
USAGE
    exit 1
    ;;
esac
