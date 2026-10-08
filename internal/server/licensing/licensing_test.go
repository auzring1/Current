package licensing

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/auzring1/auzring/gen/dbq"
	"github.com/auzring1/auzring/internal/server/store"
	"github.com/auzring1/auzring/internal/shared/license"
	"github.com/auzring1/auzring/internal/testutil/pgtest"
)

var t0 = time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

type fx struct {
	t    *testing.T
	svc  *Service
	db   *pgtest.DB
	org  uuid.UUID
	user uuid.UUID
	site uuid.UUID
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
	mu   sync.Mutex
	now  time.Time
}

func (f *fx) clock() time.Time { f.mu.Lock(); defer f.mu.Unlock(); return f.now }
func (f *fx) set(t time.Time)  { f.mu.Lock(); f.now = t; f.mu.Unlock() }

func newFx(t *testing.T) *fx {
	db := pgtest.New(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	f := &fx{t: t, db: db, org: uuid.New(), user: uuid.New(), site: uuid.New(), pub: pub, priv: priv, now: t0}
	f.svc = &Service{Pool: db.Pool, Keys: []ed25519.PublicKey{pub}, Now: f.clock}
	f.exec("INSERT INTO organizations (id, name) VALUES ($1, 'o')", f.org)
	f.exec("INSERT INTO users (id, org_id, email, display_name, password_hash) VALUES ($1, $2, $3, 'A', 'x')", f.user, f.org, f.user.String()+"@example.com")
	f.exec("INSERT INTO sites (id, org_id, name) VALUES ($1, $2, 's')", f.site, f.org)
	return f
}

func (f *fx) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.svc.Pool.Exec(context.Background(), sql, args...); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fx) count(sql string, args ...any) int {
	f.t.Helper()
	var n int
	if err := f.svc.Pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func (f *fx) devices(n int, status string) []uuid.UUID {
	var ids []uuid.UUID
	for i := 0; i < n; i++ {
		id := uuid.New()
		f.exec("INSERT INTO devices (id, org_id, site_id, status, hostname, arch, online) VALUES ($1,$2,$3,$4,$5,'amd64',false)",
			id, f.org, f.site, status, "h-"+id.String()[:8])
		ids = append(ids, id)
	}
	return ids
}

func i64(v int64) *int64 { return &v }

// issue signs a license with the fixture key (or another).
func (f *fx) issue(mut func(d *license.Document)) string { return f.issueWith(f.priv, mut) }

func (f *fx) issueWith(key ed25519.PrivateKey, mut func(d *license.Document)) string {
	f.t.Helper()
	d := &license.Document{Format: 1, LicenseID: "LIC-1", Licensee: "Acme", IssuedAt: t0.Unix(), NotBefore: t0.Unix(), MaxDevices: 100,
		Features: []string{}, ExpiresAt: i64(t0.AddDate(1, 0, 0).Unix())}
	if mut != nil {
		mut(d)
	}
	b, err := license.Marshal(d)
	if err != nil {
		f.t.Fatal(err)
	}
	return license.Encode(b, license.Sign(key, b))
}

func (f *fx) actor() Actor { return Actor{Org: f.org, User: f.user, IP: "127.0.0.1"} }

func (f *fx) status() Status {
	f.t.Helper()
	st, err := f.svc.Status(context.Background(), f.org)
	if err != nil {
		f.t.Fatal(err)
	}
	return st
}

func (f *fx) install(blob string) Status {
	f.t.Helper()
	st, err := f.svc.Install(context.Background(), f.actor(), blob)
	if err != nil {
		f.t.Fatalf("install: %v", err)
	}
	return st
}

// check runs the new-device check the way the enrollment and approval paths do.
func (f *fx) check(replaces *uuid.UUID) error {
	return store.Tx(context.Background(), f.svc.Pool, func(_ pgx.Tx, q *dbq.Queries) error {
		return f.svc.CheckNewDevice(context.Background(), q, f.org, replaces)
	})
}

func TestUnlicensedEvaluationCap(t *testing.T) {
	f := newFx(t)
	st := f.status()
	if st.State != Evaluation || st.MaxDevices != 25 || st.Devices != 0 || st.License != nil || !st.Configured {
		t.Fatalf("fresh install: %+v", st)
	}
	f.devices(24, "active")
	f.devices(5, "pending") // pending devices do not use a slot
	f.devices(3, "revoked") // nor do revoked ones
	if err := f.check(nil); err != nil {
		t.Fatalf("slot 25 refused: %v", err)
	}
	f.devices(1, "active")
	st = f.status()
	if st.Devices != 25 || st.PendingDevices != 5 || !st.AtCapacity || st.OverCapacity {
		t.Fatalf("at the cap: %+v", st)
	}
	var le *LimitError
	err := f.check(nil)
	if !errors.As(err, &le) || !strings.Contains(err.Error(), "limited to 25 devices") || !strings.Contains(err.Error(), "keep working") {
		t.Fatalf("slot 26 must be refused with a clear message: %v", err)
	}
}

func TestReplacementOfActiveDeviceIsAlwaysAllowed(t *testing.T) {
	f := newFx(t)
	ids := f.devices(25, "active")
	if err := f.check(&ids[0]); err != nil {
		t.Fatalf("a replacement is net zero: %v", err)
	}
	revoked := f.devices(1, "revoked")
	if err := f.check(&revoked[0]); err == nil {
		t.Fatal("replacing a device that is no longer active frees no slot")
	}
}

func TestInstallLiftsTheCapAndIsAudited(t *testing.T) {
	f := newFx(t)
	f.devices(25, "active")
	if f.check(nil) == nil {
		t.Fatal("setup: expected the cap")
	}
	st := f.install(f.issue(func(d *license.Document) { d.MaxDevices = 100; d.Features = []string{"reports.export"} }))
	if st.State != Licensed || st.MaxDevices != 100 || st.Devices != 25 || st.AtCapacity || st.License == nil || st.License.Licensee != "Acme" {
		t.Fatalf("after install: %+v", st)
	}
	if len(st.Features) != 1 || st.Features[0] != "reports.export" {
		t.Fatalf("features: %v", st.Features)
	}
	if err := f.check(nil); err != nil {
		t.Fatalf("licensed install refused a device: %v", err)
	}
	if n := f.count("SELECT count(*) FROM audit_log WHERE action='license.install' AND outcome='success'"); n != 1 {
		t.Fatalf("license.install audit entries: %d", n)
	}
	h, err := f.svc.History(context.Background(), f.org)
	if err != nil || len(h) != 1 || !h[0].Current || h[0].MaxDevices != 100 || h[0].InstalledBy == "" {
		t.Fatalf("history: %+v %v", h, err)
	}
}

func TestSmallerLicenseKeepsExistingDevices(t *testing.T) {
	f := newFx(t)
	f.devices(40, "active")
	f.install(f.issue(func(d *license.Document) { d.LicenseID = "LIC-A"; d.MaxDevices = 40 }))
	st := f.install(f.issue(func(d *license.Document) { d.LicenseID = "LIC-B"; d.MaxDevices = 30 }))
	if st.Devices != 40 || st.MaxDevices != 30 || !st.OverCapacity || !st.AtCapacity || st.State != Licensed {
		t.Fatalf("over the cap: %+v", st)
	}
	if f.check(nil) == nil {
		t.Fatal("a new device must be refused when over the cap")
	}
	// Nothing was removed or disabled.
	if n := f.count("SELECT count(*) FROM devices WHERE org_id=$1 AND status='active'", f.org); n != 40 {
		t.Fatalf("existing devices changed: %d", n)
	}
	h, _ := f.svc.History(context.Background(), f.org)
	if len(h) != 2 || !h[0].Current || h[0].LicenseID != "LIC-B" || h[1].Current {
		t.Fatalf("history keeps both: %+v", h)
	}
}

func TestExpiryGraceAndFallback(t *testing.T) {
	f := newFx(t)
	exp := t0.AddDate(0, 6, 0)
	f.install(f.issue(func(d *license.Document) {
		d.ExpiresAt = i64(exp.Unix())
		d.MaxDevices = 200
		d.Features = []string{"x"}
	}))
	f.devices(50, "active")
	at := func(d time.Time) Status { f.set(d); return f.status() }

	if st := at(exp.Add(-time.Hour)); st.State != Licensed || st.MaxDevices != 200 {
		t.Fatalf("before expiry: %+v", st)
	}
	// One day of clock-skew tolerance, then grace.
	if st := at(exp.Add(12 * time.Hour)); st.State != Licensed {
		t.Fatalf("inside skew: %+v", st)
	}
	st := at(exp.Add(48 * time.Hour))
	if st.State != Grace || st.MaxDevices != 200 || st.GraceEndsAt == nil || !st.GraceEndsAt.Equal(exp.Add(GracePeriod)) || len(st.Features) != 1 {
		t.Fatalf("grace: %+v", st)
	}
	if err := f.check(nil); err != nil {
		t.Fatalf("grace keeps the licensed cap: %v", err)
	}
	st = at(exp.Add(GracePeriod - time.Hour))
	if st.State != Grace {
		t.Fatalf("last hour of grace: %+v", st)
	}
	st = at(exp.Add(GracePeriod + time.Hour))
	if st.State != Evaluation || st.MaxDevices != 25 || !st.OverCapacity || len(st.Features) != 0 || st.License == nil {
		t.Fatalf("after grace: %+v", st)
	}
	if !strings.Contains(st.Message, "grace period is over") {
		t.Fatalf("message: %q", st.Message)
	}
	var le *LimitError
	if err := f.check(nil); !errors.As(err, &le) {
		t.Fatalf("after grace new devices are capped: %v", err)
	}
	if n := f.count("SELECT count(*) FROM devices WHERE status='active'"); n != 50 {
		t.Fatal("existing devices must be untouched")
	}
}

func TestClockRollbackDoesNotReviveAnExpiredLicense(t *testing.T) {
	f := newFx(t)
	exp := t0.AddDate(0, 3, 0)
	f.install(f.issue(func(d *license.Document) { d.ExpiresAt = i64(exp.Unix()) }))
	late := exp.Add(GracePeriod + 24*time.Hour)
	// Time passes normally; the minute tick records how far the server has seen it go.
	for c := t0; c.Before(late); c = c.Add(30 * time.Hour) {
		f.set(c)
		if err := f.svc.advanceTo(context.Background(), c); err != nil {
			t.Fatal(err)
		}
	}
	f.set(late)
	if err := f.svc.advanceTo(context.Background(), late); err != nil {
		t.Fatal(err)
	}
	if st := f.status(); st.State != Evaluation {
		t.Fatalf("setup: %+v", st)
	}
	f.set(t0.Add(24 * time.Hour)) // an administrator turns the clock back
	st := f.status()
	if st.State != Evaluation || !st.Now.Equal(late) {
		t.Fatalf("a rolled-back clock revived the license: %+v", st)
	}
}

func TestClockAdvanceIsBounded(t *testing.T) {
	f := newFx(t)
	f.svc.Tick(context.Background())
	f.set(t0.AddDate(5, 0, 0)) // a clock that briefly jumped far ahead
	f.svc.Tick(context.Background())
	q := dbq.New(f.svc.Pool)
	hw, err := q.GetLicenseClock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if hw.After(t0.Add(maxClockAdvance)) {
		t.Fatalf("one tick moved the high-water mark by %s", hw.Sub(t0))
	}
}

func TestInstallRefusals(t *testing.T) {
	f := newFx(t)
	ctx := context.Background()
	otherPub, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	_ = otherPub
	cases := map[string]string{
		"garbage":       "hello",
		"wrong key":     f.issueWith(otherPriv, nil),
		"not yet valid": f.issue(func(d *license.Document) { d.NotBefore = t0.AddDate(0, 1, 0).Unix(); d.IssuedAt = t0.Unix() }),
		"long expired": f.issue(func(d *license.Document) {
			d.ExpiresAt = i64(t0.Add(-100 * 24 * time.Hour).Unix())
			d.NotBefore = t0.Add(-200 * 24 * time.Hour).Unix()
			d.IssuedAt = d.NotBefore
		}),
		"tampered": strings.Replace(f.issue(nil), "AZL1.", "AZL1.A", 1),
	}
	for name, blob := range cases {
		_, err := f.svc.Install(ctx, f.actor(), blob)
		if !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: want ErrInvalid, got %v", name, err)
		}
	}
	if n := f.count("SELECT count(*) FROM licenses"); n != 0 {
		t.Fatalf("refused licenses were stored: %d", n)
	}
	if n := f.count("SELECT count(*) FROM audit_log WHERE action='license.invalid' AND outcome='denied'"); n != len(cases) {
		t.Fatalf("license.invalid audit entries: %d", n)
	}
	// The same license twice, or an older revision of it, is a conflict; a newer revision is fine.
	good := f.issue(nil)
	f.install(good)
	if _, err := f.svc.Install(ctx, f.actor(), good); !errors.Is(err, ErrConflict) {
		t.Fatalf("reinstall: %v", err)
	}
	if _, err := f.svc.Install(ctx, f.actor(), f.issue(func(d *license.Document) { d.IssuedAt = t0.Add(-time.Hour).Unix() })); !errors.Is(err, ErrConflict) {
		t.Fatalf("older revision: %v", err)
	}
	f.set(t0.Add(time.Hour))
	f.install(f.issue(func(d *license.Document) { d.IssuedAt = t0.Add(time.Hour).Unix(); d.MaxDevices = 500 }))
	if f.status().MaxDevices != 500 {
		t.Fatal("renewal not applied")
	}
}

