// Package licensing turns the installed license (an offline-verifiable, vendor-signed document) into
// the installation's effective state and enforces its one hard rule: a license problem only ever
// stops NEW devices from being enrolled or approved.
//
// What it never does (decision D85, docs/SECURITY.md §9g): stop jobs, security updates, inventory,
// existing devices, sign-in, revocation or uninstalling. There is no phone-home (O9); the license
// is verified locally against the vendor key compiled into the server.
package licensing

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/auzring1/auzring/gen/dbq"
	"github.com/auzring1/auzring/internal/server/audit"
	"github.com/auzring1/auzring/internal/server/store"
	"github.com/auzring1/auzring/internal/shared/license"
)

// Default policy (decision D85; the business model is still open decision O8).
const (
	// EvaluationMaxDevices is the cap without a usable license.
	EvaluationMaxDevices = 25
	// GracePeriod is how long an expired subscription keeps its cap before it falls back to evaluation.
	GracePeriod = 30 * 24 * time.Hour
	// maxClockAdvance bounds how far the stored high-water clock moves in one step, so a clock that
	// briefly jumped far into the future cannot expire a license for good.
	maxClockAdvance = 36 * time.Hour
)

// State is the installation's licensing state.
type State string

const (
	// Licensed: a valid license is installed and in its term.
	Licensed State = "licensed"
	// Grace: the subscription ended less than GracePeriod ago; its device cap still applies.
	Grace State = "grace"
	// Evaluation: no license, or the subscription ended more than GracePeriod ago. Capped at
	// EvaluationMaxDevices.
	Evaluation State = "evaluation"
	// Invalid: a license is installed but cannot be used (signature does not verify under a key this
	// build trusts, not valid yet, or this build has no license key). Behaves as Evaluation.
	Invalid State = "invalid"
)

// Errors the API maps to HTTP statuses.
var (
	ErrInvalid  = errors.New("licensing: invalid license")
	ErrConflict = errors.New("licensing: conflict")
	// ErrUpdatesEnded: a release is not covered by the license's updates_until.
	ErrUpdatesEnded = errors.New("licensing: release not covered by the license")
)

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, a...))
}

// Info describes the installed license (only for a license whose signature verified).
type Info struct {
	LicenseID    string     `json:"license_id"`
	Licensee     string     `json:"licensee"`
	IssuedAt     time.Time  `json:"issued_at"`
	NotBefore    time.Time  `json:"not_before"`
	ExpiresAt    *time.Time `json:"expires_at"`
	MaxDevices   int        `json:"max_devices"`
	Features     []string   `json:"features"`
	UpdatesUntil *time.Time `json:"updates_until"`
	Notes        string     `json:"notes"`
	KeyID        string     `json:"key_id"`
	InstalledAt  time.Time  `json:"installed_at"`
}

// Status is the effective licensing state of one organization.
type Status struct {
	State State `json:"state"`
	// Message says in a sentence why the state is what it is.
	Message string `json:"message"`
	// Configured is false when this build contains no vendor license key ("licensing not configured").
	Configured bool `json:"configured"`
	// MaxDevices is the cap on enrolled devices that currently applies.
	MaxDevices int `json:"max_devices"`
	// Devices is the number of enrolled (active) devices; PendingDevices await approval.
	Devices        int `json:"devices"`
	PendingDevices int `json:"pending_devices"`
	// AtCapacity: no free slot (new enrollments and approvals are refused). OverCapacity: more
	// devices than the cap (possible after a smaller license was installed); existing ones keep working.
	AtCapacity           bool       `json:"at_capacity"`
	OverCapacity         bool       `json:"over_capacity"`
	GraceEndsAt          *time.Time `json:"grace_ends_at"`
	EvaluationMaxDevices int        `json:"evaluation_max_devices"`
	// Features that the license grants right now (empty without a usable license).
	Features []string `json:"features"`
	License  *Info    `json:"license"`

	// Now is the clock the decision used (the later of the system clock and the stored high-water mark).
	Now time.Time `json:"now"`

	doc *license.Document
}

// LimitError is returned when a new device cannot be enrolled or approved.
type LimitError struct{ Status Status }

func (e *LimitError) Error() string {
	s := e.Status
	var why string
	switch {
	case s.State == Licensed || s.State == Grace:
		why = fmt.Sprintf("the installed license covers %d devices", s.MaxDevices)
	case s.License != nil || !s.Configured:
		why = fmt.Sprintf("the installed license cannot be used (%s), so the evaluation limit of %d devices applies", s.Message, s.MaxDevices)
	default:
		why = fmt.Sprintf("this installation is unlicensed (evaluation) and limited to %d devices", s.MaxDevices)
	}
	return fmt.Sprintf("device limit reached: %s and %d are enrolled. An administrator can install a license under License in the console to enroll more devices. Devices that are already enrolled keep working.", why, s.Devices)
}

