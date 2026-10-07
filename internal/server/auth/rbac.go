package auth

import "slices"

// Permission names checked by API handlers.
const (
	PermDevicesRead      = "devices:read"
	PermDevicesWrite     = "devices:write"
	PermEnrollmentRead   = "enrollment:read"
	PermEnrollmentWrite  = "enrollment:write"
	PermAuditRead        = "audit:read"
	PermGroupsRead       = "groups:read"
	PermGroupsWrite      = "groups:write"
	PermInventoryExport  = "inventory:export"
	PermCatalogRead      = "catalog:read"
	PermCatalogWrite     = "catalog:write"
	PermCatalogOverride  = "catalog:override"
	PermDeploymentsRead  = "deployments:read"
	PermDeploymentsWrite = "deployments:write"
	PermSettingsWrite    = "settings:write"
)

// Roles.
const (
	RoleAdmin    = "admin"
	RoleOperator = "operator"
	RoleReadOnly = "readonly"
)

var rolePerms = map[string][]string{
	RoleAdmin: {PermDevicesRead, PermDevicesWrite, PermEnrollmentRead, PermEnrollmentWrite, PermAuditRead,
		PermGroupsRead, PermGroupsWrite, PermInventoryExport,
		PermCatalogRead, PermCatalogWrite, PermCatalogOverride, PermDeploymentsRead, PermDeploymentsWrite, PermSettingsWrite},
	RoleOperator: {PermDevicesRead, PermDevicesWrite, PermEnrollmentRead, PermGroupsRead, PermGroupsWrite, PermInventoryExport,
		PermCatalogRead, PermCatalogWrite, PermDeploymentsRead, PermDeploymentsWrite},
	RoleReadOnly: {PermDevicesRead, PermGroupsRead, PermCatalogRead, PermDeploymentsRead},
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
