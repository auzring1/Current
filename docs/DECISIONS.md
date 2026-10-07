# Decision log

Defaults chosen during planning. Each entry can be overridden. Entries marked **OWNER** are yours to decide; the others are engineering defaults.

## Owner decisions

### Resolved (2026-10-06, Phase 1 kickoff)
| # | Decision | Resolution |
|---|---|---|
| O1 | Source and distribution model | **Closed source.** Only permissive dependencies (MIT/BSD/Apache-2.0/ISC; MPL-2.0 file-level). No GPL/AGPL. Enforced by the license check in CI. |
| O2 | Minimum Windows version | **Windows 10 1809+, Windows 11, Server 2019+.** |
| O3 | Scale per installation | **~10,000 devices.** |
| O4 | Product name, domain, IANA PEN, security contact | Keep codename **"Auzring"** and placeholder contacts for now. The job-signing EKU uses IANA's documentation PEN 32473 (RFC 5612) as a **placeholder** until a PEN is registered (see D25). |
| O6 | Agent installer | The agent binary is the installer: `auzring-agent.exe install --server <host:port> --token <enrollment string>` and `auzring-agent.exe uninstall`. **The MSI is built with WiX v7** (EULA accepted in the build config) as a *thin wrapper* that runs those commands. MSI work happens in **Phase 5**, not before. |

### Still open
| # | Decision | Default I'm assuming | Needed by |
|---|---|---|---|
| O5 | Code-signing certificate for agent and MSI | Azure Trusted Signing or an OV/EV certificate held in a cloud HSM | Phase 5 |
| O7 | Vendor release-signing key custody | Cloud KMS (e.g. AWS KMS or Azure Key Vault HSM) with a protected CI environment | Phase 5 |
| O8 | License-key model (per device count? feature tiers? updates for N years?) | Ed25519-signed offline license: licensee, max devices, features, update-eligibility end date | Phase 6 |
| O9 | Telemetry back to us | **None.** No phone-home of any kind | n/a |

## Engineering defaults
| # | Decision | Rationale |
|---|---|---|
| D1 | Go for agent and server, single module | Shared protocol/crypto/version code; static binaries; good Windows API access |
| D2 | gRPC bidi stream over TLS 1.3 mTLS | Typed and versioned; flow control; keepalive; low idle cost |
| D3 | Gateway terminates mTLS on its own port; not behind Caddy | Avoids proxy-forwarded client-identity vulnerabilities (SECURITY T-NET-3) |
| D4 | No SQLite dev mode | One SQL dialect; dev compose gives Postgres in one command |
| D5 | sqlc + pgx + goose | Compile-time-checked parameterized SQL; embedded forward-only migrations |
| D6 | ~~OpenAPI spec-first + oapi-codegen~~ **Revised in Phase 1:** `api/openapi.yaml` is the contract; Go handlers are hand-written with strict decoding (unknown fields rejected, size limits, explicit validation); `TestRoutesMatchSpec` fails the build if routes and spec drift; TypeScript types are generated from the spec | Generated Go server stubs added awkward types and a large dependency surface (kin-openapi) to the shipped binary; the drift test keeps the single-source-of-truth benefit |
| D7 | Mantine + TanStack + Vite; SSE for live updates | Permissive license, CSP-nonce support, data-grid friendly; SSE is simpler and safer than WebSockets |
| D8 | Root CA protected by owner passphrase, issuing CA and job-signing key encrypted with KEK | Separates TLS trust from job-signing trust; root operations are rare and deliberate |
| D9 | Ed25519 for job signatures; P-256 device keys (TPM-compatible) | Small, fast, deterministic; TPM 2.0 supports P-256, not Ed25519 |
| D10 | Device certificates 90 days, renew at 1/3 remaining, 180-day expired-renewal grace | Short-lived certificates without stranding laptops that have been offline |
| D11 | winget is a metadata source only; our own installer engine executes | The winget CLI is unsupported as SYSTEM (see research note) |
| D12 | Per-user app policy default = `report_only` | Safe default; admins opt in to changes |
| D13 | User-scope staging: SYSTEM-write, user read/execute (stricter than the brief's "user + SYSTEM writable") | Users don't need write access; removes a TOCTOU window |
| D14 | Logon fallback uses SYSTEM-principal task + named event, not a user-principal task | No user→SYSTEM IPC channel to attack |
| D15 | Self-update via A/B slots + `ImagePath` switch + scheduled rollback check | Survives a broken new binary without an extra resident watchdog process |
| D16 | Third-party installers downloaded from vendor URLs by default; server caching opt-in | Avoids redistribution-licensing problems by default |
| D17 | Agent-local policy ceiling set at install time | Limits blast radius of a server compromise |
| D18 | Audit log hash chain + insert-only role | Makes tampering evident without external infrastructure |
| D19 | Caddy (not Traefik) for the GUI | Simpler config, automatic HTTPS, built-in internal CA for LAN mode |
| D20 | bbolt for agent local state | Pure Go, tiny, transactional; no CGO |
| D21 | Linters: `go vet` + `staticcheck` + `gosec` (Linux and Windows builds) + project semgrep rules, instead of golangci-lint | golangci-lint 2.14 cannot yet analyze Go 1.26+ code; revisit when it supports our toolchain |
| D22 | Toolchain Go 1.27.1 (`toolchain` in go.mod), `go 1.26` language level (required by dependencies) | Latest stable compiler for security fixes |
| D23 | Agent polls enrollment status every 60 s (±20 s jitter) while pending approval, not 5 min | Approval in the console takes effect within about a minute; cost is one small request per pending device |
| D24 | Agent decides certificate renewal on server-corrected time (offset from HelloAck) | A wrong local clock caused renewal loops in testing; the server clock is the reference |
| D25 | Job-signing EKU OID `1.3.6.1.4.1.32473.7231.1.1` (documentation PEN) until a real PEN is registered; agents will accept both during the transition | Go cannot encode 128-bit `2.25` UUID arcs in certificate EKUs, so a registered PEN is the clean fix |
| D26 | X-Forwarded-For trusted only from Caddy's fixed container IP (`AUZ_CADDY_IP/32`), not the whole Docker network | The Docker bridge gateway sits inside the network range; trusting the range allowed a forwarded-IP spoof path |
| D27 | Breached-password check uses an embedded list (46k entries ≥ 12 chars from SecLists, MIT) | Offline, no phone-home (O9); NIST 800-63B-style policy without composition rules |
| D28 | Database traffic between server and PostgreSQL is not TLS-encrypted inside the internal Docker network | Same host, internal-only network with no published port; TLS to Postgres is planned for split deployments (Phase 6) |
| D29 | **Temporary pin:** `google.golang.org/grpc v1.85.0-dev.0.20260825072537-93e31b48545e` (pre-release snapshot) | Fixes GO-2026-6443, an unauthenticated server panic (missing `:authority`/Host) reachable on our internet-facing gateway listener. No stable release contains the fix yet. **Move to v1.85.0 as soon as it is tagged**; govulncheck in CI enforces that no called vulnerability remains |
