#!/usr/bin/env bash
# Runs the browser end-to-end test against a fresh server and database.
# Requires: Go, Node, a PostgreSQL superuser URL in AUZ_TEST_PG_URL, and
# Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${AUZ_TEST_PG_URL:?set AUZ_TEST_PG_URL to a PostgreSQL superuser URL}"
work=$(mktemp -d)
trap 'kill ${server_pid:-0} 2>/dev/null || true; rm -rf "$work"' EXIT

(cd web && npm run build >/dev/null)
go build -o "$work/auzring-server" ./cmd/auzring-server
go build -o "$work/auzring-agent" ./cmd/auzring-agent

db="auz_gui_$(date +%s)"
psql "$AUZ_TEST_PG_URL" -qc "CREATE DATABASE $db"
dburl=$(python3 -c "import sys,urllib.parse as u;p=u.urlsplit(sys.argv[1]);print(u.urlunsplit(p._replace(path='/'+sys.argv[2])))" "$AUZ_TEST_PG_URL" "$db")

AUZ_DEV_MODE=true AUZ_PUBLIC_URL=http://localhost:18080 AUZ_HTTP_ADDR=127.0.0.1:18080 \
AUZ_GATEWAY_ADDR=127.0.0.1:18443 AUZ_GATEWAY_PUBLIC_ADDR=localhost:18443 AUZ_GATEWAY_SANS=127.0.0.1 \
AUZ_DATABASE_URL="$dburl" AUZ_MASTER_KEY=$(openssl rand -hex 32) AUZ_HEARTBEAT_INTERVAL=5s \
  "$work/auzring-server" serve >"$work/server.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 50); do grep -q "setup token" "$work/server.log" 2>/dev/null && break; sleep 0.2; done
token=$(grep -A2 "enter this one-time setup token" "$work/server.log" | tail -1 | tr -d ' ')
if ! kill -0 "$server_pid" 2>/dev/null || [ -z "$token" ]; then
  echo "server failed to start (is port 18080/18443 in use?)"; cat "$work/server.log"; exit 1
fi

cd web
AUZ_SETUP_TOKEN="$token" AUZ_AGENT_BIN="$work/auzring-agent" AUZ_GATEWAY=127.0.0.1:18443 \
  npx playwright test "$@" || { echo "--- server log ---"; tail -50 "$work/server.log"; exit 1; }
