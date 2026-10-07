-- name: LockDeviceInventory :one
-- Serializes inventory writes for one device and returns its revisions.
SELECT software_rev, users_rev, org_id FROM devices WHERE id = $1 FOR UPDATE;

-- name: UpsertSoftwareTitles :many
INSERT INTO software_titles (id, org_id, normalized_name, normalized_publisher, display_name, display_publisher)
SELECT t.id, @org_id::uuid, t.nn, t.np, t.dn, t.dp
FROM unnest(@ids::uuid[], @normalized_names::text[], @normalized_publishers::text[],
            @display_names::text[], @display_publishers::text[])
     AS t(id, nn, np, dn, dp)
ON CONFLICT (org_id, normalized_name, normalized_publisher)
DO UPDATE SET normalized_name = software_titles.normalized_name
RETURNING id, normalized_name, normalized_publisher;

-- name: RecordSoftwareChanges :exec
-- History for items that are new or changed version, computed before upserting.
INSERT INTO software_history (device_id, title_id, name, scope, user_sid, change, old_version, new_version, observed_at)
SELECT @device_id::uuid, n.title_id, n.name, n.scope, n.user_sid,
       CASE WHEN o.device_id IS NULL THEN 'added' ELSE 'version' END,
       COALESCE(o.version, ''), n.version, @now::timestamptz
FROM unnest(@sources::text[], @scopes::text[], @user_sids::text[], @item_keys::text[],
            @title_ids::uuid[], @names::text[], @versions::text[])
     AS n(source, scope, user_sid, item_key, title_id, name, version)
LEFT JOIN software_installs o
       ON o.device_id = @device_id::uuid AND o.source = n.source AND o.scope = n.scope
      AND o.user_sid = n.user_sid AND o.item_key = n.item_key
WHERE o.device_id IS NULL OR o.version IS DISTINCT FROM n.version;

-- name: UpsertSoftwareInstalls :exec
INSERT INTO software_installs (device_id, source, scope, user_sid, item_key, title_id, name, version, version_key,
    publisher, install_date, install_location, uninstall_string, quiet_uninstall_string, product_code,
    system_component, first_seen_at, last_seen_at)
SELECT @device_id::uuid, n.source, n.scope, n.user_sid, n.item_key, n.title_id, n.name, n.version, n.version_key,
       n.publisher, n.install_date, n.install_location, n.uninstall_string, n.quiet_uninstall_string, n.product_code,
       n.system_component, @now::timestamptz, @now::timestamptz
FROM unnest(@sources::text[], @scopes::text[], @user_sids::text[], @item_keys::text[], @title_ids::uuid[],
            @names::text[], @versions::text[], @version_keys::bytea[], @publishers::text[], @install_dates::text[],
            @install_locations::text[], @uninstall_strings::text[], @quiet_uninstall_strings::text[],
            @product_codes::text[], @system_components::boolean[])
     AS n(source, scope, user_sid, item_key, title_id, name, version, version_key, publisher, install_date,
          install_location, uninstall_string, quiet_uninstall_string, product_code, system_component)
ON CONFLICT (device_id, source, scope, user_sid, item_key) DO UPDATE SET
    title_id = EXCLUDED.title_id, name = EXCLUDED.name, version = EXCLUDED.version,
    version_key = EXCLUDED.version_key, publisher = EXCLUDED.publisher, install_date = EXCLUDED.install_date,
    install_location = EXCLUDED.install_location, uninstall_string = EXCLUDED.uninstall_string,
    quiet_uninstall_string = EXCLUDED.quiet_uninstall_string, product_code = EXCLUDED.product_code,
    system_component = EXCLUDED.system_component, last_seen_at = EXCLUDED.last_seen_at;

