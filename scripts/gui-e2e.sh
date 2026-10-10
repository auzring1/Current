#!/usr/bin/env bash
# Runs the browser end-to-end test against a fresh server and database.
# Requires: Go, Node, a PostgreSQL superuser URL in RENOVATIO_TEST_PG_URL, and
# Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${RENOVATIO_TEST_PG_URL:?set RENOVATIO_TEST_PG_URL to a PostgreSQL superuser URL}"
work=$(mktemp -d)
trap 'kill ${server_pid:-0} 2>/dev/null || true; rm -rf "$work"' EXIT

(cd web && npm run build >/dev/null)
go build -o "$work/renovatio-server" ./cmd/renovatio-server
go build -o "$work/renovatio-agent" ./cmd/renovatio-agent

db="rnv_gui_$(date +%s)"
psql "$RENOVATIO_TEST_PG_URL" -qc "CREATE DATABASE $db"
dburl=$(python3 -c "import sys,urllib.parse as u;p=u.urlsplit(sys.argv[1]);print(u.urlunsplit(p._replace(path='/'+sys.argv[2])))" "$RENOVATIO_TEST_PG_URL" "$db")

RENOVATIO_DEV_MODE=true RENOVATIO_PUBLIC_URL=http://localhost:18080 RENOVATIO_HTTP_ADDR=127.0.0.1:18080 \
RENOVATIO_GATEWAY_ADDR=127.0.0.1:18443 RENOVATIO_GATEWAY_PUBLIC_ADDR=localhost:18443 RENOVATIO_GATEWAY_SANS=127.0.0.1 \
RENOVATIO_CONTENT_DIR="$work/content" RENOVATIO_DATABASE_URL="$dburl" RENOVATIO_MASTER_KEY=$(openssl rand -hex 32) RENOVATIO_HEARTBEAT_INTERVAL=5s \
  "$work/renovatio-server" serve >"$work/server.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 50); do grep -q "setup token" "$work/server.log" 2>/dev/null && break; sleep 0.2; done
token=$(grep -A2 "enter this one-time setup token" "$work/server.log" | tail -1 | tr -d ' ')
if ! kill -0 "$server_pid" 2>/dev/null || [ -z "$token" ]; then
  echo "server failed to start (is port 18080/18443 in use?)"; cat "$work/server.log"; exit 1
fi

cd web
RENOVATIO_SETUP_TOKEN="$token" RENOVATIO_AGENT_BIN="$work/renovatio-agent" RENOVATIO_GATEWAY=127.0.0.1:18443 \
  npx playwright test "$@" || { echo "--- server log ---"; tail -50 "$work/server.log"; exit 1; }
