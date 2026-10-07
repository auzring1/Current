-- name: InsertSoftwarePolicy :exec
INSERT INTO software_policies (id, org_id, name, kind, package_id, group_ids, delay_days, only_new_devices, unverified_confirmed, maint_window, enabled, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);

-- name: UpdateSoftwarePolicy :execrows
UPDATE software_policies SET name = $3, kind = $4, package_id = $5, group_ids = $6, delay_days = $7, only_new_devices = $8,
    unverified_confirmed = $9, maint_window = $10, enabled = $11, updated_at = now()
WHERE id = $1 AND org_id = $2;

-- name: DeleteSoftwarePolicy :execrows
DELETE FROM software_policies WHERE id = $1 AND org_id = $2;

-- name: GetSoftwarePolicy :one
SELECT * FROM software_policies WHERE id = $1 AND org_id = $2;

-- name: ListSoftwarePolicies :many
SELECT p.*, k.name AS package_name, k.identifier AS package_identifier
FROM software_policies p JOIN catalog_packages k ON k.id = p.package_id
WHERE p.org_id = $1 ORDER BY lower(p.name);

-- name: ListEnabledSoftwarePolicies :many
SELECT * FROM software_policies WHERE enabled ORDER BY created_at, id;

-- name: ListOutdatedForPackage :many
-- Machine-wide copies of a package (matched by normalized name) older than the target version.
SELECT DISTINCT ON (si.device_id) si.device_id, si.version
FROM software_installs si JOIN software_titles st ON st.id = si.title_id
WHERE si.device_id = ANY(@device_ids::uuid[]) AND NOT si.system_component AND si.scope = 'machine'
  AND st.normalized_name = @normalized_name::text AND si.version_key IS NOT NULL AND si.version_key < @version_key::bytea
ORDER BY si.device_id, si.version_key DESC;

-- name: ListDevicesWithPackage :many
SELECT DISTINCT si.device_id
FROM software_installs si JOIN software_titles st ON st.id = si.title_id
WHERE si.device_id = ANY(@device_ids::uuid[]) AND NOT si.system_component AND st.normalized_name = @normalized_name::text;

-- name: ListDevicesWithCurrentPackage :many
SELECT DISTINCT si.device_id
FROM software_installs si JOIN software_titles st ON st.id = si.title_id
WHERE si.device_id = ANY(@device_ids::uuid[]) AND NOT si.system_component AND st.normalized_name = @normalized_name::text
  AND si.version_key IS NOT NULL AND si.version_key >= @version_key::bytea;

-- name: ListDeviceEnrollTimes :many
SELECT id, enrolled_at FROM devices WHERE id = ANY($1::uuid[]);

-- name: ListPolicyAttempts :many
SELECT * FROM policy_attempts WHERE policy_id = $1 AND device_id = ANY($2::uuid[]);

-- name: UpsertPolicyAttempt :exec
INSERT INTO policy_attempts (policy_id, device_id, version, deployment_id, failures, created_at)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (policy_id, device_id) DO UPDATE SET version = EXCLUDED.version, deployment_id = EXCLUDED.deployment_id,
    failures = EXCLUDED.failures, created_at = EXCLUDED.created_at;

-- name: PolicyJobStates :many
-- Whether a device's install/update job of a deployment is still open, failed or succeeded.
SELECT deployment_id, device_id,
       bool_or(status IN ('queued', 'sent', 'accepted', 'waiting', 'running')) AS is_open,
       bool_or(status IN ('failed', 'expired', 'cancelled', 'rejected')) AS failed,
       bool_or(status IN ('succeeded', 'succeeded_reboot')) AS ok
FROM jobs
WHERE deployment_id = ANY($1::uuid[]) AND type IN ('software_install', 'software_update')
GROUP BY deployment_id, device_id;

-- name: PolicyAttemptStats :one
SELECT count(*)::bigint AS devices, COALESCE(sum(failures), 0)::bigint AS failures FROM policy_attempts WHERE policy_id = $1;

-- ---- reports ----

-- name: ComplianceReport :many
SELECT d.id, d.hostname, d.site_id, d.os_caption, d.os_build, d.online, d.last_seen_at, d.wu_scanned_at, d.agent_version,
       (d.pending_reboot OR d.wu_reboot_required) AS reboot_pending,
       (count(du.update_id) FILTER (WHERE a.decision = 'approved'))::int AS approved_missing,
       (count(du.update_id) FILTER (WHERE u.severity = 'Critical' AND COALESCE(a.decision, '') <> 'declined'))::int AS critical_missing,
       (count(du.update_id) FILTER (WHERE du.state = 'failed'))::int AS failed_updates
FROM devices d
LEFT JOIN device_updates du ON du.device_id = d.id AND du.state IN ('missing', 'downloaded', 'failed')
LEFT JOIN wu_updates u ON u.org_id = d.org_id AND u.update_id = du.update_id
LEFT JOIN wu_approvals a ON a.org_id = d.org_id AND a.update_id = du.update_id
WHERE d.org_id = $1 AND d.status = 'active'
GROUP BY d.id
ORDER BY lower(d.hostname), d.id;

-- name: ReportJobCounts :many
SELECT type, status, count(*)::bigint AS n FROM jobs WHERE org_id = $1 AND created_at > $2 GROUP BY type, status;

-- name: ReportDeviceCounts :one
SELECT count(*) FILTER (WHERE status = 'active')::bigint AS active,
       count(*) FILTER (WHERE status = 'pending')::bigint AS pending,
       count(*) FILTER (WHERE status = 'revoked')::bigint AS revoked,
       count(*) FILTER (WHERE status = 'active' AND online)::bigint AS online,
       count(*) FILTER (WHERE status = 'active' AND last_seen_at < @stale_before::timestamptz)::bigint AS stale
FROM devices WHERE org_id = @org_id;