-- name: RemoveSoftwareByKeys :exec
-- Removes the listed items, recording history first.
WITH gone AS (
    DELETE FROM software_installs s
    USING unnest(@sources::text[], @scopes::text[], @user_sids::text[], @item_keys::text[])
          AS k(source, scope, user_sid, item_key)
    WHERE s.device_id = @device_id::uuid AND s.source = k.source AND s.scope = k.scope
      AND s.user_sid = k.user_sid AND s.item_key = k.item_key
    RETURNING s.title_id, s.name, s.scope, s.user_sid, s.version
)
INSERT INTO software_history (device_id, title_id, name, scope, user_sid, change, old_version, new_version, observed_at)
SELECT @device_id::uuid, title_id, name, scope, user_sid, 'removed', version, '', @now::timestamptz FROM gone;

-- name: RemoveSoftwareNotIn :exec
-- Full-snapshot replace: everything not in the snapshot is removed (with history).
WITH gone AS (
    DELETE FROM software_installs s
    WHERE s.device_id = @device_id::uuid
      AND NOT EXISTS (
          SELECT 1
          FROM unnest(@sources::text[], @scopes::text[], @user_sids::text[], @item_keys::text[])
               AS k(source, scope, user_sid, item_key)
          WHERE s.source = k.source AND s.scope = k.scope AND s.user_sid = k.user_sid AND s.item_key = k.item_key)
    RETURNING s.title_id, s.name, s.scope, s.user_sid, s.version
)
INSERT INTO software_history (device_id, title_id, name, scope, user_sid, change, old_version, new_version, observed_at)
SELECT @device_id::uuid, title_id, name, scope, user_sid, 'removed', version, '', @now::timestamptz FROM gone;

-- name: FinishSoftwareSync :exec
UPDATE devices SET software_rev = $2, software_updated_at = $3, inventory_truncated = $4,
       software_count = (SELECT count(*) FROM software_installs WHERE device_id = $1)
WHERE id = $1;

-- name: ListDeviceSoftware :many
SELECT si.source, si.scope, si.user_sid, si.item_key, si.title_id, si.name, si.version, si.publisher,
       si.install_date, si.install_location, si.uninstall_string, si.quiet_uninstall_string, si.product_code,
       si.system_component, si.first_seen_at, si.last_seen_at
FROM software_installs si
WHERE si.device_id = $1 AND (@include_system::boolean OR NOT si.system_component)
ORDER BY lower(si.name), si.scope, si.user_sid, si.source, si.item_key;

-- name: ListDeviceSoftwareHistory :many
SELECT id, title_id, name, scope, user_sid, change, old_version, new_version, observed_at
FROM software_history WHERE device_id = $1 AND ($2::bigint = 0 OR id < $2) ORDER BY id DESC LIMIT $3;

-- name: ReplaceUsersDelete :exec
DELETE FROM device_users WHERE device_id = $1 AND NOT (sid = ANY(@sids::text[]));

-- name: UpsertDeviceUsers :exec
INSERT INTO device_users (device_id, sid, username, domain, profile_path, last_logon_at, loaded, is_admin)
SELECT @device_id::uuid, n.sid, n.username, n.domain, n.profile_path,
       CASE WHEN n.last_logon > 0 THEN to_timestamp(n.last_logon) END, n.loaded, n.is_admin
FROM unnest(@sids::text[], @usernames::text[], @domains::text[], @profile_paths::text[], @last_logons::bigint[],
            @loaded::boolean[], @is_admins::boolean[])
     AS n(sid, username, domain, profile_path, last_logon, loaded, is_admin)
ON CONFLICT (device_id, sid) DO UPDATE SET
    username = EXCLUDED.username, domain = EXCLUDED.domain, profile_path = EXCLUDED.profile_path,
    last_logon_at = EXCLUDED.last_logon_at, loaded = EXCLUDED.loaded, is_admin = EXCLUDED.is_admin;

-- name: SetUsersRev :exec
UPDATE devices SET users_rev = $2 WHERE id = $1;

-- name: ListDeviceUsers :many
SELECT * FROM device_users WHERE device_id = $1 ORDER BY loaded DESC, lower(username), sid;
