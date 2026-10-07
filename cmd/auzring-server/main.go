// Command auzring-server is the Auzring management server.
//
//	auzring-server [serve]            run the server (default)
//	auzring-server migrate            apply database migrations and exit
//	auzring-server healthcheck        exit 0 if the local server is healthy (Docker HEALTHCHECK)
//	auzring-server admin reset-mfa --email E   force MFA re-enrollment for a user
//	auzring-server admin unlock --email E      clear a login lockout
//	auzring-server admin verify-audit          verify the audit-log hash chain
//	auzring-server version
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/auzring1/auzring/gen/dbq"
	"github.com/auzring1/auzring/internal/server/app"
	"github.com/auzring1/auzring/internal/server/audit"
	"github.com/auzring1/auzring/internal/server/config"
	"github.com/auzring1/auzring/internal/server/store"
	"github.com/auzring1/auzring/internal/shared/version"
)

func main() {
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	var err error
	switch cmd {
	case "serve":
		err = serve()
	case "migrate":
		err = migrate()
	case "healthcheck":
		err = healthcheck()
	case "admin":
		err = admin(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Printf("auzring-server %s (%s)\n", version.Version, version.Commit)
	default:
		err = fmt.Errorf("unknown command %q (serve|migrate|healthcheck|admin|version)", cmd)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func logger(level string) *slog.Logger {
	var l slog.Level
	_ = l.UnmarshalText([]byte(level))
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: l}))
}

func serve() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log := logger(cfg.LogLevel)
	log.Info("starting auzring-server", "version", version.Version, "commit", version.Commit, "dev_mode", cfg.DevMode)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	a, err := app.New(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer a.Close()
	return a.Run(ctx)
}

func migrate() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	url := cfg.MigrateDatabaseURL
	if url == "" {
		url = cfg.DatabaseURL
	}
	return store.Migrate(context.Background(), url, logger(cfg.LogLevel))
}

func healthcheck() error {
	addr := os.Getenv("AUZ_HTTP_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	c := &http.Client{Timeout: 3 * time.Second}
	// #nosec G704 -- probes this container's own listener from operator configuration
	resp, err := c.Get("http://" + addr + "/readyz")
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("unhealthy: HTTP %d", resp.StatusCode)
	}
	return nil
}

func admin(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: admin reset-mfa|unlock --email E | admin verify-audit")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx := context.Background()
	pool, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	q := dbq.New(pool)
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	email := fs.String("email", "", "user email")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	switch args[0] {
	case "verify-audit":
		res, err := audit.Verify(ctx, q)
		if err != nil {
			return err
		}
		if res.BrokenAt != 0 {
			return fmt.Errorf("audit chain BROKEN at entry %d (%d entries verified before it)", res.BrokenAt, res.Checked)
		}
		fmt.Printf("audit chain intact: %d entries verified\n", res.Checked)
		return nil
	case "reset-mfa", "unlock":
		if *email == "" {
			return errors.New("--email is required")
		}
		u, err := q.GetUserByEmail(ctx, strings.ToLower(strings.TrimSpace(*email)))
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("no user with email %q", *email)
		} else if err != nil {
			return err
		}
		return store.Tx(ctx, pool, func(tx pgx.Tx, q *dbq.Queries) error {
			if args[0] == "reset-mfa" {
				if err := q.DeleteTOTP(ctx, u.ID); err != nil {
					return err
				}
				if err := q.DeleteRecoveryCodes(ctx, u.ID); err != nil {
					return err
				}
				if err := q.DeleteUserSessions(ctx, u.ID); err != nil {
					return err
				}
			} else if err := q.SetUserLoginFailure(ctx, dbq.SetUserLoginFailureParams{ID: u.ID}); err != nil {
				return err
			}
			if _, err := audit.Write(ctx, tx, audit.Entry{OrgID: &u.OrgID, ActorType: audit.ActorSystem, ActorID: "cli",
				Action: "admin." + strings.ReplaceAll(args[0], "-", "_"), TargetType: "user", TargetIDs: []string{u.ID.String()},
				Outcome: audit.Success}, time.Now()); err != nil {
				return err
			}
			fmt.Printf("%s done for %s\n", args[0], u.Email)
			return nil
		})
	default:
		return fmt.Errorf("unknown admin command %q", args[0])
	}
}
