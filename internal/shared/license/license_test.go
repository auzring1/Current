package license

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/auzring1/auzring/internal/shared/release"
)

func key(t testing.TB) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

var epoch = time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

func i64(v int64) *int64 { return &v }

func doc() *Document {
	return &Document{Format: 1, LicenseID: "LIC-0001", Licensee: "Example GmbH", IssuedAt: epoch.Unix(), NotBefore: epoch.Unix(),
		ExpiresAt: i64(epoch.AddDate(1, 0, 0).Unix()), MaxDevices: 250, Features: []string{"reports.export"},
		UpdatesUntil: i64(epoch.AddDate(1, 0, 0).Unix()), Notes: "test"}
}

func signed(t *testing.T, d *Document) (ed25519.PublicKey, ed25519.PrivateKey, string) {
	t.Helper()
	pub, priv := key(t)
	b, err := Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv, Encode(b, Sign(priv, b))
}

func TestRoundTrip(t *testing.T) {
	pub, _, blob := signed(t, doc())
	if !strings.HasPrefix(blob, "AZL1.") || strings.Count(blob, ".") != 2 {
		t.Fatalf("blob shape: %q", blob)
	}
	v, err := Verify([]ed25519.PublicKey{pub}, blob)
	if err != nil {
		t.Fatal(err)
	}
	if v.Doc.MaxDevices != 250 || v.Doc.Licensee != "Example GmbH" || v.KeyID != KeyID(pub) || v.Raw != blob {
		t.Fatalf("unexpected: %+v", v)
	}
	// Mail clients wrap lines; whitespace anywhere is ignored and the canonical form is restored.
	wrapped := blob[:20] + "\r\n  " + blob[20:50] + "\n" + blob[50:] + "\n"
	v2, err := Verify([]ed25519.PublicKey{pub}, wrapped)
	if err != nil || v2.Raw != blob {
		t.Fatalf("wrapped blob: %v", err)
	}
	// Several trusted keys: the matching one is found.
	other, _ := key(t)
	if _, err := Verify([]ed25519.PublicKey{other, pub}, blob); err != nil {
		t.Fatal(err)
	}
}

func TestNoKeyMeansNotConfigured(t *testing.T) {
	_, _, blob := signed(t, doc())
	if _, err := Verify(nil, blob); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("want ErrNotConfigured, got %v", err)
	}
	// The package default (no -ldflags key) trusts nothing.
	if len(TrustedKeys()) != 0 {
		t.Fatal("the tree must not carry a default license key")
	}
}

