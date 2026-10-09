package deploy

import (
	"bytes"
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"

	"github.com/auzring1/renovatio/gen/dbq"
	agentv1 "github.com/auzring1/renovatio/gen/proto/renovatio/agent/v1"
	"github.com/auzring1/renovatio/internal/server/audit"
	"github.com/auzring1/renovatio/internal/server/catalog"
	"github.com/auzring1/renovatio/internal/server/inventory"
	"github.com/auzring1/renovatio/internal/server/store"
	"github.com/auzring1/renovatio/internal/shared/brand"
)

// Device-level actions that are not part of a catalog deployment: refresh a device, remove a
// program found by inventory, and list the updates the catalog can offer for a device.

var (
	ErrDeviceOffline = errors.New("deploy: the device is offline")
	ErrNotActive     = errors.New("deploy: the device is not an active, enrolled device")
)

// newJob builds the stored (unsigned) form of an ad-hoc job that belongs to no deployment.
func (s *Service) newJob(org, device uuid.UUID, sid string, typ agentv1.JobType, jobType, title string, body proto.Message, notBefore, expires time.Time) (dbq.InsertJobParams, error) {
	return s.newJobWindow(org, device, sid, typ, jobType, title, body, notBefore, expires, nil)
}

func (s *Service) newJobWindow(org, device uuid.UUID, sid string, typ agentv1.JobType, jobType, title string, body proto.Message, notBefore, expires time.Time, win *agentv1.MaintenanceWindow) (dbq.InsertJobParams, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return dbq.InsertJobParams{}, err
	}
	env := &agentv1.JobEnvelope{Version: 1, JobId: id.String(), OrgId: org.String(), DeviceId: device.String(), TargetUserSid: sid,
		Type: typ, Attempt: 1, NotBefore: notBefore.Unix(), ExpiresAt: expires.Unix(), Window: win}
	switch b := body.(type) {
	case *agentv1.UninstallBody:
		env.Body = &agentv1.JobEnvelope_Uninstall{Uninstall: b}
	case *agentv1.InventoryBody:
		env.Body = &agentv1.JobEnvelope_Inventory{Inventory: b}
	case *agentv1.WuScanBody:
		env.Body = &agentv1.JobEnvelope_WuScan{WuScan: b}
	case *agentv1.WuInstallBody:
		env.Body = &agentv1.JobEnvelope_WuInstall{WuInstall: b}
	case *agentv1.WuHideBody:
		env.Body = &agentv1.JobEnvelope_WuHide{WuHide: b}
	case *agentv1.RebootBody:
		env.Body = &agentv1.JobEnvelope_Reboot{Reboot: b}
	case *agentv1.AgentUpdateBody:
		env.Body = &agentv1.JobEnvelope_AgentUpdate{AgentUpdate: b}
	default:
		return dbq.InsertJobParams{}, errors.New("deploy: unsupported ad-hoc body")
	}
	raw, err := proto.MarshalOptions{Deterministic: true}.Marshal(env)
	if err != nil {
		return dbq.InsertJobParams{}, err
	}
	return dbq.InsertJobParams{ID: id, OrgID: org, DeviceID: device, UserSid: sid, Type: jobType, Title: title, Body: raw,
		NotBefore: notBefore, ExpiresAt: expires, Attempt: 1}, nil
}

func (s *Service) activeDevice(ctx context.Context, org, device uuid.UUID) (dbq.Device, error) {
	d, err := dbq.New(s.Pool).GetDeviceInOrg(ctx, dbq.GetDeviceInOrgParams{ID: device, OrgID: org})
	if err != nil {
		return d, ErrNotActive
	}
	if d.Status != "active" {
		return d, ErrNotActive
	}
	return d, nil
}

