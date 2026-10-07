package jobs

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	agentv1 "github.com/auzring1/auzring/gen/proto/auzring/agent/v1"
)

// Reporter delivers job updates to the server. The agent core implements it on
// top of the persistent outbox, so updates survive reconnects and restarts.
type Reporter interface {
	Report(u *agentv1.JobUpdate)
}

// Engine runs accepted jobs one at a time.
type Engine struct {
	P      Platform
	Store  Store
	Report Reporter
	Fetch  Fetcher
	Log    *slog.Logger
	// Now is the server-corrected clock.
	Now func() time.Time
	// Local is the device time zone for maintenance windows (default time.Local).
	Local *time.Location
	// Allowed is the local policy ceiling (job type names). Empty = all implemented types.
	Allowed map[string]bool
	// Security reports a security event (hash or signer mismatch, ceiling violation).
	Security func(kind agentv1.SecurityEventKind, detail string)
	// InventoryNow requests an immediate software rescan (after installs and on INVENTORY_FULL jobs).
	InventoryNow func()
	// PollUserJobs is the fallback interval for waiting-for-logon jobs (default 15 min).
	PollUserJobs time.Duration
	// MaxIdle bounds how long the loop sleeps without any wake source (default 5 min).
	MaxIdle time.Duration
	// Trust returns the pinned root, job-signing certificates and identity the
	// user-context helper needs to re-verify a job.
	Trust func() (root []byte, signing [][]byte, deviceID, orgID string)

	mu      sync.Mutex
	wake    chan struct{}
	cancels map[string]context.CancelFunc
}

func (e *Engine) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

func (e *Engine) log() *slog.Logger {
	if e.Log != nil {
		return e.Log
	}
	return slog.Default()
}

func (e *Engine) local() *time.Location {
	if e.Local != nil {
		return e.Local
	}
	return time.Local
}

func (e *Engine) init() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.wake == nil {
		e.wake = make(chan struct{}, 1)
		e.cancels = map[string]context.CancelFunc{}
	}
}

// Wake makes the loop re-evaluate its queue.
func (e *Engine) Wake() {
	e.init()
	select {
	case e.wake <- struct{}{}:
	default:
	}
}

func (e *Engine) allowed(t agentv1.JobType) bool {
	name := ceilingName(t)
	if name == "" {
		return false
	}
	if len(e.Allowed) == 0 {
		return true
	}
	return e.Allowed[name]
}

func (e *Engine) report(r *Record, res *agentv1.JobResult) {
	if e.Report == nil {
		return
	}
	e.Report.Report(&agentv1.JobUpdate{JobId: r.JobID, Attempt: r.Attempt, State: r.state(), Reason: r.Reason, Result: res})
}

func (e *Engine) setState(r *Record, st agentv1.JobState, reason string, res *agentv1.JobResult) {
	changed := r.state() != st || r.Reason != reason
	r.State, r.Reason = int32(st), reason
	if res != nil {
		if b, err := marshal(res); err == nil {
			r.Result = b
		}
	}
	if err := save(e.Store, r); err != nil {
		e.log().Error("persist job", "job", r.JobID, "err", err)
	}
	if changed || res != nil {
		e.report(r, res)
	}
}

