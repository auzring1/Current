package updates

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/auzring1/current/gen/dbq"
	agentv1 "github.com/auzring1/current/gen/proto/current/agent/v1"
	"github.com/auzring1/current/internal/server/audit"
	"github.com/auzring1/current/internal/server/deploy"
	"github.com/auzring1/current/internal/server/store"
)

func (s *Service) device(ctx context.Context, org, id uuid.UUID) (dbq.Device, error) {
	d, err := dbq.New(s.Pool).GetDeviceInOrg(ctx, dbq.GetDeviceInOrgParams{ID: id, OrgID: org})
	if err != nil || d.Status != "active" {
		return d, ErrNotFound
	}
	return d, nil
}

func (s *Service) enqueue(ctx context.Context, a Actor, d dbq.Device, spec deploy.JobSpec, action string, details map[string]any, attempts []uuid.UUID) (uuid.UUID, error) {
	job, err := s.Deploy.NewJob(a.Org, d.ID, spec)
	if err != nil {
		return uuid.Nil, err
	}
	now := s.now()
	err = store.Tx(ctx, s.Pool, func(tx pgx.Tx, q *dbq.Queries) error {
		if err := q.InsertJob(ctx, job); err != nil {
			return err
		}
		for _, u := range attempts {
			if err := q.UpsertAttemptQueued(ctx, dbq.UpsertAttemptQueuedParams{OrgID: a.Org, UpdateID: u, DeviceID: d.ID, JobID: &job.ID, At: now}); err != nil {
				return err
			}
		}
		if details == nil {
			details = map[string]any{}
		}
		details["hostname"] = d.Hostname
		_, err := audit.Write(ctx, tx, audit.Entry{OrgID: &a.Org, ActorType: audit.ActorUser, ActorID: a.User.String(), ActorIP: a.IP, Action: action,
			TargetType: "device", TargetIDs: []string{d.ID.String()}, Outcome: audit.Success, Details: details}, now)
		return err
	})
	if err != nil {
		return uuid.Nil, err
	}
	s.Deploy.Publish(a.Org, "job.updated", d.ID, job.ID, uuid.Nil)
	s.Deploy.DispatchAsync(d.ID)
	return job.ID, nil
}

// ScanDevice asks a device to scan now (with the organization's source settings).
func (s *Service) ScanDevice(ctx context.Context, a Actor, device uuid.UUID) (uuid.UUID, error) {
	d, err := s.device(ctx, a.Org, device)
	if err != nil {
		return uuid.Nil, err
	}
	cfg := s.settings(ctx, a.Org)
	now := s.now()
	return s.enqueue(ctx, a, d, deploy.JobSpec{Type: agentv1.JobType_JOB_TYPE_WU_SCAN, DBType: "wu_scan", Title: "Scan for Windows updates", NotBefore: now,
		Expires: now.Add(time.Hour), Body: &agentv1.WuScanBody{Service: cfg.service, IncludeDrivers: cfg.drivers}}, "wu.scan", nil, nil)
}

func parseIDs(in []string) ([]uuid.UUID, error) {
	if len(in) == 0 || len(in) > 200 {
		return nil, invalid("choose between 1 and 200 updates")
	}
	out := make([]uuid.UUID, 0, len(in))
	for _, x := range in {
		id, err := uuid.Parse(x)
		if err != nil {
			return nil, invalid("malformed update id")
		}
		out = append(out, id)
	}
	return out, nil
}

// InstallOnDevice installs the chosen updates now, ignoring rings and approval (an explicit
// administrator action, audited). Only updates the device's last scan lists as missing are sent.
func (s *Service) InstallOnDevice(ctx context.Context, a Actor, device uuid.UUID, updateIDs []string, reboot RebootCfg) (uuid.UUID, error) {
	ids, err := parseIDs(updateIDs)
	if err != nil {
		return uuid.Nil, err
	}
	if err := reboot.normalize(); err != nil {
		return uuid.Nil, err
	}
	d, err := s.device(ctx, a.Org, device)
	if err != nil {
		return uuid.Nil, err
	}
	rows, err := dbq.New(s.Pool).ListDeviceUpdateIDs(ctx, dbq.ListDeviceUpdateIDsParams{DeviceID: device, States: []string{"missing", "downloaded"}})
	if err != nil {
		return uuid.Nil, err
	}
	missing := map[uuid.UUID]int32{}
	for _, r := range rows {
		missing[r.UpdateID] = r.Revision
	}
	var refs []*agentv1.WuUpdateRef
	var queued []uuid.UUID
	for _, id := range ids {
		if rev, ok := missing[id]; ok {
			refs = append(refs, &agentv1.WuUpdateRef{UpdateId: id.String(), Revision: rev})
			queued = append(queued, id)
		}
	}
	if len(refs) == 0 {
		return uuid.Nil, invalid("none of the chosen updates is missing on this device (scan it first)")
	}
	cfg := s.settings(ctx, a.Org)
	now := s.now()
	return s.enqueue(ctx, a, d, deploy.JobSpec{Type: agentv1.JobType_JOB_TYPE_WU_INSTALL, DBType: "wu_install", NotBefore: now, Expires: now.Add(jobLifetime),
		Title: "Install " + plural(len(refs), "Windows update"),
		Body:  &agentv1.WuInstallBody{Service: cfg.service, IncludeDrivers: cfg.drivers, Updates: refs, Reboot: reboot.Proto(now), TimeoutS: 3 * 3600, MaxRetries: 1, RetryBackoffS: 300}},
		"wu.install", map[string]any{"updates": len(refs), "restart": reboot.Allow}, queued)
}