// Service computes the licensing state and installs licenses.
type Service struct {
	Pool *pgxpool.Pool
	// Keys are the trusted vendor license public keys (default: those compiled into this build).
	Keys []ed25519.PublicKey
	Now  func() time.Time
	Log  *slog.Logger

	mu        sync.Mutex
	lastState map[uuid.UUID]State
}

// New returns a service trusting the compiled-in keys plus any extra keys (hex, comma-separated) from
// AUZ_LICENSE_PUBLIC_KEYS (test and demo keys).
func New(pool *pgxpool.Pool, extraKeysHex string, log *slog.Logger) (*Service, error) {
	extra, err := license.ParseKeys(extraKeysHex)
	if err != nil {
		return nil, err
	}
	return &Service{Pool: pool, Keys: append(license.TrustedKeys(), extra...), Log: log}, nil
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Service) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

func (s *Service) keys() []ed25519.PublicKey {
	if s.Keys != nil {
		return s.Keys
	}
	return license.TrustedKeys()
}

// effectiveNow is the later of the system clock and the highest time the server has ever recorded:
// turning the clock back does not revive an expired subscription.
func (s *Service) effectiveNow(ctx context.Context, q *dbq.Queries) time.Time {
	now := s.now()
	if hw, err := q.GetLicenseClock(ctx); err == nil && hw.After(now) {
		return hw
	}
	return now
}

// StatusIn computes the state with the given queries (inside a transaction when the caller holds one).
func (s *Service) StatusIn(ctx context.Context, q *dbq.Queries, org uuid.UUID) (Status, error) {
	now := s.effectiveNow(ctx, q)
	st := Status{State: Evaluation, Configured: len(s.keys()) > 0, MaxDevices: EvaluationMaxDevices,
		EvaluationMaxDevices: EvaluationMaxDevices, Features: []string{}, Now: now}
	row, err := q.GetCurrentLicense(ctx, org)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		if st.Configured {
			st.Message = "No license is installed."
		} else {
			st.Message = "Licensing is not configured in this build, so this installation runs unlicensed."
		}
	case err != nil:
		return st, err
	default:
		s.apply(&st, row, now)
	}
	counts, err := q.CountLicenseDevices(ctx, org)
	if err != nil {
		return st, err
	}
	st.Devices, st.PendingDevices = int(counts.Active), int(counts.Pending)
	st.AtCapacity = st.Devices >= st.MaxDevices
	st.OverCapacity = st.Devices > st.MaxDevices
	return st, nil
}

// apply folds the installed license into st.
func (s *Service) apply(st *Status, row dbq.License, now time.Time) {
	v, err := license.Verify(s.keys(), row.Blob)
	if err != nil {
		st.State = Invalid
		if errors.Is(err, license.ErrNotConfigured) {
			st.Message = "Licensing is not configured in this build, so the installed license cannot be verified."
		} else {
			st.Message = "The installed license could not be verified: " + trimPrefix(err.Error()) + "."
		}
		return
	}
	d := v.Doc
	st.doc = d
	info := &Info{LicenseID: d.LicenseID, Licensee: d.Licensee, IssuedAt: time.Unix(d.IssuedAt, 0).UTC(), NotBefore: time.Unix(d.NotBefore, 0).UTC(),
		MaxDevices: d.MaxDevices, Features: d.Features, Notes: d.Notes, KeyID: v.KeyID, InstalledAt: row.InstalledAt}
	if t, ok := d.ExpiryTime(); ok {
		info.ExpiresAt = &t
	}
	if t, ok := d.UpdatesUntilTime(); ok {
		info.UpdatesUntil = &t
	}
	st.License = info
	switch d.At(now) {
	case license.NotYetValid:
		st.State = Invalid
		st.Message = "The installed license is not valid until " + info.NotBefore.Format("2006-01-02") + "."
	case license.Valid:
		st.State, st.MaxDevices, st.Features = Licensed, d.MaxDevices, d.Features
		st.Message = fmt.Sprintf("Licensed to %s for %d devices.", d.Licensee, d.MaxDevices)
	case license.Expired:
		end := info.ExpiresAt.Add(GracePeriod)
		if now.Before(end) {
			st.State, st.MaxDevices, st.Features, st.GraceEndsAt = Grace, d.MaxDevices, d.Features, &end
			st.Message = fmt.Sprintf("The subscription ended on %s. The license still applies until %s; renew it before then.",
				info.ExpiresAt.Format("2006-01-02"), end.Format("2006-01-02"))
		} else {
			st.State = Evaluation
			st.Message = fmt.Sprintf("The subscription ended on %s and the %d-day grace period is over, so the evaluation limit applies.",
				info.ExpiresAt.Format("2006-01-02"), int(GracePeriod/(24*time.Hour)))
		}
	}
}

