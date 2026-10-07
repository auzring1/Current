package jobs

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	agentv1 "github.com/auzring1/auzring/gen/proto/auzring/agent/v1"
	"github.com/auzring1/auzring/internal/shared/installer"
	"github.com/auzring1/auzring/internal/shared/vercmp"
)

// Limits applied to every job body before anything is persisted or run.
const (
	MaxInstallerBytes = 4 << 30
	MaxTimeout        = 4 * time.Hour
	DefaultTimeout    = time.Hour
	MaxRetries        = 5
	MaxSources        = 4
	MaxDetections     = 16
)

// ErrBody is returned for a body that fails validation.
var ErrBody = errors.New("jobs: invalid job body")

var (
	guidRe     = regexp.MustCompile(`^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$`)
	sidRe      = regexp.MustCompile(`^S-1-\d+(-\d+)+$`)
	fileNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._ +()\-]{0,127}$`)
)

func bad(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrBody, fmt.Sprintf(format, a...))
}

func scopeOf(s agentv1.InstallScope) (installer.Scope, bool) {
	switch s {
	case agentv1.InstallScope_INSTALL_SCOPE_MACHINE:
		return installer.Machine, true
	case agentv1.InstallScope_INSTALL_SCOPE_USER:
		return installer.User, true
	}
	return "", false
}

var typeNames = map[agentv1.InstallerType]installer.Type{
	agentv1.InstallerType_INSTALLER_TYPE_MSI:      installer.MSI,
	agentv1.InstallerType_INSTALLER_TYPE_MSIX:     installer.MSIX,
	agentv1.InstallerType_INSTALLER_TYPE_INNO:     installer.Inno,
	agentv1.InstallerType_INSTALLER_TYPE_NSIS:     installer.NSIS,
	agentv1.InstallerType_INSTALLER_TYPE_BURN:     installer.Burn,
	agentv1.InstallerType_INSTALLER_TYPE_EXE:      installer.EXE,
	agentv1.InstallerType_INSTALLER_TYPE_PORTABLE: installer.Portable,
	agentv1.InstallerType_INSTALLER_TYPE_ZIP:      installer.Zip,
}

func checkScopeSID(scope installer.Scope, sid string) error {
	switch scope {
	case installer.Machine:
		if sid != "" {
			return bad("machine-scope job with a user SID")
		}
	case installer.User:
		if !sidRe.MatchString(sid) || len(sid) > 128 {
			return bad("user-scope job without a valid SID")
		}
	}
	return nil
}

func validateDetections(ds []*agentv1.Detection) error {
	if len(ds) > MaxDetections {
		return bad("too many detection rules")
	}
	for _, d := range ds {
		if d.Key == "" || len(d.Key) > 512 || len(d.ValueName) > 256 || len(d.Version) > 128 {
			return bad("detection rule fields out of range")
		}
		switch d.Kind {
		case agentv1.DetectionKind_DETECTION_KIND_MSI_PRODUCT:
			if !guidRe.MatchString(d.Key) {
				return bad("MSI detection key is not a product code")
			}
		case agentv1.DetectionKind_DETECTION_KIND_REGISTRY, agentv1.DetectionKind_DETECTION_KIND_FILE, agentv1.DetectionKind_DETECTION_KIND_APPX:
		default:
			return bad("unknown detection kind")
		}
	}
	return nil
}

func timeoutOf(secs uint32) (time.Duration, error) {
	if secs == 0 {
		return DefaultTimeout, nil
	}
	d := time.Duration(secs) * time.Second
	if d > MaxTimeout {
		return 0, bad("timeout over %s", MaxTimeout)
	}
	return d, nil
}

// ValidateInstall checks an install body against the envelope's target SID.
func ValidateInstall(b *agentv1.InstallBody, targetSID string) error {
	if b == nil || b.Installer == nil {
		return bad("missing installer")
	}
	scope, ok := scopeOf(b.Scope)
	if !ok {
		return bad("unknown scope")
	}
	if err := checkScopeSID(scope, targetSID); err != nil {
		return err
	}
	in := b.Installer
	t, ok := typeNames[in.Type]
	if !ok {
		return bad("unknown installer type")
	}
	if t == installer.MSIX {
		return bad("MSIX installation is not supported by this agent version")
	}
	if len(in.Sha256) != 32 {
		return bad("installer SHA-256 is mandatory")
	}
	if in.Size > MaxInstallerBytes {
		return bad("installer size over %d bytes", int64(MaxInstallerBytes))
	}
	if !fileNameRe.MatchString(in.FileName) || strings.Contains(in.FileName, "..") {
		return bad("installer file name must be a plain name")
	}
	if t == installer.Zip {
		nt, ok := typeNames[in.NestedType]
		if !ok || !nt.RunsProcess() {
			return bad("a ZIP package needs a process-based nested installer")
		}
		if in.NestedPath == "" || len(in.NestedPath) > 260 || strings.HasPrefix(in.NestedPath, "/") || strings.Contains(in.NestedPath, "..") ||
			strings.ContainsAny(in.NestedPath, `\:`) {
			return bad("nested path must be a relative archive path")
		}
	}
	if len(in.Sources) == 0 || len(in.Sources) > MaxSources {
		return bad("1..%d content sources required", MaxSources)
	}
	for _, s := range in.Sources {
		switch s.Kind {
		case agentv1.ContentSourceKind_CONTENT_SOURCE_KIND_SERVER:
			if in.Size == 0 {
				return bad("server content needs a known size")
			}
		case agentv1.ContentSourceKind_CONTENT_SOURCE_KIND_VENDOR:
			u, err := url.Parse(s.Url)
			if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || len(s.Url) > 2048 {
				return bad("vendor sources must be https URLs")
			}
		default:
			return bad("unknown content source")
		}
	}
	if err := installer.ValidateArgs(in.Args); err != nil {
		return bad("%v", err)
	}
	if in.ProductCode != "" && !guidRe.MatchString(in.ProductCode) {
		return bad("product code is not a GUID")
	}
	if len(in.SuccessCodes) > 16 || len(in.CodeMap) > 32 {
		return bad("too many exit-code entries")
	}
	if err := validateDetections(b.Detection); err != nil {
		return err
	}
	if _, err := timeoutOf(b.TimeoutS); err != nil {
		return err
	}
	if b.MaxRetries > MaxRetries || b.RetryBackoffS > 3600 {
		return bad("retry limits exceeded")
	}
	if len(b.Version) > 128 || len(b.Name) > 256 || len(b.PackageId) > 200 {
		return bad("descriptive fields too long")
	}
	return nil
}

// ValidateUninstall checks an uninstall body.
func ValidateUninstall(b *agentv1.UninstallBody, targetSID string) error {
	if b == nil {
		return bad("missing body")
	}
	scope, ok := scopeOf(b.Scope)
	if !ok {
		return bad("unknown scope")
	}
	if err := checkScopeSID(scope, targetSID); err != nil {
		return err
	}
	switch b.ItemSource {
	case "reg64", "reg32", "hku", "hku32", "msi":
	default:
		return bad("unsupported item source %q", b.ItemSource)
	}
	if (scope == installer.Machine) == (b.ItemSource == "hku" || b.ItemSource == "hku32") {
		return bad("item source does not match the scope")
	}
	if b.ItemKey == "" || len(b.ItemKey) > 512 {
		return bad("item key out of range")
	}
	if b.ProductCode != "" && !guidRe.MatchString(b.ProductCode) {
		return bad("product code is not a GUID")
	}
	if b.ItemSource == "msi" && !guidRe.MatchString(b.ItemKey) {
		return bad("MSI items are identified by product code")
	}
	if v := b.RemoveOlderThan; v != "" && (len(v) > 128 || vercmp.Key(v) == nil) {
		return bad("remove_older_than is not a comparable version")
	}
	if err := installer.ValidateArgs(b.ExtraArgs); err != nil {
		return bad("%v", err)
	}
	if _, err := timeoutOf(b.TimeoutS); err != nil {
		return err
	}
	if b.MaxRetries > MaxRetries || b.RetryBackoffS > 3600 {
		return bad("retry limits exceeded")
	}
	return nil
}

// ValidateWindow bounds a maintenance window.
func ValidateWindow(w *agentv1.MaintenanceWindow) error {
	if w == nil {
		return nil
	}
	if w.StartMinute > 1439 || w.DurationMinutes > 1440 || len(w.Days) > 7 {
		return bad("maintenance window out of range")
	}
	for _, d := range w.Days {
		if d > 6 {
			return bad("maintenance window day out of range")
		}
	}
	if w.Tz != "" {
		if _, err := time.LoadLocation(w.Tz); err != nil {
			return bad("unknown time zone")
		}
	}
	return nil
}

// ceilingName maps a job type to its name in the local policy ceiling.
func ceilingName(t agentv1.JobType) string {
	switch t {
	case agentv1.JobType_JOB_TYPE_INVENTORY_FULL:
		return "inventory"
	case agentv1.JobType_JOB_TYPE_SOFTWARE_INSTALL:
		return "software_install"
	case agentv1.JobType_JOB_TYPE_SOFTWARE_UNINSTALL:
		return "software_uninstall"
	case agentv1.JobType_JOB_TYPE_SOFTWARE_UPDATE:
		return "software_update"
	}
	return ""
}
