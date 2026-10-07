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
go build -o "$out/auzring-release" ./cmd/auzring-release
[ -f "$out/release.key" ] || "$out/auzring-release" keygen --out "$out/release.key" >/dev/null
pub=$(tr -d '[:space:]' < "$out/release.pub")
flags() { echo "-s -w -X github.com/auzring1/auzring/internal/shared/version.Version=$1 -X github.com/auzring1/auzring/internal/shared/release.PublicKeysHex=$pub"; }
for v in 0.9.0 0.9.1; do
  GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$(flags "$v")" -o "$out/auzring-agent-$v.exe" ./cmd/auzring-agent
done
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$(flags 0.9.2)" -o "$out/auzring-agent-0.9.2.exe" ./test/tools/brokenagent
for v in 0.9.1 0.9.2; do
  "$out/auzring-release" sign --key "$out/release.key" --exe "$out/auzring-agent-$v.exe" --version "$v" --notes "demo build $v" --out "$out/auzring-agent-$v.azr" >/dev/null
done
cat <<EOF
Built in $out/:
  auzring-agent-0.9.0.exe  install this on the Windows machine
  auzring-agent-0.9.1.exe + .azr  good release (upload both on the Agent updates page)
  auzring-agent-0.9.2.exe + .azr  broken release (rollback test)
The server must accept the demo key. Add this to deploy/.env and recreate the server container:
  AUZ_RELEASE_PUBLIC_KEYS=$pub
EOF
