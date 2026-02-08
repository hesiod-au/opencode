#!/usr/bin/env bash
set -euo pipefail

BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-4096}"
FRONTEND_PORT="${FRONTEND_PORT:-8888}"

# Tunables
STARTUP_GRACE_SEC="${HEALTH_STARTUP_GRACE_SEC:-20}"
CHECK_INTERVAL_SEC="${HEALTH_CHECK_INTERVAL_SEC:-10}"
FAIL_THRESHOLD="${HEALTH_FAIL_THRESHOLD:-3}"

backend_url="http://${BACKEND_HOST}:${BACKEND_PORT}/"
frontend_url="http://${FRONTEND_HOST}:${FRONTEND_PORT}/"

log() {
  # systemd/journald will capture stdout
  printf '%s opencode-healthcheck: %s\n' "$(date -Is)" "$*"
}

check_url() {
  local url="$1"
  # -f: fail on non-2xx/3xx, -sS: quiet but show errors, --max-time: bound hang
  curl -fsS --max-time 3 "$url" >/dev/null
}

log "Starting opencode dev servers via dev.sh (backend=${backend_url} frontend=${frontend_url})"

/home/clawdbot/code/opencode/dev.sh &
child_pid=$!

log "dev.sh started (pid=${child_pid}); startup grace ${STARTUP_GRACE_SEC}s"
sleep "$STARTUP_GRACE_SEC"

fails=0

# Health supervision loop.
while true; do
  # If the child is gone, exit with its status.
  if ! kill -0 "$child_pid" 2>/dev/null; then
    wait "$child_pid" || exit_code=$? || true
    exit_code="${exit_code:-0}"
    log "dev.sh exited (pid=${child_pid}, code=${exit_code})"
    exit "$exit_code"
  fi

  if check_url "$backend_url" && check_url "$frontend_url"; then
    if [ "$fails" -gt 0 ]; then
      log "Health recovered (fails was ${fails})"
    fi
    fails=0
  else
    fails=$((fails + 1))
    log "Healthcheck failed (${fails}/${FAIL_THRESHOLD})"
    if [ "$fails" -ge "$FAIL_THRESHOLD" ]; then
      log "Unhealthy after ${FAIL_THRESHOLD} failures; terminating dev.sh (pid=${child_pid})"
      kill -TERM "$child_pid" 2>/dev/null || true
      sleep 2
      kill -KILL "$child_pid" 2>/dev/null || true
      # Exit non-zero so systemd restarts the unit.
      exit 1
    fi
  fi

  sleep "$CHECK_INTERVAL_SEC"
done
