// Package app wires the server together and owns its lifecycle.
package app

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"github.com/auzring1/renovatio/internal/shared/brand"
	"log/slog"
	"net"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/auzring1/renovatio/gen/dbq"
	agentv1 "github.com/auzring1/renovatio/gen/proto/renovatio/agent/v1"
	"github.com/auzring1/renovatio/internal/server/agentrel"
	"github.com/auzring1/renovatio/internal/server/api"
	"github.com/auzring1/renovatio/internal/server/auth"
	"github.com/auzring1/renovatio/internal/server/catalog"
	"github.com/auzring1/renovatio/internal/server/config"
	"github.com/auzring1/renovatio/internal/server/deploy"
	"github.com/auzring1/renovatio/internal/server/events"
	"github.com/auzring1/renovatio/internal/server/gateway"
	"github.com/auzring1/renovatio/internal/server/kek"
	"github.com/auzring1/renovatio/internal/server/licensing"
	"github.com/auzring1/renovatio/internal/server/pki"
	"github.com/auzring1/renovatio/internal/server/policies"
	"github.com/auzring1/renovatio/internal/server/store"
	"github.com/auzring1/renovatio/internal/server/updates"
	"github.com/auzring1/renovatio/internal/server/webui"
	"github.com/auzring1/renovatio/internal/shared/release"
)

// App is a running server.
type App struct {
	Cfg      *config.Config
	Log      *slog.Logger
	Pool     *pgxpool.Pool
	Sealer   *kek.Sealer
	Events   *events.Broker
	Hub      *gateway.Hub
	Deploy   *deploy.Service
	Updates  *updates.Service
	Releases *agentrel.Service
	Policies *policies.Service
	Catalog  *catalog.Service
	// Licensing verifies the installed license and enforces the device cap on new enrollments only.
	Licensing *licensing.Service

	authority atomic.Pointer[pki.Authority]

	mu         sync.Mutex
	setupToken string
	runCtx     context.Context
	gwStarted  bool
	gwLis      net.Listener
	httpLis    net.Listener

	// GatewayReady is closed when the agent gateway is listening.
	GatewayReady chan struct{}
}