func TestNoKeyMeansUnlicensed(t *testing.T) {
	f := newFx(t)
	blob := f.issue(nil)
	f.install(blob)
	f.svc.Keys = []ed25519.PublicKey{} // this build has no license key
	// (a nil slice would fall back to the compiled-in keys, which are empty in the tree as well)
	st := f.status()
	if st.State != Invalid || st.Configured || st.MaxDevices != 25 || !strings.Contains(st.Message, "not configured") {
		t.Fatalf("no key: %+v", st)
	}
	if _, err := f.svc.Install(context.Background(), f.actor(), blob); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("install without a key: %v", err)
	}
	// A key rotation that drops the signer makes the installed license invalid, not valid.
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	f.svc.Keys = []ed25519.PublicKey{other}
	if st := f.status(); st.State != Invalid || st.MaxDevices != 25 {
		t.Fatalf("untrusted signer: %+v", st)
	}
	f.svc.Keys = []ed25519.PublicKey{f.pub}
	if st := f.status(); st.State != Licensed {
		t.Fatalf("trusted again: %+v", st)
	}
	// A row edited in the database cannot raise the cap: the blob is verified on every use.
	// (the application role cannot even UPDATE the table; the owner can, as a database administrator would)
	if _, err := f.svc.Pool.Exec(context.Background(), "UPDATE licenses SET blob = blob"); err == nil {
		t.Fatal("the application role must not be able to modify installed licenses")
	}
	owner, err := pgx.Connect(context.Background(), f.db.OwnerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = owner.Close(context.Background()) }()
	if _, err := owner.Exec(context.Background(), "UPDATE licenses SET blob = replace(blob, 'AZL1.', 'AZL1.A')"); err != nil {
		t.Fatal(err)
	}
	if st := f.status(); st.State != Invalid || st.MaxDevices != 25 {
		t.Fatalf("tampered row: %+v", st)
	}
}

