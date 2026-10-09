package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/auzring1/renovatio/gen/dbq"
	"github.com/auzring1/renovatio/internal/server/store"
)

type stamp struct {
	At      time.Time      `json:"at"`
	Details map[string]any `json:"details,omitempty"`
}

// GET /settings/data/status: how much history there is, and when the last backup, export and clean-up ran (from the
// audit log, which is where each of them is recorded).
func (s *server) dataStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	org := principalFrom(r).OrgID
	q := s.q()
	last := func(action string) *stamp {
		row, err := q.LastAuditByAction(ctx, dbq.LastAuditByActionParams{OrgID: &org, Action: action})
		if err != nil {
			return nil
		}
		var d map[string]any
		_ = json.Unmarshal(row.Details, &d)
		return &stamp{At: row.Ts, Details: d}
	}
	out := map[string]any{"settings_export": last("settings.export"), "inventory_export": last("inventory.export"), "retention": last("maintenance.retention")}
	if row, err := q.LastBackupAudit(ctx); err == nil {
		var d map[string]any
		_ = json.Unmarshal(row.Details, &d)
		out["backup"] = &stamp{At: row.Ts, Details: d}
	} else if !store.IsNoRows(err) {
		s.Log.Error("backup status", "err", err)
	}
	if f, err := q.DataFootprint(ctx, org); err == nil {
		out["footprint"] = map[string]any{"jobs": f.Jobs, "compliance_snapshots": f.Snapshots, "notifications": f.Notifications, "audit_entries": f.AuditEntries, "audit_since": f.AuditSince}
	}
	writeJSON(w, http.StatusOK, out)
}

// POST /settings/data/run-retention: applies the retention settings now instead of waiting for the daily run.
func (s *server) runRetention(w http.ResponseWriter, r *http.Request) {
	if s.Maint == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "Retention is not available.")
		return
	}
	res, err := s.Maint.Run(r.Context(), principalFrom(r).OrgID)
	if err != nil {
		s.Log.Error("run retention", "err", err)
		internalError(w)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": res.Jobs, "compliance_snapshots": res.Snapshots, "notifications": res.Notifications, "devices": res.Devices})
}