// New migrates the database (if configured), connects and loads the CA.
func New(ctx context.Context, cfg *config.Config, log *slog.Logger) (*App, error) {
	if cfg.MigrateOnStart {
		url := cfg.MigrateDatabaseURL
		if url == "" {
			url = cfg.DatabaseURL
		}
		if err := store.Migrate(ctx, url, log); err != nil {
			return nil, err
		}
	}
	pool, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	store.CheckLeastPrivilege(ctx, pool, log)
	sealer, err := kek.New(cfg.MasterKey)
	if err != nil {
		pool.Close()
		return nil, err
	}
	a := &App{Cfg: cfg, Log: log, Pool: pool, Sealer: sealer, Events: events.NewBroker(), Hub: gateway.NewHub(),
		GatewayReady: make(chan struct{})}
	a.Deploy = &deploy.Service{Pool: pool, Authority: a.Authority, Dispatcher: a.Hub, Events: a.Events, Log: log.With("component", "deploy")}
	a.Updates = &updates.Service{Pool: pool, Deploy: a.Deploy, Events: a.Events, Log: log.With("component", "updates")}
	a.Catalog = newCatalog(cfg, pool)
	a.Releases = &agentrel.Service{Pool: pool, Deploy: a.Deploy, Content: a.Catalog.Content, Events: a.Events, Log: log.With("component", "agentrel")}
	if extra, err := release.ParseKeys(cfg.ReleasePublicKeys); err == nil && len(extra) > 0 {
		a.Releases.Keys = append(release.TrustedKeys(), extra...)
	}
	lic, err := licensing.New(pool, cfg.LicensePublicKeys, log.With("component", "licensing"))
	if err != nil {
		pool.Close()
		return nil, err
	}
	a.Licensing = lic
	a.Releases.Licensing = lic
	a.Policies = &policies.Service{Pool: pool, Deploy: a.Deploy, Log: log.With("component", "policies")}
	a.Deploy.AfterTerminal = func(ctx context.Context, j dbq.Job, status string, u *agentv1.JobUpdate) {
		a.Updates.AfterJob(ctx, j, status, u)
		a.Releases.AfterJob(ctx, j, status, u)
	}
	q := dbq.New(pool)
	if err := q.MarkAllDevicesOffline(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	auth, err := pki.LoadAuthority(ctx, q, sealer)
	switch {
	case err == nil:
		a.authority.Store(auth)
	case errors.Is(err, pki.ErrNotInitialized):
		n, cerr := q.CountUsers(ctx)
		if cerr != nil {
			pool.Close()
			return nil, cerr
		}
		if n > 0 {
			pool.Close()
			return nil, errors.New("users exist but the certificate authority is missing; restore from backup")
		}
		if err := a.newSetupToken(); err != nil {
			pool.Close()
			return nil, err
		}
	default:
		pool.Close()
		return nil, fmt.Errorf("load certificate authority: %w", err)
	}
	return a, nil
}

// Close releases resources.
func (a *App) Close() { a.Pool.Close() }

func (a *App) newSetupToken() error {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	a.mu.Lock()
	a.setupToken = base64.RawURLEncoding.EncodeToString(b)
	tok := a.setupToken
	a.mu.Unlock()
	fmt.Fprintf(os.Stderr, "\n"+
		"==================================================================\n"+
		"  "+brand.Name+" first-run setup is pending.\n"+
		"  Open %s and enter this one-time setup token:\n\n"+
		"      %s\n\n"+
		"  The token changes every time the server restarts until setup is done.\n"+
		"==================================================================\n\n", a.Cfg.Origin(), tok)
	a.Log.Info("first-run setup pending; setup token printed to stderr")
	return nil
}

// SetupToken returns the current setup token (tests only).
func (a *App) SetupToken() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.setupToken
}

// Authority returns the loaded CA (nil before setup).
func (a *App) Authority() *pki.Authority { return a.authority.Load() }

// --- api.SetupController ---

type setupCtl struct{ a *App }

func (s setupCtl) Required(ctx context.Context) (bool, error) {
	n, err := dbq.New(s.a.Pool).CountUsers(ctx)
	return n == 0, err
}

func (s setupCtl) CheckToken(tok string) bool {
	s.a.mu.Lock()
	defer s.a.mu.Unlock()
	return s.a.setupToken != "" && len(tok) == len(s.a.setupToken) &&
		subtle.ConstantTimeCompare([]byte(tok), []byte(s.a.setupToken)) == 1
}

func (s setupCtl) Completed(ctx context.Context) error {
	auth, err := pki.LoadAuthority(ctx, dbq.New(s.a.Pool), s.a.Sealer)
	if err != nil {
		return err
	}
	s.a.authority.Store(auth)
	s.a.mu.Lock()
	s.a.setupToken = ""
	s.a.mu.Unlock()
	return s.a.startGateway()
}

// Handler builds the HTTP handler (exposed for tests).
func (a *App) Handler() http.Handler {
	sessions := &auth.Sessions{
		Q:      func(context.Context) *dbq.Queries { return dbq.New(a.Pool) },
		Idle:   a.Cfg.SessionIdleTimeout,
		Abs:    a.Cfg.SessionAbsTimeout,
		Secure: a.Cfg.SecureCookies(),
	}
	return api.NewHandler(api.Deps{
		Cfg: a.Cfg, Pool: a.Pool, Sealer: a.Sealer, Sessions: sessions, Events: a.Events,
		Setup: setupCtl{a}, Devices: a.Hub, Authority: a.Authority, Log: a.Log, Deploy: a.Deploy, Catalog: a.Catalog, Updates: a.Updates, Releases: a.Releases, Policies: a.Policies, Licensing: a.Licensing,
	}, webui.Handler())
}

