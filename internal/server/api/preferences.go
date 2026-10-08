package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/auzring1/renovatio/gen/dbq"
	"github.com/auzring1/renovatio/internal/server/branding"
	"github.com/auzring1/renovatio/internal/server/store"
)

// Limits on what one account may store. The document is small by design: it holds a theme, a density and the
// table views people save, and is capped so it cannot be used as storage.
const (
	maxViewTables   = 32
	maxViewsPerTbl  = 20
	maxViewStateLen = 4096
)

var (
	tableIDRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)
	viewIDRe  = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)
)

// savedView is one named table view (visible columns, order, widths, sort, filters), opaque to the server apart
// from being a small JSON object.
type savedView struct {
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	State json.RawMessage `json:"state"`
}

// preferences is a person's console appearance, kept on the account so it follows them to any device.
type preferences struct {
	Theme   string                 `json:"theme"`   // "" = the organization's default
	Density string                 `json:"density"` // "" | comfortable | compact
	Views   map[string][]savedView `json:"views"`   // table id -> saved views
}

func (p *preferences) normalize() {
	if p.Views == nil {
		p.Views = map[string][]savedView{}
	}
}

// GET /me/preferences: the signed-in person's preferences (empty values until they choose).
func (s *server) getPreferences(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r)
	var out preferences
	raw, err := s.q().GetUserPreferences(r.Context(), p.UserID)
	switch {
	case store.IsNoRows(err):
	case err != nil:
		s.Log.Error("preferences", "err", err)
		internalError(w)
		return
	default:
		_ = json.Unmarshal(raw, &out)
	}
	out.normalize()
	writeJSON(w, http.StatusOK, out)
}

// PUT /me/preferences: replaces the signed-in person's preferences.
func (s *server) putPreferences(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r)
	if p.TokenID != "" {
		writeError(w, http.StatusForbidden, "forbidden", "An API token cannot change console preferences.")
		return
	}
	var in preferences
	if !decode(w, r, &in) {
		return
	}
	in.normalize()
	fields := map[string]string{}
	in.Theme = strings.TrimSpace(in.Theme)
	if in.Theme != "" && !branding.ValidThemeID(in.Theme) {
		fields["theme"] = "That theme is not valid."
	}
	if in.Density != "" && in.Density != "comfortable" && in.Density != "compact" {
		fields["density"] = "Density is comfortable or compact."
	}
	if in.Theme != "" && fields["theme"] == "" && s.Branding != nil {
		if pub, err := s.Branding.Public(r.Context()); err == nil && len(pub.AllowedThemes) > 0 && !slices.Contains(pub.AllowedThemes, in.Theme) {
			fields["theme"] = "Your administrator does not offer that theme."
		}
	}
	if len(in.Views) > maxViewTables {
		fields["views"] = "Too many tables have saved views."
	}
	for tbl, views := range in.Views {
		if !tableIDRe.MatchString(tbl) || len(views) > maxViewsPerTbl {
			fields["views"] = "A table has an invalid id or too many saved views."
			break
		}
		ids := map[string]bool{}
		for _, v := range views {
			name := strings.TrimSpace(v.Name)
			bad := !viewIDRe.MatchString(v.ID) || ids[v.ID] || name == "" || utf8.RuneCountInString(name) > 60 || len(v.State) > maxViewStateLen
			for _, c := range name {
				bad = bad || unicode.IsControl(c)
			}
			var obj map[string]json.RawMessage
			bad = bad || json.Unmarshal(v.State, &obj) != nil || obj == nil || !bytes.HasPrefix(bytes.TrimSpace(v.State), []byte("{"))
			if bad {
				fields["views"] = "A saved view is not valid (id, name up to 60 characters, small JSON state)."
			}
			ids[v.ID] = true
		}
	}
	if len(fields) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, apiError{Error: errorBody{Code: "invalid_preferences", Message: "Some preferences are not valid.", Fields: fields}})
		return
	}
	raw, err := json.Marshal(in)
	if err != nil || len(raw) > 60<<10 {
		writeError(w, http.StatusUnprocessableEntity, "invalid_preferences", "The preferences are too large.")
		return
	}
	if err := s.q().UpsertUserPreferences(r.Context(), dbq.UpsertUserPreferencesParams{UserID: p.UserID, Data: raw, UpdatedAt: s.now()}); err != nil {
		s.Log.Error("save preferences", "err", err)
		internalError(w)
		return
	}
	writeJSON(w, http.StatusOK, in)
}