func trimPrefix(s string) string {
	const p = "license: "
	if len(s) > len(p) && s[:len(p)] == p {
		return s[len(p):]
	}
	return s
}

// Status computes the state of org.
func (s *Service) Status(ctx context.Context, org uuid.UUID) (Status, error) {
	return s.StatusIn(ctx, dbq.New(s.Pool), org)
}

// CheckNewDevice decides whether one more device may become active in org. It must run inside the
// transaction that creates or approves the device: it takes a per-organization lock first, so two
// concurrent requests cannot both use the last slot. replaces is the active device a re-enrolling
// machine will replace (net zero, always allowed).
//
// This is the ONLY place the device cap is enforced.
func (s *Service) CheckNewDevice(ctx context.Context, q *dbq.Queries, org uuid.UUID, replaces *uuid.UUID) error {
	if err := q.LockLicenseCapacity(ctx, org.String()); err != nil {
		return err
	}
	if replaces != nil {
		if old, err := q.GetDeviceInOrg(ctx, dbq.GetDeviceInOrgParams{ID: *replaces, OrgID: org}); err == nil && old.Status == "active" {
			return nil
		}
	}
	st, err := s.StatusIn(ctx, q, org)
	if err != nil {
		return err
	}
	if st.Devices >= st.MaxDevices {
		return &LimitError{Status: st}
	}
	return nil
}

// Actor is who installs a license (for audit).
type Actor struct {
	Org  uuid.UUID
	User uuid.UUID
	IP   string
}