// RequestRefresh asks an online device to send its device, software and user information now. A
// refresh requested within the last two minutes is reused instead of queuing another.
func (s *Service) RequestRefresh(ctx context.Context, org, user, device uuid.UUID, ip string) (uuid.UUID, error) {
	d, err := s.activeDevice(ctx, org, device)
	if err != nil {
		return uuid.Nil, err
	}
	if !d.Online {
		return uuid.Nil, ErrDeviceOffline
	}
	q := dbq.New(s.Pool)
	if id, err := q.FindRecentRefresh(ctx, device); err == nil {
		return id, nil
	}
	now := s.now()
	j, err := s.newJob(org, device, "", agentv1.JobType_JOB_TYPE_INVENTORY_FULL, "inventory_full", "Refresh device information",
		&agentv1.InventoryBody{}, now, now.Add(15*time.Minute))
	if err != nil {
		return uuid.Nil, err
	}
	err = store.Tx(ctx, s.Pool, func(tx pgx.Tx, q *dbq.Queries) error {
		if err := q.InsertJob(ctx, j); err != nil {
			return err
		}
		_, err := audit.Write(ctx, tx, audit.Entry{OrgID: &org, ActorType: audit.ActorUser, ActorID: user.String(), ActorIP: ip,
			Action: "device.refresh", TargetType: "device", TargetIDs: []string{device.String()}, Outcome: audit.Success,
			Details: map[string]any{"hostname": d.Hostname}}, now)
		return err
	})
	if err != nil {
		return uuid.Nil, err
	}
	s.publish(org, "job.updated", device, j.ID, uuid.Nil)
	s.dispatchAsync(device)
	return j.ID, nil
}

// SoftwareRef identifies one inventory row of a device.
type SoftwareRef struct {
	Source  string `json:"source"`
	Scope   string `json:"scope"`
	UserSID string `json:"user_sid"`
	ItemKey string `json:"item_key"`
}

// UninstallResult is what UninstallSoftware did with each requested row.
type UninstallResult struct {
	JobIDs  []uuid.UUID `json:"job_ids"`
	Skipped []Skip      `json:"skipped"`
}

// UninstallSoftware queues one uninstall job per listed inventory row (no catalog package needed).
// The command is derived on the device from the row's own registry data (D45); system components
// (drivers, runtimes, updates hidden from Apps & features) are refused.
func (s *Service) UninstallSoftware(ctx context.Context, org, user, device uuid.UUID, ip string, refs []SoftwareRef) (*UninstallResult, error) {
	if len(refs) == 0 || len(refs) > 200 {
		return nil, invalid("choose between 1 and 200 programs")
	}
	d, err := s.activeDevice(ctx, org, device)
	if err != nil {
		return nil, err
	}
	q := dbq.New(s.Pool)
	now := s.now()
	expires := now.Add(72 * time.Hour)
	res := &UninstallResult{JobIDs: []uuid.UUID{}, Skipped: []Skip{}}
	var jobs []dbq.InsertJobParams
	var names []string
	for _, r := range refs {
		if r.Scope != "machine" && r.Scope != "user" || (r.Scope == "user") != (r.UserSID != "") {
			return nil, invalid("scope and user_sid disagree for %q", r.ItemKey)
		}
		row, err := q.GetDeviceInstall(ctx, dbq.GetDeviceInstallParams{DeviceID: device, Source: r.Source, Scope: r.Scope, UserSid: r.UserSID, ItemKey: r.ItemKey})
		if err != nil {
			res.Skipped = append(res.Skipped, Skip{Device: r.ItemKey, Reason: "not in this device's inventory (refresh and try again)"})
			continue
		}
		if row.SystemComponent {
			res.Skipped = append(res.Skipped, Skip{Device: row.Name, Reason: "system components cannot be removed from here"})
			continue
		}
		if r.Source == "appx" || r.Source == "portable" {
			res.Skipped = append(res.Skipped, Skip{Device: row.Name, Reason: "this kind of program (" + r.Source + ") cannot be uninstalled by " + brand.Name + " yet"})
			continue
		}
		sc := agentv1.InstallScope_INSTALL_SCOPE_MACHINE
		if r.Scope == "user" {
			sc = agentv1.InstallScope_INSTALL_SCOPE_USER
		}
		body := &agentv1.UninstallBody{Name: row.Name, Scope: sc, ItemSource: r.Source, ItemKey: r.ItemKey,
			Method: agentv1.UninstallMethod_UNINSTALL_METHOD_AUTO, TimeoutS: 3600, MaxRetries: 1, RetryBackoffS: 120}
		if r.Source == "msi" {
			body.ProductCode = r.ItemKey
		}
		j, err := s.newJob(org, device, r.UserSID, agentv1.JobType_JOB_TYPE_SOFTWARE_UNINSTALL, "software_uninstall", "Uninstall "+row.Name+" "+row.Version, body, now, expires)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, j)
		names = append(names, row.Name)
	}
	if len(jobs) == 0 {
		return res, nil
	}
	err = store.Tx(ctx, s.Pool, func(tx pgx.Tx, q *dbq.Queries) error {
		for _, j := range jobs {
			if err := q.InsertJob(ctx, j); err != nil {
				return err
			}
		}
		_, err := audit.Write(ctx, tx, audit.Entry{OrgID: &org, ActorType: audit.ActorUser, ActorID: user.String(), ActorIP: ip,
			Action: "software.uninstall", TargetType: "device", TargetIDs: []string{device.String()}, Outcome: audit.Success,
			Details: map[string]any{"hostname": d.Hostname, "programs": names}}, now)
		return err
	})
	if err != nil {
		return nil, err
	}
	for _, j := range jobs {
		res.JobIDs = append(res.JobIDs, j.ID)
		s.publish(org, "job.updated", device, j.ID, uuid.Nil)
	}
	s.dispatchAsync(device)
	return res, nil
}

