#!/usr/bin/env bash
# Writes deploy/docker-compose.image.yml from deploy/docker-compose.yml.
#
# The two files are the same stack. The only difference: the image file PULLS the published server image
# (ghcr.io/<owner>/current-server) instead of building it from source, so updating is "pull and restart".
# Do not edit the image file by hand; `make generate` rewrites it and `make check-generated` (CI) fails on drift.
set -euo pipefail
cd "$(dirname "$0")/.."

src=deploy/docker-compose.yml
out=${1:-deploy/docker-compose.image.yml}

awk '
  NR == 1 { print "# GENERATED from docker-compose.yml by scripts/gen-image-compose.sh. Do not edit by hand."
            print "# Same stack, but the server image is PULLED from the registry instead of built from source."
            print "# Install and update steps: docs/RUNBOOK.md, \"Install from the published image\"."
            print "#   docker compose -f deploy/docker-compose.image.yml --env-file deploy/.env up -d"
            skip_header = 1 }
  skip_header && /^#/ { next }
  { skip_header = 0 }
  /^# The server image is built once/ { next }
  /^x-server-build:/ { in_anchor = 1; next }
  in_anchor && /^  / { next }
  { in_anchor = 0 }
  /^    build: \*server-build$/ { next }
  /^    image: current\/server:/ {
    print "    image: ${CURRENT_IMAGE:-ghcr.io/auzring1/current-server}:${CURRENT_VERSION:-latest}"
    print "    pull_policy: always"
    next
  }
  { print }
' "$src" > "$out"
