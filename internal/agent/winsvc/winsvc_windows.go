//go:build windows

// Package winsvc runs the agent under the Windows Service Control Manager.
package winsvc

import (
	"context"
	"time"

	"golang.org/x/sys/windows/svc"

	"github.com/auzring1/auzring/internal/agent/jobs"
)

// IsService reports whether the process was started by the SCM.
func IsService() bool {
	ok, err := svc.IsWindowsService()
	return err == nil && ok
}

type handler struct{ run func(context.Context) error }

// Run hands control to the SCM until the service is stopped.
func Run(name string, run func(context.Context) error) error {
	return svc.Run(name, &handler{run: run})
}

func (h *handler) Execute(_ []string, req <-chan svc.ChangeRequest, st chan<- svc.Status) (bool, uint32) {
	st <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.run(ctx) }()
	st <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown | svc.AcceptSessionChange}
	for {
		select {
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				st <- c.CurrentStatus
			case svc.SessionChange:
				// logon, unlock, remote connect: re-evaluate jobs waiting for a user
				jobs.NotifySessionChange()
			case svc.Stop, svc.Shutdown:
				st <- svc.Status{State: svc.StopPending, WaitHint: 20000}
				cancel()
				select {
				case <-done:
				case <-time.After(20 * time.Second):
				}
				return false, 0
			}
		case err := <-done:
			cancel()
			if err != nil {
				// Non-zero exit triggers the configured recovery (restart) actions.
				return false, 1
			}
			return false, 0
		}
	}
}