// dispatchAsync hands queued jobs to the device without holding up the request.
func (s *Service) dispatchAsync(device uuid.UUID) {
	s.bg.Add(1)
	go func() { // #nosec G118 -- delivery to the device must outlive the HTTP request; Service.Wait tracks it
		defer s.bg.Done()
		s.Dispatch(context.Background(), device)
	}()
}

// AvailableUpdate is an installed program for which the catalog holds a newer version.
type AvailableUpdate struct {
	Name             string    `json:"name"`
	InstalledVersion string    `json:"installed_version"`
	Source           string    `json:"source"`
	Scope            string    `json:"scope"`
	UserSID          string    `json:"user_sid"`
	ItemKey          string    `json:"item_key"`
	PackageID        uuid.UUID `json:"package_id"`
	PackageName      string    `json:"package_name"`
	Identifier       string    `json:"identifier"`
	LatestVersion    string    `json:"latest_version"`
	Verified         bool      `json:"verified"`
	SelfUpdating     bool      `json:"self_updating"`
	// Deployable is false when Renovatio leaves this update to the vendor (a self-updating app).
	Deployable bool   `json:"deployable"`
	Reason     string `json:"reason,omitempty"`
}

// latestVersion is the newest version of a catalog package that an organization allows.
type latestVersion struct {
	ver      *dbq.CatalogVersion
	excluded bool
	enforce  bool
}

// catalogMatcher matches installed programs to imported catalog packages (by normalized name) and decides whether a
// program is older than the newest version its package's pin allows.
type catalogMatcher struct {
	ctx    context.Context
	q      *dbq.Queries
	org    uuid.UUID
	byName map[string][]dbq.CatalogPackage
	cache  map[uuid.UUID]latestVersion
}

func (s *Service) newCatalogMatcher(ctx context.Context, org uuid.UUID) (*catalogMatcher, error) {
	q := dbq.New(s.Pool)
	pkgs, err := q.ListAllOrgPackages(ctx, org)
	if err != nil {
		return nil, err
	}
	m := &catalogMatcher{ctx: ctx, q: q, org: org, byName: map[string][]dbq.CatalogPackage{}, cache: map[uuid.UUID]latestVersion{}}
	for _, p := range pkgs {
		n := inventory.NormalizeName(p.Name, "")
		m.byName[n] = append(m.byName[n], p)
	}
	return m, nil
}

