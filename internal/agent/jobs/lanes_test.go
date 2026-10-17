package jobs

import (
	"testing"
	"time"

	agentv1 "github.com/auzring1/librepatch/gen/proto/librepatch/agent/v1"
)

func (r *rig) rebootCount() int {
	r.p.mu.Lock()
	defer r.p.mu.Unlock()
	return len(r.p.reboots)
}

func (r *rig) eventually(what string, f func() bool) {
	r.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !f() {
		if time.Now().After(deadline) {
			r.t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// A restart must not wait for a Windows Update scan that is still running: it only stores a plan and starts the
// system countdown.
func TestRestartIsNotHeldBackByARunningScan(t *testing.T) {
	r := newRig(t)
	r.p.wuc.scanGate, r.p.wuc.scanning = make(chan struct{}), make(chan struct{}, 1)
	r.e.init()
	scan, scanEnv := r.wuEnv("scan", agentv1.JobType_JOB_TYPE_WU_SCAN, nil)
	r.e.Accept(scan, scanEnv)
	done := make(chan struct{})
	go func() { r.e.tickLane(r.ctx, laneMain); close(done) }()
	select {
	case <-r.p.wuc.scanning:
	case <-time.After(5 * time.Second):
		t.Fatal("the scan never started")
	}

	rb, rbEnv := r.wuEnv("restart", agentv1.JobType_JOB_TYPE_REBOOT, nil)
	r.e.Accept(rb, rbEnv)
	r.e.tickLane(r.ctx, laneControl)
	if r.state("restart") != agentv1.JobState_JOB_STATE_SUCCEEDED || r.rebootCount() != 1 {
		t.Fatalf("restart state %v, countdowns started %d; want succeeded and 1 while the scan still runs", r.state("restart"), r.rebootCount())
	}
	if r.state("scan") != agentv1.JobState_JOB_STATE_RUNNING {
		t.Fatalf("scan state %v; it should still be running", r.state("scan"))
	}

	close(r.p.wuc.scanGate)
	<-done
	if r.state("scan") != agentv1.JobState_JOB_STATE_SUCCEEDED {
		t.Fatalf("scan state %v", r.state("scan"))
	}
	// The main loop leaves restart requests alone: no second countdown.
	r.e.tickLane(r.ctx, laneMain)
	if r.rebootCount() != 1 {
		t.Fatalf("%d countdowns; want 1", r.rebootCount())
	}
}

// A restart still waits for an installer (or update) that it would interrupt, as before, and starts as soon as that
// job ends.
func TestRestartWaitsForARunningInstaller(t *testing.T) {
	r := newRig(t)
	r.e.init()
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	r.installerRegisters("2.0", 0)
	inner := r.p.runFn
	r.p.runFn = func(s RunSpec, user string) (RunResult, error) {
		select {
		case started <- struct{}{}:
		default:
		}
		<-release
		return inner(s, user)
	}
	r.f.data["https://v.example/i1.exe"] = []byte("MZ installer bytes i1")
	se, env := r.installEnv("i1", nil)
	r.e.Accept(se, env)
	done := make(chan struct{})
	go func() { r.e.tickLane(r.ctx, laneMain); close(done) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("the installer never started")
	}

	rb, rbEnv := r.wuEnv("restart", agentv1.JobType_JOB_TYPE_REBOOT, nil)
	r.e.Accept(rb, rbEnv)
	r.e.tickLane(r.ctx, laneControl)
	if r.rebootCount() != 0 || r.state("restart") != agentv1.JobState_JOB_STATE_WAITING {
		t.Fatalf("restart state %v, countdowns %d; want waiting and none while an installer runs", r.state("restart"), r.rebootCount())
	}

	close(release)
	<-done
	r.eventually("the restart to be released", func() bool { return r.e.unsafe.Load() == 0 })
	r.e.tickLane(r.ctx, laneControl)
	if r.state("restart") != agentv1.JobState_JOB_STATE_SUCCEEDED || r.rebootCount() != 1 {
		t.Fatalf("restart state %v, countdowns %d; want succeeded and 1 after the installer ended", r.state("restart"), r.rebootCount())
	}
}
