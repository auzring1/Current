package api

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"runtime/debug"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/auzring1/current/gen/dbq"
	"github.com/auzring1/current/internal/server/audit"

	"github.com/auzring1/current/internal/server/auth"
	"github.com/auzring1/current/internal/server/config"
)

type ctxKey int

const (
	ctxIP ctxKey = iota
	ctxSession
	ctxPrincipal
)

// Principal is the authenticated, MFA-verified caller.
type Principal struct {
	UserID      uuid.UUID
	OrgID       uuid.UUID
	Email       string
	DisplayName string
	// Permissions are the organization-wide permissions; Access also holds the site-limited ones.
	Permissions []string
	Access      auth.Access
	TokenID     string // set when the request was authenticated with an API token
}

func clientIP(r *http.Request) string {
	if v, ok := r.Context().Value(ctxIP).(string); ok {
		return v
	}
	return ""
}

func sessionFrom(r *http.Request) *auth.Session {
	s, _ := r.Context().Value(ctxSession).(*auth.Session)
	return s
}

func principalFrom(r *http.Request) *Principal {
	p, _ := r.Context().Value(ctxPrincipal).(*Principal)
	return p
}

func (s *server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				s.Log.Error("panic in handler", "panic", v, "path", r.URL.Path, "stack", string(debug.Stack()))
				internalError(w)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// realIP trusts X-Forwarded-For only from configured proxies, walking the
// header right-to-left and stopping at the first untrusted hop.
func (s *server) realIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := remoteAddr(r.RemoteAddr)
		if trusted(s.Cfg.TrustedProxies, ip) {
			hops := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
			for i := len(hops) - 1; i >= 0; i-- {
				h := strings.TrimSpace(hops[i])
				a, err := netip.ParseAddr(h)
				if err != nil {
					break
				}
				ip = a.Unmap().String()
				if !trusted(s.Cfg.TrustedProxies, ip) {
					break
				}
			}
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxIP, ip)))
	})
}

func remoteAddr(ra string) string {
	host, _, err := net.SplitHostPort(ra)
	if err != nil {
		host = ra
	}
	if a, err := netip.ParseAddr(host); err == nil {
		return a.Unmap().String()
	}
	return host
}

func trusted(prefixes []netip.Prefix, ip string) bool {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}
	for _, p := range prefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

func securityHeaders(cfg *config.Config) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("X-Frame-Options", "DENY")
			h.Set("Referrer-Policy", "no-referrer")
			h.Set("Cross-Origin-Opener-Policy", "same-origin")
			h.Set("Cross-Origin-Resource-Policy", "same-origin")
			h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
			if cfg.SecureCookies() {
				h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
			}
			next.ServeHTTP(w, r)
		})
	}
}

func apiHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func (s *server) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.apiIP.Allow(clientIP(r)) {
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many requests.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int)        { s.status = code; s.ResponseWriter.WriteHeader(code) }
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func (s *server) requestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		// Never log bodies, cookies, query strings or headers (they may carry secrets).
		s.Log.Info("http", "method", r.Method, "path", r.URL.Path, "status", rec.status,
			"ip", clientIP(r), "dur_ms", time.Since(start).Milliseconds())
	})
}

func unsafeMethod(m string) bool {
	return m != http.MethodGet && m != http.MethodHead && m != http.MethodOptions
}

// originCheck rejects cross-origin state-changing requests (CSRF layer 1).
func (s *server) originCheck(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A bearer-token request carries no ambient credentials (no cookie), so it cannot be forged by
		// another site; browsers never add an Authorization header on their own.
		if unsafeMethod(r.Method) && !(strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") && s.Sessions.TokenFromRequest(r) == "") {
			origin := r.Header.Get("Origin")
			ok := false
			switch {
			case origin != "":
				ok = origin == s.Cfg.Origin()
			default:
				ok = r.Header.Get("Sec-Fetch-Site") == "same-origin"
			}
			if !ok {
				writeError(w, http.StatusForbidden, "bad_origin", "Cross-origin request rejected.")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) loadSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := s.Sessions.TokenFromRequest(r)
		if tok != "" {
			sess, err := s.Sessions.Lookup(r.Context(), tok)
			if err == nil {
				r = r.WithContext(context.WithValue(r.Context(), ctxSession, sess))
			} else if err != auth.ErrNoSession {
				s.Log.Error("session lookup", "err", err)
				internalError(w)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// csrfCheck requires the per-session synchronizer token on state changes
// made with a session (CSRF layer 2). Login/setup carry no session.
func (s *server) csrfCheck(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if sess := sessionFrom(r); sess != nil && unsafeMethod(r.Method) && r.URL.Path != "/api/v1/auth/login" {
			got := r.Header.Get("X-CSRF-Token")
			if got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(sess.CSRFToken)) != 1 {
				writeError(w, http.StatusForbidden, "csrf", "Missing or invalid CSRF token.")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// require enforces an authenticated caller holding an ORGANIZATION-WIDE permission. Site-limited
// roles never satisfy it: organization configuration and fleet-wide views need an org-wide role.
func (s *server) require(perm string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p, ok := s.principal(w, r)
			if !ok {
				return
			}
			if !p.Access.OrgHas(perm) {
				writeError(w, http.StatusForbidden, "forbidden", "You do not have permission to do that.")
				return
			}
			next.ServeHTTP(w, s.withPrincipal(r, p))
		})
	}
}

// requireSelf lets any authenticated caller in (the handler acts on the caller's own account).
func (s *server) requireSelf(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := s.principal(w, r)
		if !ok {
			return
		}
		next.ServeHTTP(w, s.withPrincipal(r, p))
	})
}

// requireAny lets a caller in who holds the permission anywhere (organization-wide or for some
// sites); the handler narrows what it returns with sitesFor.
func (s *server) requireAny(perm string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p, ok := s.principal(w, r)
			if !ok {
				return
			}
			if !p.Access.HasAnywhere(perm) {
				writeError(w, http.StatusForbidden, "forbidden", "You do not have permission to do that.")
				return
			}
			next.ServeHTTP(w, s.withPrincipal(r, p))
		})
	}
}

