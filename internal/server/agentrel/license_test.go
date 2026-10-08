package agentrel

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/auzring1/auzring/internal/server/licensing"
	"github.com/auzring1/auzring/internal/shared/license"
	"github.com/auzring1/auzring/internal/shared/release"
)

// A license with an updates_until date refuses agent releases published after it: at upload, when the
// target is chosen, and (if the license changes later) by pausing a running rollout. Without a license
// nothing is refused.
func TestLicenseUpdatePeriodGatesAgentReleasesOnly(t *testing.T) {
	f := newFx(t)
	ctx := context.Background()
	lic := &licensing.Service{Pool: f.pool, Keys: []ed25519.PublicKey{f.pub}, Now: f.now}
	f.svc.Licensing = lic
	until := f.now().AddDate(0, 6, 0)
	late := until.Add(48 * time.Hour)
	mk := func(version string, at time.Time) ([]byte, []byte) {
		bin := []byte("MZ agent " + version)
		h := sha256.Sum256(bin)
		m := &release.Manifest{Format: 1, Product: release.Product, Version: version, OS: "windows", Arch: "amd64", SHA256: hex.EncodeToString(h[:]), Size: uint64(len(bin)), ReleasedAt: at.Unix()}
		mb, _ := release.Marshal(m)
		b, _ := release.EncodeBundle(&release.Bundle{Manifest: mb, Signature: release.Sign(f.priv, mb), KeyID: release.KeyID(f.pub)})
		return b, bin
	}
	// Evaluation (no license): everything is allowed.
	b, bin := mk("2.0.0", late)
	rel, err := f.svc.AddRelease(ctx, f.actor(), b, bytes.NewReader(bin))
	if err != nil {
		t.Fatalf("no license: %v", err)
	}
	// Install a license (the fixture key stands in for the vendor key) that ends updates at `until`.
	cut := until.Unix()
	doc := &license.Document{Format: 1, LicenseID: "L1", Licensee: "Acme", IssuedAt: f.now().Unix(), NotBefore: f.now().Unix(), MaxDevices: 50,
		Features: []string{}, UpdatesUntil: &cut}
	db, _ := license.Marshal(doc)
	if _, err := lic.Install(ctx, licensing.Actor{Org: f.org, User: f.user}, license.Encode(db, license.Sign(f.priv, db))); err != nil {
		t.Fatal(err)
	}
	b, bin = mk("2.1.0", late)
	if _, err := f.svc.AddRelease(ctx, f.actor(), b, bytes.NewReader(bin)); !errors.Is(err, ErrNotEligible) || !strings.Contains(err.Error(), "2.1.0") {
		t.Fatalf("upload after the cut-off: %v", err)
	}
	if f.count("SELECT count(*) FROM agent_releases WHERE version='2.1.0'") != 0 {
		t.Fatal("a refused release was stored")
	}
	b, bin = mk("1.9.0", until.Add(-time.Hour))
	good, err := f.svc.AddRelease(ctx, f.actor(), b, bytes.NewReader(bin))
	if err != nil {
		t.Fatalf("release before the cut-off: %v", err)
	}
	// The release stored before the license was installed cannot be chosen as the target any more.
	err = f.svc.SetRollout(ctx, f.actor(), Rollout{ReleaseID: &rel.ID, SoakHours: 1, SuccessThreshold: 100, BatchPerTick: 10})
	if !errors.Is(err, ErrNotEligible) {
		t.Fatalf("rollout of a release after the cut-off: %v", err)
	}
	dev := f.device("1.0.0")
	f.rollout(good, nil)
	f.svc.Tick(ctx)
	if f.openJobs(dev) != 1 {
		t.Fatal("an eligible release must roll out")
	}

	// A rollout whose target stops being covered (the license changes under it) is paused, not continued.
	dev2 := f.device("1.0.0")
	f.exec("UPDATE agent_rollout SET release_id=$1 WHERE org_id=$2", rel.ID, f.org) // as if chosen before the license
	f.svc.Tick(ctx)
	if f.openJobs(dev2) != 0 {
		t.Fatal("jobs were created for a release the license does not cover")
	}
	if f.count("SELECT count(*) FROM agent_rollout WHERE org_id=$1 AND paused AND paused_reason LIKE '%update period%'", f.org) != 1 {
		t.Fatal("the rollout was not paused with the reason")
	}
	if f.count("SELECT count(*) FROM audit_log WHERE action='agent.rollout_hold' AND outcome='denied'") != 1 {
		t.Fatal("pause not audited")
	}
}
