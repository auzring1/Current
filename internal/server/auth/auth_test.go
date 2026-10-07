package auth

import (
	"strings"
	"testing"
	"time"
)

func TestPasswordHashVerify(t *testing.T) {
	h, err := HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$m=65536,t=3,p=2$") || NeedsRehash(h) {
		t.Fatalf("unexpected hash format %q", h)
	}
	if !VerifyPassword("correct horse battery", h) {
		t.Fatal("valid password rejected")
	}
	if VerifyPassword("wrong", h) || VerifyPassword("correct horse battery", "") || VerifyPassword("x", "$bcrypt$x") {
		t.Fatal("invalid password accepted")
	}
	// Hostile parameters are refused rather than computed.
	if VerifyPassword("x", "$argon2id$v=19$m=99999999,t=3,p=2$AAAA$AAAA") {
		t.Fatal("hostile params accepted")
	}
}

func TestPasswordPolicy(t *testing.T) {
	bad := []string{"short", "aaaaaaaaaaaaaaaa", "qwertyuiopasdfghjkl", "alice@example.com", strings.Repeat("x", 300)}
	for _, pw := range bad {
		if ValidatePassword(pw, "alice@example.com") == nil {
			t.Errorf("weak password %q accepted", pw)
		}
	}
	if err := ValidatePassword("Granite-Lantern-Pickle-42", "alice@example.com"); err != nil {
		t.Fatalf("good password rejected: %v", err)
	}
	if len(commonPasswords()) < 1000 {
		t.Fatal("breach list not loaded")
	}
}

func TestTOTPRFC6238Vector(t *testing.T) {
	// RFC 6238 Appendix B, SHA1 secret "12345678901234567890", T=59 -> 94287082 (8 digits); 6-digit = 287082.
	secret := []byte("12345678901234567890")
	if got := TOTPCode(secret, 59/30); got != "287082" {
		t.Fatalf("got %s", got)
	}
	now := time.Unix(1111111109, 0) // vector -> 07081804 -> 081804
	if got := TOTPCode(secret, TOTPStep(now)); got != "081804" {
		t.Fatalf("got %s", got)
	}
	step, ok := VerifyTOTP(secret, "081804", now.Add(25*time.Second))
	if !ok || step != TOTPStep(now) {
		t.Fatal("skew window not honoured")
	}
	if _, ok := VerifyTOTP(secret, "081804", now.Add(5*time.Minute)); ok {
		t.Fatal("stale code accepted")
	}
	if _, ok := VerifyTOTP(secret, "abc", now); ok {
		t.Fatal("malformed code accepted")
	}
	if !strings.HasPrefix(TOTPURI("Auzring", "a@b.c", secret), "otpauth://totp/Auzring:a@b.c?") {
		t.Fatal(TOTPURI("Auzring", "a@b.c", secret))
	}
}

func TestRecoveryCodes(t *testing.T) {
	codes, err := NewRecoveryCodes(RecoveryCodeCount)
	if err != nil || len(codes) != 10 {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, c := range codes {
		if len(c) != 14 || !LooksLikeRecoveryCode(c) || seen[c] {
			t.Fatalf("bad code %q", c)
		}
		seen[c] = true
		if string(HashRecoveryCode(strings.ToUpper(c))) != string(HashRecoveryCode(" "+c+" ")) {
			t.Fatal("normalization mismatch")
		}
	}
	if LooksLikeRecoveryCode("123456") {
		t.Fatal("TOTP code classified as recovery code")
	}
}

func TestRBAC(t *testing.T) {
	for _, x := range PermissionsFor([]string{RoleReadOnly}) {
		switch x {
		case PermDevicesRead, PermGroupsRead, PermCatalogRead, PermDeploymentsRead, PermUpdatesRead:
		default:
			t.Fatalf("read-only role has %s", x)
		}
	}
	for _, x := range PermissionsFor([]string{RoleOperator}) {
		if x == PermCatalogOverride || x == PermSettingsWrite || x == PermUpdatesPolicy {
			t.Fatalf("operator has %s: overrides (silent arguments), org settings and update rings, rules and sources are admin-only", x)
		}
	}
	if len(PermissionsFor([]string{RoleAdmin})) != 17 {
		t.Fatal("admin permissions missing")
	}
	p := PermissionsFor([]string{RoleOperator, RoleReadOnly})
	for _, x := range p {
		if x == PermEnrollmentWrite || x == PermAuditRead {
			t.Fatal("operator must not create tokens or read audit")
		}
	}
	hasUpdatesWrite := false
	for _, x := range PermissionsFor([]string{RoleOperator}) {
		hasUpdatesWrite = hasUpdatesWrite || x == PermUpdatesWrite
	}
	if !hasUpdatesWrite {
		t.Fatal("operators approve updates and restart devices")
	}
	if len(PermissionsFor([]string{"nonsense"})) != 0 {
		t.Fatal("unknown role granted permissions")
	}
}

func TestLimiter(t *testing.T) {
	l := NewLimiter(1, time.Minute, 3)
	for i := 0; i < 3; i++ {
		if !l.Allow("ip") {
			t.Fatal("burst not allowed")
		}
	}
	if l.Allow("ip") {
		t.Fatal("over-limit request allowed")
	}
	if !l.Allow("other") {
		t.Fatal("keys must be independent")
	}
}
