#!/usr/bin/env bash
# Runs the Auzring load scenarios (docs/LOADTEST.md) with cmd/auzring-loadsim.
#
# Local mode (default): builds the server, the load generator and the bootstrap tool, creates a
# fresh database on the PostgreSQL named by AUZ_TEST_PG_URL (a superuser URL), starts the server
# binary, completes first-run setup through the REST API, runs the scenarios and writes
#   <out>/<scenario>.json, <out>/<scenario>.md, <out>/summary.md, <out>/server.log
# Nothing from <out> is ever committed (loadtest-results/ is git-ignored); it holds device
# private keys (the identity cache) and an API token, so keep it private.
#
# External mode (--external): points at a server you already run (for example docker compose
# on another host). Needs
#   LOADTEST_API=https://auzring.example.com   REST base URL
#   LOADTEST_API_TOKEN=...                     API token with enrollment:write, devices:read,
#                                              devices:write, updates:write, reports:read
#   LOADTEST_GATEWAY=agents.example.com:8443   gateway address as in its certificate
# The enrollment rate limits of that server must allow the fleet (AUZ_ENROLL_RATE_PER_IP and
# AUZ_ENROLL_RATE_PER_TOKEN), or enrollment takes about agents/10 minutes.
#
# Usage: scripts/loadtest.sh [--agents N] [--scenarios "steady storm churn"] [--duration 2m]
#          [--ramp-per-sec N] [--storm-mode client|server-restart] [--jobs-fraction F]
#          [--heartbeat 30s] [--inventory-size N] [--inventory-change-every 1m] [--out DIR]
#          [--external] [--ports 18080:18443]
set -euo pipefail
cd "$(dirname "$0")/.."

AGENTS=1000
SCENARIOS="steady storm"
DURATION=2m
RAMP=100
STORM_MODE=client
JOBS_FRACTION=0.02
HEARTBEAT=30s
INV_SIZE=120
INV_CHANGE=1m
OUT=""
EXTERNAL=0
HTTP_PORT=18080
GW_PORT=18443
LOG_LEVEL=${LOADTEST_LOG_LEVEL:-info}

