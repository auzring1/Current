//go:build !windows

package jobs

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/auzring1/auzring/internal/agent/inventory"
	"github.com/auzring1/auzring/internal/shared/installer"
)

// devPlatform is the Linux stand-in used only for integration tests and the
// browser test. It runs "installers" as plain executables and has no registry,
// so detection uses files. It is never shipped (the product agent is Windows-only).
type devPlatform struct {
	dir string
	pf  string
}

// NewPlatform returns the development platform rooted at dataDir. The fake
// "Program Files" is AUZ_DEV_PROGRAMFILES or <dataDir>/pf.
func NewPlatform(dataDir string) Platform {
	pf := os.Getenv("AUZ_DEV_PROGRAMFILES")
	if pf == "" {
		pf = filepath.Join(dataDir, "pf")
	}
	return &devPlatform{dir: dataDir, pf: pf}
}

func (p *devPlatform) StagingDir(_ installer.Scope, _, jobID string) (string, error) {
	d := filepath.Join(p.dir, "stage", jobID)
	return d, os.MkdirAll(d, 0o700)
}
func (p *devPlatform) RemoveAll(path string) error           { return os.RemoveAll(path) }
func (p *devPlatform) FreeSpaceMB(string) (uint64, error)    { return 1 << 20, nil }
func (p *devPlatform) OSBuild() uint32                       { return 99999 }
func (p *devPlatform) AppxPackages(string) ([]string, error) { return nil, nil }
func (p *devPlatform) SessionEvents() <-chan struct{}        { return sessionSig }
func (p *devPlatform) HasSession(string) bool                { return true }
func (p *devPlatform) TrustedExecutable(string) error        { return nil }
func (p *devPlatform) MsiExec() string                       { return "msiexec.exe" }

func (p *devPlatform) Env(_ installer.Scope, _ string, name string) string {
	if strings.EqualFold(name, "PROGRAMFILES") {
		return p.pf
	}
	return os.Getenv(name)
}

func (p *devPlatform) FileVersion(path string) (string, bool, error) {
	if _, err := os.Stat(path); err != nil {
		return "", false, nil
	}
	return "", true, nil
}

type emptyRoot struct{}

func (emptyRoot) SubKeyNames() ([]string, error)         { return nil, nil }
func (emptyRoot) Open(string) (inventory.RegNode, error) { return nil, inventory.ErrRegNotExist }
func (emptyRoot) String(string) (string, bool)           { return "", false }
func (emptyRoot) DWord(string) (uint32, bool)            { return 0, false }
func (emptyRoot) Close()                                 {}

func (p *devPlatform) UninstallRoots(installer.Scope, string) ([]inventory.RegNode, error) {
	return []inventory.RegNode{emptyRoot{}}, nil
}

func (p *devPlatform) OpenLocked(path string) (LockedFile, error) { return os.Open(path) } // #nosec G304 -- staged file
func (p *devPlatform) VerifySignature(string) (Signature, error)  { return Signature{}, nil }

func (p *devPlatform) Run(ctx context.Context, s RunSpec) (RunResult, error) {
	if s.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.Timeout)
		defer cancel()
	}
	if err := os.Chmod(s.Exe, 0o700); err != nil && !errors.Is(err, os.ErrNotExist) { // staged scripts must be executable
		return RunResult{}, err
	}
	cmd := exec.CommandContext(ctx, s.Exe, s.Args...) // #nosec G204 -- dev platform runs the staged, hash-verified test installer
	cmd.Dir = s.Dir
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	err := cmd.Run()
	res := RunResult{LogTail: out.String()}
	var ee *exec.ExitError
	switch {
	case ctx.Err() == context.DeadlineExceeded:
		res.TimedOut = true
		res.ExitCode = -1
		return res, nil
	case errors.As(err, &ee):
		res.ExitCode = ee.ExitCode()
		return res, nil
	case err != nil:
		return res, err
	}
	return res, nil
}

func (p *devPlatform) RunAsUser(ctx context.Context, _ string, s RunSpec) (RunResult, error) {
	return p.Run(ctx, s)
}
