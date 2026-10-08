#!/usr/bin/env bash
# Builds agent versions for trying out agent self-update on a test machine (docs/demos/PHASE5-DEMO.md):
#   0.9.0  the agent you install first
#   0.9.1  a good release: the update should succeed
#   0.9.2  a deliberately broken release: the machine must roll back to 0.9.1 by itself
# Creates a throw-away release key under dist-demo/ (git-ignored). Nothing here is a real release.
set -euo pipefail
cd "$(dirname "$0")/.."
out=${1:-dist-demo}
mkdir -p "$out"
go build -o "$out/renovatio-release" ./cmd/renovatio-release
[ -f "$out/release.key" ] || "$out/renovatio-release" keygen --out "$out/release.key" >/dev/null
pub=$(tr -d '[:space:]' < "$out/release.pub")
flags() { echo "-s -w -X github.com/auzring1/renovatio/internal/shared/version.Version=$1 -X github.com/auzring1/renovatio/internal/shared/release.PublicKeysHex=$pub"; }
for v in 0.9.0 0.9.1; do
  GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$(flags "$v")" -o "$out/renovatio-agent-$v.exe" ./cmd/renovatio-agent
done
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$(flags 0.9.2)" -o "$out/renovatio-agent-0.9.2.exe" ./test/tools/brokenagent
for v in 0.9.1 0.9.2; do
  "$out/renovatio-release" sign --key "$out/release.key" --exe "$out/renovatio-agent-$v.exe" --version "$v" --notes "demo build $v" --out "$out/renovatio-agent-$v.rnr" >/dev/null
done
cat <<EOF
Built in $out/:
  renovatio-agent-0.9.0.exe  install this on the Windows machine
  renovatio-agent-0.9.1.exe + .rnr  good release (upload both on the Agent updates page)
  renovatio-agent-0.9.2.exe + .rnr  broken release (rollback test)
The server must accept the demo key. Add this to deploy/.env and recreate the server container:
  RENOVATIO_RELEASE_PUBLIC_KEYS=$pub
EOF