// requireDevice guards a route of the form .../devices/{id}/...: the caller needs the permission for
// the site the device belongs to (or organization-wide). A device of another organization, a device
// in a site the caller cannot reach and a missing device all answer 404, so ids cannot be probed.
func (s *server) requireDevice(perm string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p, ok := s.principal(w, r)
			if !ok {
				return
			}
			if !p.Access.HasAnywhere(perm) {
				writeError(w, http.StatusForbidden, "forbidden", "You do not have permission to do that.")
				return
			}
			if !p.Access.OrgHas(perm) {
				id, err := uuid.Parse(chi.URLParam(r, "id"))
				if err != nil || !s.deviceInScope(r.Context(), p, perm, id) {
					writeError(w, http.StatusNotFound, "not_found", "Not found.")
					return
				}
			}
			next.ServeHTTP(w, s.withPrincipal(r, p))
		})
	}
}

// deviceInScope reports whether the caller holds perm for the device's site.
func (s *server) deviceInScope(ctx context.Context, p *Principal, perm string, device uuid.UUID) bool {
	d, err := s.q().GetDeviceInOrg(ctx, dbq.GetDeviceInOrgParams{ID: device, OrgID: p.OrgID})
	return err == nil && p.Access.SiteHas(d.SiteID, perm)
}

func (s *server) withPrincipal(r *http.Request, p *Principal) *http.Request {
	ctx := context.WithValue(r.Context(), ctxPrincipal, p)
	if p.TokenID != "" {
		ctx = audit.WithAPIToken(ctx, p.TokenID)
	}
	return r.WithContext(ctx)
}

const apiTokenPrefix = "cur_"

// principal resolves the caller: a fully MFA-verified session, or an API token.
func (s *server) principal(w http.ResponseWriter, r *http.Request) (*Principal, bool) {
	if p := principalFrom(r); p != nil {
		return p, true
	}
	if sess := sessionFrom(r); sess != nil && sess.MFAVerified {
		return s.sessionPrincipal(w, r, sess)
	}
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer "+apiTokenPrefix) && s.Sessions.TokenFromRequest(r) == "" {
		return s.tokenPrincipal(w, r, strings.TrimPrefix(h, "Bearer "))
	}
	writeError(w, http.StatusUnauthorized, "unauthenticated", "Sign in required.")
	return nil, false
}

func (s *server) sessionPrincipal(w http.ResponseWriter, r *http.Request, sess *auth.Session) (*Principal, bool) {
	u, err := s.q().GetUserByID(r.Context(), sess.UserID)
	if err != nil || u.Status != "active" {
		writeError(w, http.StatusUnauthorized, "unauthenticated", "Sign in required.")
		return nil, false
	}
	acc, ok := s.accessOf(w, r, u)
	if !ok {
		return nil, false
	}
	return &Principal{UserID: u.ID, OrgID: u.OrgID, Email: u.Email, DisplayName: u.DisplayName, Permissions: acc.OrgPermissions(), Access: acc}, true
}

func (s *server) accessOf(w http.ResponseWriter, r *http.Request, u dbq.User) (auth.Access, bool) {
	binds, err := s.q().ListRoleBindingsForUser(r.Context(), u.ID)
	if err != nil {
		s.Log.Error("role bindings", "err", err)
		internalError(w)
		return auth.Access{}, false
	}
	grants := make([]auth.Grant, len(binds))
	for i, b := range binds {
		grants[i] = auth.Grant{Role: b.Role, ScopeType: b.ScopeType, ScopeID: b.ScopeID}
	}
	return auth.NewAccess(u.OrgID, grants), true
}

// tokenPrincipal authenticates an API token. The token's power is its scopes intersected with the
// owner's CURRENT permissions, so demoting or disabling a user immediately weakens their tokens.
func (s *server) tokenPrincipal(w http.ResponseWriter, r *http.Request, secret string) (*Principal, bool) {
	fail := func() (*Principal, bool) {
		writeError(w, http.StatusUnauthorized, "unauthenticated", "That API token is not valid.")
		return nil, false
	}
	if len(secret) > 100 {
		return fail()
	}
	sum := sha256.Sum256([]byte(secret))
	t, err := s.q().GetAPITokenByHash(r.Context(), sum[:])
	if err != nil {
		return fail()
	}
	now := s.now()
	if t.RevokedAt != nil || !now.Before(t.ExpiresAt) {
		return fail()
	}
	u, err := s.q().GetUserByID(r.Context(), t.UserID)
	if err != nil || u.Status != "active" {
		return fail()
	}
	acc, ok := s.accessOf(w, r, u)
	if !ok {
		return nil, false
	}
	acc = acc.Restrict(t.Scopes)
	if t.LastUsedAt == nil || now.Sub(*t.LastUsedAt) > time.Minute {
		_ = s.q().TouchAPIToken(r.Context(), dbq.TouchAPITokenParams{ID: t.ID, LastUsedAt: &now, LastUsedIp: clientIP(r)})
	}
	return &Principal{UserID: u.ID, OrgID: u.OrgID, Email: u.Email, DisplayName: u.DisplayName, Permissions: acc.OrgPermissions(), Access: acc, TokenID: t.ID.String()}, true
}

var _ = slog.LevelInfo
