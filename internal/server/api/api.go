// Package api implements the REST API used by the web console.
// The contract is api/openapi.yaml; TestRoutesMatchSpec keeps them in sync.
package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/auzring1/auzring/gen/dbq"
	"github.com/auzring1/auzring/internal/server/auth"
	"github.com/auzring1/auzring/internal/server/catalog"
	"github.com/auzring1/auzring/internal/server/config"
	"github.com/auzring1/auzring/internal/server/deploy"
	"github.com/auzring1/auzring/internal/server/events"
	"github.com/auzring1/auzring/internal/server/kek"
	"github.com/auzring1/auzring/internal/server/pki"
)

// SetupController is implemented by the app to drive first-run setup.
type SetupController interface {
	// Required reports whether first-run setup is still pending.
	Required(ctx context.Context) (bool, error)
	// CheckToken validates the one-time setup token printed at startup.
	CheckToken(tok string) bool
	// Completed is called after setup commits (loads the CA, starts the gateway).
	Completed(ctx context.Context) error
}

// DeviceController lets handlers act on live agent connections.
type DeviceController interface {
	Disconnect(deviceID uuid.UUID, reason string)
}

// Deps are the API's dependencies.
type Deps struct {
	Cfg       *config.Config
	Pool      *pgxpool.Pool
	Sealer    *kek.Sealer
	Sessions  *auth.Sessions
	Events    *events.Broker
	Setup     SetupController
	Devices   DeviceController
	Authority func() *pki.Authority
	Deploy    *deploy.Service
	Catalog   *catalog.Service
	Log       *slog.Logger
	Now       func() time.Time
}

type server struct {
	Deps
	loginIP    *auth.Limiter
	loginEmail *auth.Limiter
	setupIP    *auth.Limiter
	apiIP      *auth.Limiter
	sse        *sseLimiter
}

func (s *server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *server) q() *dbq.Queries { return dbq.New(s.Pool) }

// NewHandler builds the full HTTP handler: /api/v1, health endpoints and the GUI.
func NewHandler(d Deps, gui http.Handler) http.Handler {
	s := &server{
		Deps:       d,
		loginIP:    auth.NewLimiter(10, time.Minute, 10),
		loginEmail: auth.NewLimiter(5, time.Minute, 5),
		setupIP:    auth.NewLimiter(5, time.Minute, 10),
		apiIP:      auth.NewLimiter(20, time.Second, 60),
		sse:        newSSELimiter(5),
	}
	go s.sweepLimiters()

	r := chi.NewRouter()
	r.Use(s.recoverer, s.realIP, securityHeaders(d.Cfg))
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	r.Get("/readyz", s.readyz)
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(apiHeaders, s.rateLimit, s.requestLog, s.originCheck, s.loadSession, s.csrfCheck)
		s.routes(r)
	})
	if gui != nil {
		r.NotFound(gui.ServeHTTP)
	}
	return r
}

