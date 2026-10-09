// Package config loads server configuration from environment variables.
//
// Secrets are never read from plain environment variables in production:
// every secret has a *_FILE variant intended for Docker secrets, and the
// plain variant is only accepted when RENOVATIO_DEV_MODE=true.
package config

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/auzring1/renovatio/internal/shared/license"
	"github.com/auzring1/renovatio/internal/shared/release"
)

// Default enrollment rate limits, per minute (PROTOCOL §4.1).
const (
	DefaultEnrollRatePerIP    = 10
	DefaultEnrollRatePerToken = 60
)

// Config is the full server configuration.
type Config struct {
	DevMode bool

	// HTTPAddr serves the REST API, GUI and SSE (behind Caddy).
	HTTPAddr string
	// PublicURL is the browser-facing origin, e.g. https://renovatio.example.com.
	// Used for Origin/CSRF checks and cookie security.
	PublicURL *url.URL
	// TrustedProxies are the CIDRs whose X-Forwarded-For header is trusted.
	TrustedProxies []netip.Prefix

	// GatewayAddr is the agent mTLS listener.
	GatewayAddr string
	// GatewayPublicAddr is host:port agents dial (embedded in enrollment bundles).
	GatewayPublicAddr string
	// GatewaySANs are DNS names / IPs placed in the gateway certificate.
	GatewaySANs []string

	// DatabaseURL is the runtime (least-privilege) connection.
	DatabaseURL string
	// MigrateDatabaseURL is the schema-owner connection used for migrations.
	// Empty means "use DatabaseURL".
	MigrateDatabaseURL string
	MigrateOnStart     bool

	// MasterKey is the 32-byte key-encryption key (KEK).
	MasterKey []byte

	// DeviceCertLifetime and renewal grace (shortened only in tests).
	DeviceCertLifetime time.Duration
	DeviceRenewGrace   time.Duration
	EnrollPollInterval time.Duration
	// EnrollRatePerIP and EnrollRatePerToken are the enrollment attempts allowed per minute for one
	// source IP and one enrollment token (the burst is the same number). Defaults: 10 and 60. They
	// protect token guessing; raise them only for a rollout of many machines behind one NAT address.
	EnrollRatePerIP    int
	EnrollRatePerToken int
	HeartbeatInterval  time.Duration
	// IgnoreIPAllowlist is the break-glass switch for a console IP allow-list that locked everyone out.
	IgnoreIPAllowlist  bool
	SessionIdleTimeout time.Duration
	SessionAbsTimeout  time.Duration
	LogLevel           string

	// ContentDir holds uploaded installers (a volume in compose). Empty disables custom packages.
	ContentDir string
	// GitHubToken optionally raises the GitHub API rate limit for winget imports.
	GitHubToken string
	// WingetSource is "github" (default) or "off".
	WingetSource string
	// ReleasePublicKeys are extra vendor release public keys (hex, comma-separated) the server accepts
	// agent releases for, in addition to the keys compiled in. Agents only trust their own compiled-in keys.
	ReleasePublicKeys string
	// LicensePublicKeys are extra vendor license public keys (hex, comma-separated), for test and demo
	// keys, in addition to the keys compiled into this build (internal/shared/license.PublicKeysHex).
	LicensePublicKeys string
}

// Load reads configuration from the process environment.
func Load() (*Config, error) { return LoadFrom(os.LookupEnv) }

