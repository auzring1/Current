// Package deploy plans deployments into per-device jobs, signs and dispatches
// them, and tracks their results (docs/ARCHITECTURE.md §5-6).
package deploy

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/proto"

	"github.com/auzring1/auzring/gen/dbq"
	agentv1 "github.com/auzring1/auzring/gen/proto/auzring/agent/v1"
	"github.com/auzring1/auzring/internal/server/events"
	"github.com/auzring1/auzring/internal/server/pki"
	"github.com/auzring1/auzring/internal/shared/envelope"
	"github.com/auzring1/auzring/internal/shared/pkix"
)

// Dispatcher delivers a signed envelope to a connected device.
type Dispatcher interface {
	// Offer sends se to the device's live stream; false if it is not connected.
	Offer(deviceID uuid.UUID, se *agentv1.SignedEnvelope) bool
}

// Service owns deployments and jobs.
type Service struct {
	Pool       *pgxpool.Pool
	Authority  func() *pki.Authority
	Dispatcher Dispatcher
	Events     *events.Broker
	Log        *slog.Logger
	Now        func() time.Time
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

// Errors the API maps to HTTP statuses.
var (
	ErrInvalid      = errors.New("deploy: invalid request")
	ErrNoTargets    = errors.New("deploy: no active devices match the targets")
	ErrUnverified   = errors.New("deploy: package is not verified; confirm to deploy it")
	ErrExcluded     = errors.New("deploy: package is excluded by an administrator")
	ErrNotRetryable = errors.New("deploy: only failed, expired, rejected or cancelled jobs can be retried")
)

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, a...))
}

// signAndOffer signs the stored job body for dispatch and offers it to the
// device. It reports whether the device received it.
func (s *Service) signAndOffer(ctx context.Context, j dbq.Job) bool {
	auth := s.Authority()
	if auth == nil || s.Dispatcher == nil {
		return false
	}
	var env agentv1.JobEnvelope
	if err := proto.Unmarshal(j.Body, &env); err != nil {
		s.log().Error("stored job body is corrupt", "job", j.ID, "err", err)
		return false
	}
	now := s.now()
	env.IssuedAt = now.Add(-time.Minute).Unix() // tolerate small clock differences on the device
	env.Nonce = make([]byte, 16)
	_, _ = rand.Read(env.Nonce)
	key, ok := auth.JobSigning.Key.(ed25519.PrivateKey)
	if !ok {
		s.log().Error("job-signing key is not Ed25519")
		return false
	}
	se, err := envelope.Sign(key, pkix.KeyID(auth.JobSigning.Cert), &env)
	if err != nil {
		s.log().Error("sign job", "job", j.ID, "err", err)
		return false
	}
	if !s.Dispatcher.Offer(j.DeviceID, se) {
		return false
	}
	raw, _ := proto.Marshal(se)
	q := dbq.New(s.Pool)
	if err := q.MarkJobSent(ctx, dbq.MarkJobSentParams{ID: j.ID, Envelope: raw, SentAt: &now}); err != nil {
		s.log().Error("mark job sent", "job", j.ID, "err", err)
	}
	return true
}

// Dispatch offers every pending job of a device (called when it connects and
// whenever new jobs are created for a connected device), and cancellations the
// agent may not have seen.
func (s *Service) Dispatch(ctx context.Context, deviceID uuid.UUID) {
	q := dbq.New(s.Pool)
	jobs, err := q.ListDispatchableJobs(ctx, deviceID)
	if err != nil {
		s.log().Error("list dispatchable jobs", "device", deviceID, "err", err)
		return
	}
	for _, j := range jobs {
		if !s.signAndOffer(ctx, j) {
			return // not connected, or no CA yet
		}
	}
	pending, err := q.ListCancelPending(ctx, deviceID)
	if err != nil {
		return
	}
	for _, id := range pending {
		j, err := q.GetJobForDevice(ctx, dbq.GetJobForDeviceParams{ID: id, DeviceID: deviceID})
		if err != nil {
			continue
		}
		s.offerCancel(j)
	}
}

// offerCancel tells the device to drop a job it may still hold.
func (s *Service) offerCancel(j dbq.Job) {
	auth := s.Authority()
	if auth == nil || s.Dispatcher == nil {
		return
	}
	now := s.now()
	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	id, _ := uuid.NewV7()
	env := &agentv1.JobEnvelope{Version: 1, JobId: id.String(), OrgId: j.OrgID.String(), DeviceId: j.DeviceID.String(),
		Type: agentv1.JobType_JOB_TYPE_CANCEL, IssuedAt: now.Add(-time.Minute).Unix(), NotBefore: now.Unix(),
		ExpiresAt: now.Add(7 * 24 * time.Hour).Unix(), Nonce: nonce, Attempt: 1,
		Body: &agentv1.JobEnvelope_Cancel{Cancel: &agentv1.CancelBody{JobId: j.ID.String()}}}
	key, ok := auth.JobSigning.Key.(ed25519.PrivateKey)
	if !ok {
		return
	}
	if se, err := envelope.Sign(key, pkix.KeyID(auth.JobSigning.Cert), env); err == nil {
		s.Dispatcher.Offer(j.DeviceID, se)
	}
}

func (s *Service) publish(org uuid.UUID, typ string, device, job, dep uuid.UUID) {
	if s.Events != nil {
		s.Events.Publish(org, events.Event{Type: typ, DeviceID: device, JobID: job, DeploymentID: dep})
	}
}

// reidentify gives a stored job body a new job ID, attempt and validity.
func reidentify(body []byte, id uuid.UUID, attempt uint32, notBefore, expires time.Time) ([]byte, error) {
	var env agentv1.JobEnvelope
	if err := proto.Unmarshal(body, &env); err != nil {
		return nil, err
	}
	env.JobId, env.Attempt, env.NotBefore, env.ExpiresAt = id.String(), attempt, notBefore.Unix(), expires.Unix()
	return proto.MarshalOptions{Deterministic: true}.Marshal(&env)
}
