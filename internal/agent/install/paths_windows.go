//go:build windows

package install

import (
	"os"
	"path/filepath"
)

// Directories (ARCHITECTURE §3.2).
func programDir() string {
	pf := os.Getenv("ProgramFiles")
	if pf == "" {
		pf = `C:\Program Files`
	}
	return filepath.Join(pf, "Auzring", "Agent")
}

// DataDir is the protected state directory.
func DataDir() string {
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	return filepath.Join(pd, "Auzring")
}

// BinaryPath is where the installed agent lives (slot A; slot B is for Phase 5 self-update).
func BinaryPath() string { return filepath.Join(programDir(), "slot-a", "auzring-agent.exe") }
