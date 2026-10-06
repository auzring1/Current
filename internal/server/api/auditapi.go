package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/auzring1/auzring/gen/dbq"
)

type auditView struct {
	ID         int64           `json:"id"`
	TS         time.Time       `json:"ts"`
	ActorType  string          `json:"actor_type"`
	ActorID    string          `json:"actor_id"`
	ActorIP    string          `json:"actor_ip"`
	Action     string          `json:"action"`
	TargetType string          `json:"target_type"`
	TargetIDs  []string        `json:"target_ids"`
	Outcome    string          `json:"outcome"`
	Details    json.RawMessage `json:"details"`
}

func (s *server) listAudit(w http.ResponseWriter, r *http.Request) {
	limit, _, ok := paging(w, r, 100, 500)
	if !ok {
		return
	}
	var before *int64
	if v := r.URL.Query().Get("before_id"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 1 {
			badRequest(w, "before_id must be a positive integer")
			return
		}
		before = &n
	}
	org := principalFrom(r).OrgID
	rows, err := s.q().ListAudit(r.Context(), dbq.ListAuditParams{OrgID: &org, Limit: limit, BeforeID: before})
	if err != nil {
		internalError(w)
		return
	}
	items := make([]auditView, 0, len(rows))
	for _, a := range rows {
		items = append(items, auditView{ID: a.ID, TS: a.Ts, ActorType: a.ActorType, ActorID: a.ActorID, ActorIP: a.ActorIp,
			Action: a.Action, TargetType: a.TargetType, TargetIDs: a.TargetIds, Outcome: a.Outcome, Details: a.Details})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
