// Command auzring-agent is the Auzring endpoint agent.
//
//	auzring-agent install --server HOST:PORT --token AURZ1.... [--allowed-jobs inventory,wu_scan]
//	auzring-agent uninstall
//	auzring-agent status
//	auzring-agent run [--data-dir DIR] [--server HOST:PORT --token AURZ1....]   (foreground; development)
//	auzring-agent version
//
// When started by the Windows Service Control Manager it runs as a service.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"syscall"
	"time"

	"github.com/auzring1/auzring/internal/agent/config"
	"github.com/auzring1/auzring/internal/agent/core"
	"github.com/auzring1/auzring/internal/agent/hardware"
	"github.com/auzring1/auzring/internal/agent/install"
	"github.com/auzring1/auzring/internal/agent/inventory"
	"github.com/auzring1/auzring/internal/agent/keystore"
	"github.com/auzring1/auzring/internal/agent/logging"
	"github.com/auzring1/auzring/internal/agent/store"
	"github.com/auzring1/auzring/internal/agent/winsvc"
	"github.com/auzring1/auzring/internal/shared/version"
)

func main() {
	// Footprint budget (ARCHITECTURE §3.1).
	debug.SetMemoryLimit(24 << 20)

	if winsvc.IsService() {
		if err := winsvc.Run(install.ServiceName, func(ctx context.Context) error { return runAgent(ctx, install.DataDir(), nil) }); err != nil {
			os.Exit(1)
		}
		return
	}
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "install":
		err = cmdInstall(os.Args[2:])
	case "uninstall":
		err = install.Uninstall(os.Stdout)
	case "status":
		err = cmdStatus(os.Args[2:])
	case "run":
		err = cmdRun(os.Args[2:])
	case "service":
		err = errors.New("the service command is only used by the Windows Service Control Manager")
	case "version", "--version", "-v":
		fmt.Printf("auzring-agent %s (%s)\n", version.Version, version.Commit)
	case "help", "-h", "--help":
		usage()
	default:
		usage()
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `Usage:
  auzring-agent install --server HOST:PORT --token AURZ1....   Install and enroll (Administrator)
  auzring-agent uninstall                                      Remove the agent (Administrator)
  auzring-agent status                                         Show enrollment/connection state
  auzring-agent run [--data-dir DIR] [--server S --token T]    Run in the foreground (development)
  auzring-agent version
`)
}

func cmdInstall(args []string) error {
	fl := flag.NewFlagSet("install", flag.ContinueOnError)
	server := fl.String("server", "", "gateway address host:port (defaults to the address inside the token)")
	token := fl.String("token", "", "enrollment string from the console (AURZ1....)")
	allowed := fl.String("allowed-jobs", "", "optional local ceiling of allowed job types (comma-separated)")
	wait := fl.Duration("wait", 90*time.Second, "how long to wait for enrollment to finish")
	if err := fl.Parse(args); err != nil {
		return err
	}
	if *token == "" {
		return errors.New("--token is required")
	}
	return install.Install(install.Options{Server: *server, Token: *token, AllowedJobs: *allowed, Wait: *wait, Out: os.Stdout})
}

func cmdStatus(args []string) error {
	fl := flag.NewFlagSet("status", flag.ContinueOnError)
	dir := fl.String("data-dir", install.DataDir(), "agent data directory")
	if err := fl.Parse(args); err != nil {
		return err
	}
	st, err := core.ReadStatus(*dir)
	if err != nil {
		return fmt.Errorf("no status available (is the agent installed?): %w", err)
	}
	fmt.Printf("state:      %s\ndevice id:  %s\nserver:     %s\nversion:    %s\nupdated:    %s\n",
		st.State, st.DeviceID, st.Server, st.Version, st.UpdatedAt.Local().Format(time.RFC1123))
	if st.Message != "" {
		fmt.Printf("message:    %s\n", st.Message)
	}
	return nil
}

func cmdRun(args []string) error {
	fl := flag.NewFlagSet("run", flag.ContinueOnError)
	dir := fl.String("data-dir", install.DataDir(), "agent data directory")
	server := fl.String("server", "", "gateway address (first run only)")
	token := fl.String("token", "", "enrollment string (first run only)")
	if err := fl.Parse(args); err != nil {
		return err
	}
	if err := os.MkdirAll(*dir, 0o700); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var first *config.Config
	if *token != "" {
		c, err := config.FromBundle(*token, *server)
		if err != nil {
			return err
		}
		first = c
	}
	return runAgent(ctx, *dir, first)
}

// runAgent loads config/state and runs the agent core until ctx ends.
func runAgent(ctx context.Context, dataDir string, first *config.Config) error {
	cfgPath := filepath.Join(dataDir, "config.json")
	cfg, err := config.Load(cfgPath)
	switch {
	case errors.Is(err, fs.ErrNotExist) && first != nil:
		cfg = first
		if err := config.Save(cfgPath, cfg); err != nil {
			return err
		}
	case err != nil:
		return fmt.Errorf("load %s: %w", cfgPath, err)
	}
	logDir := filepath.Join(dataDir, "logs")
	if err := os.MkdirAll(logDir, 0o700); err != nil {
		return err
	}
	var console io.Writer
	if !winsvc.IsService() {
		console = os.Stderr
	}
	log := logging.New(logDir, cfg.LogLevel, console)
	st, err := store.Open(filepath.Join(dataDir, "state.db"))
	if err != nil {
		log.Error("open state", "err", err)
		return err
	}
	defer func() { _ = st.Close() }()
	_ = st.LedgerPrune(time.Now())
	log.Info("auzring-agent starting", "version", version.Version, "server", cfg.Server)
	a := &core.Agent{Cfg: cfg, CfgPath: cfgPath, DataDir: dataDir, Store: st, Keys: keystore.Default(dataDir),
		HW: hardware.New(), Log: log, Version: version.Version}
	a.Inv = &inventory.Manager{Collector: inventory.NewCollector(), Store: st, Log: log}
	if w, err := inventory.NewWatcher(log); err != nil {
		log.Warn("registry change watcher unavailable; relying on the daily rescan", "err", err)
	} else {
		defer w.Close()
		a.Changes = w.Events()
	}
	return a.Run(ctx)
}
