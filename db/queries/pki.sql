-- name: InsertPKIMaterial :exec
INSERT INTO pki_material (id, kind, cert_der, key_enc, key_protection, not_after)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: GetActivePKI :one
SELECT * FROM pki_material WHERE kind = $1 AND retired_at IS NULL;

-- name: RetireActivePKI :exec
UPDATE pki_material SET retired_at = $2 WHERE kind = $1 AND retired_at IS NULL;

-- name: InsertDeviceCert :exec
INSERT INTO device_certs (serial, device_id, public_key_sha256, not_before, not_after)
VALUES ($1, $2, $3, $4, $5);

-- name: GetDeviceCert :one
SELECT * FROM device_certs WHERE serial = $1;

-- name: RevokeDeviceCerts :exec
UPDATE device_certs SET revoked_at = $2, revoke_reason = $3
WHERE device_id = $1 AND revoked_at IS NULL;

-- name: RevokeDeviceCertsExcept :exec
UPDATE device_certs SET revoked_at = $3, revoke_reason = $4
WHERE device_id = $1 AND serial <> $2 AND revoked_at IS NULL;

-- name: RevokeSupersededCerts :exec
-- Called when a device connects with a renewed certificate: older certs are retired.
UPDATE device_certs SET revoked_at = $3, revoke_reason = 'superseded'
WHERE device_id = $1 AND serial <> $2 AND revoked_at IS NULL AND not_after < $4;
