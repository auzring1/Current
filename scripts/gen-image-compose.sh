#!/usr/bin/env bash
# Writes deploy/docker-compose.image.yml from deploy/docker-compose.yml.
#
# The two files are the same stack. The only difference: the image file PULLS the three published images
# (ghcr.io/<owner>/librepatch-server, -caddy and -postgres) instead of building them from source, so updating is
# "pull and restart", and an install needs nothing but this one file (decision D110).
# Do not edit the image file by hand; `make generate` rewrites it and `make check-generated` (CI) fails on drift.
set -euo pipefail
cd "$(dirname "$0")/.."

src=deploy/docker-compose.yml
out=${1:-deploy/docker-compose.image.yml}

awk '
  NR == 1 { print "# GENERATED from docker-compose.yml by scripts/gen-image-compose.sh. Do not edit by hand."
            print "# The whole LibrePatch stack in ONE file: the three images are PULLED from the registry, nothing else is needed."
            print "# Set your host name in the settings block below, then start it (docs/RUNBOOK.md, \"Install from the published image\"):"
            print "#   docker compose -f docker-compose.image.yml up -d          (in Synology Container Manager: paste this file into a new project)"
            skip_header = 1 }
  skip_header && /^#/ { next }
  { skip_header = 0 }
  /^# The server image is built once/ { next }
  /^x-[a-z]+-build:/ { in_anchor = 1; next }
  in_anchor && /^  / { next }
  { in_anchor = 0 }
  /^    build: \*[a-z]+-build$/ { next }
  /^    image: librepatch\/[a-z]+:/ {
    match($0, /librepatch\/[a-z]+:/)
    name = substr($0, RSTART + 11, RLENGTH - 12)
    print "    image: ${LIBREPATCH_REGISTRY:-ghcr.io/auzring1}/librepatch-" name ":${LIBREPATCH_VERSION:-latest}"
    print "    pull_policy: always"
    next
  }
  { print }' "$src" > "$out"