// Install verifies a pasted license and, when it is usable, makes it the one in force. Every
// attempt is audited (license.install, or license.invalid for a refused one); history is kept.
func (s *Service) Install(ctx context.Context, a Actor, blob string) (Status, error) {
	now := s.now()
	fail := func(reason string, err error) (Status, error) {
		_ = audit.Log(ctx, s.Pool, audit.Entry{OrgID: &a.Org, ActorType: audit.ActorUser, ActorID: a.User.String(), ActorIP: a.IP, Action: "license.invalid",
			TargetType: "license", Outcome: audit.Denied, Details: map[string]any{"reason": reason}})
		return Status{}, err
	}
	keys := s.keys()
	v, err := license.Verify(keys, blob)
	if err != nil {
		if errors.Is(err, license.ErrNotConfigured) {
			return fail("not_configured", invalid("licensing is not configured in this build, so licenses cannot be installed"))
		}
		return fail("verification_failed", invalid("%s", trimPrefix(err.Error())))
	}
	q := dbq.New(s.Pool)
	eff := s.effectiveNow(ctx, q)
	d := v.Doc
	switch d.At(eff) {
	case license.NotYetValid:
		return fail("not_yet_valid", invalid("this license is not valid until %s", time.Unix(d.NotBefore, 0).UTC().Format("2006-01-02")))
	case license.Expired:
		if exp, _ := d.ExpiryTime(); !eff.Before(exp.Add(GracePeriod)) {
			return fail("expired", invalid("this license expired on %s", exp.Format("2006-01-02")))
		}
	}
	id, err := uuid.NewV7()
	if err != nil {
		return Status{}, err
	}
	err = store.Tx(ctx, s.Pool, func(tx pgx.Tx, q *dbq.Queries) error {
		if cur, err := q.GetCurrentLicense(ctx, a.Org); err == nil {
			if old, err := license.Verify(keys, cur.Blob); err == nil && old.Doc.LicenseID == d.LicenseID && old.Doc.IssuedAt >= d.IssuedAt {
				return fmt.Errorf("%w: this license (or a newer revision of it) is already installed", ErrConflict)
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err := q.InsertLicense(ctx, dbq.InsertLicenseParams{ID: id, OrgID: a.Org, LicenseID: d.LicenseID, KeyID: v.KeyID, Blob: v.Raw, InstalledBy: &a.User, InstalledAt: now}); err != nil {
			return err
		}
		det := map[string]any{"license_id": d.LicenseID, "licensee": d.Licensee, "max_devices": d.MaxDevices, "key_id": v.KeyID}
		if t, ok := d.ExpiryTime(); ok {
			det["expires_at"] = t.Format(time.RFC3339)
		}
		_, err := audit.Write(ctx, tx, audit.Entry{OrgID: &a.Org, ActorType: audit.ActorUser, ActorID: a.User.String(), ActorIP: a.IP, Action: "license.install",
			TargetType: "license", TargetIDs: []string{id.String()}, Outcome: audit.Success, Details: det}, now)
		return err
	})
	if err != nil {
		if errors.Is(err, ErrConflict) {
			_ = audit.Log(ctx, s.Pool, audit.Entry{OrgID: &a.Org, ActorType: audit.ActorUser, ActorID: a.User.String(), ActorIP: a.IP, Action: "license.invalid",
				TargetType: "license", Outcome: audit.Denied, Details: map[string]any{"reason": "already_installed", "license_id": d.LicenseID}})
		}
		return Status{}, err
	}
	_ = s.advanceTo(ctx, now)
	return s.Status(ctx, a.Org)
}

// HistoryItem is one installed license.
type HistoryItem struct {
	ID           uuid.UUID  `json:"id"`
	LicenseID    string     `json:"license_id"`
	Licensee     string     `json:"licensee"`
	MaxDevices   int        `json:"max_devices"`
	ExpiresAt    *time.Time `json:"expires_at"`
	UpdatesUntil *time.Time `json:"updates_until"`
	KeyID        string     `json:"key_id"`
	InstalledAt  time.Time  `json:"installed_at"`
	InstalledBy  string     `json:"installed_by"`
	// Current marks the license in force.
	Current bool `json:"current"`
}

// History lists installed licenses, newest first. The documents are parsed without re-checking the
// signature (they were verified when installed; the current state is shown by Status).
func (s *Service) History(ctx context.Context, org uuid.UUID) ([]HistoryItem, error) {
	rows, err := dbq.New(s.Pool).ListLicenses(ctx, org)
	if err != nil {
		return nil, err
	}
	out := make([]HistoryItem, 0, len(rows))
	for i, r := range rows {
		it := HistoryItem{ID: r.ID, LicenseID: r.LicenseID, KeyID: r.KeyID, InstalledAt: r.InstalledAt, Current: i == 0}
		if r.InstalledByEmail != nil {
			it.InstalledBy = *r.InstalledByEmail
		}
		if d, err := license.ParseUnverified(r.Blob); err == nil {
			it.Licensee, it.MaxDevices = d.Licensee, d.MaxDevices
			if t, ok := d.ExpiryTime(); ok {
				it.ExpiresAt = &t
			}
			if t, ok := d.UpdatesUntilTime(); ok {
				it.UpdatesUntil = &t
			}
		}
		out = append(out, it)
	}
	return out, nil
}

// CheckRelease reports whether an agent release published at releasedAt (unix seconds from the signed
// manifest, 0 = none) is covered by org's license. It is used ONLY for agent self-update rollout:
// a lapsed updates entitlement must never hold back Windows, driver or software updates.
// Without a license (evaluation) every release is eligible.
func (s *Service) CheckRelease(ctx context.Context, org uuid.UUID, version string, releasedAt int64) error {
	st, err := s.Status(ctx, org)
	if err != nil {
		return err
	}
	if st.doc == nil || st.doc.UpdatesEligible(releasedAt) {
		return nil
	}
	until, _ := st.doc.UpdatesUntilTime()
	if releasedAt <= 0 {
		return fmt.Errorf("%w: agent release %s carries no publication date, so it cannot be shown to be inside the license's update period (updates until %s)",
			ErrUpdatesEnded, version, until.Format("2006-01-02"))
	}
	return fmt.Errorf("%w: agent release %s was published on %s, after the end of this license's update period (%s). Renew or upgrade the license to roll out newer agent releases. Windows, driver and software updates are not affected",
		ErrUpdatesEnded, version, time.Unix(releasedAt, 0).UTC().Format("2006-01-02"), until.Format("2006-01-02"))
}

// advanceTo moves the stored high-water mark up to now, by at most maxClockAdvance per call.
func (s *Service) advanceTo(ctx context.Context, now time.Time) error {
	q := dbq.New(s.Pool)
	hw, err := q.GetLicenseClock(ctx)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return q.AdvanceLicenseClock(ctx, now)
	case err != nil:
		return err
	case now.After(hw):
		next := now
		if now.Sub(hw) > maxClockAdvance {
			next = hw.Add(maxClockAdvance)
		}
		return q.AdvanceLicenseClock(ctx, next)
	}
	return nil
}

// Tick records the highest observed time and logs state changes. Run it about once a minute.
func (s *Service) Tick(ctx context.Context) {
	q := dbq.New(s.Pool)
	if err := s.advanceTo(ctx, s.now()); err != nil {
		s.log().Error("license clock", "err", err)
		return
	}
	orgs, err := q.ListOrgIDs(ctx)
	if err != nil {
		return
	}
	for _, org := range orgs {
		st, err := s.StatusIn(ctx, q, org)
		if err != nil {
			continue
		}
		s.mu.Lock()
		if s.lastState == nil {
			s.lastState = map[uuid.UUID]State{}
		}
		prev, seen := s.lastState[org]
		s.lastState[org] = st.State
		s.mu.Unlock()
		if !seen || prev != st.State {
			s.log().Info("license state", "org", org, "state", st.State, "max_devices", st.MaxDevices, "devices", st.Devices, "detail", st.Message)
		}
	}
}
