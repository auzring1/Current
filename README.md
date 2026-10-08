# Auzring (codename)

Self-hosted patch and software management for Windows endpoints. It has three parts: a small Go agent, a Go server with a REST API and web console, and a hardened `docker compose` deployment.

**Status: Phase 5 (automation and polish) complete, awaiting review.** On top of Phases 1–4 you can now: let agents **update themselves** to a vendor-signed release (pilot first, automatic rollback if the new version does not connect); manage **users, sites and roles** (a role can be limited to one site), sign in with a **security key** as a second factor, and use **scoped API tokens**; define **software policies** (keep a package current, or install it on new devices); see **patch-compliance reports**; search, export and verify the **audit log**; take **encrypted backups** and restore them; and deploy the agent with an **MSI** (GPO, Intune, RMM). **Not yet verified on real Windows:** the self-update switch and rollback, and the MSI (never built, because WiX cannot bind an MSI on Linux); see [docs/SECURITY.md §9d](docs/SECURITY.md) and the [Phase 5 demo](docs/demos/PHASE5-DEMO.md). The release-signing key and code-signing certificate are still owner decisions; release hardening and load testing are Phase 6 ([docs/PLAN.md](docs/PLAN.md)).

## Quick start (production-style, one host)
```bash
./scripts/init-secrets.sh                       # Docker secrets in deploy/secrets/ (back them up!)
cp deploy/.env.example deploy/.env              # set AUZ_HOSTNAME (and AUZ_CADDY_TLS)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml logs server | grep -A2 "setup token"
```
Then open `https://<AUZ_HOSTNAME>` and follow the setup wizard. Build the Windows agent with
`GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o auzring-agent.exe ./cmd/auzring-agent`
and install it on an endpoint with the command the console shows under **Enrollment**.

- Full operations guide: [docs/RUNBOOK.md](docs/RUNBOOK.md)
- Step-by-step demos on a test VM: [Phase 1](docs/demos/PHASE1-DEMO.md), [Phase 2 (inventory)](docs/demos/PHASE2-DEMO.md), [Phase 3 (software deployment)](docs/demos/PHASE3-DEMO.md), [Phase 4 (Windows updates)](docs/demos/PHASE4-DEMO.md), [Phase 5 (self-update, access, policies, backup, MSI)](docs/demos/PHASE5-DEMO.md)

## Development
Requirements: Go 1.27 (the toolchain is pinned in `go.mod`), Node 22, Docker.
```bash
make tools                 # pinned generators and linters
make dev-db                # throwaway Postgres; prints AUZ_TEST_PG_URL to export
make web build             # console bundle, server, agent (windows + linux test build)
make test                  # unit, database and in-process end-to-end tests (race detector)
make test-gui              # Playwright: setup → MFA login → enroll a real agent → deploy a package → revoke, CSP-strict
make fuzz                  # 20 s per fuzz target over the untrusted-input parsers
make test-compose          # full docker-compose stack + real agent process
make lint vuln licenses    # vet, staticcheck, gosec, semgrep; govulncheck, npm audit; license allow-list
```
Run the web console against a local server: start the server with `AUZ_DEV_MODE=true AUZ_PUBLIC_URL=http://localhost:5173 ...`, then run `cd web && npm run dev`.

## Repository layout
| Path | |
|---|---|
| `cmd/auzring-server`, `cmd/auzring-agent`, `cmd/auzring-release` | Binaries (`auzring-release` is the vendor-side release signing tool, not shipped to customers) |
| `cmd/auzring-loadsim` | Load generator that simulates thousands of agents against a server (see [docs/LOADTEST.md](docs/LOADTEST.md)); a test tool, not shipped |
| `internal/server/*` | API, auth/MFA, gateway, PKI, audit, store, web UI embedding |
| `internal/agent/*` | Agent core, CNG key store, hardware collector, Windows service, installer |
| `internal/shared/*` | Protocol helpers shared by both: envelopes, enrollment bundle, PKIX conventions |
| `proto/`, `api/openapi.yaml`, `db/` | Agent protocol, REST contract, migrations and queries |
| `gen/` | Generated code (protobuf, sqlc). CI checks it is up to date |
| `web/` | React + TypeScript + Mantine console (embedded into the server binary) |
| `installer/windows` | WiX sources and build scripts for the agent MSI |
| `deploy/` | Dockerfile, compose stack, Caddyfile, Postgres init |
| `test/` | End-to-end, compose integration, VM matrix harness (`test/vm-matrix`), CI tools |
| `docs/` | Plan, architecture, protocol, data model, security, decisions, runbook, demos |

## Documentation
| Doc | |
|---|---|
| [PLAN](docs/PLAN.md) | Summary, stack, roadmap |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Components, agent internals, install engine, user-context helper |
| [PROTOCOL](docs/PROTOCOL.md) | Enrollment, mTLS channel, signed jobs, inventory |
| [DATA_MODEL](docs/DATA_MODEL.md) | PostgreSQL schema |
| [SECURITY](docs/SECURITY.md) | Threat model, Phase 1 controls with evidence, known gaps, disclosure policy |
| [DECISIONS](docs/DECISIONS.md) | Owner decisions and engineering defaults |
| [RUNBOOK](docs/RUNBOOK.md) | Install, operate, troubleshoot |
| [Research: winget & user context](docs/research/winget-and-user-context.md) | Why we don't execute through winget |

License: proprietary, all rights reserved (see [LICENSE](LICENSE)). Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