func TestConcurrentEnrollmentsNeverExceedTheCap(t *testing.T) {
	f := newFx(t)
	f.devices(20, "active") // 5 free slots
	var wg sync.WaitGroup
	var granted atomic.Int32
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := store.Tx(context.Background(), f.svc.Pool, func(tx pgx.Tx, q *dbq.Queries) error {
				if err := f.svc.CheckNewDevice(context.Background(), q, f.org, nil); err != nil {
					return err
				}
				id := uuid.New()
				_, err := tx.Exec(context.Background(), "INSERT INTO devices (id, org_id, site_id, status, hostname, arch) VALUES ($1,$2,$3,'active','c','amd64')", id, f.org, f.site)
				return err
			})
			if err == nil {
				granted.Add(1)
			}
		}()
	}
	wg.Wait()
	if granted.Load() != 5 || f.status().Devices != 25 {
		t.Fatalf("granted %d, devices %d", granted.Load(), f.status().Devices)
	}
}

func TestCheckReleaseOnlyAppliesWithAnUpdatesCutoff(t *testing.T) {
	f := newFx(t)
	ctx := context.Background()
	released := t0.Add(-24 * time.Hour).Unix()
	if err := f.svc.CheckRelease(ctx, f.org, "1.0.0", released); err != nil {
		t.Fatalf("evaluation must not restrict agent updates: %v", err)
	}
	until := t0.AddDate(0, 6, 0)
	f.install(f.issue(func(d *license.Document) { d.UpdatesUntil = i64(until.Unix()) }))
	if err := f.svc.CheckRelease(ctx, f.org, "1.0.0", until.Unix()); err != nil {
		t.Fatalf("release at the cut-off: %v", err)
	}
	err := f.svc.CheckRelease(ctx, f.org, "2.0.0", until.Add(time.Hour).Unix())
	if !errors.Is(err, ErrUpdatesEnded) || !strings.Contains(err.Error(), "2.0.0") || !strings.Contains(err.Error(), "Windows, driver and software updates are not affected") {
		t.Fatalf("release after the cut-off: %v", err)
	}
	if err := f.svc.CheckRelease(ctx, f.org, "2.0.0", 0); !errors.Is(err, ErrUpdatesEnded) {
		t.Fatalf("undated release under a cut-off: %v", err)
	}
	// The entitlement outlives the subscription: an expired license still bounds the update period.
	f.set(until.AddDate(1, 0, 0))
	if err := f.svc.CheckRelease(ctx, f.org, "2.0.0", until.Add(time.Hour).Unix()); !errors.Is(err, ErrUpdatesEnded) {
		t.Fatalf("expired license: %v", err)
	}
	f.install(f.issue(func(d *license.Document) {
		d.IssuedAt = t0.Add(time.Hour).Unix()
		d.NotBefore = t0.Unix()
		d.ExpiresAt = nil
		d.UpdatesUntil = nil
	}))
	if err := f.svc.CheckRelease(ctx, f.org, "2.0.0", until.Add(time.Hour).Unix()); err != nil {
		t.Fatalf("no cut-off: %v", err)
	}
}
