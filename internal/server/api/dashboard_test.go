package api

import (
	"testing"

	"github.com/google/uuid"

	"github.com/auzring1/renovatio/internal/server/auth"
	"github.com/auzring1/renovatio/internal/server/licensing"
)

func TestLicenseSeverity(t *testing.T) {
	cases := []struct {
		name string
		st   licensing.Status
		sev  string
		ok   bool
	}{
		{"healthy", licensing.Status{State: licensing.Licensed, Devices: 10, MaxDevices: 100}, "", false},
		{"nearly full", licensing.Status{State: licensing.Licensed, Devices: 90, MaxDevices: 100}, "info", true},
		{"at capacity", licensing.Status{State: licensing.Licensed, Devices: 100, MaxDevices: 100, AtCapacity: true}, "warning", true},
		{"grace", licensing.Status{State: licensing.Grace, Devices: 1, MaxDevices: 100}, "warning", true},
		{"over capacity", licensing.Status{State: licensing.Licensed, Devices: 120, MaxDevices: 100, OverCapacity: true}, "critical", true},
		{"invalid", licensing.Status{State: licensing.Invalid}, "critical", true},
		{"evaluation, plenty of room", licensing.Status{State: licensing.Evaluation, Devices: 1, MaxDevices: 25}, "", false},
	}
	for _, c := range cases {
		sev, ok := licenseSeverity(c.st)
		if sev != c.sev || ok != c.ok {
			t.Errorf("%s: got %q %v, want %q %v", c.name, sev, ok, c.sev, c.ok)
		}
	}
}

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
