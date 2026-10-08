package e2e

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/auzring1/renovatio/internal/agent/core"
	sconfig "github.com/auzring1/renovatio/internal/server/config"
	"github.com/auzring1/renovatio/internal/shared/license"
)

// TestLicenseDeviceCap: without a license the server runs as an evaluation limited to 25 enrolled
// devices. The 26th enrollment (and an approval) is refused with a clear message, while every existing
// device, the console and revocation keep working. Installing a license lifts the cap.
func TestLicenseDeviceCap(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	h := newHarnessCfg(t, 90*24*time.Hour, func(c *sconfig.Config) { c.LicensePublicKeys = hex.EncodeToString(pub) })
	h.setupAndLogin()
	ctx := context.Background()

	sign := func(mut func(d *license.Document)) string {
		now := time.Now()
		d := &license.Document{Format: 1, LicenseID: "LIC-E2E", Licensee: "E2E Corp", IssuedAt: now.Unix(), NotBefore: now.Add(-time.Hour).Unix(),
			MaxDevices: 100, Features: []string{"reports.export"}}
		if mut != nil {
			mut(d)
		}
		b, err := license.Marshal(d)
		if err != nil {
			t.Fatal(err)
		}
		return license.Encode(b, license.Sign(priv, b))
	}
	lic := func() map[string]any {
		st, b := h.do("GET", "/api/v1/license", nil, nil)
		if st != 200 {
			t.Fatalf("GET /license: %d %v", st, b)
		}
		return b
	}

	// Unlicensed evaluation.
	b := lic()
	if b["state"] != "evaluation" || b["max_devices"].(float64) != 25 || b["devices"].(float64) != 0 || b["license"] != nil || b["configured"] != true {
		t.Fatalf("fresh server: %v", b)
	}

	// 23 devices that were enrolled earlier (seeded; the enrollment rate limit makes 26 real agents slow).
	var org, site uuid.UUID
	if err := h.db.Pool.QueryRow(ctx, "SELECT org_id, id FROM sites ORDER BY created_at LIMIT 1").Scan(&org, &site); err != nil {
		t.Fatal(err)
	}
	seed := func(status string, n int) []uuid.UUID {
		var ids []uuid.UUID
		for i := 0; i < n; i++ {
			id := uuid.New()
			if _, err := h.db.Pool.Exec(ctx, `INSERT INTO devices (id, org_id, site_id, status, hostname, arch, approved_at) VALUES ($1,$2,$3,$4,$5,'amd64', now())`,
				id, org, site, status, "seed-"+id.String()[:8]); err != nil {
				t.Fatal(err)
			}
			ids = append(ids, id)
		}
		return ids
	}
	seeded := seed("active", 23)

	// Real agents 24 and 25 enroll; the 26th is refused.
	enr := h.createToken("cap", 10, false)
	a24 := h.startAgent(enr, &fakeHW{host: "PC-024", serial: "SN-024", uuid: "UUID-024"}, nil)
	waitFor(t, 15*time.Second, "agent 24 connected", func() bool { return a24.state() == "connected" })
	a25 := h.startAgent(enr, &fakeHW{host: "PC-025", serial: "SN-025", uuid: "UUID-025"}, nil)
	waitFor(t, 15*time.Second, "agent 25 connected", func() bool { return a25.state() == "connected" })
	b = lic()
	if b["devices"].(float64) != 25 || b["at_capacity"] != true || b["over_capacity"] != false {
		t.Fatalf("at the cap: %v", b)
	}
	a26 := h.startAgent(enr, &fakeHW{host: "PC-026", serial: "SN-026", uuid: "UUID-026"}, nil)
	waitFor(t, 15*time.Second, "agent 26 refused", func() bool { return a26.state() == "error" })
	s, _ := core.ReadStatus(a26.dir)
	if !strings.Contains(s.Message, "device limit reached") || !strings.Contains(s.Message, "limited to 25 devices") || !strings.Contains(s.Message, "License") {
		t.Fatalf("the installer output must say why: %q", s.Message)
	}
	a26.stop()
	var used int
	_ = h.db.Pool.QueryRow(ctx, "SELECT used_count FROM enrollment_tokens WHERE name='cap'").Scan(&used)
	if used != 2 {
		t.Fatalf("a refused enrollment consumed the token: used_count=%d", used)
	}
	if n := len(h.devices()); n != 25 {
		t.Fatalf("a refused enrollment left a device behind: %d", n)
	}
	var denied int
	_ = h.db.Pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE action='device.enroll' AND outcome='denied' AND details->>'reason'='license_device_limit'`).Scan(&denied)
	if denied != 1 {
		t.Fatalf("denied enrollment audit entries: %d", denied)
	}

	// Approval of a pending device is blocked the same way, with a message the console shows.
	pending := seed("pending", 1)[0]
	st, body := h.do("POST", "/api/v1/devices/"+pending.String()+"/approve", map[string]any{}, nil)
	eb, _ := body["error"].(map[string]any)
	if st != 409 || eb["code"] != "license_device_limit" || !strings.Contains(eb["message"].(string), "device limit reached") {
		t.Fatalf("approve at the cap: %d %v", st, body)
	}

	// Everything else keeps working at the cap: existing agents stay connected and the console can act on them.
	if a24.state() != "connected" || a25.state() != "connected" {
		t.Fatal("existing agents were affected by the cap")
	}
	if st, _ := h.do("POST", "/api/v1/devices/"+a24.identity(t).DeviceID+"/refresh", map[string]any{}, nil); st != 202 {
		t.Fatalf("refresh of an existing device at the cap: %d", st)
	}

	// Installing licenses: garbage and wrong-key licenses are refused and audited; the real one lifts the cap.
	if st, _ := h.do("PUT", "/api/v1/license", map[string]any{"license": "AZL1.garbage.garbage"}, nil); st != 422 {
		t.Fatalf("garbage license: %d", st)
	}
	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	d := &license.Document{Format: 1, LicenseID: "FORGED", Licensee: "Mallory", IssuedAt: time.Now().Unix(), NotBefore: time.Now().Unix(), MaxDevices: 100000, Features: []string{}}
	db, _ := license.Marshal(d)
	if st, _ := h.do("PUT", "/api/v1/license", map[string]any{"license": license.Encode(db, license.Sign(otherPriv, db))}, nil); st != 422 {
		t.Fatalf("forged license: %d", st)
	}
	if lic()["state"] != "evaluation" {
		t.Fatal("a refused license changed the state")
	}
	good := sign(nil)
	st, body = h.do("PUT", "/api/v1/license", map[string]any{"license": good}, nil)
	if st != 200 || body["state"] != "licensed" || body["max_devices"].(float64) != 100 || body["at_capacity"] != false {
		t.Fatalf("install: %d %v", st, body)
	}
	if st, _ := h.do("PUT", "/api/v1/license", map[string]any{"license": good}, nil); st != 409 {
		t.Fatalf("reinstalling the same license: %d", st)
	}
	st, body = h.do("GET", "/api/v1/license/history", nil, nil)
	if st != 200 || len(body["items"].([]any)) != 1 {
		t.Fatalf("history: %d %v", st, body)
	}

	// The blocked pending device can be approved now, and the refused machine can enroll.
	if st, body := h.do("POST", "/api/v1/devices/"+pending.String()+"/approve", map[string]any{}, nil); st != 204 {
		t.Fatalf("approve after the license: %d %v", st, body)
	}
	a26b := h.startAgent(enr, &fakeHW{host: "PC-026", serial: "SN-026", uuid: "UUID-026"}, nil)
	waitFor(t, 15*time.Second, "agent 26 connected after the license", func() bool { return a26b.state() == "connected" })

	// A smaller license than the fleet: nothing is removed, only new devices are refused.
	later := time.Now().Add(time.Minute)
	small := sign(func(d *license.Document) { d.MaxDevices = 5; d.IssuedAt = later.Unix() })
	if st, body := h.do("PUT", "/api/v1/license", map[string]any{"license": small}, nil); st != 200 || body["over_capacity"] != true {
		t.Fatalf("smaller license: %d %v", st, body)
	}
	if a24.state() != "connected" || a26b.state() != "connected" {
		t.Fatal("a smaller license affected existing devices")
	}
	if st, _ := h.do("POST", "/api/v1/devices/"+seeded[0].String()+"/revoke", map[string]any{"reason": "test"}, nil); st != 204 {
		t.Fatalf("revoking must always work: %d", st)
	}

	// Audit trail.
	var installs, invalids int
	_ = h.db.Pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE action='license.install' AND outcome='success'`).Scan(&installs)
	_ = h.db.Pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE action='license.invalid' AND outcome='denied'`).Scan(&invalids)
	if installs != 2 || invalids < 3 {
		t.Fatalf("audit: installs=%d invalid=%d", installs, invalids)
	}
}
