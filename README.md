# Auzring (codename)

Self-hosted patch and software management for Windows endpoints. It has three parts: a small Go agent, a Go server with a REST API and web console, and a hardened `docker compose` deployment.

**Status: Phase 1 (foundations) complete.** The server, internal CA, enrollment, mTLS agent channel, the Windows agent with hardware inventory, and the web console with mandatory MFA all work. Software inventory, deployments, Windows Update and the rest arrive in later phases; see [docs/PLAN.md](docs/PLAN.md).

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
- Step-by-step demo on a test VM: [docs/demos/PHASE1-DEMO.md](docs/demos/PHASE1-DEMO.md)

## Development
Requirements: Go 1.27 (the toolchain is pinned in `go.mod`), Node 22, Docker.
```bash
make tools                 # pinned generators and linters
make dev-db                # throwaway Postgres; prints AUZ_TEST_PG_URL to export
make web build             # console bundle, server, agent (windows + linux test build)
make test                  # unit, database and in-process end-to-end tests (race detector)
make test-gui              # Playwright: setup → MFA login → enroll a real agent → revoke, CSP-strict
make test-compose          # full docker-compose stack + real agent process
make lint vuln licenses    # vet, staticcheck, gosec, semgrep; govulncheck, npm audit; license allow-list
```
Run the web console against a local server: start the server with `AUZ_DEV_MODE=true AUZ_PUBLIC_URL=http://localhost:5173 ...`, then run `cd web && npm run dev`.

## Repository layout
| Path | |
|---|---|
| `cmd/auzring-server`, `cmd/auzring-agent` | Binaries |
| `internal/server/*` | API, auth/MFA, gateway, PKI, audit, store, web UI embedding |
| `internal/agent/*` | Agent core, CNG key store, hardware collector, Windows service, installer |
| `internal/shared/*` | Protocol helpers shared by both: envelopes, enrollment bundle, PKIX conventions |
| `proto/`, `api/openapi.yaml`, `db/` | Agent protocol, REST contract, migrations and queries |
| `gen/` | Generated code (protobuf, sqlc). CI checks it is up to date |
| `web/` | React + TypeScript + Mantine console (embedded into the server binary) |
| `deploy/` | Dockerfile, compose stack, Caddyfile, Postgres init |
| `test/` | End-to-end, compose integration, tools |
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
