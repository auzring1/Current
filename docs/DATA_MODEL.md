# Data model (PostgreSQL)

Status: Phase 1 tables are implemented in `db/migrations/00001_foundations.sql`: tenancy, identity, sessions, PKI, enrollment, devices, device certs and audit. Later sections are design. Column lists are abridged.

Phase 1 differences from the design below:
- `pki_material` stores the **root key sealed with the owner passphrase** (`key_protection='passphrase'`; argon2id + AES-GCM), so the server can unlock it only when the owner types the passphrase. The issuing, job-signing and gateway keys are sealed with the KEK.
- `sessions.pending_totp_enc` holds the new TOTP secret during a forced MFA re-enrollment. `setup_state` holds the first-run TOTP secret until setup commits.
- Device hardware is stored as a `jsonb` snapshot (`devices.hardware`, protobuf field names) plus denormalized columns for listing. The normalized software tables arrive in Phase 2.
- `device_certs.serial` is lowercase hex text.

## Conventions
- Primary keys are `uuid` (v7, so they sort by time). The audit log and event tables use `bigint` identity.
- **Every tenant-owned row has `org_id`**, and most also have `site_id`. v1 ships single-tenant (one org created at setup), but every query is scoped by org, and RBAC checks site scope.
- Every query is a sqlc-generated parameterized statement. The application never builds SQL by concatenating strings. The only dynamic SQL is the dynamic-group compiler, and it emits identifiers from a fixed allow-list, with all values as parameters.
- Timestamps are `timestamptz`.
- Migrations are forward-only and follow expand-then-contract across releases. `goose` runs them in transactions under an advisory lock.
- **Database roles:**
  - `auzring_migrator`: owns the DDL;
  - `auzring_app`: DML only, and on `audit_log` `INSERT`/`SELECT` only;
  - `auzring_readonly`: reporting and backups.

## Tenancy and identity
```
organizations(id, name, created_at)
sites(id, org_id, name, timezone)
users(id, org_id, email citext unique, display_name, password_hash, status[active|disabled],
      failed_logins, locked_until, password_changed_at, created_at)
user_identities(id, user_id, provider[local|oidc:<name>], subject, unique(provider, subject))   -- OIDC-ready
mfa_totp(user_id, secret_enc bytea, confirmed_at)                     -- encrypted with server KEK
mfa_webauthn(id, user_id, credential_id, public_key, sign_count, aaguid, name, created_at)
mfa_recovery_codes(user_id, code_hash, used_at)
role_bindings(id, user_id, role[admin|operator|readonly], scope_type[org|site], scope_id)
sessions(id_hash bytea pk, user_id, created_at, last_seen_at, idle_expires_at, abs_expires_at,
         mfa_verified_at, ip, user_agent, csrf_secret)
api_tokens(id, org_id, name, token_hash bytea, scopes text[], site_ids uuid[], created_by,
           expires_at, last_used_at, revoked_at)
```

## Devices and PKI
```
enrollment_tokens(id, org_id, site_id, token_hash, max_uses, used_count, expires_at,
                  require_approval bool, default_group_ids uuid[], created_by, revoked_at)
devices(id, org_id, site_id, status[pending|active|revoked|retired], hostname, fqdn, domain,
        os_caption, os_build, os_ubr, arch, serial, manufacturer, model, chassis,
        cpu, ram_bytes, uptime_s, pending_reboot, bitlocker jsonb, last_user, ips inet[],
        agent_version, enrolled_at, approved_by, last_seen_at, online bool,
        inventory_rev bigint, hw_rev bigint, local_policy jsonb)
device_certs(serial numeric pk, device_id, public_key_sha256, not_before, not_after,
             revoked_at, revoke_reason)
device_users(device_id, sid, username, domain, profile_path, last_logon_at, loaded bool,
             is_admin bool, primary key(device_id, sid))
device_sessions(device_id, session_id, sid, state, kind[console|rdp], updated_at)
pki_material(id, kind[root|issuing|job_signing], cert_der, key_enc bytea null, not_after, retired_at)
   -- root key_enc is NULL (offline). job_signing/issuing keys encrypted with server KEK.
```

## Inventory
```
software_titles(id, org_id, normalized_name, normalized_publisher, catalog_package_id null,
                self_updating bool, unique(org_id, normalized_name, normalized_publisher))
software_installs(device_id, source, scope[machine|user], user_sid ('' for machine), item_key,
                  title_id, name, version, version_key bytea, publisher, install_date,
                  install_location, uninstall_string, quiet_uninstall_string, product_code,
                  system_component bool, first_seen_at, last_seen_at,
                  primary key(device_id, source, scope, user_sid, item_key))
software_history(id bigint, device_id, title_id, scope, user_sid, change[added|removed|version],
                 old_version, new_version, observed_at)       -- partitioned by month
```
- `version_key` is a byte-comparable encoding of the version, produced by the shared Go comparer. That makes `version_key < $1` correct in SQL, for example for "Chrome < 130".
- Indexes: `(title_id, version_key)` and `(device_id)`. A trigram index on `software_titles.normalized_name` powers search.

