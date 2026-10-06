package api

import (
	"context"
	"crypto/subtle"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"runtime/debug"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/auzring1/auzring/internal/server/auth"
	"github.com/auzring1/auzring/internal/server/config"
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
	Permissions []string
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
		if unsafeMethod(r.Method) {
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

// require enforces an MFA-verified session and a permission.
func (s *server) require(perm string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p, ok := s.principal(w, r)
			if !ok {
				return
			}
			for _, have := range p.Permissions {
				if have == perm {
					next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxPrincipal, p)))
					return
				}
			}
			writeError(w, http.StatusForbidden, "forbidden", "You do not have permission to do that.")
		})
	}
}

// principal resolves the caller from a fully verified session.
func (s *server) principal(w http.ResponseWriter, r *http.Request) (*Principal, bool) {
	sess := sessionFrom(r)
	if sess == nil || !sess.MFAVerified {
		writeError(w, http.StatusUnauthorized, "unauthenticated", "Sign in required.")
		return nil, false
	}
	q := s.q()
	u, err := q.GetUserByID(r.Context(), sess.UserID)
	if err != nil || u.Status != "active" {
		writeError(w, http.StatusUnauthorized, "unauthenticated", "Sign in required.")
		return nil, false
	}
	binds, err := q.ListRoleBindingsForUser(r.Context(), u.ID)
	if err != nil {
		s.Log.Error("role bindings", "err", err)
		internalError(w)
		return nil, false
	}
	var roles []string
	for _, b := range binds {
		if b.ScopeType == "org" && b.ScopeID == u.OrgID {
			roles = append(roles, b.Role)
		}
	}
	return &Principal{UserID: u.ID, OrgID: u.OrgID, Email: u.Email, DisplayName: u.DisplayName,
		Permissions: auth.PermissionsFor(roles)}, true
}

var _ = slog.LevelInfo
