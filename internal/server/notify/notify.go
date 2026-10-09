// Package notify turns events into e-mails and webhook calls according to the organization's settings (D95): rules
// say who hears about what, quiet hours hold messages back, and an outbox with retries and de-duplication makes
// delivery survive a restart and a flaky mail server. Nothing here talks to the network except to the mail relay and
// the webhook URLs an administrator configured.
package notify

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/auzring1/renovatio/internal/shared/brand"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/auzring1/renovatio/gen/dbq"
	"github.com/auzring1/renovatio/internal/server/branding"
	"github.com/auzring1/renovatio/internal/server/licensing"
	"github.com/auzring1/renovatio/internal/server/settings"
	"github.com/auzring1/renovatio/internal/shared/vercmp"
)

// Service sends notifications.
type Service struct {
	Pool      *pgxpool.Pool
	Settings  *settings.Service
	Branding  *branding.Service
	Licensing *licensing.Service
	Log       *slog.Logger
	Now       func() time.Time
	// Mailer and Poster are replaced in tests.
	Mailer Mailer
	Poster Poster

	ticks int
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Service) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

// Event is something that happened.
type Event struct {
	Name string
	// Key de-duplicates: the same event with the same key is queued once per target (empty = never de-duplicated).
	Key     string
	Subject string
	Text    string
	Data    map[string]any
}

// Emit queues the event for every rule that wants it. It never fails the caller's work: errors are logged.
func (s *Service) Emit(ctx context.Context, org uuid.UUID, ev Event) {
	if err := s.emit(ctx, org, ev); err != nil {
		s.log().Error("queue notification", "event", ev.Name, "err", err)
	}
}

