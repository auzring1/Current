# Runbook

Status: covers Phase 1 (server, web console, agent enrollment and connectivity); later phases extend it, and section 9 is for the release manager.

## 1. Requirements

| Component | Requirement |
|---|---|
| Server host | Linux with Docker Engine 24+ and Compose v2. 2 vCPU, 4 GB RAM and 40 GB disk are enough for Phase 1 and ~2k devices. Sizing for 10k devices comes from the Phase 6 load test. |
| DNS | One name for the server, e.g. `renovatio.example.com`. Browsers use `https://<name>`, agents use `<name>:8443`. |
| Inbound firewall to the server | 443/tcp (console). 80/tcp only for Let's Encrypt HTTP challenges. 8443/tcp from every managed endpoint (agent gateway). |
| Outbound from endpoints | 8443/tcp to the server. To install **winget-catalog** packages, also HTTPS to the vendors' download hosts (the URLs inside each manifest). Custom (uploaded) packages need only the server. |
| Outbound from the server | HTTPS to `raw.githubusercontent.com` and `api.github.com` for **Import from winget**, and to `cdn.winget.microsoft.com` once a day for the winget index (3.7 MB; see *Software updates without a catalog*, 5a). Set `RENOVATIO_WINGET_SOURCE=off` to disable both (custom uploads still work). |
| Endpoints | Windows 10 1809+, Windows 11, Server 2019+, x64. |

**TLS-inspecting proxies must exempt the gateway host:port.** Agents use mutual TLS and pin the server's own CA, so interception breaks the connection by design. That is the protection working, not a bug.

## 2. Install the server

```bash
git clone <repo> renovatio && cd renovatio
./scripts/init-secrets.sh                 # creates deploy/secrets/ (refuses to overwrite)
cp deploy/.env.example deploy/.env        # then edit RENOVATIO_HOSTNAME and RENOVATIO_CADDY_TLS
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml logs server | grep -A2 "setup token"
```

**What `init-secrets.sh` creates** (all random). The directory is 0700:

| Secret | Purpose |
|---|---|
| `master_key` | 32-byte key-encryption key (KEK). It encrypts the issuing-CA key, the job-signing key, the gateway key and every TOTP secret. **Back it up securely and separately from database backups.** Without it, those keys cannot be decrypted. |
| `postgres_owner_password` | Schema owner. Used only by the one-shot `maintenance` service (migrations, backup, restore); the running server never holds it. |
| `postgres_app_password` | Least-privilege runtime role `renovatio_app`. It has DML only and is insert-only on `audit_log`. |
| `database_url`, `migrate_database_url` | Connection strings the server reads as Docker secrets. |

**Browser TLS modes** (`RENOVATIO_CADDY_TLS` in `deploy/.env`):

- `internal`: Caddy's own CA, for LAN-only installs. Export the root with `docker compose -f deploy/docker-compose.yml cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt` and distribute it to admin workstations, for example via GPO under Trusted Root Certification Authorities.
- An email address: a public Let's Encrypt certificate. Ports 80 and 443 must be reachable from the internet.
- Your own certificate: mount it into the Caddy container and replace the `tls` line in `deploy/Caddyfile` with `tls /path/cert.pem /path/key.pem`.

These modes only affect the console. The agent channel always uses the server's internal CA, which agents pin.

### 2.1 Behind your own reverse proxy (for example the Synology DSM reverse proxy)

Use this when another proxy already owns ports 80 and 443 and does the browser TLS. The console then goes browser, your proxy (HTTPS), Caddy (plain HTTP, on the same host), the server. **Agents do not use it**: they connect to the NAS on port 8443 directly, because the gateway checks each agent's client certificate itself (mTLS) and an HTTP proxy would break that. Point the agents' name (`SERVER=renovatio.example.org:8443`) at the NAS and allow port 8443 in its firewall.

1. In `deploy/.env` (the commented block in `.env.example` has the same lines):
   ```
   RENOVATIO_HOSTNAME=renovatio.example.org
   RENOVATIO_CADDYFILE=./Caddyfile.behind-proxy
   RENOVATIO_HTTP_PORT=127.0.0.1:8080
   RENOVATIO_HTTPS_PORT=8444
   ```
   `RENOVATIO_HTTP_PORT` with `127.0.0.1:` keeps plain HTTP reachable only from the NAS itself. `RENOVATIO_HTTPS_PORT` is published but unused in this mode; it only has to differ from the port your proxy uses. Leave `RENOVATIO_PUBLIC_PORT_SUFFIX` empty when people browse on the normal HTTPS port. `RENOVATIO_HOSTNAME` must be the name people type, because the console checks the origin of every change request against it.
2. In DSM (Control Panel, Login Portal, Advanced, Reverse Proxy, Create): source HTTPS, your host name, port 443; destination **HTTP**, `localhost`, port 8080. Assign a certificate for that name (Control Panel, Security, Certificate). DSM adds `X-Forwarded-For`; keep any option that forwards the original Host and client address.
3. Start the stack as in section 2. Then sign in once and open **Audit log**: the entry should show **your workstation's address**. If it shows an address inside `172.31.250.0/24` or the NAS's own address, the server did not believe the forwarded header; see below.
4. Test an installer upload (**Catalog, Upload custom installer**) and watch the Devices page update by itself. A `413` means DSM's request-size limit is lower than the 2 GiB the console allows; raise it for this proxy rule.