// Run serves HTTP and (once the CA exists) the agent gateway until ctx ends.
func (a *App) Run(ctx context.Context) error {
	a.mu.Lock()
	a.runCtx = ctx
	a.mu.Unlock()

	lis, err := net.Listen("tcp", a.Cfg.HTTPAddr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", a.Cfg.HTTPAddr, err)
	}
	a.mu.Lock()
	a.httpLis = lis
	a.mu.Unlock()
	srv := &http.Server{
		Handler:           a.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
		ErrorLog:          slog.NewLogLogger(a.Log.Handler(), slog.LevelWarn),
	}
	if a.Authority() != nil {
		if err := a.startGateway(); err != nil {
			return err
		}
	}
	go a.housekeeping(ctx)

	errCh := make(chan error, 1)
	go func() {
		a.Log.Info("http listening", "addr", lis.Addr().String())
		errCh <- srv.Serve(lis)
	}()
	select {
	case <-ctx.Done():
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
	return nil
}

// HTTPAddr returns the bound HTTP address (useful with :0 in tests).
func (a *App) HTTPAddr() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.httpLis == nil {
		return ""
	}
	return a.httpLis.Addr().String()
}

// GatewayAddr returns the bound gateway address.
func (a *App) GatewayAddr() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.gwLis == nil {
		return ""
	}
	return a.gwLis.Addr().String()
}

func (a *App) startGateway() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.gwStarted || a.runCtx == nil {
		return nil
	}
	ctx := a.runCtx
	gw := gateway.New(gateway.Options{Config: a.Cfg, Pool: a.Pool, Sealer: a.Sealer, Authority: a.Authority(),
		Events: a.Events, Hub: a.Hub, Log: a.Log.With("component", "gateway"), Deploy: a.Deploy, Updates: a.Updates, Content: a.Catalog.Content, Licensing: a.Licensing})
	if err := gw.RefreshCertificate(ctx); err != nil {
		return fmt.Errorf("gateway certificate: %w", err)
	}
	lis, err := net.Listen("tcp", a.Cfg.GatewayAddr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", a.Cfg.GatewayAddr, err)
	}
	a.gwLis = lis
	a.gwStarted = true
	go func() {
		a.Log.Info("agent gateway listening", "addr", lis.Addr().String(), "public", a.Cfg.GatewayPublicAddr)
		if err := gw.Serve(ctx, lis); err != nil {
			a.Log.Error("gateway stopped", "err", err)
		}
	}()
	close(a.GatewayReady)
	return nil
}

func (a *App) housekeeping(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	n := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.Deploy.Sweep(ctx)
			a.Updates.Tick(ctx)
			a.Releases.Tick(ctx)
			a.Licensing.Tick(ctx)
			if n%5 == 0 {
				a.Policies.Tick(ctx)
			}
			n++
			if n%1440 == 0 {
				a.Updates.Prune(ctx)
			}
			if n%10 != 0 {
				continue
			}
			if n, err := dbq.New(a.Pool).DeleteExpiredSessions(ctx, time.Now()); err != nil {
				a.Log.Error("session cleanup", "err", err)
			} else if n > 0 {
				a.Log.Debug("expired sessions removed", "count", n)
			}
		}
	}
}

// newCatalog builds the catalog service from the configuration.
func newCatalog(cfg *config.Config, pool *pgxpool.Pool) *catalog.Service {
	s := &catalog.Service{Pool: pool, Overlay: catalog.LoadOverlay()}
	if cfg.WingetSource == "github" {
		s.Source = &catalog.GitHubSource{Token: cfg.GitHubToken}
	}
	if cfg.ContentDir != "" {
		s.Content = &catalog.Store{Dir: cfg.ContentDir}
	}
	return s
}
