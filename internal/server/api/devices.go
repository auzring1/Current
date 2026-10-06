package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/auzring1/auzring/gen/dbq"
	"github.com/auzring1/auzring/internal/server/audit"
	"github.com/auzring1/auzring/internal/server/events"
	"github.com/auzring1/auzring/internal/server/store"
)

type deviceView struct {
	ID               uuid.UUID       `json:"id"`
	SiteID           uuid.UUID       `json:"site_id"`
	Status           string          `json:"status"`
	StatusReason     string          `json:"status_reason"`
	Hostname         string          `json:"hostname"`
	OSCaption        string          `json:"os_caption"`
	OSBuild          string          `json:"os_build"`
	Arch             string          `json:"arch"`
	AgentVersion     string          `json:"agent_version"`
	Manufacturer     string          `json:"manufacturer"`
	Model            string          `json:"model"`
	Serial           string          `json:"serial"`
	Online           bool            `json:"online"`
	LastSeenAt       *time.Time      `json:"last_seen_at"`
	LastIP           string          `json:"last_ip"`
	EnrolledAt       time.Time       `json:"enrolled_at"`
	ApprovedAt       *time.Time      `json:"approved_at"`
	RevokedAt        *time.Time      `json:"revoked_at"`
	UptimeS          int64           `json:"uptime_s"`
	PendingReboot    bool            `json:"pending_reboot"`
	LoggedOnUser     string          `json:"logged_on_user"`
	ReplacesDeviceID *uuid.UUID      `json:"replaces_device_id"`
	Hardware         json.RawMessage `json:"hardware,omitempty"`
	Certificates     []certView      `json:"certificates,omitempty"`
}

type certView struct {
	Serial    string     `json:"serial"`
	NotBefore time.Time  `json:"not_before"`
	NotAfter  time.Time  `json:"not_after"`
	RevokedAt *time.Time `json:"revoked_at"`
}

func (s *server) listDevices(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r)
	limit, offset, ok := paging(w, r, 100, 500)
	if !ok {
		return
	}
	var status *string
	if v := r.URL.Query().Get("status"); v != "" {
		switch v {
		case "pending", "active", "revoked", "retired":
			status = &v
		default:
			badRequest(w, "status must be one of pending, active, revoked, retired")
			return
		}
	}
	q := s.q()
	rows, err := q.ListDevices(r.Context(), dbq.ListDevicesParams{OrgID: p.OrgID, Limit: limit, Offset: offset, Status: status})
	if err != nil {
		s.Log.Error("list devices", "err", err)
		internalError(w)
		return
	}
	total, err := q.CountDevices(r.Context(), dbq.CountDevicesParams{OrgID: p.OrgID, Status: status})
	if err != nil {
		internalError(w)
		return
	}
	items := make([]deviceView, 0, len(rows))
	for _, d := range rows {
		items = append(items, deviceView{ID: d.ID, SiteID: d.SiteID, Status: d.Status, StatusReason: d.StatusReason,
			Hostname: d.Hostname, OSCaption: d.OsCaption, OSBuild: d.OsBuild, Arch: d.Arch, AgentVersion: d.AgentVersion,
			Manufacturer: d.Manufacturer, Model: d.Model, Serial: d.Serial, Online: d.Online, LastSeenAt: d.LastSeenAt,
			LastIP: d.LastIp, EnrolledAt: d.EnrolledAt, ApprovedAt: d.ApprovedAt, RevokedAt: d.RevokedAt,
			UptimeS: d.UptimeS, PendingReboot: d.PendingReboot, LoggedOnUser: d.LoggedOnUser, ReplacesDeviceID: d.ReplacesDeviceID})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total})
}

func (s *server) deviceFromURL(w http.ResponseWriter, r *http.Request) (dbq.Device, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "Device not found.")
		return dbq.Device{}, false
	}
	d, err := s.q().GetDeviceInOrg(r.Context(), dbq.GetDeviceInOrgParams{ID: id, OrgID: principalFrom(r).OrgID})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "not_found", "Device not found.")
		return d, false
	} else if err != nil {
		internalError(w)
		return d, false
	}
	return d, true
}