while [ $# -gt 0 ]; do
  case "$1" in
    --agents) AGENTS=$2; shift 2 ;;
    --scenarios) SCENARIOS=$2; shift 2 ;;
    --duration) DURATION=$2; shift 2 ;;
    --ramp-per-sec) RAMP=$2; shift 2 ;;
    --storm-mode) STORM_MODE=$2; shift 2 ;;
    --jobs-fraction) JOBS_FRACTION=$2; shift 2 ;;
    --heartbeat) HEARTBEAT=$2; shift 2 ;;
    --inventory-size) INV_SIZE=$2; shift 2 ;;
    --inventory-change-every) INV_CHANGE=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --external) EXTERNAL=1; shift ;;
    --ports) HTTP_PORT=${2%%:*}; GW_PORT=${2##*:}; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' | head -n -1; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

OUT=${OUT:-loadtest-results/$(date +%Y%m%d-%H%M%S)}
mkdir -p "$OUT/bin"
chmod 700 "$OUT"
OUT=$(cd "$OUT" && pwd)

# File descriptors: every simulated agent is one socket in the load generator, and every connection one
# socket in the server. Both processes started here inherit this limit.
hard=$(ulimit -Hn)
if [ "$hard" != "unlimited" ]; then ulimit -n "$hard" || true; fi
have=$(ulimit -n)
if [ "$have" != "unlimited" ] && [ "$have" -lt $((AGENTS + 500)) ]; then
  echo "WARNING: open-file limit is $have; $AGENTS agents need about $((AGENTS + 500)) per process (docs/LOADTEST.md section 'Tuning')." >&2
fi

echo "== building"
CGO_ENABLED=0 go build -trimpath -o "$OUT/bin/auzring-loadsim" ./cmd/auzring-loadsim
server_pid=""
cleanup() {
  [ -n "${server_pid:-}" ] && kill "$server_pid" 2>/dev/null || true
  [ -n "${dbname:-}" ] && [ -n "${AUZ_TEST_PG_URL:-}" ] && psql "$AUZ_TEST_PG_URL" -qc "DROP DATABASE IF EXISTS $dbname WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

start_server() {
  (
    export AUZ_DEV_MODE=true AUZ_PUBLIC_URL="http://localhost:$HTTP_PORT" AUZ_HTTP_ADDR="127.0.0.1:$HTTP_PORT"
    export AUZ_GATEWAY_ADDR="127.0.0.1:$GW_PORT" AUZ_GATEWAY_PUBLIC_ADDR="localhost:$GW_PORT" AUZ_GATEWAY_SANS=127.0.0.1
    export AUZ_CONTENT_DIR="$OUT/content" AUZ_DATABASE_URL="$dburl" AUZ_MASTER_KEY="$(cat "$OUT/master_key")"
    export AUZ_WINGET_SOURCE=off AUZ_LOG_LEVEL="$LOG_LEVEL"
    # Enrollment limits are raised for the test: one machine enrolls the whole fleet from one address.
    export AUZ_ENROLL_RATE_PER_IP=1000000 AUZ_ENROLL_RATE_PER_TOKEN=1000000
    exec "$OUT/bin/auzring-server" serve >>"$OUT/server.log" 2>&1
  ) &
  server_pid=$!
}

if [ "$EXTERNAL" = 1 ]; then
  : "${LOADTEST_API:?set LOADTEST_API}" "${LOADTEST_API_TOKEN:?set LOADTEST_API_TOKEN}" "${LOADTEST_GATEWAY:?set LOADTEST_GATEWAY}"
  api=$LOADTEST_API; gateway=$LOADTEST_GATEWAY
  export AUZ_LOADSIM_API_TOKEN=$LOADTEST_API_TOKEN
  [ "$STORM_MODE" = client ] || { echo "server-restart storms need local mode" >&2; exit 2; }
  pgflag=(); pidflag=()
else
  : "${AUZ_TEST_PG_URL:?set AUZ_TEST_PG_URL to a PostgreSQL superuser URL}"
  CGO_ENABLED=0 go build -trimpath -o "$OUT/bin/auzring-server" ./cmd/auzring-server
  CGO_ENABLED=0 go build -trimpath -o "$OUT/bin/bootstrap" ./test/tools/bootstrap
  dbname="auz_load_$(date +%s)"
  psql "$AUZ_TEST_PG_URL" -qc "CREATE DATABASE $dbname"
  dburl=$(python3 -c "import sys,urllib.parse as u;p=u.urlsplit(sys.argv[1]);print(u.urlunsplit(p._replace(path='/'+sys.argv[2])))" "$AUZ_TEST_PG_URL" "$dbname")
  (umask 077; openssl rand -hex 32 >"$OUT/master_key")
  echo "== starting the server (database $dbname, http :$HTTP_PORT, gateway :$GW_PORT)"
  start_server
  for _ in $(seq 1 100); do grep -q "setup token" "$OUT/server.log" 2>/dev/null && break; sleep 0.2; done
  token=$(grep -A2 "enter this one-time setup token" "$OUT/server.log" | tail -1 | tr -d ' ')
  if ! kill -0 "$server_pid" 2>/dev/null || [ -z "$token" ]; then echo "server failed to start"; cat "$OUT/server.log"; exit 1; fi
  "$OUT/bin/bootstrap" -url "http://localhost:$HTTP_PORT" -setup-token "$token" -max-uses 100000 \
    -api-token-out "$OUT/api_token" >"$OUT/enrollment_string" 2>"$OUT/bootstrap.log" || { cat "$OUT/bootstrap.log"; exit 1; }
  chmod 600 "$OUT/api_token" "$OUT/enrollment_string"
  api="http://localhost:$HTTP_PORT"; gateway="127.0.0.1:$GW_PORT"
  AUZ_LOADSIM_API_TOKEN=$(cat "$OUT/api_token"); export AUZ_LOADSIM_API_TOKEN
  pgflag=(--pg-url "$dburl")
  pidflag=(--server-pid "$server_pid")
  [ "$STORM_MODE" = server-restart ] && pidflag=()
fi

{
  echo "# Load test $(basename "$OUT")"
  echo
  echo "- commit: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)$(git diff --quiet 2>/dev/null || echo ' (dirty)')"
  echo "- host: $(nproc) CPUs, $(awk '/MemTotal/{printf "%.1f GiB", $2/1048576}' /proc/meminfo) RAM, $(uname -sr)"
  echo "- open-file limit: $(ulimit -n); ephemeral ports: $(cat /proc/sys/net/ipv4/ip_local_port_range 2>/dev/null | tr '\t' '-')"
  echo "- go: $(go version)"
  echo "- agents: $AGENTS, ramp $RAMP/s, hold $DURATION, heartbeat $HEARTBEAT, inventory $INV_SIZE items, change every $INV_CHANGE, jobs fraction $JOBS_FRACTION"
  echo "- mode: $([ "$EXTERNAL" = 1 ] && echo external || echo 'local server binary, load generator on the same host')"
  echo
} >"$OUT/summary.md"

status=0
for sc in $SCENARIOS; do
  echo "== scenario $sc ($AGENTS agents)"
  args=(--api "$api" --server "$gateway" --agents "$AGENTS" --ramp-per-sec "$RAMP" --duration "$DURATION"
    --heartbeat "$HEARTBEAT" --inventory-size "$INV_SIZE" --inventory-change-every "$INV_CHANGE"
    --jobs-fraction "$JOBS_FRACTION" --scenario "$sc" --identity-cache "$OUT/identities.json"
    --report "$OUT/$sc.json" --report-md "$OUT/$sc.md" --no-fail)
  [ "$EXTERNAL" = 1 ] || args+=(--enrollment "$(cat "$OUT/enrollment_string")")
  args+=(${pgflag[@]+"${pgflag[@]}"} ${pidflag[@]+"${pidflag[@]}"})
  if [ "$sc" = storm ] && [ "$STORM_MODE" = server-restart ]; then
    args+=(--storm-mode external)
    "$OUT/bin/auzring-loadsim" "${args[@]}" >"$OUT/$sc.out" 2>"$OUT/$sc.err" &
    sim=$!
    for _ in $(seq 1 3600); do grep -q "STORM: waiting" "$OUT/$sc.err" 2>/dev/null && break; kill -0 "$sim" 2>/dev/null || break; sleep 0.1; done
    if kill -0 "$sim" 2>/dev/null; then
      echo "   restarting the server (SIGTERM, then start again on the same database)"
      kill -TERM "$server_pid"; wait "$server_pid" 2>/dev/null || true
      start_server
    fi
    wait "$sim" || status=1
  else
    [ "$sc" = storm ] && args+=(--storm-mode client)
    "$OUT/bin/auzring-loadsim" "${args[@]}" >"$OUT/$sc.out" 2>"$OUT/$sc.err" || status=1
  fi
  { cat "$OUT/$sc.md" 2>/dev/null || { echo "## $sc: no report"; tail -5 "$OUT/$sc.err"; }; echo; } >>"$OUT/summary.md"
  head -n 12 "$OUT/$sc.md" 2>/dev/null || true
done

if [ -f "$OUT/server.log" ]; then
  {
    echo "## Server log"
    echo
    echo "Lines by level and message (top 15):"
    echo '```'
    grep -E "level=(WARN|ERROR)" "$OUT/server.log" | sed -E 's/^time=[^ ]+ //; s/(device|job|id)=[0-9a-f-]{36}//g; s/ip=[0-9.:]+//; s/err="([^"]{0,90}).*/err="\1"/' | sort | uniq -c | sort -rn | head -15 || true
    echo '```'
  } >>"$OUT/summary.md"
fi
echo "== done; report in $OUT/summary.md"
exit $status
