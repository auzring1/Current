# Renovatio (codename)

Self-hosted patch and software management for Windows endpoints. It has three parts: a lightweight Go agent, a Go server with a REST API and web GUI, and a hardened docker-compose deployment.

**Status: Phase 0 (planning). No code yet.** Start with [docs/PLAN.md](docs/PLAN.md).

| Doc | |
|---|---|
| [PLAN](docs/PLAN.md) | Summary, stack, roadmap, assumptions |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Components, agent internals, install engine, user-context helper, repo layout |
| [DATA_MODEL](docs/DATA_MODEL.md) | PostgreSQL schema |
| [PROTOCOL](docs/PROTOCOL.md) | Enrollment, mTLS channel, signed jobs, inventory deltas |
| [SECURITY](docs/SECURITY.md) | Threat model and disclosure policy |
| [DECISIONS](docs/DECISIONS.md) | Defaults chosen and open owner decisions |
| [RUNBOOK](docs/RUNBOOK.md) | Operations (filled in from Phase 1) |
| [Research: winget & user context](docs/research/winget-and-user-context.md) | Why we don't execute through winget |