// LoadFrom reads configuration using the given lookup function (testable).
func LoadFrom(lookup func(string) (string, bool)) (*Config, error) {
	get := func(k, def string) string {
		if v, ok := lookup(k); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
		return def
	}
	c := &Config{}
	var errs []error
	var err error

	c.DevMode, err = strconv.ParseBool(get("RENOVATIO_DEV_MODE", "false"))
	if err != nil {
		errs = append(errs, fmt.Errorf("RENOVATIO_DEV_MODE: %w", err))
	}
	secret := func(name string) (string, error) {
		if path := get(name+"_FILE", ""); path != "" {
			b, err := os.ReadFile(path) // #nosec G304 -- operator-supplied secret path
			if err != nil {
				return "", fmt.Errorf("%s_FILE: %w", name, err)
			}
			return strings.TrimSpace(string(b)), nil
		}
		if v := get(name, ""); v != "" {
			if !c.DevMode {
				return "", fmt.Errorf("%s must be provided via %s_FILE (Docker secret); plain env vars are only allowed with RENOVATIO_DEV_MODE=true", name, name)
			}
			return v, nil
		}
		return "", nil
	}

	c.HTTPAddr = get("RENOVATIO_HTTP_ADDR", ":8080")
	c.GatewayAddr = get("RENOVATIO_GATEWAY_ADDR", ":8443")
	c.LogLevel = get("RENOVATIO_LOG_LEVEL", "info")
	c.ContentDir = get("RENOVATIO_CONTENT_DIR", "")
	if c.GitHubToken, err = secret("RENOVATIO_GITHUB_TOKEN"); err != nil {
		errs = append(errs, err)
	}
	c.WingetSource = get("RENOVATIO_WINGET_SOURCE", "github")
	c.ReleasePublicKeys = get("RENOVATIO_RELEASE_PUBLIC_KEYS", "")
	if _, err := release.ParseKeys(c.ReleasePublicKeys); err != nil {
		errs = append(errs, fmt.Errorf("RENOVATIO_RELEASE_PUBLIC_KEYS: %w", err))
	}
	c.LicensePublicKeys = get("RENOVATIO_LICENSE_PUBLIC_KEYS", "")
	if _, err := license.ParseKeys(c.LicensePublicKeys); err != nil {
		errs = append(errs, fmt.Errorf("RENOVATIO_LICENSE_PUBLIC_KEYS: %w", err))
	}
	if c.WingetSource != "github" && c.WingetSource != "off" {
		errs = append(errs, errors.New("RENOVATIO_WINGET_SOURCE must be github or off"))
	}

	pub := get("RENOVATIO_PUBLIC_URL", "")
	if pub == "" {
		errs = append(errs, errors.New("RENOVATIO_PUBLIC_URL is required (e.g. https://renovatio.example.com)"))
	} else if u, perr := url.Parse(pub); perr != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		errs = append(errs, fmt.Errorf("RENOVATIO_PUBLIC_URL %q is not a valid http(s) origin", pub))
	} else {
		if u.Scheme == "http" && !c.DevMode {
			errs = append(errs, errors.New("RENOVATIO_PUBLIC_URL must be https unless RENOVATIO_DEV_MODE=true"))
		}
		u.Path, u.RawQuery, u.Fragment = "", "", ""
		c.PublicURL = u
	}

	c.GatewayPublicAddr = get("RENOVATIO_GATEWAY_PUBLIC_ADDR", "")
	if c.GatewayPublicAddr == "" && c.PublicURL != nil {
		c.GatewayPublicAddr = net.JoinHostPort(c.PublicURL.Hostname(), "8443")
	}
	if c.GatewayPublicAddr != "" {
		if _, _, serr := net.SplitHostPort(c.GatewayPublicAddr); serr != nil {
			errs = append(errs, fmt.Errorf("RENOVATIO_GATEWAY_PUBLIC_ADDR %q must be host:port", c.GatewayPublicAddr))
		}
	}
	for _, s := range strings.Split(get("RENOVATIO_GATEWAY_SANS", ""), ",") {
		if s = strings.TrimSpace(s); s != "" {
			c.GatewaySANs = append(c.GatewaySANs, s)
		}
	}
	if host, _, serr := net.SplitHostPort(c.GatewayPublicAddr); serr == nil && host != "" {
		c.GatewaySANs = appendUnique(c.GatewaySANs, host)
	}

	for _, s := range strings.Split(get("RENOVATIO_TRUSTED_PROXIES", ""), ",") {
		if s = strings.TrimSpace(s); s == "" {
			continue
		}
		p, perr := netip.ParsePrefix(s)
		if perr != nil {
			errs = append(errs, fmt.Errorf("RENOVATIO_TRUSTED_PROXIES: %w", perr))
			continue
		}
		c.TrustedProxies = append(c.TrustedProxies, p)
	}

	if c.DatabaseURL, err = secret("RENOVATIO_DATABASE_URL"); err != nil {
		errs = append(errs, err)
	} else if c.DatabaseURL == "" {
		errs = append(errs, errors.New("RENOVATIO_DATABASE_URL_FILE is required"))
	}
	if c.MigrateDatabaseURL, err = secret("RENOVATIO_MIGRATE_DATABASE_URL"); err != nil {
		errs = append(errs, err)
	}
	c.MigrateOnStart, err = strconv.ParseBool(get("RENOVATIO_MIGRATE_ON_START", "true"))
	if err != nil {
		errs = append(errs, fmt.Errorf("RENOVATIO_MIGRATE_ON_START: %w", err))
	}

	mk, err := secret("RENOVATIO_MASTER_KEY")
	if err != nil {
		errs = append(errs, err)
	} else if mk == "" {
		errs = append(errs, errors.New("RENOVATIO_MASTER_KEY_FILE is required (32 random bytes, hex or base64)"))
	} else if c.MasterKey, err = decodeKey(mk); err != nil {
		errs = append(errs, fmt.Errorf("RENOVATIO_MASTER_KEY: %w", err))
	}

	dur := func(name string, def time.Duration, min time.Duration) time.Duration {
		v := get(name, "")
		if v == "" {
			return def
		}
		d, perr := time.ParseDuration(v)
		if perr != nil || d < min {
			errs = append(errs, fmt.Errorf("%s: invalid duration %q (minimum %s)", name, v, min))
			return def
		}
		return d
	}
	count := func(name string, def int) int {
		v := get(name, "")
		if v == "" {
			return def
		}
		n, perr := strconv.Atoi(v)
		if perr != nil || n < 1 || n > 1_000_000 {
			errs = append(errs, fmt.Errorf("%s: %q is not a number between 1 and 1000000", name, v))
			return def
		}
		return n
	}
	// Short lifetimes are only for tests; the minimums keep production sane.
	minLife := 24 * time.Hour
	if c.DevMode {
		minLife = 10 * time.Second
	}
	c.DeviceCertLifetime = dur("RENOVATIO_DEVICE_CERT_LIFETIME", 90*24*time.Hour, minLife)
	c.DeviceRenewGrace = dur("RENOVATIO_DEVICE_RENEW_GRACE", 180*24*time.Hour, 0)
	c.EnrollPollInterval = dur("RENOVATIO_ENROLL_POLL_INTERVAL", 60*time.Second, time.Second)
	c.EnrollRatePerIP = count("RENOVATIO_ENROLL_RATE_PER_IP", DefaultEnrollRatePerIP)
	c.EnrollRatePerToken = count("RENOVATIO_ENROLL_RATE_PER_TOKEN", DefaultEnrollRatePerToken)
	c.HeartbeatInterval = dur("RENOVATIO_HEARTBEAT_INTERVAL", 5*time.Minute, time.Second)
	c.IgnoreIPAllowlist = os.Getenv("RENOVATIO_IGNORE_IP_ALLOWLIST") == "true"
	c.SessionIdleTimeout = dur("RENOVATIO_SESSION_IDLE_TIMEOUT", 30*time.Minute, time.Minute)
	c.SessionAbsTimeout = dur("RENOVATIO_SESSION_ABSOLUTE_TIMEOUT", 12*time.Hour, 5*time.Minute)

	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return c, nil
}

// SecureCookies reports whether cookies must carry the Secure attribute.
func (c *Config) SecureCookies() bool { return c.PublicURL.Scheme == "https" }

// Origin returns scheme://host[:port] of the public URL.
func (c *Config) Origin() string { return c.PublicURL.Scheme + "://" + c.PublicURL.Host }

func appendUnique(list []string, v string) []string {
	for _, s := range list {
		if strings.EqualFold(s, v) {
			return list
		}
	}
	return append(list, v)
}
