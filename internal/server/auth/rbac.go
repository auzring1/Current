package auth

import "slices"

// Permission names checked by API handlers.
const (
	PermDevicesRead     = "devices:read"
	PermDevicesWrite    = "devices:write"
	PermEnrollmentRead  = "enrollment:read"
	PermEnrollmentWrite = "enrollment:write"
	PermAuditRead       = "audit:read"
	PermGroupsRead      = "groups:read"
	PermGroupsWrite     = "groups:write"
	PermInventoryExport = "inventory:export"
)

// Roles.
const (
	RoleAdmin    = "admin"
	RoleOperator = "operator"
	RoleReadOnly = "readonly"
)

var rolePerms = map[string][]string{
	RoleAdmin: {PermDevicesRead, PermDevicesWrite, PermEnrollmentRead, PermEnrollmentWrite, PermAuditRead,
		PermGroupsRead, PermGroupsWrite, PermInventoryExport},
	RoleOperator: {PermDevicesRead, PermDevicesWrite, PermEnrollmentRead, PermGroupsRead, PermGroupsWrite, PermInventoryExport},
	RoleReadOnly: {PermDevicesRead, PermGroupsRead},
}

// PermissionsFor returns the sorted union of permissions for org-scoped roles.
// Site-scoped bindings are honoured from Phase 5 (per-site scoping); in Phase 1
// they grant nothing org-wide.
func PermissionsFor(orgRoles []string) []string {
	var out []string
	for _, r := range orgRoles {
		out = append(out, rolePerms[r]...)
	}
	slices.Sort(out)
	return slices.Compact(out)
}
