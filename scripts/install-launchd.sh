#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${PROJECT_DIR:-${SCRIPT_DIR:h}}"
DOMAIN="gui/$(id -u)"
AGENTS_DIR="$HOME/Library/LaunchAgents"

mkdir -p "$AGENTS_DIR" "$PROJECT_DIR/data"

write_plist() {
  local label="$1"
  local account="$2"
  local slot="$3"
  local hour="$4"
  local minute="$5"
  local jitter="$6"
  local stdout_path="$PROJECT_DIR/data/monitor.$slot.out.log"
  local stderr_path="$PROJECT_DIR/data/monitor.$slot.err.log"
  local plist="$AGENTS_DIR/$label.plist"

  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$PROJECT_DIR/scripts/run-monitor.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>MONITOR_ACCOUNT</key>
    <string>$account</string>
    <key>MONITOR_SLOT</key>
    <string>$slot</string>
    <key>MONITOR_JITTER_SECONDS</key>
    <string>$jitter</string>
    <key>MONITOR_SINCE_DAYS</key>
    <string>3</string>
    <key>MONITOR_MAX_VIDEOS</key>
    <string>2</string>
    <key>MONITOR_MAX_PROFILE_PAGES</key>
    <string>2</string>
    <key>MONITOR_MAX_COMMENT_PAGES</key>
    <string>3</string>
    <key>MONITOR_MAX_PROFILE_SCROLLS</key>
    <string>16</string>
    <key>MONITOR_MAX_COMMENT_SCROLLS</key>
    <string>4</string>
    <key>MONITOR_VIDEO_TIMEOUT_MS</key>
    <string>60000</string>
    <key>MONITOR_RUN_TIMEOUT_SECONDS</key>
    <string>1200</string>
    <key>MONITOR_ABBREVIATION_LIMIT</key>
    <string>80</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>$hour</integer>
    <key>Minute</key>
    <integer>$minute</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$stdout_path</string>
  <key>StandardErrorPath</key>
  <string>$stderr_path</string>
</dict>
</plist>
PLIST

  launchctl bootout "$DOMAIN" "$plist" 2>/dev/null || true
  launchctl enable "$DOMAIN/$label" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$plist"
  launchctl enable "$DOMAIN/$label"
  echo "installed=$plist account=$account slot=$slot scheduled=${hour}:${minute} jitter_seconds=$jitter"
  launchctl print "$DOMAIN/$label" >/dev/null
}

zsh "$PROJECT_DIR/scripts/pause-launchd.sh" >/dev/null || true

load_account_ids() {
  local accounts_path="${ACCOUNTS_PATH:-$PROJECT_DIR/config/accounts.json}"
  if [[ ! -f "$accounts_path" ]]; then
    echo "Missing accounts config: $accounts_path" >&2
    echo "Copy config/accounts.example.json to config/accounts.json and fill in your own creators first." >&2
    exit 1
  fi

  node -e '
    const fs = require("fs");
    const accounts = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(accounts)) throw new Error("accounts config must be an array");
    for (const account of accounts) {
      if (account && account.enabled !== false && account.account_id) {
        console.log(account.account_id);
      }
    }
  ' "$accounts_path"
}

ACCOUNT_IDS=("${(@f)$(load_account_ids)}")
if (( ${#ACCOUNT_IDS[@]} == 0 )); then
  echo "No enabled accounts found in config/accounts.json" >&2
  exit 1
fi

if (( ${#ACCOUNT_IDS[@]} >= 1 )); then
  write_plist "com.douyin.stock.signal.monitor.noon" "${ACCOUNT_IDS[1]}" "noon_close" 11 40 1200
fi
if (( ${#ACCOUNT_IDS[@]} >= 2 )); then
  write_plist "com.douyin.stock.signal.monitor.evening" "${ACCOUNT_IDS[2]}" "evening" 18 5 3300
fi
if (( ${#ACCOUNT_IDS[@]} >= 3 )); then
  write_plist "com.douyin.stock.signal.monitor.night" "${ACCOUNT_IDS[3]}" "night" 2 20 2400
fi

echo "status=loaded"
