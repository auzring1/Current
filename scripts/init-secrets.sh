#!/usr/bin/env bash
# Generates the Docker secrets for deploy/docker-compose.yml.
# Refuses to overwrite existing secrets (that would lock you out of the
# encrypted CA keys and the database). Back up deploy/secrets/ securely.
set -euo pipefail
dir="$(cd "$(dirname "$0")/.." && pwd)/deploy/secrets"
if [ -e "$dir/master_key" ]; then
  echo "Secrets already exist in $dir; refusing to overwrite." >&2
  exit 1
fi
umask 077
mkdir -p "$dir"
chmod 700 "$dir"
rand() { openssl rand -hex "$1"; }
rand 32 > "$dir/master_key"
owner_pw=$(rand 24)
app_pw=$(rand 24)
printf '%s' "$owner_pw" > "$dir/postgres_owner_password"
printf '%s' "$app_pw" > "$dir/postgres_app_password"
printf 'postgres://auzring_owner:%s@postgres:5432/auzring?sslmode=disable' "$owner_pw" > "$dir/migrate_database_url"
printf 'postgres://auzring_app:%s@postgres:5432/auzring?sslmode=disable' "$app_pw" > "$dir/database_url"
# The directory is private (0700). Files must be readable by the non-root
# container users the bind mounts are presented to, hence 0644 inside it.
chmod 644 "$dir"/*
echo "Secrets written to $dir"
echo "IMPORTANT: back up $dir/master_key securely. Without it the CA keys and MFA secrets cannot be decrypted."
