# Rename plan: Auzring → Renovatio

> **Status: stages 2 and 3 done (branch `rename-renovatio`).** Stage 3 (DECISIONS D91): because only a test machine and a VM exist, the group-B identifiers listed below as "keep" were renamed as well, and nothing of the old name remains except the company name and the GitHub organisation. The recommendations in sections 2 and 3 are therefore historical.
>
> Stage 2 decisions: Decisions taken: keep the group-B identifiers listed under "Keep" in section 3; rename B16, B17 (image), B24, B25; add the Windows version resource (B6); the software is **Renovatio**, the agent **Renovatio Agent**, the company stays **Auzring**; rename the GitHub repository and Go module path to `renovatio` (the repository rename itself is done in GitHub's settings; the organisation `auzring1` stays); example host names change. See DECISIONS D89 and D90.

Stage 1 (below) was a survey and a set of recommendations, written before any change.

Survey method: `git grep` over every tracked file (server, agent, web console, installer/MSI, scripts, CI workflows, docs, the six PHASE demo files, tests, `deploy/`), excluding generated code (`gen/`, which is regenerated from the sources) and agent worktrees. Patterns: `auzring`, `Auzring`, `AUZRING`, `AUZ_`, `AURZ1`, `AZL1`, plus the related abbreviations `azt_` (API tokens) and `.azr` (release bundles).

| Pattern | Lines | Files |
|---|---:|---:|
| `Auzring` (capitalised, the display name) | 233 | 83 |
| `auzring` (lower case) | 1,124 | 251 |
| `AUZRING` | 0 | 0 |
| `AUZ_` (environment variables; 76 distinct names) | 372 | 50 |
| `AURZ1` (enrollment string prefix; note the spelling) | 57 | 20 |
| `AZL1` (license prefix) | 31 | 16 |
| `azt_` (API token prefix) | 12 | 9 |
| `.azr` (release bundle extension) | 52 | 18 |

Of the 1,124 lower-case lines, **477 are Go import paths** (`github.com/auzring1/auzring/...`). That is the module path, which is its own decision (section 4, C1).

---

## 1. Group A: user-visible text (rename all of it)

| Area | Where | Examples |
|---|---|---|
| Web console | `web/index.html` (page title), `Layout.tsx` (header), `LoginPage`, `SetupPage`, `CatalogPage`, `PackagePage`, `NewDeploymentPage`, `UpdatePolicyPage`, `DeviceSoftware`, `DeviceWindowsUpdates`, `common.tsx` (recovery-codes file text and name) | "Sign in to Auzring", "Set up Auzring", "Passed the Auzring VM test matrix", "served by Auzring", "Auzring does not change these policies" |
| Server messages and text | `internal/server/webui/webui.go` (fallback page), `app/app.go` (first-run setup banner), `api/deployments.go`, `deploy/device.go`, `agentrel/agentrel.go` (job title "Update the Auzring agent to …"), `backup/{backup,crypto}.go` ("is this an Auzring backup?") | |
| Second-factor labels | `api/{authn,setup}.go`: TOTP issuer `"Auzring"` (shown in authenticator apps); WebAuthn `RPDisplayName` | New enrollments only; entries already in people's authenticator apps keep the old label |
| Downloads | CSV file names (`auzring-<kind>-<time>.csv`, `api/reports.go`), `auzring-recovery-codes.txt` | |
| Agent on the machine | Windows service **display name** and **description** (`install_windows.go`), the scheduled-task description, the Windows Update `ClientApplicationID` (`wua_windows.go`; appears in Windows Update logs), installer console output and `auzring-agent` usage/help text | |
| MSI | `Package.wxs`: product name, manufacturer, ARP comments, summary text, every launch-condition message, the feature title; `installer/windows/README.md`, `build.ps1` help | "The Auzring Agent requires Windows 10 version 1809 …" |
| Outbound HTTP identity | `User-Agent: Auzring-Agent` (agent vendor downloads), `Auzring-Server` (catalog sync) | Seen only in vendor and GitHub logs |
| Certificate subject text on **newly created** CAs | `internal/server/pki/pki.go`: "Auzring Root CA", "Issuing CA", "Job Signing", "Agent Gateway", organization "Auzring device" | Nothing verifies these names (agents pin the root by key hash; the one name check is the device URN, B7). Existing installs keep the old names; only a fresh setup or a CA rotation shows the new ones |
| API description | `api/openapi.yaml` title and intro (and the generated `schema.d.ts` comments) | |
| Documentation | `README.md`, `docs/*.md` (RUNBOOK 54 hits, VERIFYING_RELEASES 29, ARCHITECTURE 19, PROTOCOL 12, SECURITY 12, …), `docs/demos/PHASE1…PHASE6-DEMO.md` (about 62), installer and script help text, CI workflow display names | Command lines in the docs follow whatever is decided for B below |
| Screenshots | The console test can capture screenshots (`AUZ_SCREENSHOTS`); there are no committed images. Demo text that describes what a screen shows will be updated | |
| Test expectations | Strings the tests assert (`TOTPURI("Auzring", …)`, `otpauth://totp/Auzring:…`, installer tests) | Updated together with the strings |

Stage 2 will also add the single source of truth and the test that fails if the old name reaches a user-visible string (as you specified).

---

## 2. Group B: identifiers that installed agents or deployments depend on

Risk is what breaks if the identifier changes under an existing installation (including your lab machines). "New installs" means a machine or server set up after the rename.

| # | Identifier | Where | Risk of renaming | Recommendation |
|---|---|---|---|---|
| B1 | **Windows service name** `AuzringAgent` | `install/paths.go`, `selfupdate/platform_windows.go`, MSI registry search (`SYSTEM\CurrentControlSet\Services\AuzringAgent`) | Installed agents would no longer find their own service: self-update cannot switch slots, `uninstall`, the MSI's "already installed" detection and the rollback task all break. Customers' monitoring and `sc`/GPO scripts also use the name | **Keep.** (The *display name* is group A and is renamed.) |
| B2 | **Install and data paths** `C:\Program Files\Auzring\Agent\slot-a\…`, `C:\ProgramData\Auzring` (config, `state.db`, logs, `tmp`), `C:\ProgramData\AuzringStage`, `C:\Program Files\AuzringSetup` (MSI staging) | `install/paths_windows.go`, `selfupdate/platform_windows.go`, `jobs/{platform,helper}_windows.go`, `inventory/platform_windows.go`, `Package.wxs`, docs | A renamed agent would look in an empty new directory: it loses its device identity, its job ledger and its config, so every device must re-enroll. Updating in place would need migration code (move and re-ACL a protected tree) that I cannot test without Windows | **Keep.** These are folders on machines, not text people read. If you want the new name there for fresh installs only, say so; I would then add "use the legacy folder if it exists" logic, which is risk I cannot validate here |
| B3 | **Scheduled task** `\Auzring\rollback-check` | `selfupdate/platform_windows.go` | A self-update that starts under one agent version and finishes under another would cancel the wrong task name and leave a stray rollback task that later restores an old binary | **Keep** (its description text is renamed) |
| B4 | **Registry**: the service key above; no `HKLM\SOFTWARE\Auzring` key or Run key exists | — | See B1 | Nothing else to rename |
| B5 | **CNG key container prefix** `Auzring-Agent-Device-` | `agent/core/agent.go` (`KeyPrefix`) | The device's private key is looked up by this name. Renaming makes the agent unable to find its key, so it must enroll again | **Keep** |
| B6 | **Agent executable name** `auzring-agent.exe` (inside `slot-a`/`slot-b`, the service image path, release manifests name the file) | `install/paths_windows.go`, `selfupdate`, `Package.wxs`, installer, docs | The service image path and the A/B slot layout contain the name; a rename has to be delivered by a self-update that changes the path the service starts, which is exactly the part of self-update I cannot test on Windows. Task Manager and the Services list show this file name | **Keep the file name; make the product show as "Renovatio".** I can add a Windows version resource (ProductName / FileDescription "Renovatio Agent") so Task Manager, Services and file properties say Renovatio without renaming the file. That is new work, small, build-only; tell me if you want it |
| B7 | **Device certificate URN** `urn:auzring:device:<uuid>` (and the CN check against it) | `shared/pkix/pkix.go` | Every issued device certificate carries it; the server and agents check it. Changing it invalidates all certificates | **Keep** |
| B8 | **Wire protocol**: protobuf package `auzring.agent.v1`, hence the gRPC service paths `/auzring.agent.v1.…`, and the `proto/auzring/...` directory | `proto/`, `gen/`, every gateway and agent file | Old and new agents and servers could not talk to each other. Not a text change you want to risk | **Keep** (you said not to change the wire protocol unless approved) |
| B9 | **Cryptographic domain separators**: `auzring/job/v1\0`, `auzring/release/v1\0`, `auzring/license/v1\0`, `auzring/revoke/v1\0`, `auzring/root-key/v1` (AEAD context) | `shared/{envelope,release,license}`, `pki/seal.go`, `proto` comments | They are part of what is signed or encrypted. Changing job, root-key or revoke invalidates every signature or sealed key that exists. (Release and license domains have no real signatures yet, but demo agents are built with the current ones.) | **Keep all.** They are never shown to a person |
| B10 | **Environment variable prefix** `AUZ_` (76 names: `AUZ_DATABASE_URL`, `AUZ_MASTER_KEY_FILE`, `AUZ_PUBLIC_URL`, `AUZ_RELEASE_PUBLIC_KEYS`, `AUZ_LICENSE_PUBLIC_KEYS`, …) | `config.go`, compose, `.env.example`, Dockerfile, scripts, CI, docs (372 lines) | Every existing `deploy/.env`, systemd unit and CI secret that sets one would silently stop working (defaults would apply, some of them security-relevant) | **Keep.** If you want a new prefix later, add `RENOVATIO_` as an accepted alias and keep `AUZ_` working; I would not rename in one step |
| B11 | **Enrollment string prefix** `AURZ1.` | `shared/bundle`, MSI launch condition, console, docs | New servers issuing a new prefix would produce strings that already-installed (Phase ≤6) agents and installers reject; old strings stop working | **Keep.** (Optional: accept an additional new prefix, issue it later) |
| B12 | **License prefix** `AZL1.` | `shared/license`, console, docs | No real license exists (demo keys only), so nothing in the field depends on it. It is an opaque magic string | **Keep** (not a brand a customer reads). Cheap to change now if you prefer; say so |
| B13 | **API token prefix** `azt_` | `api/middleware.go` and docs | Tokens that exist (your lab) stop authenticating | **Keep** |
| B14 | **Release bundle extension** `.azr` and the manifest `product` value `auzring-agent` | `shared/release`, `cmd/auzring-release`, console upload | The manifest `product` field is checked by agents (`not an agent release`); old and new would reject each other | **Keep the `product` value.** The extension is a convention; keep too |
| B15 | **Session cookie name** `__Host-auz_session` (`auz_session` in dev) | `auth/session.go` | Everyone is signed out once. No other effect | **Keep** (invisible); safe to change if you want |
| B16 | **Binary names, server side**: `auzring-server` (container entrypoint `/auzring-server`, `docker compose … maintenance`), and the vendor tools `auzring-release`, `auzring-license`, `auzring-sbom`, `auzring-loadsim` | `cmd/`, Dockerfile, compose, scripts, CI, docs, demos | Admins' own scripts and cron jobs that call `/auzring-server …` would break; nothing is installed on endpoints. No release has been published under these names | **Rename** (they are things an administrator or vendor types and reads). I would keep the old `/auzring-server` path as a symlink for one release only if you want a transition |
| B17 | **Container image and registry names** `auzring/server:dev`, `ghcr.io/auzring1/auzring-server`, cosign certificate identity `repo:auzring1/auzring:environment:release` | compose, Dockerfile, CI, release workflow, docs | Compose would build/pull a differently named image (harmless for a build-from-source stack). The cosign identity and GHCR path are tied to the GitHub repository name, not to the product name | **Rename the image** (`renovatio/server`). The GHCR/cosign names follow the repository decision C1 |
| B18 | **Docker Compose project name** `name: auzring` | `deploy/docker-compose.yml`, integration test | The project name prefixes volume and network names (`auzring_pgdata`, `auzring_content`, …). Changing it makes `up` create **new empty volumes**; your database and uploaded installers would appear to be gone (they remain under the old names) | **Keep.** Or pin the volume names explicitly first. Do not change silently |
| B19 | **Database and role names**: database `auzring`, roles `auzring_owner`, `auzring_app`, `auzring_admin`; connection strings in secrets files | `deploy/postgres/init/01-roles.sh`, compose, `scripts/init-secrets.sh`, **migrations `00001`–`00008` (`GRANT … TO auzring_app` guarded by `IF EXISTS`)**, CI | Existing databases keep the old names (init scripts run once). A new role name on a new database would make the guarded `GRANT`s in the (immutable, already applied elsewhere) migrations **silently skip**, leaving the runtime role without permissions. Editing applied migrations is not acceptable | **Keep.** Names are internal to the database container |
| B20 | **Backup/archive format identifiers** (the age archive header, manifest strings; the PostgreSQL `application_name` values `auzring-backup` and `auzring-restore`) | `internal/server/backup` | Restores of existing backups depend on the format strings; `application_name` is only a label in `pg_stat_activity` | **Keep the format** (the error messages that say "Auzring backup" and "auzring-server" are group A/B16) |
| B21 | **Log and file names**: `agent.log`, `rollback-check.log` (no brand in the file name; the folder is B2); `/var/lib/auzring/content` (server content volume path); `auzring-msi.log` (a name given on the example command line) | Dockerfile, compose, runbook | The content path is mounted by compose; changing it needs a volume migration | **Keep paths.** Example file names in docs follow the new name |
| B22 | **HTTP headers**: no brand-specific request or response header exists | — | — | Nothing to do (`X-CSRF-Token`, `X-Forwarded-For` are generic) |
| B23 | **MSI UpgradeCode** `A4744534-8AD1-4F57-B3FC-159B732BAD2A` | `Package.wxs` | **This GUID must not change**: a different UpgradeCode makes the new MSI a different product, so it would install beside the old one instead of upgrading it | **Keep the GUID.** The product *name* and manufacturer text are group A and are renamed (upgrades still work) |
| B24 | **MSI output file name** `auzring-agent-<version>-x64.msi` | `installer/windows/build.ps1`, docs, CI | None for installed machines; customers' deployment scripts reference the file name | **Rename** to `renovatio-agent-…`, with the release notes saying so |
| B25 | **Release artifact file names** (`auzring-agent_<v>_windows_amd64.exe`, `auzring-server_…`, SBOMs, `SHA256SUMS` entries) and **Authenticode subject** (chosen later with the certificate, O5) | `scripts/build-release.sh`, release workflow, docs | None yet: nothing has been released. The Authenticode subject will come from the certificate | **Rename**; decide the certificate subject with O5 |

---

## 3. Items in group B that I would change **now** (no installed base) versus never

* **Change in stage 2 (after your OK):** B16, B17 (image name), B24, B25, and the group-A items.
* **Keep, permanently or until a tested migration exists:** B1, B2, B3, B5, B7, B8, B9, B10, B11, B13, B14, B18, B19, B20, B21, B23. These make an installed agent or a running stack unrecognisable to itself if renamed; a customer's first sight of the product name is never one of these.
* **Your call:** B6 (version resource, my suggestion above), B12 and B15 (invisible, free to change), and the transition options for B10 and B16.

## 4. Group C: items I am unsure about

| # | Item | Why unsure | My lean |
|---|---|---|---|
| C1 | **Go module path and GitHub repository** `github.com/auzring1/auzring` (477 import lines, `go.mod`, `buf` and `sqlc` configs, GHCR path, the cosign identity in `docs/VERIFYING_RELEASES.md`, `-ldflags -X …` strings) | It is a code-hosting name rather than a product string, and the repository is private. Renaming it is mechanical, but it is tied to the GitHub organisation/repository you own (`auzring1`), which only you can rename; GitHub redirects the old URL | Rename the repository and module **in a separate commit after** the product rename, if you rename the repo at all. Until then it keeps compiling unchanged |
| C2 | **Domain names in examples**: `auzring.example.com`, `auzring.lab`, `auzring.lan` | Example hostnames in docs, `.env.example`, MSI messages and tests. They are placeholders, but they are user-visible in docs and installer error messages | Rename to `renovatio.example.com` / `renovatio.lab` in text; tests may use any hostname |
| C3 | **Dev-only paths**: `/var/lib/auzring-agent` (Linux dev agent data), `AUZ_DEV_PROGRAMFILES` | Only used by developers and CI | Follow B10 for the variable; rename the Linux dev path with the rest of the Linux build |
| C4 | **Migration file comments** (`-- Runs as the schema owner (auzring_owner)…`) | Editing a goose migration changes its checksum if the tool compares it | Do not edit any migration file, comments included |
| C5 | **The name `Renovatio` in the existing code**: I found no existing use. Please confirm the exact spellings you want: product "Renovatio", agent "Renovatio Agent", manufacturer/company "Renovatio" (or a different company name for the MSI manufacturer field and the certificate organisation?) | Needed for the single source of truth (name, short name, company, agent name) | Three constants: `Name` ("Renovatio"), `AgentName` ("Renovatio Agent"), `Company` |
| C6 | **Placeholder contacts and security contact** in `SECURITY.md` §10 and elsewhere | You asked earlier to keep placeholder contacts | Left as they are unless you give real ones |
| C7 | **Historical text**: `DECISIONS.md`, the PHASE demo files and this plan describe the product as it was called when written | Renaming history is arguable | Rename the product name in all of them (you asked for the demo files); keep decision numbers and dates |

---

## 5. What I need from you

1. Approve (or change) the **recommendations in section 3**, in particular: keep the Windows service name, folders, scheduled task, key prefix and the wire/crypto identifiers (B1–B3, B5, B7–B9); keep `AUZ_`, `AURZ1`, `azt_` (B10, B11, B13); keep the compose project name and database/role names (B18, B19).
2. Rename the server binary, vendor tools, image, MSI file name and release artifact names (B16, B17, B24, B25)? Do you want a one-release compatibility alias for `/auzring-server`?
3. Do you want the **Windows version resource** so the agent shows as "Renovatio Agent" in Task Manager and file properties (B6)?
4. Confirm the spellings and the company name (C5), and whether the GitHub repository and Go module path should be renamed later (C1).
5. Should the example hostnames change (C2)?

Stage 2 will not start until you answer. When it does, I will work on a branch (`rename-renovatio`, already created from `phase-6`), not on `main`.
