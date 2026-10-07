-- name: ListGroups :many
SELECT id, org_id, name, description, filter, created_by, created_at, updated_at
FROM groups WHERE org_id = $1 ORDER BY lower(name), id LIMIT 500;

-- name: GetGroup :one
SELECT id, org_id, name, description, filter, created_by, created_at, updated_at
FROM groups WHERE id = $1 AND org_id = $2;

-- name: CreateGroup :exec
INSERT INTO groups (id, org_id, name, description, filter, created_by)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: UpdateGroup :execrows
UPDATE groups SET name = $3, description = $4, filter = $5, updated_at = $6
WHERE id = $1 AND org_id = $2;

-- name: DeleteGroup :execrows
DELETE FROM groups WHERE id = $1 AND org_id = $2;