// names lists the normalized package names, for narrowing a database query.
func (m *catalogMatcher) names() []string {
	out := make([]string, 0, len(m.byName))
	for n := range m.byName {
		out = append(out, n)
	}
	return out
}

func (m *catalogMatcher) latest(p dbq.CatalogPackage) latestVersion {
	if l, ok := m.cache[p.ID]; ok {
		return l
	}
	var l latestVersion
	pin := ""
	if ov, err := m.q.GetPackageOverride(m.ctx, dbq.GetPackageOverrideParams{OrgID: m.org, PackageID: p.ID}); err == nil {
		pin, l.excluded, l.enforce = ov.Pin, ov.Excluded, ov.SelfUpdatePolicy == "enforce"
	}
	if vs, err := m.q.ListPackageVersions(m.ctx, p.ID); err == nil {
		l.ver, _ = catalog.ChooseVersion(vs, "", pin)
	}
	m.cache[p.ID] = l
	return l
}

// outdated returns the package that has a newer allowed version than the installed one (the first match wins: one
// package per installed program).
func (m *catalogMatcher) outdated(normalizedName string, versionKey []byte) (dbq.CatalogPackage, latestVersion, bool) {
	for _, p := range m.byName[normalizedName] {
		l := m.latest(p)
		if l.ver == nil || l.excluded || versionKey == nil || bytes.Compare(versionKey, l.ver.VersionKey) >= 0 {
			continue
		}
		return p, l, true
	}
	return dbq.CatalogPackage{}, latestVersion{}, false
}

// DeviceUpdates matches a device's installed programs to imported catalog packages (by normalized
// name) and returns those that are older than the newest version the package's pin allows.
func (s *Service) DeviceUpdates(ctx context.Context, org, device uuid.UUID) ([]AvailableUpdate, error) {
	q := dbq.New(s.Pool)
	rows, err := q.ListDeviceInstallRows(ctx, device)
	if err != nil {
		return nil, err
	}
	m, err := s.newCatalogMatcher(ctx, org)
	if err != nil {
		return nil, err
	}
	out := []AvailableUpdate{}
	for _, r := range rows {
		p, l, ok := m.outdated(r.NormalizedName, r.VersionKey)
		if !ok {
			continue
		}
		u := AvailableUpdate{Name: r.Name, InstalledVersion: r.Version, Source: r.Source, Scope: r.Scope, UserSID: r.UserSid, ItemKey: r.ItemKey,
			PackageID: p.ID, PackageName: p.Name, Identifier: p.Identifier, LatestVersion: l.ver.Version, Verified: p.Verified,
			SelfUpdating: p.SelfUpdating, Deployable: true}
		if p.SelfUpdating && !l.enforce {
			u.Deployable, u.Reason = false, "updates itself; left to the vendor's updater"
		}
		out = append(out, u)
	}
	return out, nil
}

// FleetUpdateDevice is one device that has an older version of a package installed.
type FleetUpdateDevice struct {
	DeviceID         uuid.UUID `json:"device_id"`
	Hostname         string    `json:"hostname"`
	InstalledVersion string    `json:"installed_version"`
	Scope            string    `json:"scope"`
}

// FleetUpdate is a catalog package that is out of date on at least one active device.
type FleetUpdate struct {
	PackageID     uuid.UUID `json:"package_id"`
	PackageName   string    `json:"package_name"`
	Identifier    string    `json:"identifier"`
	LatestVersion string    `json:"latest_version"`
	Verified      bool      `json:"verified"`
	SelfUpdating  bool      `json:"self_updating"`
	// Deployable is false when Renovatio leaves this update to the vendor (a self-updating app).
	Deployable bool                `json:"deployable"`
	Reason     string              `json:"reason,omitempty"`
	Devices    []FleetUpdateDevice `json:"devices"`
}

