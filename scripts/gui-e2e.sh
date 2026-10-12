#!/usr/bin/env bash
# Runs the browser end-to-end test against a fresh server and database.
# Requires: Go, Node, a PostgreSQL superuser URL in CURRENT_TEST_PG_URL, and
# Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CURRENT_TEST_PG_URL:?set CURRENT_TEST_PG_URL to a PostgreSQL superuser URL}"
work=$(mktemp -d)
trap 'kill ${server_pid:-0} 2>/dev/null || true; rm -rf "$work"' EXIT

(cd web && npm run build >/dev/null)
go build -o "$work/current-server" ./cmd/current-server
go build -o "$work/current-agent" ./cmd/current-agent

db="cur_gui_$(date +%s)"
psql "$CURRENT_TEST_PG_URL" -qc "CREATE DATABASE $db"
dburl=$(python3 -c "import sys,urllib.parse as u;p=u.urlsplit(sys.argv[1]);print(u.urlunsplit(p._replace(path='/'+sys.argv[2])))" "$CURRENT_TEST_PG_URL" "$db")

CURRENT_DEV_MODE=true CURRENT_PUBLIC_URL=http://localhost:18080 CURRENT_HTTP_ADDR=127.0.0.1:18080 \
CURRENT_GATEWAY_ADDR=127.0.0.1:18443 CURRENT_GATEWAY_PUBLIC_ADDR=localhost:18443 CURRENT_GATEWAY_SANS=127.0.0.1 \
CURRENT_CONTENT_DIR="$work/content" CURRENT_DATABASE_URL="$dburl" CURRENT_MASTER_KEY=$(openssl rand -hex 32) CURRENT_HEARTBEAT_INTERVAL=5s CURRENT_WINGET_SOURCE=off \
  "$work/current-server" serve >"$work/server.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 50); do grep -q "setup token" "$work/server.log" 2>/dev/null && break; sleep 0.2; done
token=$(grep -A2 "enter this one-time setup token" "$work/server.log" | tail -1 | tr -d ' ')
if ! kill -0 "$server_pid" 2>/dev/null || [ -z "$token" ]; then
  echo "server failed to start (is port 18080/18443 in use?)"; cat "$work/server.log"; exit 1
fi

cd web
CURRENT_SETUP_TOKEN="$token" CURRENT_AGENT_BIN="$work/current-agent" CURRENT_GATEWAY=127.0.0.1:18443 \
  npx playwright test "$@" || { echo "--- server log ---"; tail -50 "$work/server.log"; exit 1; }
