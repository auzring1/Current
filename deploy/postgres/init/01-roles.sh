#!/bin/sh
# Runs once, on first database initialization, as the bootstrap superuser (current_admin).
# Creates two NON-superuser roles (SECURITY.md T-SRV-1/T-SRV-4):
#   current_owner  owns the database and the schema; used only by the one-shot "maintenance" service
#                  (migrations, backup, restore). It can not run programs or read files on the host.
#   current_app    the runtime role (DML only; insert-only on audit_log).
set -eu
owner_pw="$(cat /run/secrets/postgres_owner_password)"
app_pw="$(cat /run/secrets/postgres_app_password)"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=owner_pw="$owner_pw" --set=app_pw="$app_pw" --set=db="$POSTGRES_DB" <<'SQL'
CREATE ROLE current_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'owner_pw';
ALTER DATABASE :"db" OWNER TO current_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO current_owner;
CREATE ROLE current_app LOGIN NOSUPERUSER PASSWORD :'app_pw';
GRANT CONNECT ON DATABASE :"db" TO current_app;
-- The public schema is owned by pg_database_owner in PostgreSQL 15+; make the owner explicit.
ALTER SCHEMA public OWNER TO current_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
