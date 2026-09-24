#!/bin/bash
# Production start script for DigitalOcean App Platform.
#
# On every boot:
#   1. Run the idempotent seeder (default tenant, super-admin user,
#      building-type profiles + lexicons, default pricing row, retention
#      settings).
#   2. Launch the Python pdf-sidecar in the background on port 8008.
#   3. Exec the Node.js API server in the foreground on $PORT (default DO
#      health-check port 8080). It also serves the built web frontend.
#
# Schema is intentionally NOT pushed here. The managed prod DB carries legacy
# columns the current schema no longer defines (e.g. tenants.external_company_id,
# users.password_hash), and `drizzle-kit push` would DROP them. Schema changes
# are applied to prod additively by hand (ALTER TABLE ... ADD COLUMN IF NOT
# EXISTS). The seeder only depends on columns that already exist.
#
# Skip the seeder by setting SKIP_DB_BOOTSTRAP=1.

set -e

# Force production mode for every step below. The DB resolver in
# lib/db/src/index.ts only prefers DO_DATABASE_URL (the real managed-DB string)
# over DATABASE_URL when NODE_ENV=production; otherwise it can pick DO's broken
# placeholder DATABASE_URL (host "base"), breaking the seeder and login.
export NODE_ENV=production

if [ "${SKIP_DB_BOOTSTRAP:-0}" != "1" ]; then
  echo "[start-prod.sh] Running seeder…"
  node --enable-source-maps artifacts/api-server/dist/seed.mjs || {
    echo "[start-prod.sh] WARN: seed failed (continuing)."
  }
else
  echo "[start-prod.sh] SKIP_DB_BOOTSTRAP=1 — skipping seeder."
fi

# Start pdf-sidecar in the background on a fixed internal port
PORT=8008 python3 artifacts/pdf-sidecar/main.py &
SIDECAR_PID=$!
echo "[start-prod.sh] pdf-sidecar started (PID: $SIDECAR_PID) on 8008"

# Trap so the sidecar dies with the parent
trap "kill $SIDECAR_PID 2>/dev/null || true" EXIT

# Start the API server in the foreground (binds to $PORT, default DO health
# check port is 8080). PDF_SIDECAR_URL defaults to http://127.0.0.1:8008.
cd artifacts/api-server
exec node --enable-source-maps ./dist/index.mjs
