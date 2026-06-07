#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

PORT="$(node --env-file-if-exists=apps/api/.env.local -p \
  'process.env.API_PORT || "4000"')"
PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"

if [ -n "$PIDS" ]; then
  echo "Stopping API server on port $PORT: $PIDS"
  kill $PIDS 2>/dev/null || true

  attempts=0
  while lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 20 ]; then
      echo "Port $PORT is still busy; forcing shutdown: $PIDS"
      kill -9 $PIDS 2>/dev/null || true
      break
    fi
    sleep 0.25
  done
fi

echo "Starting API server on port $PORT"
exec pnpm --filter @support-agent/api start:dev
