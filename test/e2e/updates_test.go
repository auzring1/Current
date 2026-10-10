//go:build !windows

// The scripted Windows Update client exists only in non-Windows builds (internal/agent/wu).
package e2e

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	agentv1 "github.com/auzring1/current/gen/proto/current/agent/v1"
	"github.com/auzring1/current/internal/agent/wu"
)

const (
	kbSecurity = "aaaaaaaa-0000-0000-0000-000000000001"
	kbOptional = "aaaaaaaa-0000-0000-0000-000000000002"
)

func writeWU(t *testing.T, dir string, f wu.DevFile) {
	t.Helper()
	b, _ := json.Marshal(f)
	if err := os.WriteFile(filepath.Join(dir, "wu-dev.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) waitJobByID(id, want string) map[string]any {
	h.t.Helper()
	var got map[string]any
	waitFor(h.t, 30*time.Second, "job "+id+" "+want, func() bool {
		_, got = h.do("GET", "/api/v1/jobs/"+id, nil, nil)
		return got["status"] == want
	})
	return got
}

func (h *harness) windowsUpdates(dev string) map[string]map[string]any {
	_, b := h.do("GET", "/api/v1/devices/"+dev+"/windows-updates", nil, nil)
	out := map[string]map[string]any{}
	for _, it := range items(b) {
		out[it["update_id"].(string)] = it
	}
	return out
}

func TestWindowsUpdateEndToEnd(t *testing.T) {
	h := newHarness(t)
	h.setupAndLogin()
	ta := h.startAgent(h.createToken("wu", 5, false), &fakeHW{host: "LAP-W1", serial: "SW1", uuid: "UW1"}, nil, withJobs)
	writeWU(t, ta.dir, wu.DevFile{Updates: []wu.DevUpdate{
		{ID: kbSecurity, Revision: 7, Title: "2026-03 Cumulative Update for Windows 11 (KB5000001)", KB: []string{"5000001"}, Classification: "Security Updates",
			Severity: "Critical", NeedsReboot: true, ReleaseDate: time.Now().Add(-72 * time.Hour).Unix()},
		{ID: kbOptional, Revision: 1, Title: "Optional preview update (KB5000002)", KB: []string{"5000002"}, Classification: "Updates"},
	}, Policy: nil})
	waitFor(t, 15*time.Second, "agent connected", func() bool { return ta.state() == "connected" })
	dev := h.devices()[0]["id"].(string)
	ctx := context.Background()

	// The server sends the source settings; the agent scans and reports without anyone asking.
	h.app.Updates.Tick(ctx)
	waitFor(t, 20*time.Second, "first scan reported", func() bool { return len(h.windowsUpdates(dev)) == 2 })
	ups := h.windowsUpdates(dev)
	if ups[kbSecurity]["state"] != "missing" || ups[kbSecurity]["severity"] != "Critical" || ups[kbSecurity]["classification"] != "Security Updates" {
		t.Fatalf("scan result: %v", ups[kbSecurity])
	}
	_, cat := h.do("GET", "/api/v1/updates?decision=pending", nil, nil)
	if len(items(cat)) != 2 || items(cat)[0]["devices_missing"] != float64(1) {
		t.Fatalf("catalog: %v", cat)
	}

	// Who manages updates: a WSUS policy shows up as a conflict.
	writeWU(t, ta.dir, wu.DevFile{Updates: []wu.DevUpdate{
		{ID: kbSecurity, Revision: 7, Title: "2026-03 Cumulative Update for Windows 11 (KB5000001)", KB: []string{"5000001"}, Classification: "Security Updates", Severity: "Critical", NeedsReboot: true},
		{ID: kbOptional, Revision: 1, Title: "Optional preview update (KB5000002)", KB: []string{"5000002"}, Classification: "Updates"},
	}, Policy: &agentv1.WuPolicyInfo{WsusConfigured: true, WsusServer: "http://wsus.example:8530", EffectiveSource: "wsus"}})
	st, sc := h.do("POST", "/api/v1/devices/"+dev+"/windows-updates/scan", map[string]any{}, nil)
	if st != 202 {
		t.Fatalf("scan: %d %v", st, sc)
	}
	h.waitJobByID(sc["job_id"].(string), "succeeded")
	waitFor(t, 15*time.Second, "policy conflict reported", func() bool {
		_, c := h.do("GET", "/api/v1/update-conflicts", nil, nil)
		return len(items(c)) == 1
	})

	// Approve one update and put the device in a ring that restarts at once when needed.
	_, g := h.do("POST", "/api/v1/groups", map[string]any{"kind": "static", "name": "Pilot PCs"}, nil)
	if st, _ := h.do("POST", "/api/v1/groups/"+g["id"].(string)+"/members", map[string]any{"add": []string{dev}}, nil); st != 204 {
		t.Fatalf("add member: %d", st)
	}
	st, ring := h.do("POST", "/api/v1/update-rings", map[string]any{"name": "Pilot", "ordinal": 1, "group_ids": []string{g["id"].(string)},
		"success_threshold": 90, "enabled": true, "restart": map[string]any{"allow": "outside_active_hours", "notify_minutes": 1}}, nil)
	if st != 201 {
		t.Fatalf("ring: %d %v", st, ring)
	}
	st, dec := h.do("POST", "/api/v1/updates/decision", map[string]any{"update_ids": []string{kbSecurity}, "decision": "approved", "note": "pilot"}, nil)
	if st != 200 || dec["changed"] != float64(1) {
		t.Fatalf("approve: %d %v", st, dec)
	}
	// The ring job is created by the scheduler, not by the approval.
	h.app.Updates.Tick(ctx)
	var jobID string
	waitFor(t, 10*time.Second, "install job", func() bool {
		_, js := h.do("GET", "/api/v1/devices/"+dev+"/jobs", nil, nil)
		for _, j := range items(js) {
			if j["type"] == "wu_install" {
				jobID = j["id"].(string)
			}
		}
		return jobID != ""
	})
	j := h.waitJobByID(jobID, "succeeded_reboot")
	_, detail := h.do("GET", "/api/v1/jobs/"+jobID, nil, nil)
	res := detail["result"].(map[string]any)
	wr := res["wu_results"].([]any)
	if j["reboot_required"] != true || len(wr) != 1 || wr[0].(map[string]any)["result"] != "WU_RESULT_INSTALLED_REBOOT" {
		t.Fatalf("job result: %v", detail["result"])
	}
	// The unapproved update was left alone; the restart policy fired (dev machine records it).
	if len(h.windowsUpdates(dev)) != 1 {
		waitFor(t, 15*time.Second, "rescan after the install", func() bool { return len(h.windowsUpdates(dev)) == 1 })
	}
	waitFor(t, 10*time.Second, "restart requested", func() bool {
		_, err := os.Stat(filepath.Join(ta.dir, "reboot-requested.json"))
		return err == nil
	})
	_, cat = h.do("GET", "/api/v1/updates?decision=approved", nil, nil)
	if len(items(cat)) != 1 || items(cat)[0]["devices_installed"] != float64(1) || items(cat)[0]["decision_source"] != "manual" {
		t.Fatalf("approved update: %v", cat)
	}
	// Running the scheduler again installs nothing new.
	h.app.Updates.Tick(ctx)
	_, js := h.do("GET", "/api/v1/devices/"+dev+"/jobs", nil, nil)
	n := 0
	for _, x := range items(js) {
		if x["type"] == "wu_install" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("%d install jobs", n)
	}

	// Hide the other update everywhere; the device reports it hidden after the job.
	st, dec = h.do("POST", "/api/v1/updates/decision", map[string]any{"update_ids": []string{kbOptional}, "decision": "hidden"}, nil)
	if st != 200 || dec["hide_jobs"] != float64(1) {
		t.Fatalf("hide: %d %v", st, dec)
	}
	waitFor(t, 20*time.Second, "update reported hidden", func() bool { return h.windowsUpdates(dev)[kbOptional]["state"] == "hidden" })

	// Manual restart with a countdown.
	_ = os.Remove(filepath.Join(ta.dir, "reboot-requested.json"))
	st, rb := h.do("POST", "/api/v1/devices/"+dev+"/reboot", map[string]any{"minutes": 5, "reason": "maintenance"}, nil)
	if st != 202 {
		t.Fatalf("reboot: %d %v", st, rb)
	}
	h.waitJobByID(rb["job_id"].(string), "succeeded")
	b, err := os.ReadFile(filepath.Join(ta.dir, "reboot-requested.json"))
	if err != nil {
		t.Fatal(err)
	}
	var rq struct {
		DelayS  int    `json:"delay_s"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(b, &rq)
	if rq.DelayS != 300 || rq.Message == "" {
		t.Fatalf("restart request: %+v", rq)
	}

	// Audit trail.
	_, au := h.do("GET", "/api/v1/audit?limit=200", nil, nil)
	seen := map[string]bool{}
	for _, e := range items(au) {
		seen[e["action"].(string)] = true
	}
	for _, a := range []string{"wu.scan", "wu.ring_create", "wu.decision", "device.reboot"} {
		if !seen[a] {
			t.Errorf("audit log lacks %s", a)
		}
	}
}