// routes registers every API route. Keep in sync with api/openapi.yaml.
func (s *server) routes(r chi.Router) {
	r.Get("/setup/status", s.setupStatus)
	r.Post("/setup/begin", s.setupBegin)
	r.Post("/setup/complete", s.setupComplete)

	r.Post("/auth/login", s.login)
	r.Post("/auth/mfa", s.mfaVerify)
	r.Post("/auth/mfa/enroll", s.mfaEnroll)
	r.Post("/auth/logout", s.logout)
	r.Get("/auth/session", s.session)

	r.With(s.require(auth.PermDevicesRead)).Get("/devices", s.listDevices)
	r.With(s.require(auth.PermDevicesRead)).Get("/devices/{id}", s.getDevice)
	r.With(s.require(auth.PermDevicesWrite)).Post("/devices/{id}/approve", s.approveDevice)
	r.With(s.require(auth.PermDevicesWrite)).Post("/devices/{id}/revoke", s.revokeDevice)
	r.With(s.require(auth.PermDevicesWrite)).Delete("/devices/{id}", s.deleteDevice)
	r.With(s.require(auth.PermDevicesWrite)).Post("/devices/delete", s.deleteDevices)

	r.With(s.require(auth.PermDevicesRead)).Get("/devices/{id}/software", s.deviceSoftware)
	r.With(s.require(auth.PermDevicesRead)).Get("/devices/{id}/software/history", s.deviceSoftwareHistory)
	r.With(s.require(auth.PermDevicesRead)).Get("/devices/{id}/users", s.deviceUsers)

	r.With(s.require(auth.PermDevicesRead)).Get("/software", s.searchSoftware)
	r.With(s.require(auth.PermDevicesRead)).Get("/software/{id}", s.getSoftware)
	r.With(s.require(auth.PermDevicesRead)).Get("/software/{id}/installs", s.titleInstalls)

	r.With(s.require(auth.PermGroupsRead)).Get("/groups", s.listGroups)
	r.With(s.require(auth.PermGroupsWrite)).Post("/groups", s.createGroup)
	r.With(s.require(auth.PermGroupsRead)).Post("/groups/preview", s.previewGroup)
	r.With(s.require(auth.PermGroupsRead)).Get("/groups/{id}", s.getGroup)
	r.With(s.require(auth.PermGroupsWrite)).Put("/groups/{id}", s.updateGroup)
	r.With(s.require(auth.PermGroupsWrite)).Delete("/groups/{id}", s.deleteGroup)
	r.With(s.require(auth.PermGroupsRead)).Get("/groups/{id}/devices", s.groupDevices)

	r.With(s.require(auth.PermInventoryExport)).Get("/reports/software.csv", s.softwareCSV)
	r.With(s.require(auth.PermInventoryExport)).Get("/reports/devices.csv", s.devicesCSV)

	r.With(s.require(auth.PermDeploymentsRead)).Get("/devices/{id}/jobs", s.deviceJobs)
	r.With(s.require(auth.PermDeploymentsRead)).Get("/devices/{id}/updates", s.deviceUpdates)
	r.With(s.require(auth.PermDeploymentsWrite)).Post("/devices/{id}/software/uninstall", s.uninstallDeviceSoftware)
	r.With(s.require(auth.PermDevicesWrite)).Post("/devices/{id}/refresh", s.refreshDevice)

	r.With(s.require(auth.PermCatalogRead)).Get("/catalog/packages", s.listPackages)
	r.With(s.require(auth.PermCatalogRead)).Get("/catalog/search", s.searchCatalog)
	r.With(s.require(auth.PermCatalogRead)).Get("/catalog/packages/{id}", s.getPackage)
	r.With(s.require(auth.PermCatalogWrite)).Post("/catalog/import", s.importPackage)
	r.With(s.require(auth.PermCatalogWrite)).Post("/catalog/content", s.uploadContent)
	r.With(s.require(auth.PermCatalogWrite)).Post("/catalog/custom", s.createCustom)
	r.With(s.require(auth.PermCatalogOverride)).Put("/catalog/packages/{id}/overrides", s.putOverrides)
	r.With(s.require(auth.PermCatalogWrite)).Delete("/catalog/packages/{id}", s.deletePackage)
	r.With(s.require(auth.PermCatalogRead)).Get("/settings", s.getSettings)
	r.With(s.require(auth.PermSettingsWrite)).Put("/settings", s.putSettings)

	r.With(s.require(auth.PermDeploymentsRead)).Get("/deployments", s.listDeployments)
	r.With(s.require(auth.PermDeploymentsWrite)).Post("/deployments", s.createDeployment)
	r.With(s.require(auth.PermDeploymentsRead)).Get("/deployments/{id}", s.getDeployment)
	r.With(s.require(auth.PermDeploymentsRead)).Get("/deployments/{id}/jobs", s.deploymentJobs)
	r.With(s.require(auth.PermDeploymentsWrite)).Post("/deployments/{id}/cancel", s.cancelDeployment)
	r.With(s.require(auth.PermDeploymentsRead)).Get("/jobs/{id}", s.getJob)
	r.With(s.require(auth.PermDeploymentsWrite)).Post("/jobs/{id}/retry", s.retryJob)
	r.With(s.require(auth.PermGroupsWrite)).Post("/groups/{id}/members", s.changeGroupMembers)

	r.With(s.require(auth.PermEnrollmentRead)).Get("/enrollment-tokens", s.listTokens)
	r.With(s.require(auth.PermEnrollmentWrite)).Post("/enrollment-tokens", s.createToken)
	r.With(s.require(auth.PermEnrollmentWrite)).Post("/enrollment-tokens/{id}/revoke", s.revokeToken)

	r.With(s.require(auth.PermAuditRead)).Get("/audit", s.listAudit)
	r.With(s.require(auth.PermDevicesRead)).Get("/events", s.events)
}

func (s *server) readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.Pool.Ping(ctx); err != nil {
		http.Error(w, "database unavailable", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) sweepLimiters() {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for range t.C {
		for _, l := range []*auth.Limiter{s.loginIP, s.loginEmail, s.setupIP, s.apiIP} {
			l.Sweep()
		}
	}
}