func TestRefuses(t *testing.T) {
	pub, priv, blob := signed(t, doc())
	other, _ := key(t)
	keys := []ed25519.PublicKey{pub}
	parts := strings.Split(blob, ".")
	docB, _ := base64.RawURLEncoding.DecodeString(parts[1])

	if _, err := Verify([]ed25519.PublicKey{other}, blob); err == nil {
		t.Fatal("signature by an untrusted key accepted")
	}
	// Tampering: one changed digit in max_devices.
	tampered := strings.Replace(string(docB), `"max_devices":250`, `"max_devices":950`, 1)
	if tampered == string(docB) {
		t.Fatal("test bug: nothing replaced")
	}
	if _, err := Verify(keys, "AZL1."+base64.RawURLEncoding.EncodeToString([]byte(tampered))+"."+parts[2]); err == nil {
		t.Fatal("tampered document accepted")
	}
	// Flip a bit in the signature.
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	sig[0] ^= 1
	if _, err := Verify(keys, "AZL1."+parts[1]+"."+base64.RawURLEncoding.EncodeToString(sig)); err == nil {
		t.Fatal("tampered signature accepted")
	}
	// Wrong domain: signed without the separator, or with the release domain.
	for _, dom := range []string{"", release.Domain, "auzring/license/v2\x00", "auzring/license/v1"} {
		bad := ed25519.Sign(priv, append([]byte(dom), docB...))
		if _, err := Verify(keys, Encode(docB, bad)); err == nil {
			t.Fatalf("signature under domain %q accepted", dom)
		}
	}
	// And the other way round: a license signature must never verify as a release signature.
	if _, err := release.Verify(keys, docB, Sign(priv, docB), ""); err == nil {
		t.Fatal("a license signature verified as a release")
	}
	// Structure.
	for name, in := range map[string]string{
		"empty":        "",
		"prefix":       "AZL2." + parts[1] + "." + parts[2],
		"two parts":    "AZL1." + parts[1],
		"four parts":   blob + ".x",
		"padding":      "AZL1." + parts[1] + "=." + parts[2],
		"std alphabet": "AZL1." + strings.NewReplacer("-", "+", "_", "/").Replace(parts[1]) + "+." + parts[2],
		"short sig":    "AZL1." + parts[1] + "." + base64.RawURLEncoding.EncodeToString(sig[:10]),
		"huge":         "AZL1." + strings.Repeat("A", MaxBlobBytes) + "." + parts[2],
	} {
		if _, err := Verify(keys, in); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestStrictJSON(t *testing.T) {
	pub, priv := key(t)
	good, _ := Marshal(doc())
	cases := map[string]string{
		"unknown field":   strings.Replace(string(good), `"notes":"test"`, `"notes":"test","extra":1`, 1),
		"trailing object": string(good) + `{}`,
		"trailing brace":  string(good) + `}`,
		"trailing junk":   string(good) + ` x`,
		"wrong type":      strings.Replace(string(good), `"max_devices":250`, `"max_devices":"250"`, 1),
		"float devices":   strings.Replace(string(good), `"max_devices":250`, `"max_devices":250.5`, 1),
		"not an object":   `[1]`,
		"null":            `null`,
	}
	for name, c := range cases {
		b := []byte(c)
		if name != "" && string(b) == string(good) {
			t.Fatalf("%s: test bug", name)
		}
		// The signature is valid: only the strict parser can refuse.
		if _, err := Verify([]ed25519.PublicKey{pub}, Encode(b, Sign(priv, b))); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestValidate(t *testing.T) {
	mut := func(f func(d *Document)) *Document { d := doc(); f(d); return d }
	bad := map[string]*Document{
		"format":           mut(func(d *Document) { d.Format = 2 }),
		"empty id":         mut(func(d *Document) { d.LicenseID = "" }),
		"id chars":         mut(func(d *Document) { d.LicenseID = "a b" }),
		"licensee empty":   mut(func(d *Document) { d.Licensee = "  " }),
		"licensee control": mut(func(d *Document) { d.Licensee = "a\x00b" }),
		"licensee long":    mut(func(d *Document) { d.Licensee = strings.Repeat("x", MaxLicensee+1) }),
		"issued":           mut(func(d *Document) { d.IssuedAt = 0 }),
		"not_before":       mut(func(d *Document) { d.NotBefore = 0 }),
		"devices zero":     mut(func(d *Document) { d.MaxDevices = 0 }),
		"devices huge":     mut(func(d *Document) { d.MaxDevices = MaxDevices + 1 }),
		"features nil":     mut(func(d *Document) { d.Features = nil }),
		"feature case":     mut(func(d *Document) { d.Features = []string{"Reports"} }),
		"feature dup":      mut(func(d *Document) { d.Features = []string{"a", "a"} }),
		"feature many":     mut(func(d *Document) { d.Features = make([]string, MaxFeatures+1) }),
		"expires before":   mut(func(d *Document) { d.ExpiresAt = i64(d.NotBefore) }),
		"expires zero":     mut(func(d *Document) { d.ExpiresAt = i64(0) }),
		"updates negative": mut(func(d *Document) { d.UpdatesUntil = i64(-5) }),
		"notes long":       mut(func(d *Document) { d.Notes = strings.Repeat("n", MaxNotes+1) }),
		"notes control":    mut(func(d *Document) { d.Notes = "a\x1bb" }),
	}
	for name, d := range bad {
		if _, err := Marshal(d); err == nil {
			t.Errorf("%s: Marshal accepted", name)
		}
	}
	d := doc()
	d.ExpiresAt, d.UpdatesUntil, d.Features, d.Notes = nil, nil, []string{}, ""
	if _, err := Marshal(d); err != nil {
		t.Fatalf("perpetual license without extras: %v", err)
	}
}

func TestValidityWithInjectedClock(t *testing.T) {
	d := doc()
	d.NotBefore = epoch.Unix()
	exp := time.Unix(*d.ExpiresAt, 0)
	cases := []struct {
		name string
		now  time.Time
		want Validity
	}{
		{"long before", epoch.Add(-72 * time.Hour), NotYetValid},
		{"just inside skew before not_before", epoch.Add(-ClockSkew + time.Minute), Valid},
		{"just outside skew before not_before", epoch.Add(-ClockSkew - time.Minute), NotYetValid},
		{"at not_before", epoch, Valid},
		{"mid", epoch.AddDate(0, 6, 0), Valid},
		{"at expiry", exp, Valid},
		{"inside skew after expiry", exp.Add(ClockSkew - time.Minute), Valid},
		{"outside skew after expiry", exp.Add(ClockSkew + time.Minute), Expired},
		{"long after", exp.AddDate(5, 0, 0), Expired},
	}
	for _, c := range cases {
		if got := d.At(c.now); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
	d.ExpiresAt = nil
	if d.At(epoch.AddDate(50, 0, 0)) != Valid {
		t.Error("a license without expiry must stay valid")
	}
}

func TestUpdatesEligible(t *testing.T) {
	d := doc()
	until := *d.UpdatesUntil
	if !d.UpdatesEligible(until) || !d.UpdatesEligible(until-1) {
		t.Error("a release at or before the cut-off must be eligible")
	}
	if d.UpdatesEligible(until + 1) {
		t.Error("a release after the cut-off must not be eligible")
	}
	if d.UpdatesEligible(0) {
		t.Error("an undated release cannot be shown to be eligible under a cut-off")
	}
	d.UpdatesUntil = nil
	if !d.UpdatesEligible(0) || !d.UpdatesEligible(1<<40) {
		t.Error("no cut-off means everything is eligible")
	}
}

func TestParseKeys(t *testing.T) {
	pub, _ := key(t)
	h := hex.EncodeToString(pub)
	got, err := ParseKeys(h + " , " + h + ",")
	if err != nil || len(got) != 2 {
		t.Fatalf("%v %d", err, len(got))
	}
	for _, bad := range []string{"zz", h[:62], h + "00"} {
		if _, err := ParseKeys(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func FuzzVerify(f *testing.F) {
	pub, priv := key(f)
	b, _ := Marshal(doc())
	blob := Encode(b, Sign(priv, b))
	f.Add(blob)
	f.Add("")
	f.Add("AZL1..")
	f.Add("AZL1.e30.AAAA")
	f.Add(blob[:len(blob)/2])
	f.Add(blob + " \n" + blob)
	keys := []ed25519.PublicKey{pub}
	f.Fuzz(func(t *testing.T, in string) {
		v, err := Verify(keys, in)
		if err != nil {
			return
		}
		// Anything accepted must be fully valid and re-encode to an accepted canonical form.
		if verr := v.Doc.Validate(); verr != nil {
			t.Fatalf("accepted an invalid document: %v", verr)
		}
		if _, err := Verify(keys, v.Raw); err != nil {
			t.Fatalf("canonical form rejected: %v", err)
		}
		_ = v.Doc.At(epoch)
	})
}

func FuzzDecode(f *testing.F) {
	f.Add("AZL1.e30.AAAA")
	f.Add("AZL1.....")
	f.Fuzz(func(t *testing.T, in string) {
		_, _, _ = Decode(in)
		_, _ = ParseUnverified(in)
	})
}