## Groups
```
groups(id, org_id, site_id null, name, kind[static|dynamic], filter jsonb, created_by)
group_members(group_id, device_id)                  -- static groups only
group_membership_cache(group_id, device_id, computed_at)  -- dynamic; refreshed on inventory change
```
`filter` is a typed AST, e.g. `{"and":[{"f":"software.title","op":"eq","v":"Google Chrome"},{"f":"software.version","op":"lt","v":"130"},{"f":"device.chassis","op":"in","v":["laptop","notebook"]}]}`. Field names come from an allow-list. Values are validated per field type and always bound as parameters.

## Catalog
```
catalog_packages(id, org_id null(global), source[winget|custom|overlay], package_identifier,
                 name, publisher, homepage, license, verified bool, verified_matrix_run_id,
                 self_updating bool, imported_at, unique(org_id, source, package_identifier))
catalog_versions(id, package_id, version, version_key, manifest jsonb, manifest_sha256, imported_at)
catalog_installers(id, version_id, architecture, scope[machine|user|any], installer_type,
                   nested_type, url, sha256, size, signer_subject, signer_thumbprint_pin,
                   product_code, upgrade_code, switches jsonb, success_codes int[],
                   expected_codes jsonb, min_os, dependencies jsonb, elevation_requirement)
detection_rules(id, package_id, version_id null, scope, kind[msi|registry|file|appx], params jsonb)
package_overrides(org_id, package_id, silent_args jsonb, extra_detection jsonb, pin text,
                  excluded bool, user_scope_policy, self_update_policy, updated_by, updated_at)
content_blobs(sha256 pk, size, media_type, storage_path, origin[upload|cache], uploaded_by, created_at)
winget_index(package_identifier, name, publisher, latest_version, tags, moniker, synced_at) -- search only
```

## Deployments and jobs
```
maintenance_windows(id, org_id, name, days smallint[], start_local time, duration interval,
                    tz_mode[device|fixed], tz)
deployments(id, org_id, name, kind[software|windows_update|reboot|inventory], action,
            spec jsonb, reboot_policy jsonb, window_id, starts_at, deadline_at,
            status[draft|pending_approval|active|paused|completed|cancelled],
            created_by, approved_by, approved_at)
deployment_rings(deployment_id, ordinal, name, group_ids uuid[], device_ids uuid[],
                 start_after interval, success_threshold numeric, status, started_at)
jobs(id, org_id, deployment_id null, ring_ordinal, device_id, user_sid ('' = machine),
     type, payload jsonb, not_before, expires_at, attempt, status, status_reason,
     envelope bytea null, sent_at, acked_at, started_at, finished_at,
     exit_code, result jsonb, reboot_required bool)
job_events(id bigint, job_id, ts, kind, message, data jsonb)    -- partitioned by month
policies(id, org_id, kind[auto_update|baseline|user_scope_app|self_update], spec jsonb,
         target_group_ids uuid[], enabled, created_by, updated_at)
```
Jobs are indexed by `(device_id, status)` for dispatch and `(deployment_id, status)` for progress.

## Windows Update (Phase 4)
```
wu_updates(update_id uuid, revision int, title, kb text[], classification, severity, products text[],
           is_driver bool, driver_class, driver_hwid, driver_version, release_date, support_url,
           primary key(update_id, revision))
device_updates(device_id, update_id, revision, state[missing|downloaded|installed|hidden|failed|pending_reboot],
               last_result, scanned_at, primary key(device_id, update_id))
wu_approvals(org_id, update_id, revision, decision[approved|declined|hidden], ring_policy, decided_by, decided_at)
wu_approval_rules(id, org_id, name, classifications text[], severities text[], include_drivers,
                  delay_days, target_group_ids uuid[], enabled)
```

## Audit
```
audit_log(id bigint identity, ts, org_id, actor_type[user|api_token|system|device], actor_id,
          actor_ip, action, target_type, target_ids text[], outcome[success|denied|error],
          details jsonb, prev_hash bytea, hash bytea)
```
- `hash = SHA-256(prev_hash || canonical(row))`. The chain is checked daily, and on demand from the GUI.
- `auzring_app` cannot run `UPDATE`/`DELETE`/`TRUNCATE` on the table, and a trigger rejects them for every role except the migrator.
- An optional syslog/JSON forwarder streams entries to a SIEM.

## Licensing (Phase 6)
```
licenses(id, document bytea, signature bytea, licensee, max_devices, features text[], issued_at, expires_at null)
```
