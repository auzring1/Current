package deploy

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/auzring1/renovatio/gen/dbq"
	"github.com/auzring1/renovatio/internal/server/catalog"
	"github.com/auzring1/renovatio/internal/server/inventory"
	"github.com/auzring1/renovatio/internal/server/wingetindex"
	"github.com/auzring1/renovatio/internal/shared/vercmp"
)

// useIndex gives the fixture's service the small synthetic winget index.
func (f *fixture) useIndex() {
	f.t.Helper()
	b, err := os.ReadFile("../wingetindex/testdata/mini-source2.msix")
	if err != nil {
		f.t.Fatal(err)
	}
	snap, err := wingetindex.ParseMSIX(b)
	if err != nil {
		f.t.Fatal(err)
	}
	w := &wingetindex.Service{}
	w.Use(snap)
	f.svc.Winget = w
	f.svc.Overlay = catalog.LoadOverlay()
}

// program records an installed program with the details the matcher uses.
func (f *fixture) program(dev uuid.UUID, source, itemKey, name, publisher, productCode, version string) {
	f.t.Helper()
	ctx := context.Background()
	var title uuid.UUID
	norm := inventory.NormalizeName(name, version)
	err := f.pool.QueryRow(ctx, `INSERT INTO software_titles (id, org_id, normalized_name, normalized_publisher, display_name, display_publisher)
		VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (org_id, normalized_name, normalized_publisher) DO UPDATE SET display_name = EXCLUDED.display_name
		RETURNING id`, uuid.New(), f.org, norm, strings.ToLower(publisher), name, publisher).Scan(&title)
	if err != nil {
		f.t.Fatal(err)
	}
	f.exec(`INSERT INTO software_installs (device_id, source, scope, user_sid, item_key, title_id, name, version, version_key, publisher, product_code, first_seen_at, last_seen_at)
		VALUES ($1,$2,'machine','',$3,$4,$5,$6,$7,$8,$9,now(),now())`, dev, source, itemKey, title, name, version, vercmp.Key(version), publisher, productCode)
}

func TestUpdatesFromTheWingetIndexNeedNoCatalogEntry(t *testing.T) {
	f := newFixture(t)
	f.useIndex()
	ctx := context.Background()
	old, cur, other := f.device("old", "amd64"), f.device("cur", "amd64"), f.device("other", "amd64")
	f.program(old, "reg64", "7-Zip", "7-Zip 24.08 (x64 edition)", "Igor Pavlov", "", "24.08")
	f.program(old, "reg64", "Google Chrome", "Google Chrome", "Google LLC", "", "154.0.8037.98")
	f.program(old, "reg64", "HSC", "Hospital Scheduling Client", "Contoso Health", "", "1.0")
	f.program(cur, "reg64", "7-Zip", "7-Zip 26.04 (x64 edition)", "Igor Pavlov", "", "26.04")
	f.program(other, "reg64", "Google Chrome", "Google Chrome", "Google LLC", "", "154.0.8000.1")

	ups, err := f.svc.DeviceUpdates(ctx, f.org, old)
	if err != nil || len(ups) != 2 {
		t.Fatalf("%+v %v", ups, err)
	}
	by := map[string]AvailableUpdate{}
	for _, u := range ups {
		by[u.WingetID] = u
	}
	z, c := by["7zip.7zip"], by["Google.Chrome"]
	if z.InCatalog || z.PackageID != uuid.Nil || z.LatestVersion != "26.04" || z.InstalledVersion != "24.08" || !z.Deployable || z.MatchedBy != "product_code" {
		t.Fatalf("7-Zip: %+v", z)
	}
	// Chrome updates itself: listed, but left to the vendor unless an administrator decides otherwise.
	if c.InCatalog || c.LatestVersion != "155.0.8059.40" || c.Deployable || c.Reason == "" || !c.SelfUpdating || c.MatchedBy != "name" {
		t.Fatalf("Chrome: %+v", c)
	}
	if ups, _ := f.svc.DeviceUpdates(ctx, f.org, cur); len(ups) != 0 {
		t.Fatalf("a current install is not an update: %+v", ups)
	}

	fleet, err := f.svc.FleetUpdates(ctx, f.org)
	if err != nil || len(fleet) != 2 {
		t.Fatalf("%+v %v", fleet, err)
	}
	if fleet[0].WingetID != "Google.Chrome" || len(fleet[0].Devices) != 2 || fleet[0].InCatalog || fleet[1].WingetID != "7zip.7zip" || len(fleet[1].Devices) != 1 {
		t.Fatalf("fleet: %+v", fleet)
	}

	// Without an index nothing changes: only the catalog counts.
	f.svc.Winget = nil
	if ups, _ := f.svc.DeviceUpdates(ctx, f.org, old); len(ups) != 0 {
		t.Fatalf("no index, no catalog: %+v", ups)
	}
}

func TestACatalogEntryDecidesInsteadOfTheIndex(t *testing.T) {
	f := newFixture(t)
	f.useIndex()
	ctx := context.Background()
	d := f.device("pc", "amd64")
	f.program(d, "reg64", "7-Zip", "7-Zip 24.08 (x64 edition)", "Igor Pavlov", "", "24.08")

	// Imported under another name: the product code finds it, the catalog's newest allowed version is what counts.
	q := dbq.New(f.pool)
	pid, err := q.UpsertCatalogPackage(ctx, dbq.UpsertCatalogPackageParams{ID: uuid.New(), OrgID: f.org, Source: "winget", Identifier: "7zip.7zip", Name: "Archive Tool", Publisher: "Igor Pavlov"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.UpsertCatalogVersion(ctx, dbq.UpsertCatalogVersionParams{ID: uuid.New(), PackageID: pid, Version: "25.01", VersionKey: vercmp.Key("25.01")}); err != nil {
		t.Fatal(err)
	}
	ups, _ := f.svc.DeviceUpdates(ctx, f.org, d)
	if len(ups) != 1 || !ups[0].InCatalog || ups[0].PackageID != pid || ups[0].LatestVersion != "25.01" || ups[0].WingetID != "7zip.7zip" {
		t.Fatalf("%+v", ups)
	}
	// An administrator excluded the package: the index must not bring it back.
	f.exec("INSERT INTO package_overrides (org_id, package_id, excluded) VALUES ($1,$2,true)", f.org, pid)
	if ups, _ := f.svc.DeviceUpdates(ctx, f.org, d); len(ups) != 0 {
		t.Fatalf("excluded package listed: %+v", ups)
	}
	// A pin below the installed version: same.
	f.exec("UPDATE package_overrides SET excluded = false, pin = '< 24.0'")
	if ups, _ := f.svc.DeviceUpdates(ctx, f.org, d); len(ups) != 0 {
		t.Fatalf("pinned package listed: %+v", ups)
	}
}
