# Runbook

Status: covers Phase 1 (server, web console, agent enrollment and connectivity). Later phases extend it.

## 1. Requirements

| Component | Requirement |
|---|---|
| Server host | Linux with Docker Engine 24+ and Compose v2. 2 vCPU, 4 GB RAM and 40 GB disk are enough for Phase 1 and ~2k devices. Sizing for 10k devices comes from the Phase 6 load test. |
| DNS | One name for the server, e.g. `auzring.example.com`. Browsers use `https://<name>`, agents use `<name>:8443`. |
| Inbound firewall to the server | 443/tcp (console). 80/tcp only for Let's Encrypt HTTP challenges. 8443/tcp from every managed endpoint (agent gateway). |
| Outbound from endpoints | 8443/tcp to the server. To install **winget-catalog** packages, also HTTPS to the vendors' download hosts (the URLs inside each manifest). Custom (uploaded) packages need only the server. |
| Outbound from the server | HTTPS to `raw.githubusercontent.com` and `api.github.com` for **Import from winget**. Set `AUZ_WINGET_SOURCE=off` to disable it (custom uploads still work). |
| Endpoints | Windows 10 1809+, Windows 11, Server 2019+, x64. |

**TLS-inspecting proxies must exempt the gateway host:port.** Agents use mutual TLS and pin the server's own CA, so interception breaks the connection by design. That is the protection working, not a bug.

## 2. Install the server

```bash
git clone <repo> auzring && cd auzring
./scripts/init-secrets.sh                 # creates deploy/secrets/ (refuses to overwrite)
cp deploy/.env.example deploy/.env        # then edit AUZ_HOSTNAME and AUZ_CADDY_TLS
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml logs server | grep -A2 "setup token"
```

**What `init-secrets.sh` creates** (all random). The directory is 0700:

| Secret | Purpose |
|---|---|
| `master_key` | 32-byte key-encryption key (KEK). It encrypts the issuing-CA key, the job-signing key, the gateway key and every TOTP secret. **Back it up securely and separately from database backups.** Without it, those keys cannot be decrypted. |
| `postgres_owner_password` | Schema owner. Used only for migrations at server start. |
| `postgres_app_password` | Least-privilege runtime role `auzring_app`. It has DML only and is insert-only on `audit_log`. |
| `database_url`, `migrate_database_url` | Connection strings the server reads as Docker secrets. |

**Browser TLS modes** (`AUZ_CADDY_TLS` in `deploy/.env`):

- `internal`: Caddy's own CA, for LAN-only installs. Export the root with `docker compose -f deploy/docker-compose.yml cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt` and distribute it to admin workstations, for example via GPO under Trusted Root Certification Authorities.
- An email address: a public Let's Encrypt certificate. Ports 80 and 443 must be reachable from the internet.
- Your own certificate: mount it into the Caddy container and replace the `tls` line in `deploy/Caddyfile` with `tls /path/cert.pem /path/key.pem`.

These modes only affect the console. The agent channel always uses the server's internal CA, which agents pin.

## 3. First-run setup
1. Open `https://<AUZ_HOSTNAME>`. You are sent to **Set up Auzring**.
2. Enter the one-time **setup token** from the server log. It changes on every restart until setup completes.
3. Enter the organization name, your name, and a password: at least 12 characters, and breached or common passwords are rejected.
4. Enter a **CA root passphrase** (16+ characters). The server never stores it. You will need it for rare CA operations from Phase 5 on (rotating the job-signing key, revoking a signing key). **Store it offline, for example in a safe or a password manager vault that is separate from your password.**
5. Scan the QR code with an authenticator app and enter the 6-digit code. MFA is mandatory.
6. Save the 10 recovery codes. Each works once if you lose your authenticator.

## 4. Enroll devices
1. In the console, go to **Enrollment**, then **New token**. Give it a name, a maximum number of uses and a lifetime. Optionally turn on **Require administrator approval**.
2. Copy the install command. It is shown only once.
3. On the endpoint, in an **elevated** PowerShell or Command Prompt:
   ```
   .\auzring-agent.exe install --server auzring.example.com:8443 --token AURZ1.eyJ...
   ```
   - `--server` is optional. It defaults to the address inside the token; set it when agents must use a different name or IP. That name or IP must be in the gateway certificate: add it with `AUZ_GATEWAY_SANS`.
   - `--allowed-jobs inventory,wu_scan` is optional. It sets a local ceiling that the server can never raise (enforced from Phase 3, when jobs exist).