// Accept takes a verified envelope. It validates the body, applies the policy
// ceiling, persists the job and reports ACCEPTED (or REJECTED). A job that is
// already known is not an attack: the server re-offers jobs whose
// acknowledgement it never saw, so the current state is simply reported again.
func (e *Engine) Accept(se *agentv1.SignedEnvelope, env *agentv1.JobEnvelope) {
	e.init()
	if r := load(e.Store, env.JobId); r != nil {
		e.report(r, r.result())
		return
	}
	r := &Record{JobID: env.JobId, Type: int32(env.Type), SID: env.TargetUserSid, Attempt: env.Attempt,
		NotBefore: env.NotBefore, Expires: env.ExpiresAt, Keep: env.ExpiresAt + int64((24 * time.Hour).Seconds())}
	if b, err := marshalSigned(se); err == nil {
		r.Signed = b
	}
	reject := func(reason string, kind agentv1.SecurityEventKind) {
		e.log().Warn("job rejected", "job", env.JobId, "reason", reason)
		if kind != agentv1.SecurityEventKind_SECURITY_EVENT_KIND_UNSPECIFIED && e.Security != nil {
			e.Security(kind, reason)
		}
		e.setState(r, agentv1.JobState_JOB_STATE_REJECTED, short(reason), &agentv1.JobResult{
			Outcome: agentv1.JobOutcome_JOB_OUTCOME_FAILED, Message: short(reason), FinishedAt: e.now().Unix()})
	}
	if env.Type == agentv1.JobType_JOB_TYPE_CANCEL {
		e.cancelJob(env.GetCancel().GetJobId(), r)
		return
	}
	if !e.allowed(env.Type) {
		reject("job type not allowed by the local policy ceiling", agentv1.SecurityEventKind_SECURITY_EVENT_KIND_POLICY_CEILING)
		return
	}
	if err := ValidateWindow(env.Window); err != nil {
		reject(err.Error(), agentv1.SecurityEventKind_SECURITY_EVENT_KIND_UNSPECIFIED)
		return
	}
	switch env.Type {
	case agentv1.JobType_JOB_TYPE_INVENTORY_FULL:
		e.setState(r, agentv1.JobState_JOB_STATE_ACCEPTED, "", nil)
	case agentv1.JobType_JOB_TYPE_SOFTWARE_INSTALL, agentv1.JobType_JOB_TYPE_SOFTWARE_UPDATE:
		if err := ValidateInstall(env.GetInstall(), env.TargetUserSid); err != nil {
			reject(err.Error(), agentv1.SecurityEventKind_SECURITY_EVENT_KIND_UNSPECIFIED)
			return
		}
		e.setState(r, agentv1.JobState_JOB_STATE_ACCEPTED, "", nil)
	case agentv1.JobType_JOB_TYPE_SOFTWARE_UNINSTALL:
		if err := ValidateUninstall(env.GetUninstall(), env.TargetUserSid); err != nil {
			reject(err.Error(), agentv1.SecurityEventKind_SECURITY_EVENT_KIND_UNSPECIFIED)
			return
		}
		e.setState(r, agentv1.JobState_JOB_STATE_ACCEPTED, "", nil)
	default:
		reject("unsupported job type", agentv1.SecurityEventKind_SECURITY_EVENT_KIND_UNSPECIFIED)
		return
	}
	e.Wake()
}

// cancelJob handles a CANCEL envelope (itself recorded as a finished job).
func (e *Engine) cancelJob(target string, self *Record) {
	e.mu.Lock()
	cancel := e.cancels[target]
	e.mu.Unlock()
	if t := load(e.Store, target); t != nil && !t.terminal() {
		t.Cancel = true
		_ = save(e.Store, t)
		if cancel != nil {
			cancel()
		}
		e.Wake()
	}
	e.setState(self, agentv1.JobState_JOB_STATE_SUCCEEDED, "cancel_requested", &agentv1.JobResult{
		Outcome: agentv1.JobOutcome_JOB_OUTCOME_SUCCESS, FinishedAt: e.now().Unix()})
}

// Run processes the queue until ctx ends.
func (e *Engine) Run(ctx context.Context) {
	e.init()
	var sessions <-chan struct{}
	if e.P != nil {
		sessions = e.P.SessionEvents()
	}
	for ctx.Err() == nil {
		wait := e.tick(ctx)
		maxIdle := e.MaxIdle
		if maxIdle == 0 {
			maxIdle = 5 * time.Minute
		}
		if wait <= 0 || wait > maxIdle {
			wait = maxIdle
		}
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-e.wake:
		case <-sessions:
		case <-t.C:
		}
		t.Stop()
	}
}