func (s *server) getDevice(w http.ResponseWriter, r *http.Request) {
	d, ok := s.deviceFromURL(w, r)
	if !ok {
		return
	}
	v := deviceView{ID: d.ID, SiteID: d.SiteID, Status: d.Status, StatusReason: d.StatusReason, Hostname: d.Hostname,
		OSCaption: d.OsCaption, OSBuild: d.OsBuild, Arch: d.Arch, AgentVersion: d.AgentVersion, Serial: d.Serial,
		Online: d.Online, LastSeenAt: d.LastSeenAt, LastIP: d.LastIp, EnrolledAt: d.EnrolledAt, ApprovedAt: d.ApprovedAt,
		RevokedAt: d.RevokedAt, UptimeS: d.UptimeS, PendingReboot: d.PendingReboot, LoggedOnUser: d.LoggedOnUser,
		ReplacesDeviceID: d.ReplacesDeviceID, Certificates: []certView{}}
	if len(d.Hardware) > 0 {
		v.Hardware = d.Hardware
		var hw struct {
			Manufacturer string `json:"manufacturer"`
			Model        string `json:"model"`
		}
		_ = json.Unmarshal(d.Hardware, &hw)
		v.Manufacturer, v.Model = hw.Manufacturer, hw.Model
	}
	rows, err := s.Pool.Query(r.Context(),
		`SELECT serial, not_before, not_after, revoked_at FROM device_certs WHERE device_id = $1 ORDER BY issued_at DESC LIMIT 20`, d.ID)
	if err == nil {
		for rows.Next() {
			var c certView
			if rows.Scan(&c.Serial, &c.NotBefore, &c.NotAfter, &c.RevokedAt) == nil {
				v.Certificates = append(v.Certificates, c)
			}
		}
		rows.Close()
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *server) approveDevice(w http.ResponseWriter, r *http.Request) {
	d, ok := s.deviceFromURL(w, r)
	if !ok {
		return
	}
	p := principalFrom(r)
	now := s.now()
	var replaced *uuid.UUID
	err := store.Tx(r.Context(), s.Pool, func(tx pgx.Tx, q *dbq.Queries) error {
		n, err := q.ApproveDevice(r.Context(), dbq.ApproveDeviceParams{ID: d.ID, OrgID: p.OrgID, ApprovedBy: &p.UserID, ApprovedAt: &now})
		if err != nil {
			return err
		}
		if n == 0 {
			return errConflict
		}
		// Re-enrollment of known hardware: approving the new identity retires the old one.
		if d.ReplacesDeviceID != nil {
			if _, err := q.RevokeDevice(r.Context(), dbq.RevokeDeviceParams{ID: *d.ReplacesDeviceID, OrgID: p.OrgID,
				StatusReason: "replaced by re-enrollment " + d.ID.String(), RevokedBy: &p.UserID, RevokedAt: &now}); err != nil {
				return err
			}
			if err := q.RevokeDeviceCerts(r.Context(), dbq.RevokeDeviceCertsParams{DeviceID: *d.ReplacesDeviceID, RevokedAt: &now, RevokeReason: "replaced"}); err != nil {
				return err
			}
			replaced = d.ReplacesDeviceID
		}
		details := map[string]any{"hostname": d.Hostname}
		if replaced != nil {
			details["replaced_device_id"] = replaced.String()
		}
		_, err = audit.Write(r.Context(), tx, audit.Entry{OrgID: &p.OrgID, ActorType: audit.ActorUser, ActorID: p.UserID.String(),
			ActorIP: clientIP(r), Action: "device.approve", TargetType: "device", TargetIDs: []string{d.ID.String()},
			Outcome: audit.Success, Details: details}, now)
		return err
	})
	if errors.Is(err, errConflict) {
		writeError(w, http.StatusConflict, "not_pending", "Only pending devices can be approved.")
		return
	} else if err != nil {
		s.Log.Error("approve device", "err", err)
		internalError(w)
		return
	}
	if replaced != nil {
		s.Devices.Disconnect(*replaced, "replaced")
		s.Events.Publish(p.OrgID, events.Event{Type: events.DeviceUpdated, DeviceID: *replaced})
	}
	s.Events.Publish(p.OrgID, events.Event{Type: events.DeviceUpdated, DeviceID: d.ID})
	w.WriteHeader(http.StatusNoContent)
}

type revokeReq struct {
	Reason string `json:"reason"`
}

func (s *server) revokeDevice(w http.ResponseWriter, r *http.Request) {
	var req revokeReq
	if !decode(w, r, &req) {
		return
	}
	req.Reason = strings.TrimSpace(req.Reason)
	if utf8.RuneCountInString(req.Reason) > 500 {
		badRequest(w, "reason must be at most 500 characters")
		return
	}
	if req.Reason == "" {
		req.Reason = "revoked by administrator"
	}
	d, ok := s.deviceFromURL(w, r)
	if !ok {
		return
	}
	p := principalFrom(r)
	now := s.now()
	err := store.Tx(r.Context(), s.Pool, func(tx pgx.Tx, q *dbq.Queries) error {
		n, err := q.RevokeDevice(r.Context(), dbq.RevokeDeviceParams{ID: d.ID, OrgID: p.OrgID, StatusReason: req.Reason,
			RevokedBy: &p.UserID, RevokedAt: &now})
		if err != nil {
			return err
		}
		if n == 0 {
			return errConflict
		}
		if err := q.RevokeDeviceCerts(r.Context(), dbq.RevokeDeviceCertsParams{DeviceID: d.ID, RevokedAt: &now, RevokeReason: req.Reason}); err != nil {
			return err
		}
		_, err = audit.Write(r.Context(), tx, audit.Entry{OrgID: &p.OrgID, ActorType: audit.ActorUser, ActorID: p.UserID.String(),
			ActorIP: clientIP(r), Action: "device.revoke", TargetType: "device", TargetIDs: []string{d.ID.String()},
			Outcome: audit.Success, Details: map[string]any{"hostname": d.Hostname, "reason": req.Reason}}, now)
		return err
	})
	if errors.Is(err, errConflict) {
		writeError(w, http.StatusConflict, "already_revoked", "Device is already revoked or retired.")
		return
	} else if err != nil {
		s.Log.Error("revoke device", "err", err)
		internalError(w)
		return
	}
	// Committed: cut the live connection immediately (PROTOCOL §7).
	s.Devices.Disconnect(d.ID, "revoked")
	s.Events.Publish(p.OrgID, events.Event{Type: events.DeviceUpdated, DeviceID: d.ID})
	w.WriteHeader(http.StatusNoContent)
}

var errConflict = errors.New("conflict")

func paging(w http.ResponseWriter, r *http.Request, def, max int32) (int32, int32, bool) {
	limit, offset := def, int32(0)
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.ParseInt(v, 10, 32)
		if err != nil || n < 1 || n > int64(max) {
			badRequest(w, "limit must be between 1 and "+strconv.Itoa(int(max)))
			return 0, 0, false
		}
		limit = int32(n)
	}
	if v := r.URL.Query().Get("offset"); v != "" {
		n, err := strconv.ParseInt(v, 10, 32)
		if err != nil || n < 0 || n > 10_000_000 {
			badRequest(w, "offset must be a non-negative integer")
			return 0, 0, false
		}
		offset = int32(n)
	}
	return limit, offset, true
}
