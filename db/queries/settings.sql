-- Settings and notifications (decision D95).

-- name: GetSettingsSection :one
SELECT * FROM settings_sections WHERE org_id = $1 AND section = $2;

-- name: GetSettingsSectionForUpdate :one
SELECT * FROM settings_sections WHERE org_id = $1 AND section = $2 FOR UPDATE;

-- name: InsertSettingsSection :exec
INSERT INTO settings_sections (org_id, section, revision, schema_version, data, secrets, updated_at, updated_by)
VALUES ($1, $2, 1, $3, $4, $5, $6, $7);

-- name: UpdateSettingsSection :execrows
UPDATE settings_sections SET revision = revision + 1, schema_version = $4, data = $5, secrets = $6, updated_at = $7, updated_by = $8
WHERE org_id = $1 AND section = $2 AND revision = $3;

-- name: FirstOrganization :one
SELECT id FROM organizations ORDER BY created_at, id LIMIT 1;

-- name: EnqueueNotification :exec
INSERT INTO notification_outbox (org_id, channel, event, target, dedupe_key, payload, not_before)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (org_id, channel, target, event, dedupe_key) WHERE dedupe_key <> '' DO NOTHING;

-- name: ClaimDueNotifications :many
SELECT * FROM notification_outbox WHERE status = 'pending' AND not_before <= $1 ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED;

-- name: FinishNotification :exec
UPDATE notification_outbox SET status = $2, attempts = attempts + 1, last_error = $3, not_before = $4, sent_at = $5 WHERE id = $1;

-- name: ListNotificationLog :many
SELECT id, channel, event, target, status, attempts, last_error, created_at, sent_at FROM notification_outbox
WHERE org_id = $1 ORDER BY id DESC LIMIT $2;

-- name: PruneNotificationLog :execrows
DELETE FROM notification_outbox WHERE status <> 'pending' AND created_at < $1;

-- name: OfflineDevicesSince :many
SELECT id, hostname, last_seen_at FROM devices
WHERE org_id = $1 AND status = 'active' AND NOT online AND last_seen_at < $2 ORDER BY last_seen_at LIMIT 500;

-- name: RolloutTargetVersion :one
SELECT r.version, r.created_at FROM agent_rollout o JOIN agent_releases r ON r.id = o.release_id
WHERE o.org_id = $1 AND o.release_id IS NOT NULL;

-- name: ActiveDeviceAgents :many
SELECT id, hostname, agent_version FROM devices WHERE org_id = $1 AND status = 'active' AND agent_version <> '' ORDER BY id LIMIT 20000;

-- name: PruneFinishedJobs :execrows
DELETE FROM jobs WHERE org_id = $1 AND status IN ('succeeded', 'succeeded_reboot', 'failed', 'expired', 'cancelled', 'rejected') AND COALESCE(finished_at, created_at) < $2;