4. The command copies the agent to `C:\Program Files\Auzring\Agent\slot-a\`, locks down `C:\ProgramData\Auzring\`, registers and starts the **AuzringAgent** service (LocalSystem, automatic start, restart on failure), and waits for enrollment.
5. Check the agent at any time with `"C:\Program Files\Auzring\Agent\slot-a\auzring-agent.exe" status`.

To **remove** the agent, run `auzring-agent.exe uninstall`. It stops and deletes the service, deletes the device key from CNG, and removes the files. If you run it from the installed copy, the program files are removed at the next reboot. **Also revoke the device in the console.** Phase 1 does not notify the server on uninstall.

## 5. Day-2 operations

| Task | How |
|---|---|
| Revoke a device | Console, then Devices, then the device, then **Revoke**. The live connection is cut immediately and the certificate can never connect again. To manage the machine again, uninstall and reinstall the agent with a new token. |
| Approve or reject a pending device | Console, then Devices, filter **Pending**, then **Approve** or **Reject**. A re-enrollment of known hardware always needs approval, and approving it revokes the old identity. |
| Locked-out admin (lost authenticator, no recovery codes) | `docker compose -f deploy/docker-compose.yml exec server /auzring-server admin reset-mfa --email you@example.com`. The user enrolls a new authenticator at next sign-in. The action is audited. |
| Clear a login lockout (10 failures lock for 15 min) | `... exec server /auzring-server admin unlock --email you@example.com` |
| Verify audit-log integrity | `... exec server /auzring-server admin verify-audit` |
| Upgrade | Back up first (§6). Then `git pull` and `docker compose ... up -d --build`. Migrations run automatically under an advisory lock and are forward-only. |
| See what is installed | Console, **Software**: one row per product with device and version counts. Open a product to see which versions exist and which devices have them; **Devices → device → Software** lists one device (with change history). |
| Find devices by software or hardware | Console, **Groups → New group**. Example: *All of* [Form factor is one of laptop/notebook/portable] [Has software "chrome" with version < 130]. **Preview matches** shows the devices; **Save group** keeps it. Membership is recomputed each time it is opened. |
| Export | **Export CSV** on the Software and Group pages (needs the `inventory:export` permission: admin and operator roles). Each export is recorded in the audit log as `inventory.export`. Cells starting with `= + - @` are prefixed with `'` so spreadsheets do not run them. |
| Gateway certificate | Renewed automatically 30 days before expiry, and re-issued when `AUZ_GATEWAY_SANS` or the hostname changes. Agents trust the CA, not the leaf, so nothing is needed on endpoints. |
| Device certificates | 90-day lifetime. Agents renew automatically when 1/3 of the lifetime remains, and up to 180 days after expiry (for laptops that were offline). |

### 5a. Software deployment (Phase 3)