func (s *Service) emit(ctx context.Context, org uuid.UUID, ev Event) error {
	ns := s.Settings.Values(ctx, org, "notifications")
	var rule settings.V
	for _, r := range ns.Items("rules") {
		if r.Str("event") == ev.Name {
			rule = r
		}
	}
	if rule == nil || !rule.Bool("enabled") {
		return nil
	}
	q := dbq.New(s.Pool)
	now := s.now()
	notBefore := now
	if rule.Bool("quiet_hours") {
		notBefore = quietUntil(ns, now)
	}
	payload := s.payload(ctx, org, ev, now)
	if rule.Bool("email") && ns.Bool("email_enabled") {
		body, _ := json.Marshal(map[string]any{"subject": ev.Subject, "text": ev.Text})
		for _, to := range rule.Strings("recipients") {
			if err := q.EnqueueNotification(ctx, dbq.EnqueueNotificationParams{OrgID: org, Channel: "email", Event: ev.Name, Target: to, DedupeKey: ev.Key, Payload: body, NotBefore: notBefore}); err != nil {
				return err
			}
		}
	}
	if rule.Bool("webhook") {
		wb, _ := json.Marshal(payload)
		is := s.Settings.Values(ctx, org, "integrations")
		for _, w := range is.Items("webhooks") {
			if !w.Bool("enabled") || !contains(w.Strings("events"), ev.Name) {
				continue
			}
			if err := q.EnqueueNotification(ctx, dbq.EnqueueNotificationParams{OrgID: org, Channel: "webhook", Event: ev.Name, Target: w.Str("id"), DedupeKey: ev.Key, Payload: wb, NotBefore: notBefore}); err != nil {
				return err
			}
		}
	}
	return nil
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

func (s *Service) names(ctx context.Context) (org, product string) {
	if s.Branding != nil {
		if p, err := s.Branding.Public(ctx); err == nil {
			return p.OrgName, p.ProductName
		}
	}
	return "", brand.Name
}

func (s *Service) payload(ctx context.Context, org uuid.UUID, ev Event, now time.Time) map[string]any {
	orgName, _ := s.names(ctx)
	p := map[string]any{"id": uuid.NewString(), "event": ev.Name, "time": now.UTC().Format(time.RFC3339), "organization": orgName, "summary": ev.Subject}
	for k, v := range ev.Data {
		p[k] = v
	}
	return p
}

// quietUntil returns when a message may be sent: now, or the end of the quiet hours if now falls inside them.
func quietUntil(ns settings.V, now time.Time) time.Time {
	if !ns.Bool("quiet_hours_enabled") {
		return now
	}
	loc, err := time.LoadLocation(ns.Str("quiet_time_zone"))
	if err != nil {
		loc = time.UTC
	}
	return QuietEnd(now, loc, ns.Str("quiet_start"), ns.Str("quiet_end"))
}

func minutes(hhmm string) int {
	var h, m int
	_, _ = fmt.Sscanf(hhmm, "%d:%d", &h, &m)
	return h*60 + m
}

// QuietEnd returns now when it is outside the quiet window [start, end) in loc, otherwise the next end of the window.
// The window may cross midnight.
func QuietEnd(now time.Time, loc *time.Location, start, end string) time.Time {
	l := now.In(loc)
	cur := l.Hour()*60 + l.Minute()
	st, en := minutes(start), minutes(end)
	inside := false
	if st < en {
		inside = cur >= st && cur < en
	} else if st > en {
		inside = cur >= st || cur < en
	}
	if !inside {
		return now
	}
	day := l
	if st > en && cur >= st {
		day = l.AddDate(0, 0, 1)
	}
	return time.Date(day.Year(), day.Month(), day.Day(), en/60, en%60, 0, 0, loc)
}

// Tick delivers what is due and, every few minutes, looks for conditions that have no event of their own.
func (s *Service) Tick(ctx context.Context) {
	s.deliver(ctx)
	s.ticks++
	if s.ticks%5 == 1 {
		s.scan(ctx)
	}
}

const maxAttempts = 5

var backoff = []time.Duration{time.Minute, 5 * time.Minute, 30 * time.Minute, 2 * time.Hour}

func (s *Service) deliver(ctx context.Context) {
	q := dbq.New(s.Pool)
	now := s.now()
	// Claim in a transaction so two servers (or two ticks) never send the same row.
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := q.WithTx(tx).ClaimDueNotifications(ctx, dbq.ClaimDueNotificationsParams{NotBefore: now, Limit: 50})
	if err != nil {
		s.log().Error("claim notifications", "err", err)
		return
	}
	for _, r := range rows {
		var sendErr error
		switch r.Channel {
		case "email":
			sendErr = s.sendEmailRow(ctx, r)
		case "webhook":
			sendErr = s.sendWebhookRow(ctx, r)
		}
		status, next, text := "sent", r.NotBefore, ""
		var sent *time.Time
		if sendErr == nil {
			sent = &now
		} else {
			text = trim(sendErr.Error(), 500)
			if int(r.Attempts)+1 >= maxAttempts {
				status = "failed"
			} else {
				status = "pending"
				next = now.Add(backoff[min(int(r.Attempts), len(backoff)-1)])
			}
			s.log().Warn("notification not delivered", "channel", r.Channel, "event", r.Event, "attempt", r.Attempts+1, "err", sendErr)
		}
		if err := q.WithTx(tx).FinishNotification(ctx, dbq.FinishNotificationParams{ID: r.ID, Status: status, LastError: text, NotBefore: next, SentAt: sent}); err != nil {
			s.log().Error("finish notification", "err", err)
		}
	}
	_ = tx.Commit(ctx)
}

func trim(s string, n int) string {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\n", " "), "\r", " ")
	if len(s) > n {
		return s[:n]
	}
	return s
}

// scan looks for the conditions that nothing announces: devices gone quiet, the license filling up, late agents.
func (s *Service) scan(ctx context.Context) {
	org, err := s.Settings.Org(ctx)
	if err != nil {
		return
	}
	ns := s.Settings.Values(ctx, org, "notifications")
	rules := map[string]settings.V{}
	for _, r := range ns.Items("rules") {
		if r.Bool("enabled") {
			rules[r.Str("event")] = r
		}
	}
	q := dbq.New(s.Pool)
	now := s.now()
	if r, ok := rules["device_offline"]; ok {
		hours := r.Int("threshold")
		if hours > 0 {
			rows, err := q.OfflineDevicesSince(ctx, dbq.OfflineDevicesSinceParams{OrgID: org, LastSeenAt: ptr(now.Add(-time.Duration(hours) * time.Hour))})
			if err == nil {
				for _, d := range rows {
					seen := ""
					if d.LastSeenAt != nil {
						seen = d.LastSeenAt.UTC().Format(time.RFC3339)
					}
					s.Emit(ctx, org, Event{Name: "device_offline", Key: "offline:" + d.ID.String() + ":" + seen,
						Subject: fmt.Sprintf("%s has not reported for %d hours or more", d.Hostname, hours),
						Text:    fmt.Sprintf("The device %s last reported at %s.", d.Hostname, seen),
						Data:    map[string]any{"device": map[string]any{"id": d.ID.String(), "hostname": d.Hostname}, "hours_offline": hours, "last_seen": seen}})
				}
			}
		}
	}
	if r, ok := rules["license_limit"]; ok && s.Licensing != nil {
		if st, err := s.Licensing.Status(ctx, org); err == nil && st.MaxDevices > 0 {
			pct := r.Int("threshold")
			if pct > 0 && st.Devices*100 >= st.MaxDevices*pct {
				s.Emit(ctx, org, Event{Name: "license_limit", Key: "license:" + now.UTC().Format("2006-01-02"),
					Subject: fmt.Sprintf("License usage is %d of %d devices", st.Devices, st.MaxDevices),
					Text:    fmt.Sprintf("%d of %d licensed devices are in use (%s). %s", st.Devices, st.MaxDevices, st.State, st.Message),
					Data:    map[string]any{"used": st.Devices, "max": st.MaxDevices, "state": string(st.State)}})
			}
		}
	}
	if r, ok := rules["agent_out_of_date"]; ok {
		if t, err := q.RolloutTargetVersion(ctx, org); err == nil && now.Sub(t.CreatedAt) >= time.Duration(r.Int("threshold"))*24*time.Hour {
			if devs, err := q.ActiveDeviceAgents(ctx, org); err == nil {
				for _, d := range devs {
					if vercmp.Key(d.AgentVersion) == nil || vercmp.Compare(d.AgentVersion, t.Version) >= 0 {
						continue
					}
					s.Emit(ctx, org, Event{Name: "agent_out_of_date", Key: "agent:" + d.ID.String() + ":" + t.Version,
						Subject: fmt.Sprintf("%s runs agent %s; the target is %s", d.Hostname, d.AgentVersion, t.Version),
						Text:    fmt.Sprintf("The device %s runs agent version %s, older than the rollout's target %s.", d.Hostname, d.AgentVersion, t.Version),
						Data:    map[string]any{"device": map[string]any{"id": d.ID.String(), "hostname": d.Hostname}, "agent_version": d.AgentVersion, "target_version": t.Version}})
				}
			}
		}
	}
}

func ptr[T any](v T) *T { return &v }
