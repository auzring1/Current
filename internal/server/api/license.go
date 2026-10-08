package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/auzring1/auzring/internal/server/licensing"
)

func (s *server) licSvc(w http.ResponseWriter) bool {
	if s.Licensing == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "Licensing is not available.")
		return false
	}
	return true
}

// GET /license: the effective state, the installed license and device usage.
func (s *server) getLicense(w http.ResponseWriter, r *http.Request) {
	if !s.licSvc(w) {
		return
	}
	st, err := s.Licensing.Status(r.Context(), principalFrom(r).OrgID)
	if err != nil {
		s.Log.Error("license status", "err", err)
		internalError(w)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// PUT /license: install a pasted license (administrators; audited).
func (s *server) putLicense(w http.ResponseWriter, r *http.Request) {
	if !s.licSvc(w) {
		return
	}
	var in struct {
		License string `json:"license"`
	}
	if !decode(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.License) == "" {
		badRequest(w, "Paste the license text (it starts with AZL1.).")
		return
	}
	p := principalFrom(r)
	st, err := s.Licensing.Install(r.Context(), licensing.Actor{Org: p.OrgID, User: p.UserID, IP: clientIP(r)}, in.License)
	switch {
	case errors.Is(err, licensing.ErrInvalid):
		writeError(w, http.StatusUnprocessableEntity, "invalid_license", strings.TrimPrefix(err.Error(), licensing.ErrInvalid.Error()+": "))
	case errors.Is(err, licensing.ErrConflict):
		writeError(w, http.StatusConflict, "license_already_installed", strings.TrimPrefix(err.Error(), licensing.ErrConflict.Error()+": "))
	case err != nil:
		s.Log.Error("install license", "err", err)
		internalError(w)
	default:
		writeJSON(w, http.StatusOK, st)
	}
}

// GET /license/history: every license that was installed, newest first.
func (s *server) licenseHistory(w http.ResponseWriter, r *http.Request) {
	if !s.licSvc(w) {
		return
	}
	items, err := s.Licensing.History(r.Context(), principalFrom(r).OrgID)
	if err != nil {
		s.Log.Error("license history", "err", err)
		internalError(w)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