| Task | How |
|---|---|
| Import a package | Console, **Catalog → Import from winget**, enter the exact winget identifier (for example `7zip.7zip`) and optionally a version. Only metadata is stored. The package page lists each installer and why any is "not deployable" (MSIX, an `exe` with no silent switch, unknown architecture). |
| Upload your own installer | **Catalog → Upload custom installer.** Choose the file, set type, architecture, scope, silent arguments and how to detect success (an MSI product code, an Uninstall registry key name, or a file path such as `%ProgramFiles%\Acme\tool.exe`). The file is stored on the `content` volume and served to devices over the agent channel. Back that volume up with the database. |
| Deploy | **Deployments → New deployment** (or **Deploy** on a package page). Choose action (install, update, uninstall), scope (machine-wide or per user), groups and/or devices, optional start time, expiry (default 72 h) and an optional maintenance window evaluated on each device in its local time. Offline devices receive the job when they reconnect and run it inside the window before it expires. |
| Watch progress | The deployment page updates live. Open a job for its timeline and the installer log tail. **Retry** creates a new attempt for a failed, expired, rejected or cancelled job; **Cancel deployment** stops everything unfinished (a job already running on a device is cancelled when the device is reachable). |
| Unverified packages | Winget packages that have not passed the VM matrix ask for a confirmation that is recorded in the audit log. Custom uploads do not. |
| Self-updating apps (Chrome, Edge, Firefox, Zoom, …) | Marked `self-updating`. Update deployments are refused and per-user in-place updates skipped, so Auzring does not fight the vendor's updater. An administrator can set **Self-updating behaviour: enforce** on the package page. |
| Per-user installs | **Settings** sets the organization default (report only, update in place, convert to machine, remove); a package can override it. The policy applies when a machine-wide deployment finds per-user copies. Per-user changes run in the user's own session, at their next logon if they are signed out ("waiting for user logon"). |
| Update and remove old versions | An **Update** removes older copies that the new installer does not replace by itself (for example an EXE install followed by an MSI update) **before** installing, as `Remove old …` jobs you can see on the Jobs tab. A removal that fails does not stop the update. |
| From a device: refresh, update, uninstall | Device page: **↻ Refresh** asks the online device to report hardware, software and users now. **Missing updates** lists installed programs that the catalog has a newer version of (**Deploy Updates**). **Software** has checkboxes, **Deploy Updates**, **Uninstall Software** and a ⋮ menu per row. System components are not removable from here. |
| Delete a device | Revoke it first. On the revoked device's page click **Delete device**, or tick several in **Devices → Revoked** and **Delete selected**. Everything about the device is removed (the audit log keeps the record). |
| Pin, exclude, change silent switches | Package page → **Overrides** (administrators only, audited). Pins: empty (newest), `latest`, `= 24.08`, `< 25`. |
| Limit what an endpoint will run | Install with `--allowed-jobs inventory,software_install,software_update,software_uninstall` (or fewer). The server cannot raise this later. |
| Where do installers come from? | Winget packages: the device downloads straight from the vendor and checks the SHA-256 from the manifest. Custom packages: from your server. The hash is signed into every job either way. |

