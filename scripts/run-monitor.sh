#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${PROJECT_DIR:-${SCRIPT_DIR:h}}"
DATA_DIR="$PROJECT_DIR/data"
LOCK_DIR="$DATA_DIR/monitor.lock"

mkdir -p "$DATA_DIR"

MONITOR_ACCOUNT="${MONITOR_ACCOUNT:-all}"
MONITOR_SLOT="${MONITOR_SLOT:-manual}"
MONITOR_JITTER_SECONDS="${MONITOR_JITTER_SECONDS:-0}"
MONITOR_RUN_TIMEOUT_SECONDS="${MONITOR_RUN_TIMEOUT_SECONDS:-1200}"
MONITOR_STALE_LOCK_SECONDS="${MONITOR_STALE_LOCK_SECONDS:-$((MONITOR_RUN_TIMEOUT_SECONDS + 300))}"
MONITOR_KILL_GRACE_SECONDS="${MONITOR_KILL_GRACE_SECONDS:-15}"
RUN_PID=""

record_failure() {
  local reason="$1"
  local detail="${2:-}"
  (cd "$PROJECT_DIR" && node ./bin/record-monitor-failure.mjs "$reason" "$detail") || true
}

process_elapsed_seconds() {
  local pid="$1"
  local etime
  local days=0
  local clock
  local -a parts
  etime="$(ps -p "$pid" -o etime= 2>/dev/null | tr -d ' ' || true)"
  [[ -z "$etime" ]] && return 0
  if [[ "$etime" == *-* ]]; then
    days="${etime%%-*}"
    clock="${etime#*-}"
  else
    clock="$etime"
  fi
  parts=("${(@s/:/)clock}")
  if (( ${#parts[@]} == 3 )); then
    echo $(( days * 86400 + parts[1] * 3600 + parts[2] * 60 + parts[3] ))
  elif (( ${#parts[@]} == 2 )); then
    echo $(( days * 86400 + parts[1] * 60 + parts[2] ))
  elif (( ${#parts[@]} == 1 )); then
    echo $(( days * 86400 + parts[1] ))
  fi
}

kill_tree() {
  local pid="$1"
  local signal="${2:-TERM}"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child" "$signal"
  done
  kill "-$signal" "$pid" 2>/dev/null || true
}

if (( MONITOR_JITTER_SECONDS > 0 )); then
  JITTER_SLEEP="$(( RANDOM % (MONITOR_JITTER_SECONDS + 1) ))"
  echo "{\"jitter_sleep_seconds\":$JITTER_SLEEP,\"slot\":\"$MONITOR_SLOT\",\"account\":\"$MONITOR_ACCOUNT\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
  sleep "$JITTER_SLEEP"
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if [[ -f "$LOCK_DIR/pid" ]]; then
    LOCK_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
      LOCK_ELAPSED="$(process_elapsed_seconds "$LOCK_PID")"
      if [[ -n "$LOCK_ELAPSED" ]] && (( LOCK_ELAPSED > MONITOR_STALE_LOCK_SECONDS )); then
        echo "{\"stale_lock\":\"killing_monitor\",\"pid\":$LOCK_PID,\"elapsed_seconds\":$LOCK_ELAPSED,\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
        kill_tree "$LOCK_PID" TERM
        sleep "$MONITOR_KILL_GRACE_SECONDS"
        if kill -0 "$LOCK_PID" 2>/dev/null; then
          kill_tree "$LOCK_PID" KILL
        fi
        record_failure "monitor_stale_lock_recovered" "pid=$LOCK_PID elapsed_seconds=$LOCK_ELAPSED"
      else
        echo "{\"skipped\":\"monitor_already_running\",\"pid\":$LOCK_PID,\"elapsed_seconds\":${LOCK_ELAPSED:-null},\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
        exit 0
      fi
    fi
  fi
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || true
  mkdir "$LOCK_DIR"
fi

if [[ ! -d "$LOCK_DIR" ]]; then
  echo "{\"skipped\":\"monitor_already_running\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
  exit 0
fi
echo "$$" > "$LOCK_DIR/pid"

cleanup() {
  if [[ -n "$RUN_PID" ]] && kill -0 "$RUN_PID" 2>/dev/null; then
    kill_tree "$RUN_PID" TERM
  fi
  rm -f "$LOCK_DIR/pid" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd "$PROJECT_DIR"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if [[ -n "${MONITOR_SINCE_DATE+x}" ]]; then
  MONITOR_SINCE_DATE_EXPLICIT="1"
else
  MONITOR_SINCE_DATE_EXPLICIT="0"
fi
MONITOR_SINCE_DAYS="${MONITOR_SINCE_DAYS:-3}"
MONITOR_MAX_VIDEOS="${MONITOR_MAX_VIDEOS:-2}"
MONITOR_MAX_PROFILE_PAGES="${MONITOR_MAX_PROFILE_PAGES:-2}"
MONITOR_MAX_COMMENT_PAGES="${MONITOR_MAX_COMMENT_PAGES:-3}"
MONITOR_MAX_PROFILE_SCROLLS="${MONITOR_MAX_PROFILE_SCROLLS:-16}"
MONITOR_MAX_COMMENT_SCROLLS="${MONITOR_MAX_COMMENT_SCROLLS:-4}"
MONITOR_ABBREVIATION_LIMIT="${MONITOR_ABBREVIATION_LIMIT:-0}"
MONITOR_VIDEO_TIMEOUT_MS="${MONITOR_VIDEO_TIMEOUT_MS:-60000}"
MONITOR_PROBE_ONLY="${MONITOR_PROBE_ONLY:-0}"

if [[ "${MONITOR_ADAPTIVE_ENABLED:-1}" != "0" ]]; then
  eval "$(node ./bin/monitor-adaptive.mjs env "$MONITOR_ACCOUNT" "$MONITOR_SLOT")"
  echo "{\"adaptive_profile\":\"$MONITOR_ADAPTIVE_PROFILE\",\"slot\":\"$MONITOR_SLOT\",\"account\":\"$MONITOR_ACCOUNT\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
fi

if [[ "$MONITOR_SINCE_DATE_EXPLICIT" != "1" ]]; then
  MONITOR_SINCE_DATE="$(TZ=Asia/Shanghai date -v-"$MONITOR_SINCE_DAYS"d +%F)"
fi

MONITOR_ARGS=(
  -- --account "$MONITOR_ACCOUNT" --headless --no-replies --since "$MONITOR_SINCE_DATE"
  --max-profile-pages "$MONITOR_MAX_PROFILE_PAGES"
  --max-comment-pages "$MONITOR_MAX_COMMENT_PAGES"
  --max-profile-scrolls "$MONITOR_MAX_PROFILE_SCROLLS"
  --max-comment-scrolls "$MONITOR_MAX_COMMENT_SCROLLS"
  --video-timeout-ms "$MONITOR_VIDEO_TIMEOUT_MS"
)
if [[ "$MONITOR_MAX_VIDEOS" != "0" ]]; then
  MONITOR_ARGS+=(--max-videos "$MONITOR_MAX_VIDEOS")
fi
if [[ "$MONITOR_ABBREVIATION_LIMIT" != "0" ]]; then
  MONITOR_ARGS+=(--abbreviation-limit "$MONITOR_ABBREVIATION_LIMIT")
fi
if [[ "$MONITOR_PROBE_ONLY" != "0" ]]; then
  MONITOR_ARGS+=(--probe)
fi

npm run monitor "${MONITOR_ARGS[@]}" &
RUN_PID="$!"
RUN_STARTED_AT="$(date +%s)"

while kill -0 "$RUN_PID" 2>/dev/null; do
  NOW="$(date +%s)"
  ELAPSED="$((NOW - RUN_STARTED_AT))"
  if (( ELAPSED > MONITOR_RUN_TIMEOUT_SECONDS )); then
    echo "{\"timeout\":\"killing_monitor\",\"pid\":$RUN_PID,\"elapsed_seconds\":$ELAPSED,\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
    kill_tree "$RUN_PID" TERM
    sleep "$MONITOR_KILL_GRACE_SECONDS"
    if kill -0 "$RUN_PID" 2>/dev/null; then
      kill_tree "$RUN_PID" KILL
    fi
    record_failure "monitor_timeout" "pid=$RUN_PID elapsed_seconds=$ELAPSED timeout_seconds=$MONITOR_RUN_TIMEOUT_SECONDS"
    node ./bin/notify-monitor.mjs "monitor_timeout" "account=$MONITOR_ACCOUNT slot=$MONITOR_SLOT elapsed_seconds=$ELAPSED; monitor paused to avoid repeated Douyin comment request pressure" || true
    zsh "$PROJECT_DIR/scripts/pause-launchd.sh" || true
    wait "$RUN_PID" 2>/dev/null || true
    RUN_PID=""
    exit 124
  fi
  sleep 5
done

set +e
wait "$RUN_PID"
STATUS="$?"
set -e
RUN_PID=""

if (( STATUS != 0 )); then
  if (( STATUS == 86 )); then
    node ./bin/monitor-adaptive.mjs pause "$MONITOR_ACCOUNT" "$MONITOR_SLOT" "exit_status=86" || true
    zsh "$PROJECT_DIR/scripts/pause-launchd.sh" || true
    exit "$STATUS"
  fi
  record_failure "monitor_failed" "exit_status=$STATUS"
  exit "$STATUS"
fi

node ./bin/monitor-adaptive.mjs success "$MONITOR_ACCOUNT" "$MONITOR_SLOT" || true