// HideOnDevice hides or unhides updates on one device.
func (s *Service) HideOnDevice(ctx context.Context, a Actor, device uuid.UUID, updateIDs []string, hide bool) (uuid.UUID, error) {
	ids, err := parseIDs(updateIDs)
	if err != nil {
		return uuid.Nil, err
	}
	d, err := s.device(ctx, a.Org, device)
	if err != nil {
		return uuid.Nil, err
	}
	refs := make([]*agentv1.WuUpdateRef, len(ids))
	for i, id := range ids {
		refs[i] = &agentv1.WuUpdateRef{UpdateId: id.String()}
	}
	cfg := s.settings(ctx, a.Org)
	now := s.now()
	return s.enqueue(ctx, a, d, deploy.JobSpec{Type: agentv1.JobType_JOB_TYPE_WU_HIDE, DBType: "wu_hide", Title: hideTitle(hide), NotBefore: now, Expires: now.Add(24 * time.Hour),
		Body: &agentv1.WuHideBody{Service: cfg.service, Updates: refs, Hide: hide}}, "wu.hide", map[string]any{"updates": len(ids), "hide": hide}, nil)
}

// RebootDevice restarts an online device after a countdown (signed-in users see it). It refuses an
// offline device: a restart queued for later could catch someone by surprise.
func (s *Service) RebootDevice(ctx context.Context, a Actor, device uuid.UUID, minutes int, reason string) (uuid.UUID, error) {
	if minutes < 1 || minutes > 1440 {
		return uuid.Nil, invalid("the countdown must be between 1 and 1440 minutes")
	}
	d, err := s.device(ctx, a.Org, device)
	if err != nil {
		return uuid.Nil, err
	}
	if !d.Online {
		return uuid.Nil, ErrOffline
	}
	reason = clean(strings.TrimSpace(reason), 200)
	now := s.now()
	return s.enqueue(ctx, a, d, deploy.JobSpec{Type: agentv1.JobType_JOB_TYPE_REBOOT, DBType: "reboot", Title: "Restart the computer", NotBefore: now, Expires: now.Add(15 * time.Minute),
		Body: &agentv1.RebootBody{Reason: reason, Reboot: &agentv1.RebootPolicy{Allow: agentv1.RebootAllow_REBOOT_ALLOW_NOW, NotifyMinutes: uint32(minutes)}}}, // #nosec G115 -- 1..1440
		"device.reboot", map[string]any{"minutes": minutes, "reason": reason}, nil)
}

// InstallUpdate installs one update on the chosen devices (or on every active device that misses
// it when deviceIDs is empty). An explicit administrator action; one install job per device.
func (s *Service) InstallUpdate(ctx context.Context, a Actor, update uuid.UUID, deviceIDs []uuid.UUID, reboot RebootCfg) (int, error) {
	if err := reboot.normalize(); err != nil {
		return 0, err
	}
	q := dbq.New(s.Pool)
	up, err := q.GetUpdate(ctx, dbq.GetUpdateParams{OrgID: a.Org, UpdateID: update})
	if err != nil {
		return 0, ErrNotFound
	}
	rows, err := q.ListUpdateDeviceStates(ctx, dbq.ListUpdateDeviceStatesParams{OrgID: a.Org, UpdateID: update})
	if err != nil {
		return 0, err
	}
	want := map[uuid.UUID]bool{}
	for _, d := range deviceIDs {
		want[d] = true
	}
	cfg := s.settings(ctx, a.Org)
	now := s.now()
	var jobs []dbq.InsertJobParams
	for _, r := range rows {
		if r.State != "missing" && r.State != "downloaded" {
			continue
		}
		if len(want) > 0 && !want[r.DeviceID] {
			continue
		}
		j, err := s.Deploy.NewJob(a.Org, r.DeviceID, deploy.JobSpec{Type: agentv1.JobType_JOB_TYPE_WU_INSTALL, DBType: "wu_install", NotBefore: now, Expires: now.Add(jobLifetime),
			Title: "Install " + clean(up.Title, 120),
			Body: &agentv1.WuInstallBody{Service: cfg.service, IncludeDrivers: cfg.drivers, Updates: []*agentv1.WuUpdateRef{{UpdateId: update.String(), Revision: up.Revision}},
				Reboot: reboot.Proto(now), TimeoutS: 3 * 3600, MaxRetries: 1, RetryBackoffS: 300}})
		if err != nil {
			return 0, err
		}
		jobs = append(jobs, j)
		if len(jobs) >= 5000 {
			break
		}
	}
	if len(jobs) == 0 {
		return 0, invalid("no device is missing this update")
	}
	err = store.Tx(ctx, s.Pool, func(tx pgx.Tx, q *dbq.Queries) error {
		for _, j := range jobs {
			if err := q.InsertJob(ctx, j); err != nil {
				return err
			}
			if err := q.UpsertAttemptQueued(ctx, dbq.UpsertAttemptQueuedParams{OrgID: a.Org, UpdateID: update, DeviceID: j.DeviceID, JobID: &j.ID, At: now}); err != nil {
				return err
			}
		}
		_, err := audit.Write(ctx, tx, audit.Entry{OrgID: &a.Org, ActorType: audit.ActorUser, ActorID: a.User.String(), ActorIP: a.IP, Action: "wu.install",
			TargetType: "update", TargetIDs: []string{update.String()}, Outcome: audit.Success,
			Details: map[string]any{"title": up.Title, "devices": len(jobs), "restart": reboot.Allow}}, now)
		return err
	})
	if err != nil {
		return 0, err
	}
	for _, j := range jobs {
		s.Deploy.DispatchAsync(j.DeviceID)
	}
	s.publish(a.Org, uuid.Nil)
	return len(jobs), nil
}

func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return strconv.Itoa(n) + " " + noun + "s"
}