// FleetUpdates lists, per catalog package, the active devices that have an older version installed. Packages that are
// current everywhere are left out. Most devices first.
func (s *Service) FleetUpdates(ctx context.Context, org uuid.UUID) ([]FleetUpdate, error) {
	m, err := s.newCatalogMatcher(ctx, org)
	if err != nil {
		return nil, err
	}
	names := m.names()
	if len(names) == 0 {
		return []FleetUpdate{}, nil
	}
	rows, err := dbq.New(s.Pool).ListFleetInstallRows(ctx, dbq.ListFleetInstallRowsParams{OrgID: org, Names: names})
	if err != nil {
		return nil, err
	}
	byPkg := map[uuid.UUID]*FleetUpdate{}
	var order []uuid.UUID
	for _, r := range rows {
		p, l, ok := m.outdated(r.NormalizedName, r.VersionKey)
		if !ok {
			continue
		}
		f := byPkg[p.ID]
		if f == nil {
			f = &FleetUpdate{PackageID: p.ID, PackageName: p.Name, Identifier: p.Identifier, LatestVersion: l.ver.Version, Verified: p.Verified,
				SelfUpdating: p.SelfUpdating, Deployable: true, Devices: []FleetUpdateDevice{}}
			if p.SelfUpdating && !l.enforce {
				f.Deployable, f.Reason = false, "updates itself; left to the vendor's updater"
			}
			byPkg[p.ID] = f
			order = append(order, p.ID)
		}
		f.Devices = append(f.Devices, FleetUpdateDevice{DeviceID: r.DeviceID, Hostname: r.Hostname, InstalledVersion: r.Version, Scope: r.Scope})
	}
	out := make([]FleetUpdate, 0, len(order))
	for _, id := range order {
		out = append(out, *byPkg[id])
	}
	sort.SliceStable(out, func(i, j int) bool {
		if len(out[i].Devices) != len(out[j].Devices) {
			return len(out[i].Devices) > len(out[j].Devices)
		}
		return strings.ToLower(out[i].PackageName) < strings.ToLower(out[j].PackageName)
	})
	return out, nil
}

// JobSpec describes an ad-hoc job (no deployment) for NewJob.
type JobSpec struct {
	Type      agentv1.JobType
	DBType    string // the jobs.type value: wu_scan, wu_install, wu_hide, reboot, ...
	Title     string
	Body      proto.Message
	NotBefore time.Time
	Expires   time.Time
	Window    *agentv1.MaintenanceWindow
}

// NewJob builds the stored form of an ad-hoc machine-scope job so the caller can insert it in its
// own transaction (and call Dispatch afterwards).
func (s *Service) NewJob(org, device uuid.UUID, sp JobSpec) (dbq.InsertJobParams, error) {
	return s.newJobWindow(org, device, "", sp.Type, sp.DBType, sp.Title, sp.Body, sp.NotBefore, sp.Expires, sp.Window)
}

// WindowProto converts a console maintenance window to its wire form after range checks.
func WindowProto(w *Window) (*agentv1.MaintenanceWindow, error) {
	if w == nil {
		return nil, nil
	}
	if w.StartMinute < 0 || w.StartMinute > 1439 || w.DurationMinutes < 1 || w.DurationMinutes > 1440 || len(w.Days) > 7 {
		return nil, invalid("maintenance window out of range")
	}
	out := &agentv1.MaintenanceWindow{StartMinute: uint32(w.StartMinute), DurationMinutes: uint32(w.DurationMinutes), Tz: w.TZ} // #nosec G115 -- bounded above
	for _, d := range w.Days {
		if d < 0 || d > 6 {
			return nil, invalid("maintenance window day out of range")
		}
		out.Days = append(out.Days, uint32(d)) // #nosec G115 -- bounded above
	}
	if w.TZ != "" {
		if _, err := time.LoadLocation(w.TZ); err != nil {
			return nil, invalid("unknown time zone")
		}
	}
	return out, nil
}

// Publish lets other services emit job events for the console.
func (s *Service) Publish(org uuid.UUID, typ string, device, job, dep uuid.UUID) {
	s.publish(org, typ, device, job, dep)
}

// DispatchAsync hands queued jobs to the device without holding up the caller.
func (s *Service) DispatchAsync(device uuid.UUID) { s.dispatchAsync(device) }
