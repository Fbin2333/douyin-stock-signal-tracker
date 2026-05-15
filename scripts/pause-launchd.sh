#!/bin/zsh
set -euo pipefail

LABELS=(
  "com.douyin.stock.signal.monitor"
  "com.douyin.stock.signal.monitor.noon"
  "com.douyin.stock.signal.monitor.evening"
  "com.douyin.stock.signal.monitor.night"
)
DOMAIN="gui/$(id -u)"
AGENTS_DIR="$HOME/Library/LaunchAgents"

for label in "${LABELS[@]}"; do
  plist="$AGENTS_DIR/$label.plist"
  launchctl bootout "$DOMAIN" "$plist" 2>/dev/null || true
  launchctl disable "$DOMAIN/$label" 2>/dev/null || true
done

echo "paused=${LABELS[*]}"
