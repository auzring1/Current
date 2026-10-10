#!/usr/bin/env bash
# Generates the Docker secrets for deploy/docker-compose.yml.
# Refuses to overwrite existing secrets (that would lock you out of the
# encrypted CA keys and the database). Back up deploy/secrets/ securely.
set -euo pipefail
dir="$(cd "$(dirname "$0")/.." && pwd)/deploy/secrets"
umask 077
rand() { openssl rand -hex "$1"; }
if [ -e "$dir/master_key" ]; then
  # Upgrade from a release that predates the separate bootstrap-superuser password: add only that file.
  if [ ! -e "$dir/postgres_admin_password" ]; then
    rand 24 > "$dir/postgres_admin_password"
    chmod 644 "$dir/postgres_admin_password"
    echo "Added $dir/postgres_admin_password (new in Phase 6). Existing secrets were left untouched."
    echo "An already initialized database keeps its old roles; see docs/RUNBOOK.md, 'Hardening an older database'."
    exit 0
  fi
  echo "Secrets already exist in $dir; refusing to overwrite." >&2
  exit 1
fi
mkdir -p "$dir"
chmod 700 "$dir"
rand 32 > "$dir/master_key"
rand 24 > "$dir/postgres_admin_password"
owner_pw=$(rand 24)
app_pw=$(rand 24)
printf '%s' "$owner_pw" > "$dir/postgres_owner_password"
printf '%s' "$app_pw" > "$dir/postgres_app_password"
printf 'postgres://current_owner:%s@postgres:5432/current?sslmode=disable' "$owner_pw" > "$dir/migrate_database_url"
printf 'postgres://current_app:%s@postgres:5432/current?sslmode=disable' "$app_pw" > "$dir/database_url"
# The directory is private (0700). Files must be readable by the non-root
# container users the bind mounts are presented to, hence 0644 inside it.
chmod 644 "$dir"/*
echo "Secrets written to $dir"
echo "IMPORTANT: back up $dir/master_key securely. Without it the CA keys and MFA secrets cannot be decrypted."
