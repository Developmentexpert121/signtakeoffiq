#!/bin/bash
# Starts the API server, web frontend, and PDF Sidecar together.
# Safe to run even when the standalone "PDF Sidecar" workflow is already
# running — it checks port 8008 first and skips if already occupied.

set -e

# Start PDF Sidecar (Python/FastAPI on port 8008) — skip if already running
if curl -sf http://127.0.0.1:8008/ >/dev/null 2>&1; then
  echo "[start.sh] PDF Sidecar already running on port 8008 — skipping"
  SIDECAR_PID=""
else
  cd /home/runner/workspace/artifacts/pdf-sidecar
  uv pip install -q -r requirements.txt 2>/dev/null || true
  python3 main.py &
  SIDECAR_PID=$!
  echo "[start.sh] PDF Sidecar started (PID: $SIDECAR_PID)"
fi

# Start API server (Node.js/Express on configured PORT)
cd /home/runner/workspace/artifacts/api-server
pnpm run dev &
API_PID=$!

# Start web frontend (Vite on configured PORT)
cd /home/runner/workspace/artifacts/web
pnpm run dev &
WEB_PID=$!

echo "[start.sh] Services started:"
echo "  PDF Sidecar PID: ${SIDECAR_PID:-already running}"
echo "  API Server  PID: $API_PID"
echo "  Web         PID: $WEB_PID"

wait $API_PID $WEB_PID ${SIDECAR_PID:+$SIDECAR_PID} 2>/dev/null || true
