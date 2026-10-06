# Decision log

Defaults chosen during planning. Each entry can be overridden. Entries marked **OWNER** are yours to decide; the others are engineering defaults.

## Open decisions for the owner
| # | Decision | Default I'm assuming | Impact if changed later |
|---|---|---|---|
| O1 | Source and distribution model | Proprietary, closed binaries; permissive-only dependencies (MIT/BSD/Apache-2.0/ISC; MPL-2.0 file-level) | High if changed to open-core (module boundaries) |
| O2 | Minimum Windows version | Windows 10 1809+, Windows 11, Server 2019+ | Server 2016: medium (MSI/EXE only). Server 2012 R2: very high (not Go) |
| O3 | Scale per installation | ~10k devices; single server container; gateway can be split later | 50k: medium (separate gateways, NATS or LISTEN/NOTIFY fan-out) |
| O4 | Product name, domain, IANA PEN, security contact | Codename "Auzring"; placeholders in docs | Low |
| O5 | Code-signing certificate for agent and MSI | Azure Trusted Signing or an OV/EV certificate held in a cloud HSM | Needed by Phase 5 |
| O6 | WiX licensing (v6+ needs the Open Source Maintenance Fee for commercial use) | Use WiX and pay the OSMF; alternatives: WiX v5 pinned, or msitools | Low (Phase 5) |
| O7 | Vendor release-signing key custody | Cloud KMS (e.g. AWS KMS or Azure Key Vault HSM) with a protected CI environment | Needed by Phase 5 |
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
| D6 | OpenAPI spec-first + oapi-codegen; TS client generated | Validation and docs come from one source |
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
