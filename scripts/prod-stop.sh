#!/usr/bin/env bash
# Stops everything prod-start.sh launched, using the PIDs saved in .run/prod.pids.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/.run/prod.pids"

if [[ ! -s "$PID_FILE" ]]; then
  echo "Nothing to stop (no $PID_FILE)."
  exit 0
fi

while read -r name pid; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "$name ($pid) was not running."
    continue
  fi
  # Signal the whole process group so children (e.g. spawned workers) go too.
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid"
  for _ in {1..20}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid"
    echo "$name ($pid) force-killed."
  else
    echo "$name ($pid) stopped."
  fi
done <"$PID_FILE"

rm -f "$PID_FILE"
