package catalog

import (
	_ "embed"
	"encoding/json"
	"strings"
)

//go:embed overlay.json
var overlayJSON []byte

//go:embed matrix_results.json
var matrixJSON []byte

// OverlayEntry is knowledge we ship about a package that its manifest lacks.
type OverlayEntry struct {
	Identifier   string `json:"identifier"`
	SelfUpdating bool   `json:"self_updating"`
	Note         string `json:"note,omitempty"`
}

// MatrixResult is one passing VM-matrix run (docs/ARCHITECTURE.md §7.9).
type MatrixResult struct {
	Identifier string `json:"identifier"`
	Scope      string `json:"scope"` // machine | user
	OS         string `json:"os"`
	RunID      string `json:"run_id"`
	PassedAt   string `json:"passed_at"`
}

// Overlay is the embedded catalog overlay plus VM-matrix results.
type Overlay struct {
	byID    map[string]OverlayEntry
	results map[string][]MatrixResult
}

// LoadOverlay parses the embedded data.
func LoadOverlay() *Overlay {
	o := &Overlay{byID: map[string]OverlayEntry{}, results: map[string][]MatrixResult{}}
	var ov struct {
		Packages []OverlayEntry `json:"packages"`
	}
	_ = json.Unmarshal(overlayJSON, &ov)
	for _, e := range ov.Packages {
		o.byID[strings.ToLower(e.Identifier)] = e
	}
	var res []MatrixResult
	_ = json.Unmarshal(matrixJSON, &res)
	for _, r := range res {
		k := strings.ToLower(r.Identifier)
		o.results[k] = append(o.results[k], r)
	}
	return o
}

// Entry returns the overlay entry for an identifier.
func (o *Overlay) Entry(id string) (OverlayEntry, bool) {
	e, ok := o.byID[strings.ToLower(id)]
	return e, ok
}

// Verified reports whether the package has a passing matrix run for the scope
// ("" = any scope).
func (o *Overlay) Verified(id, scope string) bool {
	for _, r := range o.results[strings.ToLower(id)] {
		if scope == "" || r.Scope == scope {
			return true
		}
	}
	return false
}

// Known lists the overlay's packages (used to suggest imports).
func (o *Overlay) Known() []OverlayEntry {
	out := make([]OverlayEntry, 0, len(o.byID))
	for _, e := range o.byID {
		out = append(out, e)
	}
	return out
}
