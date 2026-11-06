#!/usr/bin/env bash
# Builds the web app and starts the daemon + a static web server in the background,
# production-style. PIDs go to .run/prod.pids (read by prod-stop.sh), logs to .run/*.log.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="$ROOT/.run"
PID_FILE="$RUN_DIR/prod.pids"
SERVER_PORT="${PORT:-4500}"
WEB_PORT="${WEB_PORT:-4173}"

if [[ -s "$PID_FILE" ]]; then
  echo "Already started (found $PID_FILE). Run 'npm run prod:stop' first." >&2
  exit 1
fi

# The storage worker imports better-sqlite3; without it every Building create fails with a 503.
if [[ ! -d "$ROOT/server/node_modules/better-sqlite3" ]]; then
  echo "Server dependencies are not installed (better-sqlite3 is missing). Run 'npm run install:all' first." >&2
  exit 1
fi

for port in "$SERVER_PORT" "$WEB_PORT"; do
  if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use." >&2
    exit 1
  fi
done

mkdir -p "$RUN_DIR"

echo "Building web (VITE_SERVER_URL=http://localhost:$SERVER_PORT)..."
VITE_SERVER_URL="http://localhost:$SERVER_PORT" npm run build --prefix "$ROOT/web" >"$RUN_DIR/build.log" 2>&1 \
  || { echo "Web build failed, see $RUN_DIR/build.log" >&2; exit 1; }

# Job control puts each background job in its own process group (pgid == pid),
# so prod-stop.sh can take down a process together with anything it spawned.
set -m

(cd "$ROOT/server" && NODE_ENV=production PORT="$SERVER_PORT" exec node src/index.ts) </dev/null \
  >>"$RUN_DIR/server.log" 2>&1 &
echo "server $!" >"$PID_FILE"

(cd "$ROOT/web" && exec ./node_modules/.bin/vite preview --port "$WEB_PORT" --strictPort) </dev/null \
  >>"$RUN_DIR/web.log" 2>&1 &
echo "web $!" >>"$PID_FILE"

sleep 2
while read -r name pid; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "$name exited right after starting, see $RUN_DIR/$name.log" >&2
    "$ROOT/scripts/prod-stop.sh"
    exit 1
  fi
done <"$PID_FILE"

echo "Server: http://localhost:$SERVER_PORT  (log: .run/server.log)"
echo "Web:    http://localhost:$WEB_PORT  (log: .run/web.log)"
echo "Stop with: npm run prod:stop"