**Which address does the server believe?** Caddy and the server believe `X-Forwarded-For` only from the addresses in `RENOVATIO_UPSTREAM_PROXIES` (default: the Docker frontend network, `172.31.250.0/24`). With DSM forwarding to `localhost:8080`, Docker presents the connection as coming from that network, so the default is right. If the audit log shows another address (for example when DSM forwards to the NAS's LAN address), add that address: `RENOVATIO_UPSTREAM_PROXIES=172.31.250.0/24 192.168.1.50/32` (space-separated), then `docker compose ... up -d`. Anyone else's `X-Forwarded-For` is ignored, so a browser cannot choose its own address in the audit log.

**Do not turn on the console IP allow-list (Settings, Security) until step 3 shows the right address.** Until then every request looks like it comes from one address, and the allow-list would admit or lock out everyone together (section 5k lists the way back in).

Not verified on a Synology: the Caddy part was run with the real Caddy binary (a trusted caller's header is kept and extended, an untrusted caller's header is replaced); DSM itself and Docker on DSM were not available.

## 3. First-run setup
1. Open `https://<RENOVATIO_HOSTNAME>`. You are sent to **Set up Renovatio**.
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
   .\renovatio-agent.exe install --server renovatio.example.com:8443 --token RNV1.eyJ...
   ```
   - `--server` is optional. It defaults to the address inside the token; set it when agents must use a different name or IP. That name or IP must be in the gateway certificate: add it with `RENOVATIO_GATEWAY_SANS`.
   - `--allowed-jobs inventory,wu_scan` is optional. It sets a local ceiling that the server can never raise (enforced from Phase 3, when jobs exist).
4. The command copies the agent to `C:\Program Files\Renovatio\Agent\slot-a\`, locks down `C:\ProgramData\Renovatio\`, registers and starts the **RenovatioAgent** service (LocalSystem, automatic start, restart on failure), and waits for enrollment.
5. Check the agent at any time with `"C:\Program Files\Renovatio\Agent\slot-a\renovatio-agent.exe" status`.

**Large rollouts.** The server limits enrollment attempts to 10 per minute per source address and 60 per minute per token, which protects tokens from guessing. Machines behind one NAT address therefore enroll at about 10 per minute, and a rollout of 1,000 from one site takes about 100 minutes (agents retry on their own). If you roll out many machines at once, raise the limits for the duration with `RENOVATIO_ENROLL_RATE_PER_IP` and `RENOVATIO_ENROLL_RATE_PER_TOKEN` (attempts per minute) and restore them afterwards. At most 8 enrollments are processed at the same time; in the load test the server enrolled about 70 devices per second at most (see [LOADTEST.md](LOADTEST.md)). Servers that will hold thousands of connections also need a raised open-file limit; LOADTEST.md lists the settings.

To **remove** the agent, run `renovatio-agent.exe uninstall` (if it was installed from the MSI, uninstall the MSI instead; see below). It stops and deletes the service, deletes the device key from CNG, and removes the files. If you run it from the installed copy, the program files are removed at the next reboot. **Also revoke the device in the console.** Phase 1 does not notify the server on uninstall.

### Install with the MSI (GPO, Intune, RMM)

For fleets, use the MSI instead of copying the exe around. It is a thin wrapper around the commands above (decision O6/D67): it carries `renovatio-agent.exe`, and a SYSTEM-context step runs `renovatio-agent.exe install ...` (service, slot-a, enrollment). Build it with `installer/windows/build.ps1` (see `installer/windows/README.md`); the release pipeline signs it. Per-machine, x64 only, Windows 10 1809+ / Server 2019+, must run elevated (or as SYSTEM, which is what GPO, Intune and RMM agents do).

**Public properties** (anything else on the command line is ignored by the agent):

| Property | Required | Meaning |
|---|---|---|
| `SERVER` | first install | Gateway `host:port`, e.g. `renovatio.example.com:8443`. Letters, digits and `. - _ :` (IPv6 in `[..]`). |
| `TOKEN` | first install | The enrollment string (`RNV1....`). Letters, digits and `. - _`. Treated as a secret. |
| `ALLOWEDJOBS` | no | Comma list for the local job ceiling, e.g. `inventory,wu_scan`. Lower-case letters, digits, `_`, `,`. |

Values with spaces, quotes or shell characters are refused by the MSI (and again by the agent). Nothing is run through `cmd.exe` or PowerShell.

**Silent install (copy and paste):**
```
msiexec /i renovatio-agent-1.0.0-x64.msi /qn SERVER=renovatio.example.com:8443 TOKEN=RNV1.eyJ... ALLOWEDJOBS=inventory,wu_scan /l*v C:\Windows\Temp\renovatio-msi.log
```
`/qn` is fully silent, `/qb` shows only the progress bar. The MSI does not request a restart. Because `TOKEN` is declared a hidden property, Windows Installer writes it as `***` in verbose logs and the custom action receives it only as CustomActionData and runs the agent exe directly. **The token is still on the `msiexec` command line**, so it is visible in the process list to administrators while the install runs and in whatever logs your deployment tool keeps of the command (see the Intune and RMM notes).

**Upgrades.** Installing a newer MSI over an enrolled machine needs no properties and no token: the old package's uninstall step is skipped during a major upgrade and `install --if-not-installed` exits 0 when the service and `config.json` exist. The device identity, key and data stay. Installing the MSI on a machine where the agent is already installed (for example by hand) also does not re-enroll it; to move a device to another server, uninstall first. The MSI upgrade does **not** replace the binary in `slot-a`/`slot-b`; that is the agent's own update mechanism (ARCHITECTURE section 10).

**Group Policy.** GPO software installation (Computer Configuration, Software Settings, Software installation, "Assigned") cannot pass properties. The two workable options:
1. *Startup script (recommended).* A computer startup script runs as SYSTEM and can use the command above. Keep the MSI on a share that Domain Computers can read. Make the script skip machines that are already enrolled, so it can run on every boot:
   ```
   if not exist "C:\Program Files\Renovatio\Agent\slot-a\renovatio-agent.exe" msiexec /i "\\fs01\software\renovatio-agent.msi" /qn SERVER=renovatio.example.com:8443 TOKEN=RNV1.eyJ... /l*v "%windir%\Temp\renovatio-msi.log"
   ```
2. *Transform (.mst).* Create a transform that adds `SERVER` and `TOKEN` rows to the `Property` table (Orca, or the Windows SDK transform tools), put it next to the MSI and add it on the Modifications tab of the GPO package. Be aware that the token is then stored in the transform.
**SYSVOL and script shares are readable by every authenticated domain user, so anyone in the domain can read a token placed in a GPO script or transform.** Use the mitigations below, and prefer a share whose ACL allows only the computer accounts (and administrators) to read.

**Intune (Win32 app).** Wrap the MSI with the Win32 Content Prep Tool (`IntuneWinAppUtil.exe`) and set:
- Install command: `msiexec /i renovatio-agent-1.0.0-x64.msi /qn SERVER=renovatio.example.com:8443 TOKEN=RNV1.eyJ... /l*v "%ProgramData%\Renovatio-msi-install.log"`
- Uninstall command: `msiexec /x renovatio-agent-1.0.0-x64.msi /qn` (runs from the content folder; the ProductCode changes with every build, so do not hard-code it).
- Install behavior: System. Device restart behavior: No specific action.
- Detection rule: file exists `C:\Program Files\Renovatio\Agent\slot-a\renovatio-agent.exe` (or "Service" via a custom script rule: `Get-Service RenovatioAgent`).
- Return codes: 0 success; 1603 failed (see below); 3010 is not used.
Intune keeps the install command line in the Intune Management Extension log on the device (`C:\ProgramData\Microsoft\IntuneManagementExtension\Logs`) and in the app definition, so the token is readable there by local administrators and by Intune admins who can read the app. That is the reason for the short-lived multi-use token below.

**Generic RMM / script.** Run as SYSTEM, wait for the exit code, and treat anything other than 0 as failure:
```powershell
$p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList '/i C:\Temp\renovatio-agent.msi /qn SERVER=renovatio.example.com:8443 TOKEN=RNV1.eyJ... /l*v C:\Windows\Temp\renovatio-msi.log'
if ($p.ExitCode -ne 0) { Get-Content C:\ProgramData\Renovatio\logs\agent.log -Tail 40 -ErrorAction SilentlyContinue; exit $p.ExitCode }
```
Do not echo the command into your RMM's job output.

**Exit codes and where to look.**

| msiexec exit | Meaning | What to do |
|---|---|---|
| 0 | Installed (or enrolled and waiting for approval), or nothing to do on an enrolled machine | |
| 1603 | Fatal error: a launch condition failed (`SERVER is required...`, `TOKEN is not a Renovatio enrollment string...`, `... may only contain...`, unsupported Windows, not elevated), an older MSI than the installed one was run (downgrade), or the install step failed (the agent or the server rejected the token or `ALLOWEDJOBS`, the gateway is unreachable or does not trust the pin). The MSI rolls back: service, data directory and program files are removed. | Repeat with `/l*v msi.log` and search it for `LaunchCondition` and `Return value 3`. (The Windows version check reads the build number from the registry, `CurrentBuildNumber`, because Windows Installer can report Windows 8.1 on Windows 10/11; the first Phase 5 MSI wrongly rejected a Windows 11 machine with "requires Windows 10 version 1809".) The MSI log never contains the agent's command line or output (the token is on it), so for an install-step failure run the release's `renovatio-agent.exe` by hand (the same file the MSI carries) from an elevated prompt: `renovatio-agent.exe install --server ... --token ...` prints the reason, and `renovatio-agent.exe uninstall` cleans up. If enrollment got as far as the service, `C:\ProgramData\Renovatio\logs\agent.log` has the details until the rollback deletes it. |
| 1618 | Another installation is running | Retry later |
| 3010 | Not used | |
| 1605 | `/x` of a product that is not installed | Nothing to remove |

Uninstall: `msiexec /x renovatio-agent-1.0.0-x64.msi /qn` (or `/x {ProductCode}`). It stops and deletes the service, deletes the device key and `C:\ProgramData\Renovatio\`, `C:\Program Files\Renovatio\` and the staged `C:\Program Files\RenovatioSetup\`. A failed uninstall step does not block removal of the MSI entry, so check that the service is gone (`Get-Service RenovatioAgent`). As always, also revoke the device in the console.

**Tokens for mass deployment.** A token has a maximum number of uses, an expiry, and optionally requires approval; every successful enrollment consumes one use. A single-use token therefore works for one machine only, and a token that enrolls and is then rolled back is spent. For a rollout:
- create **one multi-use token per rollout wave** (max uses a little above the number of machines, for example 120 for 100 machines),
- give it a **short lifetime** (hours to a few days, not weeks), and revoke it when the wave is done,
- turn on **Require administrator approval** and approve the devices that you recognize in the console (a device whose hardware ID matches an existing one needs approval regardless),
- do not reuse the token for later waves, do not put it in a repository, and treat anything that stores the command line (GPO script, transform, Intune app, RMM job history) as a place where the token can be read until it expires.
Devices that enroll with a leaked token before it is revoked appear as pending when approval is on, so a leak costs you an approval click, not a rogue managed device.

## 5. Day-2 operations

| Task | How |
|---|---|
| Revoke a device | Console, then Devices, then the device, then **Revoke**. The live connection is cut immediately and the certificate can never connect again. To manage the machine again, uninstall and reinstall the agent with a new token. |
| Approve or reject a pending device | Console, then Devices, filter **Pending**, then **Approve** or **Reject**. A re-enrollment of known hardware always needs approval, and approving it revokes the old identity. |
| Locked-out admin (lost authenticator, no recovery codes) | `docker compose -f deploy/docker-compose.yml exec server /renovatio-server admin reset-mfa --email you@example.com`. The user enrolls a new authenticator at next sign-in. The action is audited. |
| Clear a login lockout (10 failures lock for 15 min) | `... exec server /renovatio-server admin unlock --email you@example.com` |
| Verify audit-log integrity | `... exec server /renovatio-server admin verify-audit` |
| Upgrade | Back up first (§6). Then `git pull` and `docker compose ... up -d --build`. Migrations run automatically under an advisory lock and are forward-only. |
| See what is installed | Console, **Software**: one row per product with device and version counts. Open a product to see which versions exist and which devices have them; **Devices → device → Software** lists one device (with change history). |
| Find devices by software or hardware | Console, **Groups → New group**. Example: *All of* [Form factor is one of laptop/notebook/portable] [Has software "chrome" with version < 130]. **Preview matches** shows the devices; **Save group** keeps it. Membership is recomputed each time it is opened. |
| Export | **Export CSV** on the Software and Group pages (needs the `inventory:export` permission: admin and operator roles). Each export is recorded in the audit log as `inventory.export`. Cells starting with `= + - @` are prefixed with `'` so spreadsheets do not run them. |
| Gateway certificate | Renewed automatically 30 days before expiry, and re-issued when `RENOVATIO_GATEWAY_SANS` or the hostname changes. Agents trust the CA, not the leaf, so nothing is needed on endpoints. |
| Device certificates | 90-day lifetime. Agents renew automatically when 1/3 of the lifetime remains, and up to 180 days after expiry (for laptops that were offline). |

### 5a. Software deployment (Phase 3)

| Task | How |
|---|---|
| Import a package | Console, **Catalog → Import from winget**, enter the exact winget identifier (for example `7zip.7zip`) and optionally a version. Only metadata is stored. The package page lists each installer and why any is "not deployable" (MSIX, an `exe` with no silent switch, unknown architecture). |
| Upload your own installer | **Catalog → Upload custom installer.** Choose the file, set type, architecture, scope, silent arguments and how to detect success (an MSI product code, an Uninstall registry key name, or a file path such as `%ProgramFiles%\Acme\tool.exe`). The file is stored on the `content` volume and served to devices over the agent channel. Back that volume up with the database. |
| Deploy | **Deployments → New deployment** (or **Deploy** on a package page). Choose action (install, update, uninstall), scope (machine-wide or per user), groups and/or devices, optional start time, expiry (default 72 h) and an optional maintenance window evaluated on each device in its local time. Offline devices receive the job when they reconnect and run it inside the window before it expires. |
| Watch progress | The deployment page updates live. Open a job for its timeline and the installer log tail. **Retry** creates a new attempt for a failed, expired, rejected or cancelled job; **Cancel deployment** stops everything unfinished (a job already running on a device is cancelled when the device is reachable). |
| Unverified packages | Winget packages that have not passed the VM matrix ask for a confirmation that is recorded in the audit log. Custom uploads do not. |
| Self-updating apps (Chrome, Edge, Firefox, Zoom, …) | Marked `self-updating`. Update deployments are refused and per-user in-place updates skipped, so Renovatio does not fight the vendor's updater. An administrator can set **Self-updating behaviour: enforce** on the package page. |
| Per-user installs | **Settings** sets the organization default (report only, update in place, convert to machine, remove); a package can override it. The policy applies when a machine-wide deployment finds per-user copies. Per-user changes run in the user's own session, at their next logon if they are signed out ("waiting for user logon"). |
| Update and remove old versions | An **Update** removes older copies that the new installer does not replace by itself (for example an EXE install followed by an MSI update) **before** installing, as `Remove old …` jobs you can see on the Jobs tab. A removal that fails does not stop the update. |
| From a device: refresh, update, uninstall | Device page: **↻ Refresh** asks the online device to report hardware, software and users now. The **Software updates** tab lists installed programs that the catalog has a newer version of (**Deploy Updates**); **Updates → Software updates** in the sidebar shows the same across the whole fleet, per package, with a way to update every device that has an older copy. **Software** has checkboxes, **Deploy Updates**, **Uninstall Software** and a ⋮ menu per row. System components are not removable from here. |
| Delete a device | Revoke it first. On the revoked device's page click **Delete device**, or tick several in **Devices → Revoked** and **Delete selected**. Everything about the device is removed (the audit log keeps the record). |
| Pin, exclude, change silent switches | Package page → **Overrides** (administrators only, audited). Pins: empty (newest), `latest`, `= 24.08`, `< 25`. |
| Limit what an endpoint will run | Install with `--allowed-jobs inventory,software_install,software_update,software_uninstall` (or fewer). The server cannot raise this later. |
| Where do installers come from? | Winget packages: the device downloads straight from the vendor and checks the SHA-256 from the manifest. Custom packages: from your server. The hash is signed into every job either way. |

Configuration (all optional, set in the server's environment):

| Variable | Meaning |
|---|---|
| `RENOVATIO_CONTENT_DIR` | Directory for uploaded installers (compose: the `content` volume at `/var/lib/renovatio/content`). Empty disables custom packages. |
| `RENOVATIO_WINGET_SOURCE` | `github` (default) or `off`. `off` also stops the winget index download. |
| `RENOVATIO_WINGET_INDEX_URL` | Where the winget index is downloaded from (https only). Empty = Microsoft's winget CDN. For an internal mirror. |
| `RENOVATIO_RELEASE_PUBLIC_KEYS` | Extra vendor release public keys (hex, comma-separated) the server accepts agent release uploads for. Only for testing your own builds; agents trust just the keys compiled into them. |
| `RENOVATIO_LICENSE_PUBLIC_KEYS` | Extra vendor license public keys (hex, comma-separated). Only for testing licensing with a key made by `renovatio-license keygen`; official builds carry the vendor key inside them. |
| `RENOVATIO_GITHUB_TOKEN` / `RENOVATIO_GITHUB_TOKEN_FILE` | Optional GitHub token that raises the API rate limit for imports. Use the `_FILE` form with a Docker secret in production. |

**Software updates without a catalog (decision D98).** The server keeps a copy of the winget community index (the file the winget client itself uses; about 15,000 packages with their newest version, the Windows product codes and the normalized names that identify them), downloaded from Microsoft's CDN a few seconds after the server starts and then once a day (**Updates → Software updates** shows its age and has **Refresh now**). Every installed program is checked against it: first by its product code or uninstall-key name, then by normalized name **and** publisher; a program that matches several packages equally well, or only a name with no matching publisher, is not matched. The result:

- **Updates → Software updates** (all devices) and the device's **Software updates** tab list a program with a newer version even though nobody imported it. Such a row says **Not in catalog yet**; hover for the winget identifier and how it was recognised.
- **Deploy** adds the package to the catalog first (the same import as **Catalog → Import from winget**, audited as `catalog.import`; needs `catalog:write`), then creates the usual deployment. The installer is still downloaded by each device from the vendor and checked against the SHA-256 in the manifest, and an untested package still asks for the audited confirmation.
- A package already in the catalog keeps its own rules: its pin, exclusion and self-update policy decide, and the index never overrides them.
- Apps that update themselves (Chrome, Edge, Firefox, Teams, ...) are listed as **Vendor updates** and left alone. **Update anyway…** (needs `catalog:write` and `catalog:override`) adds the package, turns on "push updates even though the app updates itself" for it, and deploys.
- **Catalog → Import from winget** now searches the index by name, so you do not have to know the identifier.
- Not matched: Microsoft Store apps and portable programs, and programs winget does not know (for those, add a custom package).
- If the server cannot reach the CDN the last downloaded copy keeps working (it is stored in the database), and the Software updates page shows why the last attempt failed. Trust: the index is fetched over TLS; the package signature inside it is **not** verified by the server (T-SUP-2). The index only suggests; it never installs anything by itself.

### 5b. Windows updates (Phase 4)

| Task | How |
|---|---|
| See what devices are missing | **Windows updates** lists every update any device reported (devices scan every 24 h and when you press **Scan now** on the device's **Windows updates** tab). Filter by classification, severity, decision; "only missing" hides updates nobody needs. Open an update to see which devices are missing it. |
| Approve, decline, hide | Tick updates, then **Approve**, **Decline**, **Hide on devices** or **Reset to pending**. Nothing installs automatically until it is approved (by you or a rule) **and** a ring covers the device. |
| Roll out in stages | **Update policy → Rings → Add ring.** Order 1 is the pilot (pick a small group), then broader rings. *Delay* waits after approval, *Soak* is how long the next ring waits after this one started, *Success needed* is the percentage of reporting devices that must install successfully. A ring may have a maintenance window and a restart policy. Devices in no ring are not updated automatically. |
| Auto-approve | **Update policy → Auto-approval rules**: classification, severity, include drivers, days after release. Your own decisions always win over rules. |
| A rollout stopped | **Update policy → Held updates** lists updates that failed a ring's threshold. Look at the failures on the update's device list, then **Release** (continue) or decline the update. |
| Install now on one device | Device → **Windows updates** → tick updates → **Install selected** (ignores approval and rings; audited). **Restart now…** appears when the device is waiting for a restart (countdown 1–1440 min, visible to signed-in users; 1 minute is the shortest, so nobody is restarted without a warning). |
| Source (WU / Microsoft Update / drivers) | **Update policy → Update source** (administrators). Devices get it as a scan job and rescan. |
| Conflicts | Devices managed by WSUS, update deferral policies or with automatic updates disabled show a banner on the device and appear under **Update policy**. Renovatio does not change these policies. |
| Limit what an endpoint will do | Add `wu_scan,wu_install,wu_hide,reboot` to (or leave them out of) `--allowed-jobs` at install time. |

### 5c. Agent updates (Phase 5)

| Task | How |
|---|---|
| One-time: get the agents to trust a release key | Agents only accept releases signed by the vendor release key compiled into them. Official builds carry it. For your own test builds: `scripts/release-demo.sh` builds a throw-away key and agents that trust it, and the server needs `RENOVATIO_RELEASE_PUBLIC_KEYS=<hex>` (in `deploy/.env`) to accept uploads signed with it. |
| Publish a release | **Agent updates → Upload a release**: the agent binary and its signed `.rnr` bundle (made with `renovatio-release sign`, or `manifest` + your KMS + `attach`). The server verifies both. |
| Roll it out | **Agent updates → Rollout**: pick the target release, optional **pilot groups** (they update first), a **soak** time and the success percentage the pilot must reach, and how many devices per minute. Everyone else follows when the pilot has proven itself. |
| Watch it | The page shows versions in use, how many updated/failed, why devices outside the pilot are waiting, and a banner if the rollout was put on hold. A failing pilot pauses the rollout by itself; look at the failed jobs (device → Jobs), fix or withdraw the release, then un-pause. |
| Stop or withdraw | Untick/clear the target, tick **Pause the rollout**, or **Withdraw** a release (never offered again; pauses the rollout if it was the target). |
| What happens on the machine | The agent verifies the release, copies it to the other slot, switches the service and restarts. If the new version has not connected after 10 minutes, a scheduled task (`\Renovatio\rollback-check`) puts the old version back and the job shows *failed: did not become healthy*. Logs: `C:\ProgramData\Renovatio\logs\agent.log` and `rollback-check.log`. |
| Agents from before Phase 5 | They cannot update themselves; reinstall them once (uninstall, install with a new token, or the MSI). |
| Limit what an endpoint will do | Leave `agent_update` out of `--allowed-jobs` to forbid self-update on that machine. |

### 5d. People, sites and API access (Phase 5)

| Task | How |
|---|---|
| Add a person | **Users → Add user**: email, name, a role and where it applies (whole organization, or one site). A temporary password is shown once; give it to the person privately. At the first sign-in they choose their own password and set up a second factor. |
| Give someone only one site | Create the site under **Sites**, make enrollment tokens for it (**Enrollment → New token → Site**), and give the person a role **on that site**. They see and manage that site's devices from the device pages; fleet-wide pages and organization settings stay hidden. |
| Change or remove access | **Users → ⋮ → Roles…**, **Disable**, **Delete**, **Set a temporary password**, **Reset second factor** (the person sets up a new one at the next sign-in). The last active administrator cannot be disabled, deleted or demoted. |
| Security keys | **Account security (click your name) → Add security key**. Works at `https://` addresses and `localhost`; changing the public hostname invalidates keys. |
| API tokens | **Account security → API tokens**: choose scopes (only what you can do yourself) and a lifetime (1–365 days); copy the token once. Use `Authorization: Bearer rnt_…` on `/api/v1/…` (spec: `api/openapi.yaml`). Administrators see and revoke every token under **Users → API tokens**. A token stops working when it expires, is revoked or its owner is disabled. |

### 5e. Policies, reports and the audit log (Phase 5)

| Task | How |
|---|---|
| Keep software current | **Software policies → Add policy → Keep the package at its newest version**: pick the catalog package and groups, and how many days to wait after a new version appears. Every 5 minutes the server creates a normal deployment for devices where an older machine-wide copy is installed. Follow it under **Deployments**. Self-updating apps are left alone unless the package is set to *enforce*. |
| Install on new devices | **… → Install the package on devices that newly join the groups**: devices that already have the software are never touched; by default only devices enrolled after the policy was made. |
| A policy keeps failing | A device that fails three times is left alone (one try a day). Fix the package (Catalog → overrides); a new package version starts a fresh set of tries. |
| Reports | **Reports**: devices, online, patch compliance (no approved or Critical update missing, no failed install, scanned within a week), devices needing a restart, devices not seen for a week and job results of the last 30 days; **Export patch compliance (CSV)**. |
| Search the audit log | **Audit log**: filter by action prefix (`user.`, `deployment`), outcome, actor (id or IP) and time; **Export CSV** (up to 100,000 rows; spreadsheet formulas are neutralized). |
| Prove the log is intact | **Audit log → Verify the chain** walks every entry; a broken chain names the first bad entry. Do it before relying on the log in an investigation. |

### 5f. Licensing (Phase 6)

Licensing is checked on your server, offline; nothing is ever sent to the vendor. **Rule of thumb: a licensing problem only stops NEW devices from being enrolled or approved.** Existing devices, deployments, Windows and software updates, sign-in, revoking and uninstalling keep working in every state.

| State (License page) | What it means | New devices |
|---|---|---|
| **Unlicensed (evaluation)** | No license installed (or the subscription ended more than 30 days ago) | up to 25 enrolled devices |
| **Licensed** | A valid license is installed and inside its term | up to the license's device count |
| **Expired (grace period)** | The subscription ended less than 30 days ago | the license's device count still applies until the date shown; renew before then |
| **License not usable** | The installed license cannot be verified with this build's vendor key, or is not valid yet | the evaluation limit (25) |

| Task | How |
|---|---|
| Install a license | **License** (administrators only) **→ paste the license text (it starts with `RNL1.`) → Install license**. Takes effect at once; the previous one stays in the history. Refused with a reason if the signature does not verify, it is not valid yet, it expired more than 30 days ago, or it is already installed. Each attempt is in the audit log (`license.install`, `license.invalid`). From a script: `PUT /api/v1/license` with `{"license": "RNL1...."}` (permission `license:write`). |
| Renew | Install the new license text the same way, any time before or during the grace period. Devices are not touched. |
| See usage and expiry | **License** shows "N of M devices", the term, the update period and the history. The **Devices** page shows a banner when the cap is reached or the subscription ends within 30 days (people with `license:read`, i.e. administrators and operators). |
| At the cap | The next enrollment fails on the machine with `device limit reached: ... An administrator can install a license under License ...` (the installer prints it, and the service retries every ~15 minutes, so the machine enrolls by itself once there is room); a pending device cannot be approved (the console shows the same message). Fix: install a license with more devices, or **revoke and delete** devices you no longer manage. Every other function keeps working. A smaller license than your fleet removes nothing: you are simply over the cap until devices leave. |
| A re-installed machine | Re-enrolling a known machine (same hardware) replaces its old device and is always allowed, even at the cap. |
| Agent update period | If your license has an *updates until* date, agent releases published after it cannot be uploaded or rolled out ("Agent updates" shows why); a running rollout of such a release is paused. Windows, driver and software updates are never affected, and agents that are already installed keep working. |
| "Licensing is not configured" | This server build contains no vendor license key, so it can only run as an unlicensed evaluation. Use the vendor's official build or image (compose: set `RENOVATIO_LICENSE_PUBKEYS=<hex>` in `deploy/.env` and `docker compose up --build`; plain docker: `--build-arg LICENSE_PUBLIC_KEYS=<hex>`; release builds: `RENOVATIO_LICENSE_PUBKEYS` or `release/license-public-keys.txt`, see below). |
| Clock | The server remembers the latest time it has seen; setting the clock backwards does not bring back an expired subscription. Keep the server clock correct (NTP). |

**Issuing licenses (vendor side).** `renovatio-license` is in `cmd/renovatio-license` and is not shipped to customers. Generate the license key once and keep it offline or in a KMS (it is a different key from the release key; never reuse one for the other):

```
renovatio-license keygen --out license.key            # writes license.key (secret) and license.pub
renovatio-license sign --key license.key --licensee "Example GmbH" --max-devices 250 \
    --expires 2027-10-01 --updates-until 2027-10-01 --features reports.export --out example.lic
renovatio-license show --license example.lic --pub license.pub      # check before sending
```

Put the public key hex in server builds: `go build -ldflags "-X github.com/auzring1/renovatio/internal/shared/license.PublicKeysHex=<hex>[,<hex2>]" ./cmd/renovatio-server` (several keys allow rotation). With a KMS: `renovatio-license payload --licensee ... --max-devices ... --out doc.json --tosign doc.tosign`, have the KMS Ed25519-sign the **whole** `.tosign` file (it starts with the domain separator), then `renovatio-license attach --doc doc.json --signature sig.bin --pub license.pub --out example.lic`. Official release builds (`scripts/build-release.sh`, `scripts/build-image.sh`) take the key from `RENOVATIO_LICENSE_PUBKEYS`, `--license-pubkeys`, or the non-comment lines of `release/license-public-keys.txt`, and record it in `BUILD-INFO.txt`; with none the build warns and the server runs unlicensed. Demo keys for testing go under the git-ignored `dist-demo/`; never commit a key.

### 5g. Branding (Phase 7)

Settings > Branding (administrators only) makes the console yours: organization name (top bar, sign-in page, page titles, report headers), an optional product name (white-label; empty means "Renovatio"), logos for light and dark backgrounds, a square icon, a favicon, an accent and an optional secondary color, the sign-in headline, welcome message, footer or legal text and support contact (email, phone, https link), and a report logo and footer. The preview pane shows the top bar and sign-in page in the light and the dark theme while you type.

- **Colors are checked live against WCAG AA.** White text on the accent needs 4.5:1, the accent on the dark theme 3:1, and a secondary color 3:1 on both. A failing color shows "Fail" in the table and cannot be saved (the server refuses it too).
- **Images** are PNG or JPEG up to 512 KB (logos up to 1200 x 400, icon square 64-512, favicon square 16-256). They apply as soon as uploaded. They are re-encoded on the server (metadata removed); **SVG is not accepted**. Without a dark-background logo the light logo is shown on a light chip in the dark theme.
- **Reset to defaults** clears all of it, images included (confirmation required). The old values remain in the audit log (`branding.update`, `branding.asset_set`, `branding.asset_delete`, `branding.reset`, each with before/after).
- **First run:** the wizard asks for the organization name and an optional logo. An installation that existed before this feature shows "Renovatio" with no organization name until you set one.
- **Reports:** Reports > "Printable patch compliance report" opens a standalone page with the report logo (else the light logo), organization name and footer; use the browser's print dialog for PDF. The product has no email sender yet; the report footer is stored for when it has one.
- **Roll back:** `renovatio-server migrate --down-to 9` removes the branding tables (and their data). Take a backup first.

### 5h. Themes, density and saved views (Phase 8)

Everyone chooses their own theme from the account menu (top right): **Light, Slate, Dark, Midnight, High contrast** or **Follow my device**. The choice is saved on the account and applies on any device you sign in from. The same menu sets table density (comfortable or compact). Tables have a column picker, filter chips, sortable and resizable columns, a saved-views menu (views are saved on the account too) and CSV export of what you see.

Administrators can set the **default theme** and limit **which themes people may choose** under Settings > Branding > Appearance (for example, only Light and High contrast). A person whose saved choice is no longer offered sees the organization default. The branding accent color from the same page is applied on top of every theme and adapted per theme so it stays readable. Every theme meets WCAG AA contrast; High contrast is white on black with strong borders.

`/styleguide` (administrators) shows every component in the theme you are using.

## 6. Backup and restore

`renovatio-server backup` writes one encrypted file with **the whole database and the content directory** (uploaded installers). `renovatio-server restore` loads it into an empty database. Both need the schema-owner connection, which the running server deliberately does **not** have (SECURITY.md T-SRV-4). They run in the one-shot `maintenance` service of the compose file, which is the only container that holds the owner credential and which also applies migrations at every `up`. Use `docker compose -f deploy/docker-compose.yml run --rm --no-deps -T maintenance <command>`.

### 6.1 What is and is not in a backup

| In the backup | Not in the backup |
|---|---|
| Every table in the `public` schema (found from the catalog, so new tables are included automatically), including the audit log with its hash chain, and sequence positions | **The master key (KEK) and the rest of `deploy/secrets/`.** The database only holds keys *sealed* with the KEK (issuing CA, job signing, gateway, TOTP secrets), so a backup without the KEK cannot restore a working server |
| The content directory (`RENOVATIO_CONTENT_DIR`): uploaded installers, byte for byte, with SHA-256 checked | The root CA passphrase (you hold it; the root key in the database is sealed with it) |
| A manifest: format version, `renovatio-server` version, schema version, creation time, row counts, SHA-256 of every part | `deploy/.env`, Caddy's certificates (`caddy_data`), logs, agents' local state |
| | Database roles and passwords (the roles come from `deploy/postgres/init` and the secrets) |

**You must back up `deploy/secrets/` separately** (for example `tar czf - -C deploy secrets | age -r <key> > secrets.tgz.age`, stored somewhere other than the database backups). Keep copies of the two in different places: someone who has both can read everything.

The file is encrypted with [age](https://age-encryption.org). Anyone who knows the *public* key can create a file that decrypts, so keep the backup store write-protected (see "Authenticity" in SECURITY.md §9d.a).

### 6.2 One-time setup: the backup key

Do this on an **offline or at least separate** machine, not on the Renovatio host:

```bash
age-keygen -o renovatio-backup.key         # prints the public key (age1...); keep the .key file offline
```

- The file `renovatio-backup.key` is the **age secret key**. Print it or put it in your password manager and on offline media. Whoever has it can read every backup; without it nobody can, including you.
- Put only the **public key** (`age1...`) on the Renovatio host. You can give several `--recipient` options (for example two administrators, or a spare key kept in a safe); any one of the matching secret keys can restore.
- Alternative: a **passphrase** (`--passphrase-file`, scrypt, at least 12 characters, `openssl rand -base64 24`). Passphrase files must be readable by the backup job, so prefer public keys for unattended backups. The two modes cannot be mixed in one backup.

### 6.3 Taking a backup

```bash
cd /srv/renovatio        # the checkout with deploy/
umask 077
set -o pipefail
docker compose -f deploy/docker-compose.yml run --rm --no-deps -T maintenance \
  backup --out - --recipient age1xxxxxxxx... \
  > /var/backups/renovatio/renovatio-$(date +%F-%H%M).age
```

- `--out -` writes the encrypted archive to standard output **and nothing else** (logs go to standard error); the container's root filesystem is read-only, so this is the way to get the file out. `--out /path` writes a temp file, fsyncs, and renames it into place with mode 0600 (use it where the path is writable, for example `docker compose run -v`).
- **Check the exit status.** A failed backup leaves a truncated file that does not verify. The `set -o pipefail` and a non-zero exit above matter in scripts.
- The backup is a consistent snapshot (one `REPEATABLE READ` read-only transaction); the server keeps running and is not blocked. Content files are read right after; they are written once and named by hash, so a file uploaded in between is simply extra.
- Each backup adds an `admin.backup` audit entry (after the snapshot, so not inside that backup).
- Size: roughly the size of the data plus all uploaded installers. The archive is not compressed (compressing before encrypting would save space on the database tables but cost memory and open a decompression-bomb surface; installers do not compress anyway).

**Verify every backup** without touching a database (decrypts, checks every part against the manifest, prints a summary):

```bash
renovatio-server backup --verify /var/backups/renovatio/renovatio-2026-10-07-0300.age --identity-file renovatio-backup.key
# or from the container:  docker compose ... run --rm -T --no-deps -v $PWD/renovatio-backup.key:/k:ro maintenance backup --verify - --identity-file /k < file.age
```

A routine verification needs the secret key; if you do not want it on the backup host, verify during the restore drill (6.6) instead, and on the host only check that the file is non-trivially sized and recent.

### 6.4 Scheduling

cron (`/etc/cron.d/renovatio-backup`), nightly at 02:30 as the user that owns `/srv/renovatio` and may run Docker:

```cron
30 2 * * * renovatio /usr/local/bin/renovatio-backup.sh
```

`/usr/local/bin/renovatio-backup.sh`:

```bash
#!/bin/bash
set -euo pipefail
umask 077
dest=/var/backups/renovatio
f="$dest/renovatio-$(date +%F-%H%M).age"
cd /srv/renovatio
docker compose -f deploy/docker-compose.yml run --rm --no-deps -T maintenance \
  backup --out - --recipient-file /etc/renovatio/backup-recipients.txt > "$f.partial"
test "$(stat -c %s "$f.partial")" -gt 10000       # an empty or tiny file is a failure
mv "$f.partial" "$f"
find "$dest" -name 'renovatio-*.age' -mtime +30 -delete     # retention, see 6.7
# copy off the host (a different machine or bucket); example:
# rclone copy "$f" remote:renovatio-backups/
```

Or as a systemd timer: `renovatio-backup.service` (`Type=oneshot`, `ExecStart=/usr/local/bin/renovatio-backup.sh`, `User=renovatio`) plus `renovatio-backup.timer` (`OnCalendar=*-*-* 02:30:00`, `Persistent=true`, `RandomizedDelaySec=10m`), enabled with `systemctl enable --now renovatio-backup.timer`. Make a failing run visible: `OnFailure=` an alert unit, or send the script's exit status to your monitoring. A backup nobody notices failing is not a backup.

`--recipient-file` takes the same format as age: one public key per line, `#` comments allowed.

### 6.5 Restoring (disaster recovery)

You need: the backup file, the **age secret key** (or passphrase), the **`deploy/secrets/` directory from the same installation** (above all `master_key`), and a Docker host with this repository checked out at the same or a **newer** release.

1. **Restore the secrets** into `deploy/secrets/` (mode 0700) and recreate `deploy/.env`. Do not run `init-secrets.sh`: it would create new passwords and a new master key. (If you have lost the database *volume* but kept the secrets, the Postgres passwords in the secrets are applied when the empty database is first initialized.)
2. **Start only the database**, empty: `docker compose -f deploy/docker-compose.yml up -d postgres` and wait until it is healthy. Do **not** start the `server` or run `up` for the whole stack yet: the `maintenance` migration would bring the empty database to the newest schema first, and the server would take the first-run setup token.
3. **Restore.** The secret key and the backup are handed in as read-only mounts/stdin:

   ```bash
   docker compose -f deploy/docker-compose.yml run --rm -T --no-deps \
     -v "$PWD/renovatio-backup.key:/restore.key:ro" \
     maintenance restore --in - --identity-file /restore.key < /var/backups/renovatio/renovatio-2026-10-07-0230.age
   ```

   (`--passphrase-file` works the same way with a mounted file or `RENOVATIO_BACKUP_PASSPHRASE_FILE`.) With `--in <file>` instead of `-` the archive is verified completely **before** the database is touched; with standard input it cannot be read twice, so the load is done in one transaction and rolled back if any part fails to verify.
4. What the restore does, in order: decrypts and reads the header; **refuses** a backup made by a newer `renovatio-server` than this binary or with an unknown format version; refuses a database that already holds data; runs the embedded migrations *up to the backup's schema version*; in **one transaction** loads every table (foreign-key order, user triggers off, so the audit log arrives byte for byte), resets sequences, checks `RENOVATIO_MASTER_KEY` against the sealed CA keys, writes the content files, checks every part's SHA-256 against the manifest, and only then commits; runs the remaining migrations forward; and **verifies the audit hash chain**, finishing with an `admin.restore` entry. A bad archive therefore leaves no rows behind.
5. **Start everything:** `docker compose -f deploy/docker-compose.yml up -d`. Confirm: you can sign in (your TOTP still works because the KEK is the same), `docker compose ... exec server /renovatio-server admin verify-audit` reports an intact chain, **Devices** shows the fleet (devices appear offline until they reconnect), and the **Packages** you uploaded can be opened.
6. **After the restore:** agents reconnect on their own and resend their full inventory (their revisions no longer match). Anything that happened after the backup is gone: devices enrolled since then are unknown to the server and will be refused (re-enroll them), jobs and approvals created since are lost, and the audit log ends at the backup time. Revoke any enrollment token or device you revoked after the backup was taken, again.

Refusals you may meet, and what they mean:

| Message | Meaning and fix |
|---|---|
| `restore target is not empty` | The database already has data. Restoring into it would mix two installations. Use a new empty database, or `--force --wipe` to **drop everything in the `public` schema first** (only when you are sure; there is no undo). |
| `the (empty) database is already at schema version N, newer than the backup's` | The server was started once and migrated. Recreate the database, or add `--wipe` to rebuild the schema (it is empty, so nothing is lost). |
| `backup is newer than this server` | The backup was made by a newer release. Restore with that release or later; migrations only go forward. |
| `unsupported backup format` | The file is from a format version this binary does not know. Use the release that made it. |
| `the master key ... cannot open the ... key stored in this backup` | `RENOVATIO_MASTER_KEY_FILE` is not the key in use when the backup was made. Restore the original `deploy/secrets/master_key`. `--skip-kek-check` overrides, but the server would not be able to use the CA. |
| `... does not match this backup` / `integrity check failed` | Wrong key or passphrase / the file is damaged or was altered. Try another copy. |
| `audit chain is broken` | The restore committed, but the backup's audit log does not verify (it was already damaged or tampered with when the backup was taken). Do not trust this data; restore an earlier backup. |
| `lock tables (is the server still running?)` | Something is using the database. Stop the server. |

`--skip-content` restores the database only (no content directory needed). `--force --wipe` does not delete the content directory.

### 6.6 Test your restore

An untested backup is a hope. **Do a restore drill at least once a quarter, and after every upgrade that changes the database schema** (any release with a new migration), on a scratch machine:

1. Copy the latest backup, `renovatio-backup.key` and a copy of `deploy/secrets/` to the scratch host; check out the release you run in production.
2. Follow 6.5 with a different `RENOVATIO_HOSTNAME` (agents must not be able to reach this copy: leave 8443 closed or use an isolated network).
3. Sign in, run `admin verify-audit`, open a device and a custom package, and compare the device and audit counts with production (`backup --verify` prints the row counts too).
4. Record the date and the time it took. If the drill failed, fix that first; the production backup job is not trustworthy until then.

### 6.7 Retention and storage

- Keep **daily backups for 30 days, weekly for 3 months, monthly for a year**, adjusted to how much change you can afford to lose (the recovery point is the age of the newest good backup) and to your retention rules for audit data.
- Keep at least one copy **off the host and off the same account/provider**, and one that cannot be deleted by the Renovatio host (object lock, or pull from the backup server).
- Keep the age secret key and the secrets backup in a place that survives the loss of the site. Losing the master key or the age key makes every backup useless.
- Delete old backups with the same care as the audit log: they contain it.

### 6.8 Moving to another host

Take a backup, copy `deploy/secrets/` and the backup to the new host, then follow 6.5. Update `RENOVATIO_HOSTNAME`; agents find the server by the name baked into their enrollment, so keep the old DNS name pointing at the new host or the agents cannot reconnect.

### 5k. Locked out by the console IP allow-list

Settings > Security refuses an allow-list that does not contain the address of the person saving it, but an address can
change later (a new VPN range, a proxy). Start the server once with `RENOVATIO_IGNORE_IP_ALLOWLIST=true` (in the
environment or `.env`), sign in, correct the list under Settings > Security, and restart without the variable. The list
only concerns the console and its API; agents are not affected. The same list can be exported and re-imported
(Settings > Export settings); see [SETTINGS.md](SETTINGS.md).

## 7. Incident response
- **Suspected server compromise:**
  1. Isolate the host and preserve logs and the database.
  2. Rotate the KEK and every database password.
  3. Review the audit log, after checking it with `verify-audit`.
  4. Rotate the job-signing key on the server so agents replace their stored signing certificate at the next connection. (Root-signed revocation lists, which would let agents reject a stolen key at once, are not implemented yet: SECURITY.md 9e, R-2. Until a rotated-out certificate expires, an agent that is offline during the rotation still trusts it.)
- **Suspected endpoint compromise:** revoke the device, rebuild the machine, then enroll it with a new token.
- **Suspected release-key or code-signing compromise (vendor side):** section 9.4, "Revocation, and its limits". Customers: leave `agent_update` out of `--allowed-jobs`, pause the rollout and withdraw the release on the Agent updates page.
- **Leaked enrollment token:** revoke it under Enrollment, then review **Devices**, filtered to **Pending** and recent enrollments.

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| `install` reports "server rejected the enrollment token" | The token expired, was revoked or is used up. Create a new one. |
| Agent status `error`: "chain does not match the pinned root" | The agent reached something that is not your server (wrong DNS, or a TLS-inspecting proxy). Exempt the gateway from inspection. |
| Agent stuck in `connecting` | Firewall to port 8443. Check that the name the agent dials is in the gateway certificate (`RENOVATIO_GATEWAY_SANS`). |
| Agent `pending_approval` | Approve the device in the console. The agent checks every ~60 s. |
| Device shows no software, or "not reported yet" | The agent reports shortly after connecting (the first scan is a full snapshot). Check `agent.log` for `full software inventory sent`. If the server log shows `invalid_inventory` in the audit log (`gateway.protocol_violation`), the agent sent data the server rejects; the agent version and details are in the audit entry. |
| Software list looks stale or has "inventory truncated" | Changes are detected within ~30 s of an install/uninstall. A truncated notice means the device reported more than 25,000 items. After restoring a database backup, agents resend their full inventory automatically on reconnect (their revisions no longer match). |
| A group preview says the filter could not be evaluated | The filter was too expensive for the 10 s limit. Narrow it (add a device condition before a broad software title match). |
| Agent `rejected` | The device was revoked or rejected. Uninstall, then reinstall with a new token. |
| A restart or other action takes minutes to start on the PC | Compare the server's clock with the PC's. An agent holds a job until its own clock reaches the job's start time, so a server that runs minutes ahead delays every "now" action by that long (the server allows 5 minutes of difference since this was fixed, but keep both clocks right). On a Synology: Control Panel, Regional Options, Time, synchronize with your domain controller or an NTP server. Check `agent.log` for the job's `accepted` and `restart countdown started` lines. |
| A PC takes a few minutes to show as online after it restarts | The agent starts before Windows has its network up and retries; in agents built after this change it retries at least every 15 seconds for the first 10 minutes after the service starts (older agents wait up to 5 minutes between tries). Roll out the current agent under **Agent updates**. The server notices a PC that went away without a goodbye after its keepalive timeout (about 90 seconds). |
| Logs | Agent: `C:\ProgramData\Renovatio\logs\agent.log` (JSON, rotated at 5 MB × 3). Server: `docker compose ... logs server` (JSON; never contains request bodies, cookies or tokens). |
| A job stays `sent` and never starts | The device is offline, or its agent is older than Phase 3 (reinstall the agent). Jobs are re-offered every time the device connects until it acknowledges. |
| A job shows `rejected` | The agent refused it: a verification failure (see the audit log for a `security event`) or the local `--allowed-jobs` ceiling does not include the job type. |
| A job `failed` with "signature does not match the pinned signer" or "invalid digital signature" | The installer's Authenticode signature is absent, broken or from a different publisher than pinned. Do not deploy it until you have confirmed why; fix or remove the signer pin only if you trust the file. |
| A job `failed` with "hash" in the reason | The vendor changed the file after the manifest was imported. Re-import the package version (or upload the file yourself). |
| A job `failed_detection` | The installer exited successfully but the detection rule does not see the program. Add or correct a detection rule under the package's Overrides. |
| A per-user job says "waiting for user logon" | The target user has no session. It runs at their next logon until the deployment expires. |
| Upload fails with 413 or a connection reset | Uploads are limited to 2 GiB. Behind your own proxy, raise its body limit for `/api/v1/catalog/content`. |
| "Custom packages are disabled" | `RENOVATIO_CONTENT_DIR` is not set on the server. |
| Console says "Cross-origin request rejected" | `RENOVATIO_PUBLIC_URL` (derived from `RENOVATIO_HOSTNAME` and `RENOVATIO_PUBLIC_PORT_SUFFIX`) must match exactly the URL in the browser's address bar. |

### Hardening an older database (installed before Phase 6)

Fresh installs create `renovatio_owner` as a non-superuser and keep the bootstrap superuser (`renovatio_admin`) out of every service except PostgreSQL's init script. A database created by Phase 1–5 has `renovatio_owner` as its bootstrap **superuser** (PostgreSQL does not allow demoting that role). It is still isolated from the running server (only `maintenance` holds its password), but to get the non-superuser owner: take a backup (section 6.3), run `./scripts/init-secrets.sh` (adds `postgres_admin_password`), `docker compose down -v` **after** copying `deploy/secrets/` and the backup elsewhere, `docker compose up -d postgres`, and restore (6.5). Upgrading without doing this works; the server's startup check already warns when the runtime user owns the schema.

## 9. Release manager (vendor side)

This section is for the people who ship Renovatio, not for operators of an installation. Customers verify releases with `docs/VERIFYING_RELEASES.md`. The design is `docs/DECISIONS.md` D79-D84. **Owner decisions O5 (code-signing certificate) and O7 (release-key custody) are still open**; this section describes the options and what the pipeline expects of whichever is chosen. Nothing below has run against real GitHub, Azure, AWS or a certificate yet: do the dry runs first and expect to fix small things.

### 9.1 What the pipeline does

`.github/workflows/release.yml` runs on a `v*` tag, or by hand (**Actions → release → Run workflow**, `dry_run` is on by default).

| Stage | What happens | Real release | Dry run |
|---|---|---|---|
| prepare | Decides dry run, version, environment. A real release must come from a `vX.Y.Z` tag whose commit is on `main` | enforced | version from input |
| gate | Calls the existing `ci` and `windows` workflows | runs | runs unless `run_gate` is off |
| build | `scripts/build-release.sh`: Go binaries, web bundle, SBOMs, `unsigned-SHA256SUMS` | real public keys | throw-away key |
| rebuild | The same build again on another runner in another directory; digests must match | runs | runs |
| sign-windows | Authenticode-signs the agent, **then** builds the MSI (WiX) around it, then signs the MSI; verifies the signer name | real | skipped, unsigned MSI is still built |
| sign-manifest | `renovatio-release manifest` → `tosign` → KMS signs → `attach` → `verify` (the vendor bundle, D68) | KMS via OIDC | throw-away key |
| image | Builds `deploy/Dockerfile.server`, pushes to `ghcr.io`, cosign-signs the digest, attaches the SBOM, build provenance; checks the binary inside equals the released binary | runs | OCI archive only |
| publish | `SHA256SUMS`, cosign signature, GitHub build provenance, SBOM attestations, verification, **draft** GitHub release | runs | workflow artifact only |

A person publishes the draft release after checking it. The signing jobs sit behind the protected `release` environment.

### 9.2 One-time repository setup

1. **Environments** (Settings → Environments). `release`: required reviewers (two people, not the person who pushed the tag), "prevent self-review", deployment restricted to tags matching `v*`, no bypass for administrators. `release-dryrun`: no secrets, no reviewers (it is created on first use).
2. **Tag protection**: a ruleset so that only the release managers can create `v*` tags and nobody can move or delete them.
3. **Repository variables** (not secrets; they are names and identifiers):

| Variable | Meaning |
|---|---|
| `RENOVATIO_AUTHENTICODE_PROVIDER` | `azure-artifact-signing` or `signtool` (9.5) |
| `RENOVATIO_AUTHENTICODE_SUBJECT` | The signer name (certificate CN) agents will see. It is pinned into every vendor manifest |
| `RENOVATIO_AUTHENTICODE_SUBJECTS` | Optional, separated by a vertical bar. The only signer names compiled into agent and server (D83). Default: the variable above. While rotating the certificate, list old and new |
| `RENOVATIO_AZURE_CLIENT_ID`, `RENOVATIO_AZURE_TENANT_ID`, `RENOVATIO_AZURE_SUBSCRIPTION_ID` | Azure OIDC federation (Authenticode or Key Vault) |
| `RENOVATIO_ARTIFACT_SIGNING_ENDPOINT`, `RENOVATIO_ARTIFACT_SIGNING_ACCOUNT`, `RENOVATIO_ARTIFACT_SIGNING_PROFILE` | Azure Artifact Signing account |
| `RENOVATIO_SIGNTOOL_ARGS` | The `signtool` provider: how to select the certificate (for example `/csp "<KSP>" /kc "<container>" /f cert.cer`) |
| `RENOVATIO_KMS_PROVIDER` | `aws` or `azure` (9.4) |
| `RENOVATIO_AWS_ROLE_ARN`, `RENOVATIO_AWS_REGION`, `RENOVATIO_RELEASE_KMS_KEY_ID` | AWS KMS release key |
| `RENOVATIO_AKV_VAULT`, `RENOVATIO_AKV_KEY`, `RENOVATIO_AKV_KEY_VERSION` | Azure Key Vault release key (see the caveat in `scripts/release-kms.sh`) |
| `RENOVATIO_RELEASE_MIN_VERSION` | Optional `min_version` for the manifest |

   The only secret the pipeline can read is `RENOVATIO_SIGNTOOL_SECRET` (a KSP credential for the `signtool` provider). With OIDC no cloud credential is stored in GitHub.
4. **OIDC trust.** In Azure/AWS, trust the GitHub OIDC issuer for the subject `repo:auzring1/renovatio:environment:release` only (not the repository as a whole, not the dry-run environment). The AWS role may do `kms:Sign` and `kms:GetPublicKey` on the one key and nothing else. The Azure identity gets the signing role on the one Artifact Signing certificate profile and nothing else.
5. **Pinned versions.** Every third-party action is pinned to a commit SHA (`scripts/check-actions-pinned.sh`, run in CI). To bump one: list the tags with `git ls-remote --tags https://github.com/OWNER/REPO`, review the changes between releases, and replace the SHA and the version comment together. BuildKit itself is not yet pinned by digest: set `RENOVATIO_BUILDKIT_IMAGE=moby/buildkit:vX.Y.Z@sha256:...` for the image job when you have chosen one.

### 9.3 Cutting a release

1. Merge everything to `main`; CI is green. Update `THIRD_PARTY_NOTICES.md` if dependencies changed.
2. **Rehearse locally**: `make release-dryrun` (or `scripts/release-dryrun.sh --with-repro`). It uses throw-away keys under `dist-release/dryrun/` and prints what it exercised and what it could not.
3. **Rehearse in CI**: run the workflow with `dry_run` on. Check the notices ("DRY RUN ...") and that every job is green, including `rebuild` (the reproducibility proof).
4. Create a signed tag `vX.Y.Z` on the reviewed commit and push it. The `release` environment waits for the reviewers. **Reviewers check**: the tag is the commit they reviewed, `release/release-public-keys.txt` and the variables are unchanged since the last release, the `rebuild` job passed.
5. When the run finishes there is a **draft** release. Download it and run `scripts/verify-release.sh` (VERIFYING_RELEASES.md) from a machine that is not the CI. Then publish the draft.
6. Roll it out to your own fleet first: **Agent updates → Upload a release** (the signed exe and its `.rnr`), pilot group, soak (section 5c).
7. Announce the version, the commit, the vendor key fingerprint and the Authenticode signer name through a channel other than the release page.

If something is wrong after step 5: delete the draft, leave the tag (do not move it), fix forward with the next patch version. If it was already published or uploaded to servers, **withdraw** the release on the Agent updates page (customers) and publish a corrected one.

### 9.4 Release-key custody (decision O7): key ceremony outline

The vendor release key is an **Ed25519** key (the agents verify Ed25519 and nothing else). It signs the small manifest of each agent release and nothing else; the license-signing key (Phase 6) is a different key with a different custodian, never the same one.

**Where it lives.** In a KMS/HSM that can sign but not export. The pipeline contract is `scripts/release-kms.sh <provider> sign|pubkey` and works for any service that can do a raw Ed25519 (PureEdDSA) signature over a few hundred bytes:

- **AWS KMS**: key spec `ECC_NIST_EDWARDS25519`, usage `SIGN_VERIFY`, algorithm `ED25519_SHA_512` with message type `RAW` (the manifest is far below the 4096-byte limit). Implemented in the script, tested only against a fake `aws` command here.
- **Azure Key Vault / Managed HSM**: the hook exists (`azure`), but as far as we know Key Vault does not offer Ed25519 keys. If that is still true when you decide, use AWS KMS (or Google Cloud KMS, or an HSM behind PKCS#11, by adding one more provider function to the script). Do not pick Azure for the release key without first creating a test Ed25519 key there.
- The Authenticode certificate and the release key are independent on purpose (9.5); using Azure for one and AWS for the other is fine.

**Ceremony (once, then for every rotation).**

1. Two people and a witness, with a written log. Decide the key's name, account/region and the people who may change its policy (not the people who can push tags).
2. Create the key in the KMS with: no export, deletion protection or a long deletion window, and a key policy that lets only (a) the pipeline role `kms:Sign`/`kms:GetPublicKey` under the OIDC subject condition of 9.2 and (b) a break-glass administrator role manage it. Turn on CloudTrail (or Azure diagnostic logs) for the key and alert on any `Sign` outside a release run.
3. Read the public key: `RENOVATIO_RELEASE_KMS_KEY_ID=... scripts/release-kms.sh aws pubkey` (64 hex digits). Record it and its short key id (the first 8 bytes of its SHA-256, printed by `renovatio-release keygen` and `verify`) in the log; both witnesses read them back from the KMS console.
4. Add the public key to `release/release-public-keys.txt` by pull request (two reviewers). Never commit anything else there. The first build with this file non-empty produces agents that trust the key.
5. **Make a standby key now, not later.** KMS keys cannot be backed up in a usable form: if the only key is lost or its account is closed, no agent can ever be updated again (only reinstalled). So create a second key in a different account/region/provider with a different custodian, put **both** public keys into the file from the first release, and keep the standby's access closed. This is the backup.
6. Prove sign, `attach --pub` and `verify` work with the real key before the first release: run `scripts/release-kms.sh` by hand from a shell that has assumed the role, on a test manifest.

**Rotation (planned, yearly or on staff change).** Agents learn about a new key only through an update that an already-trusted key signed, so the order matters:

1. Release N: `release-public-keys.txt` contains old and new; signed with the old key. Roll it out until the whole fleet reports version N or later (Agent updates page).
2. Release N+1: signed with the new key (point `RENOVATIO_RELEASE_KMS_KEY_ID` at it).
3. Release N+2, only after N+1 has reached the fleet: the file drops the old key. Disable the old KMS key after that.

An agent that is offline for a whole rotation may need a reinstall.

**Revocation, and its limits.** There is deliberately no revocation list that agents fetch: agents never phone home to us. What exists:

- *The key is unusable the moment you disable it in the KMS or detach the pipeline role.* A KMS key cannot be exfiltrated, so "theft" really means someone could ask the KMS to sign. Cut off the role first, then read the key's audit log for signatures you did not expect.
- A signature alone does not get a binary onto an endpoint. An attacker also needs (a) to deliver the update job through a customer's server, whose job-signing key they do not have, and (b) a binary Authenticode-signed by one of the signer names compiled into the agent (D83), that is, our certificate. Losing the release key is serious but not by itself a fleet compromise.
- Recovery is a rotation in a hurry: ship a release signed by the **standby** key that no longer trusts the compromised one, and ask customers to roll it out first. Agents that still trust the compromised key remain exposed to a forged update until they take that release; customers can stop `agent_update` jobs (leave it out of `--allowed-jobs`) and **withdraw** releases on the Agent updates page.
- Compromise of the Authenticode certificate is handled at the CA (revoke) plus a new certificate with a new CN added to `RENOVATIO_AUTHENTICODE_SUBJECTS` in a release signed under the old one. If both the release key and the certificate are lost at once, the only safe fleet recovery is a manual reinstall.

### 9.5 Code-signing certificate (decision O5): options

The agent exe and the MSI are Authenticode-signed with a timestamp. The CN of the certificate is pinned into every manifest and, since D83, compiled into the agent. Two supported ways (`RENOVATIO_AUTHENTICODE_PROVIDER`):

| | `azure-artifact-signing` (formerly Trusted Signing) | `signtool` with a certificate in a cloud HSM |
|---|---|---|
| Key handling | Microsoft holds the key; short-lived certificates are issued per signature; the GitHub job uses OIDC and no secret | The CA or HSM vendor holds the key; the job reaches it through a CSP/KSP (`RENOVATIO_SIGNTOOL_ARGS` selects it) and usually a secret (`RENOVATIO_SIGNTOOL_SECRET`) |
| Fit | Simplest and best for CI. The signer name is the validated legal entity | Independent of Azure; works with any CA that sells HSM-backed OV/EV certificates |
| Costs/limits | Needs an Azure subscription and identity validation of the organization. Check current eligibility rules and regions before relying on it | Annual certificate fee; CAs require the key to be on certified hardware, so a PFX file in CI is not an option; the KSP plumbing is the work |
| Status here | Wired to Microsoft's official action (pinned), **never run** | Wired through `scripts/authenticode.ps1`, **never run** |

Either way: sign the agent **before** the MSI is built; always apply the timestamp (a signature without one dies with the certificate); keep the signer CN stable across renewals (Azure rotates certificates but keeps the subject); do not buy an EV certificate expecting automatic SmartScreen reputation, check Microsoft's current behaviour first. Whoever owns the decision should also fix the exact CN string, because it is compared exactly (ignoring case).

### 9.6 Troubleshooting a release run

| Symptom | Likely cause |
|---|---|
| `prepare`: "a real release runs only from a v* tag" | A manual run with `dry_run` off from a branch. Real releases come from tags only |
| `build`: "release/release-public-keys.txt has no key" | The key ceremony (9.4) is not finished |
| `build`: "set RENOVATIO_AUTHENTICODE_SUBJECT" | The repository variable is missing |
| `rebuild` differs from `build` | A real reproducibility bug: run `scripts/verify-reproducible.sh` locally on the tag and compare; do not release until understood |
| `sign-windows`: "a repository variable for ... is not set" | A variable from 9.2 is missing |
| `sign-windows`: signer is 'X', expected 'Y' | `RENOVATIO_AUTHENTICODE_SUBJECT` does not equal the certificate's CN |
| `sign-manifest`: "not among the compiled-in release keys" | The KMS key is not the one in `release/release-public-keys.txt` |
| `sign-manifest`: Key Vault refuses EdDSA | Azure Key Vault has no Ed25519 here; use AWS KMS (9.4) |
| `image`: "image binary differs from the released binary" | The pinned base image's Go release differs from the pipeline's, or the web bundle differs. Update the golang digest in `deploy/Dockerfile.server` together with `GO_VERSION` |
| `publish`: `sha256sum -c` fails | Something other than the signed agent changed after the reproducible build |
