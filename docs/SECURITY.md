# Security and Threat Model

Status: threat model updated after Phase 1. It's updated every phase, and the Phase 6 security review is run against it. Every control lists the phase that delivers it. §9 lists what Phase 1 actually implements, with the test that proves each item.

## 1. Security goals
1. **Only the legitimate server, acting on an authenticated and authorized admin's intent, can make an endpoint execute anything**, and only from the fixed set of typed jobs.
2. **The network is hostile.** A machine-in-the-middle, a malicious proxy or a DNS hijack can't inject, alter, replay or redirect jobs.
3. **One compromised endpoint can't affect other endpoints or the server**, beyond its own inventory data and results.
4. **A local standard user can't use the agent to escalate privileges.**
5. **Only verified binaries get installed.** Every installer and every agent update is hash-verified, and signature-verified where possible, before it runs.
6. **Everything an admin does is attributable,** in an audit log that can be appended to but not edited.
7. **Server compromise is treated as catastrophic.** We reduce its likelihood and its blast radius, and we're honest about what we can't prevent (§6).

## 2. Assets

| ID | Asset | Why it matters |
|---|---|---|
| A1 | Job-signing private key | With it plus network position or server access, an attacker can run allowed job types as SYSTEM fleet-wide |
| A2 | Root CA key | Can mint job-signing certs and issuing CAs, so it's the top of trust |
| A3 | Issuing CA key | Can mint device certificates and gateway certificates (impersonate the server to agents for TLS, but **not** sign jobs) |
| A4 | Admin credentials, sessions, API tokens | Admin intent equals fleet control |
| A5 | Device private keys | Impersonate a device: feed false inventory, receive its jobs |
| A6 | Installer and agent binaries in transit and staging | Tampering means code runs as SYSTEM |
| A7 | Database | Inventory (usernames, hostnames, software = recon gold), audit log, encrypted keys |
| A8 | Server KEK (Docker secret) | Decrypts A1, A3 and the TOTP secrets at rest |
| A9 | Vendor release-signing key (ours, not the customer's) | Authorizes agent self-updates for *every customer* |
| A10 | Backups | Contain A7 and the encrypted key material |

## 3. Adversaries
- **External network attacker:** can reach the GUI and gateway ports, and may hold a network MITM position.
- **Malicious or compromised endpoint:** has SYSTEM on one enrolled device, so it holds that device's identity.
- **Local standard user** on a managed endpoint, possibly running malware.
- **Malicious or compromised upstream:** a poisoned winget manifest, a compromised vendor download, or a compromised dependency.
- **Insider:** a rogue operator, or a stolen admin session.
- **Attacker with access to the server host or containers.**

## 4. Trust boundaries

```
[Browser] ──TB1── [Caddy] ──TB2── [Server API] ──TB4── [Postgres]
                                   [Server gateway] ──TB3── [Agent service (SYSTEM)] ──TB5── [User helper (user)]
[Server] ──TB6── [winget CDN / vendor URLs]           [Agent] ──TB6── [vendor URLs]
[Agent service] ──TB7── [Local users / other processes on the endpoint]
[Vendor build pipeline] ──TB8── [Released agent / server artifacts]
```

## 5. Threats and mitigations

Statuses: ✅ designed in, 🔜 later phase (number given), ⚠ residual risk.

### TB3: Network between agents and server
| ID | Threat | Mitigation | Phase |
|---|---|---|---|
| T-NET-1 | MITM injects or alters jobs | TLS 1.3 + mTLS with the **root pinned by the agent**. Separately, every job is an **Ed25519-signed envelope**, verified before parsing and bound to device, org, expiry and nonce. A MITM with a valid TLS certificate still can't forge a job. | 1, 3 ✅ |
| T-NET-2 | Replay of a captured job, to the same or another device | `device_id` binding; `expires_at` (≤ 30 days); job-ID ledger kept past expiry; nonce | 3 ✅ |
| T-NET-3 | A proxy or header-forwarding setup tricks the server into trusting a spoofed client certificate | The gateway terminates TLS itself. No proxy is in the agent path, and we never read client identity from headers. | 1 ✅ |
| T-NET-4 | Rogue server (DNS hijack) | Agent pins the root SPKI. The enrollment bundle carries the pin, so trust on first use doesn't depend on DNS. | 1 ✅ |
| T-NET-5 | TLS downgrade | TLS 1.3 only, on both sides | 1 ✅ |
| T-NET-6 | Traffic analysis of inventory | All traffic is TLS. Metadata leakage (timing, size) is accepted. | ⚠ |

### TB3: Compromised endpoint against the server
| ID | Threat | Mitigation | Phase |
|---|---|---|---|
| T-DEV-1 | Device impersonates another device | Device ID taken from the verified certificate; never trusted from message fields | 1 ✅ |
| T-DEV-2 | Malicious inventory (XSS, CSV injection, SQL-looking strings, huge payloads) | Everything from agents is untrusted input: size limits, parameterized SQL, React escaping plus strict CSP, CSV formula escaping (`= + - @ \t \r` get a `'` prefix), schema validation | 1–2 ✅ |
| T-DEV-3 | Resource exhaustion (flooding messages, inventory churn) | Per-device token-bucket rate limits, message size caps, max rows, connection limit per device certificate (1) | 1–2 ✅ |
| T-DEV-4 | Content scraping (download other tenants' or other devices' uploads) | Content served only if referenced by an active job for that device | 3 ✅ |
| T-DEV-5 | Stolen device key reused elsewhere | Key held in TPM/non-exportable CNG; one stream per certificate; admin revocation is immediate; anomaly flag when a device connects from a new IP while still connected | 1 ✅ |
| T-DEV-6 | Falsified job results (claims patched when not) | Accepted risk for a compromised device, since we can't attest. Inventory cross-checks are shown. | ⚠ |

### Enrollment
| ID | Threat | Mitigation | Phase |
|---|---|---|---|
| T-ENR-1 | Token theft or mass rogue enrollment | Limited-use, expiring tokens stored hashed; optional admin approval; rate limits per IP and per token; enrollment alerts; tokens can be revoked | 1 ✅ |
| T-ENR-2 | Taking over an existing device's identity by re-enrolling | A matching hardware ID forces approval; the old certificates are revoked when the new one is approved | 1 ✅ |
| T-ENR-3 | Brute-forcing tokens | 256-bit tokens; generic errors; rate limits | 1 ✅ |

### TB7/TB5: Endpoint-local privilege escalation
| ID | Threat | Mitigation | Phase |
|---|---|---|---|
| T-LPE-1 | User swaps the installer between verification and execution (TOCTOU) | Staging is SYSTEM-write-only (user scope: SYSTEM-write, user read/execute). The file is opened deny-write, re-hashed from the handle, and the handle stays open through `CreateProcess`. | 3 ✅ |
| T-LPE-2 | DLL planting next to an installer running as SYSTEM | Staging directory can't be written by users. Working directory is staging. The agent itself uses `SetDefaultDllDirectories`. | 3 ✅ |
| T-LPE-3 | **User-writable `HKCU` uninstall strings run as SYSTEM** | Never. HKCU entries only run through the user's own helper. HKLM strings are parsed, and the executable path is checked for user-writable ACLs on the file and its parents. No shell is involved. | 3 ✅ |
| T-LPE-4 | Command-line injection through package metadata or admin args | Argument arrays, `ComposeCommandLine` quoting, no `cmd.exe`/PowerShell, allow-listed argument token patterns, MSI GUID regex | 3 ✅ |
| T-LPE-5 | Local IPC abuse (squatting or connecting to an agent pipe) | No named pipes or listening sockets. The helper gets an inherited anonymous pipe and takes one task. A user→service channel doesn't exist. | 3 ✅ |
| T-LPE-6 | Tampering with agent files, config or the service | Protected DACLs (SYSTEM/Administrators). Quoted `ImagePath`. Service DACL denies non-admins stop/config. Authenticode-signed binaries. | 1 ✅ / 5 (signing) |
| T-LPE-7 | Malicious process (same user) tampers with the helper | Accepted. The helper only has the user's own rights. The service treats its output as untrusted and re-checks detection. | ⚠ (by design) |
| T-LPE-8 | Zip-slip or path traversal in nested installers and portable packages | Paths canonicalized, must stay under the staging root; reparse points rejected | 3 ✅ |
| T-LPE-9 | Secrets on disk | Device key in TPM/CNG (not exportable). The enrollment token is deleted after use. Any other secret is DPAPI machine-scoped **and** in a SYSTEM-only file. | 1 ✅ |

### TB6: Upstream supply chain (catalog and vendors)
| ID | Threat | Mitigation | Phase |
|---|---|---|---|
| T-SUP-1 | Download replaced at the vendor URL | SHA-256 from the catalog is in the signed job. A mismatch blocks the install and raises an alert. | 3 ✅ |
| T-SUP-2 | Malicious manifest in the winget community repository | Verify the index MSIX signature. **Signer pinning** (alert/block on Authenticode signer change between versions). `verified` overlay. New versions held for a configurable delay in auto-update rings. Unverified packages warned about and role-gated. | 3, 5 ✅ / ⚠ residual |
| T-SUP-3 | SSRF through server-side fetching (catalog sync, content caching of admin-given URLs) | Server fetches only `https`; private, loopback and link-local addresses blocked unless the admin explicitly allows them; size and time caps; redirects re-checked | 3 ✅ |

### TB1/TB2: Web GUI and API
| ID | Threat | Mitigation | Phase |
|---|---|---|---|
| T-WEB-1 | Credential stuffing or brute force | argon2id (m=64 MiB, t=3, p=2, with a concurrency semaphore against memory DoS); **mandatory MFA**; per-account backoff and lockout (10 failures → 15 min); per-IP rate limits; breached-password check with an offline list | 1 ✅ |
| T-WEB-2 | Session theft | `__Host-` cookie, `HttpOnly`, `Secure`, `SameSite=Strict`; 30 min idle and 12 h absolute; ID rotated on login and privilege change; MFA re-check for sensitive actions (deploy to over N devices, root unlock, role changes, creating API tokens) | 1 ✅ |
| T-WEB-3 | CSRF | SameSite=Strict, plus a synchronizer token header on all state changes, plus an `Origin` check | 1 ✅ |
| T-WEB-4 | XSS | React escaping; CSP `default-src 'self'; script-src 'self' 'nonce-…'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`; no `dangerouslySetInnerHTML`, enforced by a lint rule | 1 ✅ |
| T-WEB-5 | SQL injection | sqlc parameterized queries only; allow-listed dynamic-group compiler | 1 ✅ |
| T-WEB-6 | Broken access control (IDOR, cross-site, cross-org) | Every query takes `org_id` and the RBAC scope; central authorization middleware plus per-handler policy; tests for each role × endpoint | 1, 5 ✅ |
| T-WEB-7 | API token misuse | Prefixed tokens (`aur_pat_`) for secret scanning; stored hashed; scoped; can't manage users, roles or tokens; expiry required | 5 ✅ |
| T-WEB-8 | Clickjacking, MIME sniffing, referrer leaks | `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, HSTS (when using public TLS) | 1 ✅ |

### TB4/host: Server and data
| ID | Threat | Mitigation | Phase |
|---|---|---|---|
| T-SRV-1 | Database exposed to the network | Postgres on an internal compose network only, no published port, scram-sha-256, least-privilege roles | 1 ✅ |
| T-SRV-2 | Container escape or lateral movement | distroless non-root, `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges`, no Docker socket mount, tmpfs `/tmp`, resource limits | 1 ✅ |
| T-SRV-3 | Theft of key material from a volume or backup | Signing and issuing keys encrypted with the KEK (from a Docker secret, never stored in the DB or image). Root key encrypted with an owner passphrase that is never stored. Backups encrypted with age. | 1, 5 ✅ |
| T-SRV-4 | Audit tampering | Insert-only database role plus a trigger; hash chain with daily verification; optional streaming to a SIEM | 1 ✅ |
| T-SRV-5 | Default credentials | None exist. First-run setup needs a one-time setup token printed to the server log/stdout, then creates the admin with MFA. | 1 ✅ |

### TB8: Our own release pipeline
| ID | Threat | Mitigation | Phase |
|---|---|---|---|
| T-REL-1 | Malicious agent update pushed through a customer server | Agent updates need a **vendor release-key** signature (compiled in) plus Authenticode with our pinned subject, and the version can't go down. A customer server can't create one. | 5 ✅ |
| T-REL-2 | Compromised dependency | Pinned modules and lockfile, Renovate with review, govulncheck, `npm audit`, gosec, semgrep, CodeQL, license allow-list, SBOM (Syft), reproducible builds, cosign-signed images | 1, 6 ✅ |
| T-REL-3 | Release-key theft | Release key in an HSM or cloud KMS, used only by a protected CI environment with required reviewers | 6 🔜 (owner decision on KMS) |

## 6. Server compromise: blast radius and residual risk
If an attacker gets admin GUI access, or code execution inside the server container while it's running, they can sign jobs. **No server-side design fully prevents this** for a system whose purpose is remote software installation. What we do:

1. **Typed jobs only.** There's no shell. The attacker can only install packages whose hash is in the job, uninstall, reboot or update. That's still dangerous, because a custom package upload is effectively arbitrary code. Uploads and deployments are fully audited.
2. **Agent-side policy ceiling.** Set at MSI install time and impossible for the server to raise. Examples: `ALLOWED_JOBS=inventory,wu` for sensitive servers, or `CUSTOM_PACKAGES=0` to only allow catalog packages with pinned signers.
3. **Four-eyes approval** (configurable): deployments over N devices, or of custom or unverified packages, need a second admin. Each approval needs fresh MFA.
4. **Detection.** Anomaly alerts (mass deployment, new custom package, signing-key use outside a deployment), plus the audit log streamed off-box.
5. **Root key offline-by-passphrase.** Server compromise doesn't give the attacker root operations (minting signing certs or revoking keys) unless they capture the passphrase during use.
6. **Future (post-v1):** PKCS#11/HSM for the job-signing key. Optionally, **admin-signed deployments**, where agents also require a WebAuthn-backed approval signature for custom packages.

Other accepted residual risks: falsified results from a compromised device (T-DEV-6), helper tampering by same-user malware (T-LPE-7), and a malicious upstream manifest that gets past signer pinning, for example a brand-new package (T-SUP-2).

## 7. Requirement → control traceability
| Requirement from the brief | Where |
|---|---|
| TLS 1.3 + mTLS, unique device certificates, rotation, immediate revocation | PROTOCOL §2, §7 |
| Limited-use expiring enrollment tokens, approval, rate limits | PROTOCOL §4.1, T-ENR-* |
| Signed jobs with a separate key, nonce, expiry, device ID | PROTOCOL §5, T-NET-1/2 |
| No remote shell; typed jobs only | ARCHITECTURE §5 |
| SHA-256 + Authenticode, protected staging, TOCTOU | ARCHITECTURE §7.3, T-LPE-1/2 |
| Agent ACLs, signed binaries, DPAPI/no plaintext secrets, no listening sockets, no injection | ARCHITECTURE §3.2, T-LPE-* |
| argon2id, MFA, RBAC, sessions, CSRF, CSP, rate limits, SQL, validation, OIDC-ready | T-WEB-*, DATA_MODEL |
| No default credentials, secrets from env/Docker secrets | T-SRV-5, RUNBOOK |
| Append-only audit log | T-SRV-4 |
| Container hardening | T-SRV-2 |
| Supply chain, SBOM, scanners, signing | T-REL-* |

## 8. Secure development rules (enforced in review and CI)
- No `exec.Command("cmd", ...)`, `powershell`, or shell strings anywhere in the agent. A semgrep rule checks this.
- No SQL outside `db/queries/`. No `fmt.Sprintf` near SQL. A semgrep rule checks this.
- All agent-supplied and helper-supplied data is validated at the boundary with explicit size limits.
- No secrets in the repo. gitleaks runs in CI.
- Crypto comes only from the Go standard library, `x/crypto` and Windows CNG. No hand-rolled primitives.
- Any change touching `internal/shared/envelope`, `pki`, `auth`, `userctx`, or `engine` needs a security-labelled review.

## 9. Phase 1: implemented controls and evidence

| Control | Evidence (automated unless noted) |
|---|---|
| TLS 1.3-only mTLS gateway terminated by the server; client cert checked against the DB on every handshake **and** every stream | `test/e2e` (revoked device cannot open a stream), `test/integration` (real stack) |
| Pinned-root enrollment; foreign roots, foreign leaves and wrong hostnames rejected | `internal/agent/core/tls_test.go` |
| Job-signing certificates accepted only if issued directly by the root, with the EKU; the issuing CA cannot mint one | `internal/server/pki/pki_test.go` |
| Envelope verification: signature over raw bytes with a domain prefix, device/org binding, expiry cap, replay ledger, revoked keys | `internal/shared/envelope/envelope_test.go` |
| Limited-use, expiring, hashed enrollment tokens; generic errors; per-IP/per-token limits; forced approval on hardware re-enrollment | `test/e2e` (exhausted token, re-enrollment pending) |
| Device key non-exportable in CNG (TPM when present); private key never in agent memory | `cng_windows_test.go` (Windows CI) |
| Agent: protected DACLs, quoted service path, restricted service DACL, enrollment token erased, no listening ports | Windows CI install job (`.github/workflows/windows.yml`) |
| argon2id with bounded concurrency; breach-list policy; mandatory TOTP with replay protection; recovery codes; lockout | `internal/server/auth`, `test/e2e` (replayed TOTP rejected) |
| `__Host-` SameSite=Strict session cookie; Origin check + synchronizer CSRF token; pre-MFA sessions cannot use the API | `test/e2e` (CSRF/cross-origin rejected, pre-MFA 401) |
| Strict CSP with per-request nonces; zero violations across the whole console flow | `web/e2e/console.spec.ts` |
| Parameterized SQL only (sqlc); no shells; no `InsecureSkipVerify` outside the pinned verifier; no `dangerouslySetInnerHTML` | `.semgrep.yml` in CI |
| Audit log append-only for the runtime role, hash-chained, tamper detected | `internal/server/audit/audit_test.go`, `admin verify-audit` in `test/integration` |
| Containers non-root (server), read-only rootfs, `cap_drop: ALL`, no-new-privileges; Postgres not published | `test/integration` asserts all of these via `docker inspect` |
| X-Forwarded-For trusted only from Caddy's fixed IP; spoofed header ignored | `test/integration` |
| Least-privilege DB role, KEK and DB credentials as Docker secrets, no default credentials (one-time setup token) | compose + `test/integration` |
| Supply chain: digest-pinned images, SHA-pinned actions, govulncheck, npm audit, gosec, staticcheck, license allow-list, gitleaks, SPDX SBOMs | `.github/workflows/ci.yml` |

**Known gaps and residual risks after Phase 1** (planned phase in brackets):
- Agent and server binaries are not yet code-signed or release-signed [5, needs O5/O7]. Until then, verify binaries by building from source.
- No WebAuthn yet (TOTP only) [5]. No API tokens yet [5]. RBAC has three org-wide roles; per-site scoping arrives in [5].
- The one-time setup token appears in the server log until setup completes. Anyone with access to container logs before setup could claim the instance; complete setup immediately after first start.
- Database traffic inside the Docker internal network is not TLS-encrypted (D28) [6 for split deployments].
- `AUZ_DEV_MODE=true` allows plain-HTTP origins, secrets in environment variables and short certificate lifetimes. It is meant for development and tests only and must never be used in production (the server logs `dev_mode:true` at start).
- govulncheck cannot run in our development sandbox (egress policy). It runs in CI.
- Agent RSS is measured informationally on Windows CI. A hard 30 MB budget check and load testing arrive in [6].
- The placeholder job-signing EKU OID uses the documentation PEN 32473 (D25).

## 10. Vulnerability disclosure
**Placeholder; the contact details are an owner decision.**
- Report to: `security@<product-domain>` (PGP key published at `/.well-known/security.txt` on the product site), or through GitHub private vulnerability reporting on this repository.
- We acknowledge within 3 business days, triage within 10, and aim to fix critical issues within 30 days and high within 60. Disclosure is coordinated with the reporter. Reporters who want credit get it.
- Safe harbour for good-faith research on your own installations. Don't test against other customers' systems.
- Supported versions: the current minor release and the previous one get security fixes.
