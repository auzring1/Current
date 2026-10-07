package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/auzring1/auzring/internal/server/deploy"
)

// deviceActionError maps the deploy service's device-level errors to HTTP responses.
func (s *server) deviceActionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, deploy.ErrDeviceOffline):
		writeError(w, http.StatusConflict, "device_offline", "The device is offline. Try again when it is connected.")
	case errors.Is(err, deploy.ErrNotActive):
		writeError(w, http.StatusConflict, "not_active", "This device is not an active, enrolled device.")
	case errors.Is(err, deploy.ErrInvalid):
		writeError(w, http.StatusUnprocessableEntity, "invalid_request", strings.TrimPrefix(err.Error(), deploy.ErrInvalid.Error()+": "))
	default:
		s.Log.Error("device action", "err", err)
		internalError(w)
	}
}

// refreshDevice: POST /devices/{id}/refresh. The device re-sends hardware, software and users now.
func (s *server) refreshDevice(w http.ResponseWriter, r *http.Request) {
	d, ok := s.deviceFromURL(w, r)
	if !ok {
		return
	}
	p := principalFrom(r)
	id, err := s.Deploy.RequestRefresh(r.Context(), p.OrgID, p.UserID, d.ID, clientIP(r))
	if err != nil {
		s.deviceActionError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]uuid.UUID{"job_id": id})
}

// uninstallDeviceSoftware: POST /devices/{id}/software/uninstall.
func (s *server) uninstallDeviceSoftware(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Items []deploy.SoftwareRef `json:"items"`
	}
	if !decode(w, r, &req) {
		return
	}
	d, ok := s.deviceFromURL(w, r)
	if !ok {
		return
	}
	p := principalFrom(r)
	res, err := s.Deploy.UninstallSoftware(r.Context(), p.OrgID, p.UserID, d.ID, clientIP(r), req.Items)
	if err != nil {
		s.deviceActionError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

// deviceUpdates: GET /devices/{id}/updates.
func (s *server) deviceUpdates(w http.ResponseWriter, r *http.Request) {
	d, ok := s.deviceFromURL(w, r)
	if !ok {
		return
	}
	items, err := s.Deploy.DeviceUpdates(r.Context(), principalFrom(r).OrgID, d.ID)
	if err != nil {
		s.deviceActionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