// tick runs every job that is eligible now and returns how long to wait for the next one.
func (e *Engine) tick(ctx context.Context) time.Duration {
	recs, err := loadAll(e.Store)
	if err != nil {
		e.log().Error("read jobs", "err", err)
		return time.Minute
	}
	sort.Slice(recs, func(i, j int) bool {
		if recs[i].NotBefore != recs[j].NotBefore {
			return recs[i].NotBefore < recs[j].NotBefore
		}
		return recs[i].JobID < recs[j].JobID
	})
	var next time.Time
	soonest := func(t time.Time) {
		if next.IsZero() || t.Before(next) {
			next = t
		}
	}
	userPoll := e.PollUserJobs
	if userPoll == 0 {
		userPoll = 15 * time.Minute
	}
	for _, r := range recs {
		if ctx.Err() != nil {
			return 0
		}
		now := e.now()
		if r.terminal() {
			if r.Keep > 0 && now.Unix() > r.Keep {
				_ = e.Store.JobDelete(r.JobID)
			}
			continue
		}
		if now.Unix() > r.Expires {
			e.setState(r, agentv1.JobState_JOB_STATE_EXPIRED, "expired", &agentv1.JobResult{
				Outcome: agentv1.JobOutcome_JOB_OUTCOME_FAILED, Message: "the job expired before it could run", FinishedAt: now.Unix()})
			continue
		}
		if r.Cancel {
			e.setState(r, agentv1.JobState_JOB_STATE_CANCELLED, "cancelled", &agentv1.JobResult{
				Outcome: agentv1.JobOutcome_JOB_OUTCOME_FAILED, Message: "cancelled by an administrator", FinishedAt: now.Unix()})
			continue
		}
		if t := time.Unix(r.NotBefore, 0); now.Before(t) {
			e.setState(r, agentv1.JobState_JOB_STATE_WAITING, "waiting_not_before", nil)
			soonest(t)
			continue
		}
		if t := time.Unix(r.NextRun, 0); r.NextRun > 0 && now.Before(t) {
			soonest(t)
			continue
		}
		_, env, err := r.envelope()
		if err != nil {
			e.setState(r, agentv1.JobState_JOB_STATE_FAILED, "corrupt_record", &agentv1.JobResult{
				Outcome: agentv1.JobOutcome_JOB_OUTCOME_FAILED, Message: "stored job could not be read", FinishedAt: now.Unix()})
			continue
		}
		if open, at := WindowOpen(env.Window, now, e.local()); !open {
			e.setState(r, agentv1.JobState_JOB_STATE_WAITING, "waiting_window", nil)
			soonest(at)
			continue
		}
		if r.SID != "" && !e.P.HasSession(r.SID) {
			e.setState(r, agentv1.JobState_JOB_STATE_WAITING, "waiting_user_logon", nil)
			soonest(now.Add(userPoll))
			continue
		}
		e.runJob(ctx, r, env)
		if r.state() == agentv1.JobState_JOB_STATE_WAITING && r.NextRun > 0 {
			soonest(time.Unix(r.NextRun, 0))
		}
	}
	if next.IsZero() {
		return 0
	}
	return next.Sub(e.now()) + time.Second
}

