#!/usr/bin/env bash
# Builds current-deploy-<version>.zip: the few files an install needs next to the published server image, so a NAS
# can download one file and start the stack without cloning the repository (docs/RUNBOOK.md, 2.2).
#
#   scripts/make-deploy-bundle.sh 1.2.3 [out.zip]
#
# The compose file inside has the version baked in as its default image tag, so the bundle always starts the
# image it was made for. Everything is copied from this checkout; nothing is generated except the README.
set -euo pipefail
cd "$(dirname "$0")/.."

version=${1:?usage: make-deploy-bundle.sh VERSION [OUT.zip]}
out=${2:-current-deploy-$version.zip}
case $out in /*) ;; *) out="$PWD/$out" ;; esac
[[ $version =~ ^[0-9A-Za-z.+-]+$ ]] || { echo "make-deploy-bundle: bad version '$version'" >&2; exit 1; }
command -v zip >/dev/null || { echo "make-deploy-bundle: zip is required" >&2; exit 1; }

# The image compose file must be current (make generate keeps it so); refuse a stale one.
tmpc=$(mktemp)
scripts/gen-image-compose.sh "$tmpc"
cmp -s "$tmpc" deploy/docker-compose.image.yml || { rm -f "$tmpc"; echo "make-deploy-bundle: deploy/docker-compose.image.yml is out of date (run make generate)" >&2; exit 1; }
rm -f "$tmpc"

root="current-deploy-$version"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/$root/deploy/postgres/init" "$stage/$root/scripts"

# The default tag becomes this version; CURRENT_VERSION in deploy/.env still overrides it.
sed "s/\${CURRENT_VERSION:-latest}/\${CURRENT_VERSION:-$version}/" deploy/docker-compose.image.yml > "$stage/$root/deploy/docker-compose.image.yml"
grep -q "CURRENT_VERSION:-$version" "$stage/$root/deploy/docker-compose.image.yml" || { echo "make-deploy-bundle: could not set the default version" >&2; exit 1; }
cp deploy/Caddyfile deploy/Caddyfile.behind-proxy deploy/.env.example "$stage/$root/deploy/"
cp deploy/postgres/init/* "$stage/$root/deploy/postgres/init/"
cp scripts/init-secrets.sh "$stage/$root/scripts/"
chmod 755 "$stage/$root/scripts/init-secrets.sh" "$stage/$root/deploy/postgres/init/"*.sh

cat > "$stage/$root/README.txt" <<README
Current server $version: install files

This folder holds the files the server image needs next to it. The server itself is the image
ghcr.io/auzring1/current-server:$version, which Docker downloads when you start the stack.

1. Create the secrets (once). KEEP A COPY of deploy/secrets somewhere safe: without master_key the
   database cannot be read again.
       ./scripts/init-secrets.sh          (or: bash scripts/init-secrets.sh)
2. Create your settings file and edit it (host name, and for a Synology reverse proxy the lines
   in the commented block):
       cp deploy/.env.example deploy/.env
3. Start it (add sudo on a Synology):
       docker compose -f deploy/docker-compose.image.yml --env-file deploy/.env up -d
4. First-run setup token:
       docker compose -f deploy/docker-compose.image.yml logs server | grep -A2 "setup token"

Update later: download the newer current-deploy zip, or set CURRENT_VERSION=<new version> in deploy/.env,
then run the same command with "pull" and again with "up -d". Back up first.

Full instructions: docs/RUNBOOK.md in the repository, section 2.2 (https://github.com/auzring1/Current).
README

rm -f "$out"
(cd "$stage" && zip -qr -X "$out" "$root")
echo "wrote $out"
