// Package brand is the single source of truth for the product name.
//
// Nothing else in the Go code may spell the product name in a string: use these constants. The web
// console receives the same values at build time (web/src/brand.generated.ts, written by `go generate`,
// checked by `make check-generated`), and the MSI build receives them as WiX variables
// (installer/windows/build.ps1 and scripts/build-msi.sh call `go run ./internal/shared/brand/gen -wix`).
// The test in this package fails if the previous name or a stray copy of the current one reaches a
// user-visible string anywhere in the repository.
package brand

//go:generate go run ./gen -ts ../../../web/src/brand.generated.ts

const (
	// Name is the product name shown to people.
	Name = "Renovatio"
	// AgentName is the name of the endpoint agent as shown on a machine (service display name, MSI, file properties).
	AgentName = Name + " Agent"
	// Company is the vendor (the manufacturer in the MSI and in the file properties, the copyright holder).
	Company = "Auzring"
	// Slug is the lower-case stem of command and file names (renovatio-server, renovatio-agent.exe, ...).
	Slug = "renovatio"
)

// Compatibility identifiers. They contain the previous product name on purpose: machines and databases that
// exist already depend on them, so they are not renamed (see RENAME-PLAN.md, group B). New code must not
// add to this list without a reason of the same kind.
const (
	// InstalledAgentExe is the agent's file name inside its slot directories and in the service image path.
	InstalledAgentExe = "auzring-agent.exe"
	// VersionBanner is what `<agent> version` prints before the version number. Agents that are installed
	// already read it from a freshly staged binary during self-update.
	VersionBanner = "auzring-agent"
	// ManifestProduct is the "product" value of a signed agent release manifest.
	ManifestProduct = "auzring-agent"
)
