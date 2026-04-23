#!/usr/bin/env bash
# restart.sh — Clean restart of the Xpoz Pipeline server
#
# Usage:
#   ./scripts/restart.sh           # kill existing process, clear tsx cache, restart
#   ./scripts/restart.sh --clean   # also truncate all DB data before restart
#
# The server starts on port 8086 (localhost only).
# Logs go to /tmp/xpoz-server.log

set -euo pipefail

PIPELINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="/tmp/xpoz-server.log"
PORT=8086

echo "=== Xpoz Pipeline — Clean Restart ==="

# 1. Kill any existing process on port 8086
existing_pid=$(lsof -t -i:"$PORT" 2>/dev/null || true)
if [ -n "$existing_pid" ]; then
  echo "  Killing PID $existing_pid on port $PORT..."
  kill -9 "$existing_pid" 2>/dev/null || true
  sleep 1
fi

# 2. Clear tsx cache
if [ -d "/tmp/tsx-0" ]; then
  rm -rf /tmp/tsx-0
  echo "  tsx cache cleared"
fi

# 3. Optional: truncate DB
if [[ "${1:-}" == "--clean" ]]; then
  echo "  Truncating DB..."
  cd "$PIPELINE_DIR"
  npx tsx src/index.ts --clean
fi

# 4. Start server
echo "  Starting server (logs → $LOG_FILE)..."
cd "$PIPELINE_DIR"
nohup npx tsx src/index.ts --serve > "$LOG_FILE" 2>&1 &

new_pid=$!
echo "  PID: $new_pid"
sleep 2

# 5. Health check
if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null; then
  echo "  ✅ Server healthy on port $PORT"
else
  echo "  ❌ Health check failed — check $LOG_FILE"
  exit 1
fi

echo "=== Done ==="