func (e *Engine) runJob(ctx context.Context, r *Record, env *agentv1.JobEnvelope) {
	jctx, cancel := context.WithCancel(ctx)
	e.mu.Lock()
	e.cancels[r.JobID] = cancel
	e.mu.Unlock()
	defer func() {
		cancel()
		e.mu.Lock()
		delete(e.cancels, r.JobID)
		e.mu.Unlock()
	}()
	r.Started = e.now().Unix()
	e.setState(r, agentv1.JobState_JOB_STATE_RUNNING, "", nil)

	var out *outcome
	switch env.Type {
	case agentv1.JobType_JOB_TYPE_INVENTORY_FULL:
		if e.InventoryNow != nil {
			e.InventoryNow()
		}
		out = &outcome{res: &agentv1.JobResult{Outcome: agentv1.JobOutcome_JOB_OUTCOME_SUCCESS, DetectionPassed: true}}
	case agentv1.JobType_JOB_TYPE_SOFTWARE_INSTALL, agentv1.JobType_JOB_TYPE_SOFTWARE_UPDATE:
		out = e.install(jctx, r, env)
	case agentv1.JobType_JOB_TYPE_SOFTWARE_UNINSTALL:
		out = e.uninstall(jctx, r, env)
	}
	if out == nil {
		out = fail("unsupported job type")
	}
	now := e.now()
	if r.Cancel || errors.Is(jctx.Err(), context.Canceled) && ctx.Err() == nil {
		out = &outcome{res: &agentv1.JobResult{Outcome: agentv1.JobOutcome_JOB_OUTCOME_FAILED, Message: "cancelled by an administrator"}, cancelled: true}
	}
	if ctx.Err() != nil { // shutting down: leave the job to be retried after restart
		r.State = int32(agentv1.JobState_JOB_STATE_ACCEPTED)
		_ = save(e.Store, r)
		return
	}
	out.res.StartedAt, out.res.FinishedAt = r.Started, now.Unix()
	r.Finished = now.Unix()

	switch {
	case out.waitUser:
		e.setState(r, agentv1.JobState_JOB_STATE_WAITING, "waiting_user_logon", nil)
		return
	case out.cancelled:
		e.setState(r, agentv1.JobState_JOB_STATE_CANCELLED, "cancelled", out.res)
		return
	case out.res.Outcome == agentv1.JobOutcome_JOB_OUTCOME_RETRYABLE:
		max, backoff := retryPolicy(env)
		if r.Tries < max && now.Unix() < r.Expires {
			r.Tries++
			d := time.Duration(backoff) * time.Second * (1 << (r.Tries - 1))
			r.NextRun = now.Add(d).Unix()
			e.log().Info("job will retry", "job", r.JobID, "try", r.Tries, "in", d)
			e.setState(r, agentv1.JobState_JOB_STATE_WAITING, "retry_backoff", nil)
			return
		}
		out.res.Outcome = agentv1.JobOutcome_JOB_OUTCOME_FAILED
		out.res.Message = short("retries exhausted: " + out.res.Message)
		e.setState(r, agentv1.JobState_JOB_STATE_FAILED, "retries_exhausted", out.res)
	case out.res.Outcome == agentv1.JobOutcome_JOB_OUTCOME_REBOOT_REQUIRED:
		out.res.RebootRequired = true
		e.setState(r, agentv1.JobState_JOB_STATE_SUCCEEDED_REBOOT, "reboot_required", out.res)
	case out.res.Outcome == agentv1.JobOutcome_JOB_OUTCOME_SUCCESS:
		e.setState(r, agentv1.JobState_JOB_STATE_SUCCEEDED, "", out.res)
	default:
		e.setState(r, agentv1.JobState_JOB_STATE_FAILED, out.reason, out.res)
	}
	if env.Type != agentv1.JobType_JOB_TYPE_INVENTORY_FULL && e.InventoryNow != nil {
		e.InventoryNow() // reflect the change in the fleet inventory without waiting for the debounce
	}
}

func retryPolicy(env *agentv1.JobEnvelope) (max uint32, backoffS uint32) {
	var b, bo uint32
	switch {
	case env.GetInstall() != nil:
		b, bo = env.GetInstall().MaxRetries, env.GetInstall().RetryBackoffS
	case env.GetUninstall() != nil:
		b, bo = env.GetUninstall().MaxRetries, env.GetUninstall().RetryBackoffS
	}
	if bo == 0 {
		bo = 60
	}
	return b, bo
}

// outcome is what a pipeline returns to runJob.
type outcome struct {
	res       *agentv1.JobResult
	reason    string
	waitUser  bool
	cancelled bool
}

func fail(format string, a ...any) *outcome {
	msg := fmt.Sprintf(format, a...)
	return &outcome{reason: "failed", res: &agentv1.JobResult{Outcome: agentv1.JobOutcome_JOB_OUTCOME_FAILED, Message: short(msg)}}
}

func short(s string) string {
	if len(s) > 1024 {
		return s[:1024]
	}
	return s
}

// helperTask prepares the re-verification material for a user-scope run.
func (e *Engine) helperTask(r *Record, stageDir, file string) *HelperTask {
	t := &HelperTask{Signed: r.Signed, SID: r.SID, StageDir: stageDir, File: file, Now: e.now().Unix()}
	if e.Trust != nil {
		t.Root, t.SigningDER, t.DeviceID, t.OrgID = e.Trust()
	}
	return t
}
