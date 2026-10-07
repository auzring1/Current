#!/bin/sh
# Creates the least-privilege runtime role (DML only; insert-only on audit_log).
# Runs once, on first database initialization, as the postgres superuser.
set -eu
app_pw="$(cat /run/secrets/postgres_app_password)"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_pw="$app_pw" --set=db="$POSTGRES_DB" <<'SQL'
CREATE ROLE auzring_app LOGIN PASSWORD :'app_pw';
GRANT CONNECT ON DATABASE :"db" TO auzring_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