Configuration (all optional, set in the server's environment):

| Variable | Meaning |
|---|---|
| `AUZ_CONTENT_DIR` | Directory for uploaded installers (compose: the `content` volume at `/var/lib/auzring/content`). Empty disables custom packages. |
| `AUZ_WINGET_SOURCE` | `github` (default) or `off`. |
| `AUZ_GITHUB_TOKEN` / `AUZ_GITHUB_TOKEN_FILE` | Optional GitHub token that raises the API rate limit for imports. Use the `_FILE` form with a Docker secret in production. |

### 5b. Windows updates (Phase 4)

| Task | How |
|---|---|
| See what devices are missing | **Windows updates** lists every update any device reported (devices scan every 24 h and when you press **Scan now** on the device's **Windows updates** tab). Filter by classification, severity, decision; "only missing" hides updates nobody needs. Open an update to see which devices are missing it. |
| Approve, decline, hide | Tick updates, then **Approve**, **Decline**, **Hide on devices** or **Reset to pending**. Nothing installs automatically until it is approved (by you or a rule) **and** a ring covers the device. |
| Roll out in stages | **Update policy → Rings → Add ring.** Order 1 is the pilot (pick a small group), then broader rings. *Delay* waits after approval, *Soak* is how long the next ring waits after this one started, *Success needed* is the percentage of reporting devices that must install successfully. A ring may have a maintenance window and a restart policy. Devices in no ring are not updated automatically. |
| Auto-approve | **Update policy → Auto-approval rules**: classification, severity, include drivers, days after release. Your own decisions always win over rules. |
| A rollout stopped | **Update policy → Held updates** lists updates that failed a ring's threshold. Look at the failures on the update's device list, then **Release** (continue) or decline the update. |
| Install now on one device | Device → **Windows updates** → tick updates → **Install selected** (ignores approval and rings; audited). **Restart now…** appears when the device is waiting for a restart (countdown 1–1440 min, visible to signed-in users). |
| Source (WU / Microsoft Update / drivers) | **Update policy → Update source** (administrators). Devices get it as a scan job and rescan. |
| Conflicts | Devices managed by WSUS, update deferral policies or with automatic updates disabled show a banner on the device and appear under **Update policy**. Auzring does not change these policies. |
| Limit what an endpoint will do | Add `wu_scan,wu_install,wu_hide,reboot` to (or leave them out of) `--allowed-jobs` at install time. |

## 6. Backup and restore (manual until Phase 5 adds `auzring-server backup`)
```bash
# Back up: database + secrets. Store the two separately, both encrypted at rest.
docker compose -f deploy/docker-compose.yml exec -T postgres pg_dump -U auzring_owner -Fc auzring > auzring-$(date +%F).dump
tar czf auzring-secrets-$(date +%F).tgz -C deploy secrets
# Restore onto a fresh install created with the SAME secrets directory:
docker compose -f deploy/docker-compose.yml exec -T postgres pg_restore -U auzring_owner -d auzring --clean --if-exists < auzring-YYYY-MM-DD.dump
```

## 7. Incident response
- **Suspected server compromise:**
  1. Isolate the host and preserve logs and the database.
  2. Rotate the KEK and every database password.
  3. Review the audit log, after checking it with `verify-audit`.
  4. From Phase 5: revoke the job-signing key with a root-signed revocation, which agents enforce on reconnect.
- **Suspected endpoint compromise:** revoke the device, rebuild the machine, then enroll it with a new token.
- **Leaked enrollment token:** revoke it under Enrollment, then review **Devices**, filtered to **Pending** and recent enrollments.

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| `install` reports "server rejected the enrollment token" | The token expired, was revoked or is used up. Create a new one. |
| Agent status `error`: "chain does not match the pinned root" | The agent reached something that is not your server (wrong DNS, or a TLS-inspecting proxy). Exempt the gateway from inspection. |
| Agent stuck in `connecting` | Firewall to port 8443. Check that the name the agent dials is in the gateway certificate (`AUZ_GATEWAY_SANS`). |
| Agent `pending_approval` | Approve the device in the console. The agent checks every ~60 s. |
| Device shows no software, or "not reported yet" | The agent reports shortly after connecting (the first scan is a full snapshot). Check `agent.log` for `full software inventory sent`. If the server log shows `invalid_inventory` in the audit log (`gateway.protocol_violation`), the agent sent data the server rejects; the agent version and details are in the audit entry. |
| Software list looks stale or has "inventory truncated" | Changes are detected within ~30 s of an install/uninstall. A truncated notice means the device reported more than 25,000 items. After restoring a database backup, agents resend their full inventory automatically on reconnect (their revisions no longer match). |
| A group preview says the filter could not be evaluated | The filter was too expensive for the 10 s limit. Narrow it (add a device condition before a broad software title match). |
| Agent `rejected` | The device was revoked or rejected. Uninstall, then reinstall with a new token. |
| Logs | Agent: `C:\ProgramData\Auzring\logs\agent.log` (JSON, rotated at 5 MB × 3). Server: `docker compose ... logs server` (JSON; never contains request bodies, cookies or tokens). |
| A job stays `sent` and never starts | The device is offline, or its agent is older than Phase 3 (reinstall the agent). Jobs are re-offered every time the device connects until it acknowledges. |
| A job shows `rejected` | The agent refused it: a verification failure (see the audit log for a `security event`) or the local `--allowed-jobs` ceiling does not include the job type. |
| A job `failed` with "signature does not match the pinned signer" or "invalid digital signature" | The installer's Authenticode signature is absent, broken or from a different publisher than pinned. Do not deploy it until you have confirmed why; fix or remove the signer pin only if you trust the file. |
| A job `failed` with "hash" in the reason | The vendor changed the file after the manifest was imported. Re-import the package version (or upload the file yourself). |
| A job `failed_detection` | The installer exited successfully but the detection rule does not see the program. Add or correct a detection rule under the package's Overrides. |
| A per-user job says "waiting for user logon" | The target user has no session. It runs at their next logon until the deployment expires. |
| Upload fails with 413 or a connection reset | Uploads are limited to 2 GiB. Behind your own proxy, raise its body limit for `/api/v1/catalog/content`. |
| "Custom packages are disabled" | `AUZ_CONTENT_DIR` is not set on the server. |
| Console says "Cross-origin request rejected" | `AUZ_PUBLIC_URL` (derived from `AUZ_HOSTNAME` and `AUZ_PUBLIC_PORT_SUFFIX`) must match exactly the URL in the browser's address bar. |
