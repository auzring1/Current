package e2e

import (
	"context"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/auzring1/librepatch/internal/agent/core"
	"github.com/auzring1/librepatch/internal/agent/jobs"
	"github.com/auzring1/librepatch/internal/agent/store"
)

// latencyPlatform stamps the moment the agent asks the operating system to restart (the last hop before Windows
// shows its countdown).
type latencyPlatform struct {
	jobs.Platform
	rebooted chan time.Time
}

func (p *latencyPlatform) Reboot(delay time.Duration, message string) error {
	select {
	case p.rebooted <- time.Now():
	default:
	}
	return p.Platform.Reboot(delay, message)
}

type hops struct {
	apiReturned time.Duration // click until the REST call returned (API, database, audit entry)
	serverSent  time.Duration // click until the server wrote the job to the device's stream
	agentOS     time.Duration // click until the agent asked Windows to restart (Reboot called)
}

// restartOnce clicks "Restart" for a device and times every hop.
func (h *harness) restartOnce(t *testing.T, dev string, rebooted <-chan time.Time) hops {
	t.Helper()
	for len(rebooted) > 0 {
		<-rebooted
	}
	t0 := time.Now()
	st, rb := h.do("POST", "/api/v1/devices/"+dev+"/reboot", map[string]any{"minutes": 1, "reason": "latency probe"}, nil)
	t1 := time.Now()
	if st != 202 {
		t.Fatalf("reboot: %d %v", st, rb)
	}
	var tOS time.Time
	select {
	case tOS = <-rebooted:
	case <-time.After(60 * time.Second):
		t.Fatal("the agent never asked the operating system to restart")
	}
	id, _ := uuid.Parse(rb["job_id"].(string))
	var sentAt *time.Time
	_ = h.db.Pool.QueryRow(context.Background(), `SELECT sent_at FROM jobs WHERE id = $1`, id).Scan(&sentAt)
	out := hops{apiReturned: t1.Sub(t0), agentOS: tOS.Sub(t0)}
	if sentAt != nil {
		out.serverSent = sentAt.Sub(t0)
	}
	return out
}

func median(d []time.Duration) time.Duration {
	s := append([]time.Duration(nil), d...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[len(s)/2]
}

func latencyAgent(t *testing.T) (*harness, *testAgent, string, *latencyPlatform) {
	h := newHarness(t)
	h.setupAndLogin()
	plat := &latencyPlatform{rebooted: make(chan time.Time, 4)}
	ta := h.startAgent(h.createToken("latency", 5, false), &fakeHW{host: "LAT-1", serial: "SLAT1", uuid: "ULAT1"}, nil, func(a *core.Agent, st *store.Store) {
		plat.Platform = jobs.NewPlatform(a.DataDir)
		a.Jobs = &jobs.Engine{P: plat, Store: st, Log: a.Log}
	})
	waitFor(t, 20*time.Second, "agent connected", func() bool { return ta.state() == "connected" })
	dev := h.devices()[0]["id"].(string)
	// Let the first inventory exchange and the first heartbeat settle so the probe measures a quiet, connected agent.
	time.Sleep(2 * time.Second)
	return h, ta, dev, plat
}

// TestRestartLatencyIdle is the ordinary case: an idle, connected agent. The restart must arrive by push within
// two seconds (it is typically a few milliseconds; the bound is generous for a loaded CI machine).
func TestRestartLatencyIdle(t *testing.T) {
	h, _, dev, plat := latencyAgent(t)
	var api, sent, os []time.Duration
	for i := 0; i < 10; i++ {
		r := h.restartOnce(t, dev, plat.rebooted)
		api, sent, os = append(api, r.apiReturned), append(sent, r.serverSent), append(os, r.agentOS)
		if r.agentOS > 2*time.Second {
			t.Errorf("restart %d reached the operating system after %v; want under 2s", i, r.agentOS)
		}
	}
	t.Logf("click -> API returned   median %v max %v", median(api), maxDur(api))
	t.Logf("click -> server sent    median %v max %v", median(sent), maxDur(sent))
	t.Logf("click -> OS restart call median %v max %v", median(os), maxDur(os))
}

func maxDur(d []time.Duration) time.Duration {
	m := d[0]
	for _, x := range d {
		m = max(m, x)
	}
	return m
}
