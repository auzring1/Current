package config

import (
	"strings"
	"testing"
)

func baseEnv() map[string]string {
	return map[string]string{
		"AUZ_DEV_MODE":     "true",
		"AUZ_PUBLIC_URL":   "http://localhost:8080",
		"AUZ_DATABASE_URL": "postgres://u:p@localhost/db",
		"AUZ_MASTER_KEY":   strings.Repeat("ab", 32),
	}
}

func load(env map[string]string) (*Config, error) {
	return LoadFrom(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
}

func TestEnrollRateLimitsDefaultAndOverride(t *testing.T) {
	c, err := load(baseEnv())
	if err != nil {
		t.Fatal(err)
	}
	if c.EnrollRatePerIP != 10 || c.EnrollRatePerToken != 60 {
		t.Fatalf("defaults changed: %d/%d (PROTOCOL §4.1 says 10 per IP and 60 per token per minute)", c.EnrollRatePerIP, c.EnrollRatePerToken)
	}
	env := baseEnv()
	env["AUZ_ENROLL_RATE_PER_IP"] = "500"
	env["AUZ_ENROLL_RATE_PER_TOKEN"] = "2000"
	c, err = load(env)
	if err != nil {
		t.Fatal(err)
	}
	if c.EnrollRatePerIP != 500 || c.EnrollRatePerToken != 2000 {
		t.Fatalf("override ignored: %d/%d", c.EnrollRatePerIP, c.EnrollRatePerToken)
	}
}

func TestEnrollRateLimitsRejectNonsense(t *testing.T) {
	for _, v := range []string{"0", "-5", "ten", "1000001", "1.5"} {
		env := baseEnv()
		env["AUZ_ENROLL_RATE_PER_IP"] = v
		if _, err := load(env); err == nil || !strings.Contains(err.Error(), "AUZ_ENROLL_RATE_PER_IP") {
			t.Errorf("%q accepted (err=%v)", v, err)
		}
	}
}
