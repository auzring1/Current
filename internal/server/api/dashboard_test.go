package api

import (
	"testing"

	"github.com/google/uuid"

	"github.com/auzring1/current/internal/server/auth"
)

func TestScope(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	org := &Principal{Access: auth.Access{Org: map[string]bool{auth.PermDevicesRead: true}}}
	if sc := scopeOf(org, auth.PermDevicesRead); !sc.ok || sc.sites != nil || !sc.has(a) {
		t.Fatalf("org-wide: %+v", sc)
	}
	site := &Principal{Access: auth.Access{Org: map[string]bool{}, Sites: map[uuid.UUID]map[string]bool{a: {auth.PermDevicesRead: true}}}}
	sc := scopeOf(site, auth.PermDevicesRead)
	if !sc.ok || !sc.has(a) || sc.has(b) {
		t.Fatalf("site-limited: %+v", sc)
	}
	if sc := scopeOf(site, auth.PermUpdatesRead); sc.ok || sc.has(a) {
		t.Fatalf("no permission: %+v", sc)
	}
}
