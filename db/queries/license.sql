-- name: InsertLicense :exec
INSERT INTO licenses (id, org_id, license_id, key_id, blob, installed_by, installed_at)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: GetCurrentLicense :one
SELECT * FROM licenses WHERE org_id = $1 ORDER BY installed_at DESC, id DESC LIMIT 1;

-- name: ListLicenses :many
SELECT l.*, u.email AS installed_by_email
FROM licenses l LEFT JOIN users u ON u.id = l.installed_by
WHERE l.org_id = $1 ORDER BY l.installed_at DESC, l.id DESC LIMIT 100;

-- name: CountLicenseDevices :one
-- Active devices count against the cap; pending ones do not (they are not enrolled until approved).
SELECT count(*) FILTER (WHERE status = 'active')::bigint AS active,
       count(*) FILTER (WHERE status = 'pending')::bigint AS pending
FROM devices WHERE org_id = $1;

-- name: LockLicenseCapacity :exec
-- Serializes enrollments and approvals of one organization for the rest of the transaction, so two
-- concurrent requests cannot both take the last free slot.
SELECT pg_advisory_xact_lock(hashtextextended('auzring/license/capacity/' || @org::text, 0));

-- name: GetLicenseClock :one
SELECT high_water FROM license_clock WHERE singleton;

-- name: AdvanceLicenseClock :exec
INSERT INTO license_clock (singleton, high_water) VALUES (true, $1)
ON CONFLICT (singleton) DO UPDATE SET high_water = GREATEST(license_clock.high_water, EXCLUDED.high_water);
