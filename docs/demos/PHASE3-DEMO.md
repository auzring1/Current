# Phase 3 demo script: software deployment

Goal: import software into the catalog, install, update and remove it on a real Windows machine from the console, see live per-device results, upload your own installer, prove that a tampered or wrongly signed installer is refused, and try the per-user paths (two users on one machine). Allow about 90 minutes; Parts A to F are the core (about 45 minutes), Parts G to K are the checks that matter most for trust.

You need the Phase 1 and 2 setup ([PHASE1-DEMO.md](PHASE1-DEMO.md), [PHASE2-DEMO.md](PHASE2-DEMO.md)): a running server stack, a console login with your authenticator, and a Windows 10/11 test machine (a VM you can revert is best). For Part K you also need a second local user on that machine. The examples assume the server name `librepatch.lab`.

**Be honest about what is new:** the Windows execution paths in this phase (running installers as the system, Authenticode checks, Job Objects, and above all running installers inside another user's session) have only been compiled and run on a CI runner, never on a real multi-user machine. Part K is the first real test of the per-user helper. If anything fails there, that is useful information, not a surprise.

The server needs outbound HTTPS to `raw.githubusercontent.com` and `api.github.com` (to import from winget). The Windows machine needs to reach the vendors' download hosts (for 7-Zip, `7-zip.org` / `github.com`).

---

## Part A: Upgrade the server (about 5 minutes)

1. **Get the Phase 3 code and restart the stack.** Data and secrets are kept; migration `00003_deployments` runs automatically, and a new `content` volume stores uploaded installers.
   ```bash
   git fetch origin && git checkout phase-3
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
   docker compose -f deploy/docker-compose.yml logs server | grep -i migrat
   docker compose -f deploy/docker-compose.yml exec server ls -ld /var/lib/librepatch/content
   ```
   ✅ The migration is applied and the server is `healthy`. The console shows new menu entries **Catalog**, **Deployments** and **Settings**.

2. **Build the Phase 3 agent** (any machine with Go 1.27):
   ```bash
   GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o librepatch-agent.exe ./cmd/librepatch-agent
   ```
   Copy it to the Windows machine (`C:\Temp`). Phase 1 and 2 agents cannot run jobs, so they must be replaced (there is no agent self-update until Phase 5).

## Part B: Reinstall the agent (about 5 minutes)

3. On the Windows machine, **PowerShell as Administrator**:
   ```powershell
   cd C:\Temp
   & "C:\Program Files\LibrePatch\Agent\slot-a\librepatch-agent.exe" uninstall      # skip if never installed
   ```
   In the console: **Enrollment → New token**, then
   ```powershell
   .\librepatch-agent.exe install --server librepatch.lab:8443 --token LP1.....
   ```
   Approve the device if it asks (same hardware re-enrolls as *pending*; approving retires the old identity). ✅ The device is **online** and its Software tab is filled.

   Create a second local user now if you will do Part K, and sign in as that user once so its profile exists: `net user demo2 "Demo-Passw0rd-2026" /add`.

## Part C: Import a package (about 5 minutes)

4. **Catalog → Import from winget.** Type `7zip.7zip` (the exact winget identifier; suggestions appear as chips). Leave the version empty and click **Import**.
   ✅ A notification says how many installers were imported and how many are deployable. You land on the package page: publisher, license, versions, and one row per installer (architecture, scope, type, size, SHA-256, and either *vendor download* or *not deployable: reason*).
   ✅ A yellow **Unverified package** box explains that no VM-matrix run has verified it yet. That is expected: nothing is verified until someone runs the matrix on real VMs.
   🔒 *Check:* the installer rows show the SHA-256 that comes from the community manifest. That hash will be signed into the job; the device refuses any other bytes.

## Part D: Install, then see it on the machine (about 10 minutes)

5. Click **Deploy** on the package page. In **New deployment**:
   - Package: 7-Zip. **Action: Install. Scope: Machine-wide.** Version: leave empty (newest).
   - Under **Devices** choose your Windows machine.
   - Tick the **unverified** confirmation. (Without it the button stays disabled; with the API the server answers `409 unverified`.)
   - Click **Start deployment**. ✅ "Deployment queued: 1 job for 1 device." Click **Watch progress**.

6. ✅ The deployment page updates **by itself** (no reload): the job goes `sent → accepted → running → succeeded` within a minute or two. Click **Details** on the job: ✅ a timeline (offered, accepted, running, succeeded), the exit code, "detection passed", the installed version and the tail of the installer log.
   On the Windows machine:
   ```powershell
   Test-Path "C:\Program Files\7-Zip\7z.exe"                       # True
   Get-Content C:\ProgramData\LibrePatch\logs\agent.log -Tail 30       # job accepted, hash verified, signature, exit code 0, detection passed
   ```
   ✅ After about a minute the device's **Software** tab (Phase 2) lists 7-Zip, and the deployment page says **completed**.

7. **Idempotence.** Create the same deployment again. ✅ The job succeeds immediately with "already satisfied" and the installer is not run (check the log: no new `run` entry).

## Part E: Update and uninstall (about 10 minutes)

8. **Update only touches older installs.** To have something to update, first make the machine old:
   - **Catalog → Import from winget**: `7zip.7zip`, version `23.01` (an older release).
   - Deployments → New deployment: Install the *23.01* version on the device (pick it in the **Version** list). ✅ It installs. (If 7-Zip 24.x is installed, uninstall it first, Step 9.)
   - Now **New deployment → Action: Update**, package 7-Zip, version empty (newest allowed). ✅ The device gets an update job; a device that already has the newest version would be *skipped* with a reason. After it succeeds, the Software tab shows the newer version.

9. **Uninstall.** **New deployment → Action: Uninstall**, 7-Zip, scope machine, your device. ✅ The job succeeds and `C:\Program Files\7-Zip\` is gone.
   🔒 *Check:* the uninstall command is **not** sent by the server. It is derived on the device from that program's own Uninstall registry entry (product code, quiet string, or Inno switches). Open **Details**: the message names how it was uninstalled.

## Part E2: Device page actions (about 10 minutes)

- **↻ Refresh** (top of the device page): ✅ the button spins for a few seconds, then "Device information refreshed"; install something on the machine first and it shows up immediately instead of after the 30 s change detection.
- **Missing updates** tab: with an older 7-Zip installed (Step 8) ✅ it lists *7-Zip 23.01 → newest*. Select it and **Deploy Updates** ✅ an update is queued (Jobs tab). Firefox and other self-updating apps show **vendor updates** and cannot be selected.
- **Update replaces old copies:** install the *EXE* 7-Zip, then deploy the update (the catalog prefers the MSI). ✅ The Jobs tab shows `Remove old 7-Zip …` first, then `Update 7-Zip …`, and Apps & features ends up with one 7-Zip.
- **Software** tab: tick programs and **Uninstall Software** (or the ⋮ menu on a row). ✅ A confirmation lists them; jobs appear on the Jobs tab. Windows components are refused with a message.
- **Delete a device:** revoke a test device, then **Delete device** (or tick several under **Devices → Revoked** and **Delete selected**). ✅ It disappears; the audit log shows `device.delete`.

## Part F: Live progress, retry, cancel, offline devices (about 10 minutes)

10. **Retry** is shown after the failure in Part H (Step 16): a failed, expired, rejected or cancelled job has a **Retry** button that creates a new attempt.

11. **Offline device.** On the Windows machine run `Stop-Service LibrePatchAgent`. In the console wait until the device shows offline, then deploy 7-Zip to it. ✅ The job sits in `queued`. Run `Start-Service LibrePatchAgent`: ✅ the job is offered as soon as the device reconnects and completes.

12. **Maintenance window.** **New deployment → Only run inside a maintenance window**: tick today's weekday, set **Starts** to about 10 minutes from now (device time) and 30 minutes duration. ✅ The job reaches `waiting` (reason `waiting_not_before`/outside window) and runs only when the window opens. The window is evaluated **on the device**, so it works even if the server is down at that moment (try `docker compose ... stop server` after the job shows `waiting`, then start it again later).

13. **Cancel.** Start a deployment with **Not before** set a day ahead, open it and click **Cancel deployment**. ✅ Status `cancelled`, the job `cancelled`. (If a device already holds the job it is cancelled when the device is reachable.)

## Part G: Your own installer (about 10 minutes)

14. Download any MSI or EXE installer you like to the **console machine** (the 7-Zip MSI from `7-zip.org` is fine). **Catalog → Upload custom installer**:
    - choose the file; Identifier `Acme.SevenZip`, Name `Acme 7-Zip`, Version `24.08`; Type `msi`, Architecture `x64`, Scope `machine`;
    - **Detection file path:** `%ProgramFiles%\7-Zip\7z.exe`.
    ✅ You land on the package page with one installer marked *served by LibrePatch*, no "unverified" warning (you supplied the file).
15. Deploy it to your device (**Install**, machine-wide). ✅ It succeeds. This time the device downloaded the bytes from **your server over the agent's mutual-TLS channel**, not from the internet (in the agent log: `fetch ... server`).
    🔒 *Check:* in the **Audit log** you see `catalog.upload` (with the SHA-256 and size), `catalog.custom` and `deployment.create`.

## Part H: Prove a bad installer is refused (about 10 minutes, important)

16. **Wrong signer.** Upload `librepatch-agent.exe` itself as a custom installer (it is not Authenticode-signed): Identifier `Check.Unsigned`, type `exe`, silent args `/S`, **Detection file path** `%ProgramFiles%\RnvCheck\never.txt`, **Required signer** `CN=Nobody Inc`. Deploy it to the device.
    ✅ The job ends `failed` with "the installer's signature does not match the pinned signer" and **never runs** (nothing starts; no `RnvCheck` folder). The agent also reports a security event.
    Click **Retry** on the job ✅ a second attempt (`attempt 2`) is queued, runs and fails the same way: a retry is a brand-new signed job, never a re-run of the old one.
17. **Tampered file.** (Needs shell access to the server.) Upload any small installer as a custom package, deploy it once successfully, then corrupt the stored file and deploy again:
    ```bash
    docker compose -f deploy/docker-compose.yml exec server sh -c 'ls /var/lib/librepatch/content/*'
    ```
    The server container is read-only and distroless (no shell), so instead run
    `docker run --rm -v <project>_content:/c alpine sh -c "echo x >> /c/*/<hash>"` against the volume (use `docker volume ls` to find its name). Deploy again. ✅ The device refuses it: the downloaded bytes do not match the SHA-256 signed into the job, and nothing runs.
18. **Silent switches that are not allowed.** Package page → **Overrides → Silent arguments**: enter `/S & calc`. ✅ Save is refused with a message naming the argument. Enter `/S` ✅ saved, and an **Overrides** change appears in the audit log as `catalog.override`.
19. **Policy ceiling.** Reinstall the agent with `--allowed-jobs inventory` (uninstall first, new token). Deploy anything. ✅ The job is `rejected` with the reason "not allowed by the local policy ceiling", and a security event is logged. The server cannot raise this limit. Reinstall without the flag afterwards.

## Part I: Self-updating apps (about 5 minutes)

20. **Catalog → Import from winget**: `Mozilla.Firefox`. ✅ It carries a grey **self-updating** badge. Try **New deployment → Update** for it. ✅ Refused: "This app updates itself, so LibrePatch leaves updates to the vendor… set the package's self-update policy to enforce". Install is still allowed. Under **Overrides → Self-updating behaviour: Enforce the pinned version anyway**, Update works.

## Part J: Version pin and exclusion (about 3 minutes)

21. On the 7-Zip package page, **Overrides → Version pin** `< 24` and Save. Deploy an Install with the version empty. ✅ It picks the newest imported version below 24 (23.01). Set the pin to `= 99.0` ✅ the deployment is refused ("no version matches"). Tick **Exclude this package from deployments** ✅ refused with "excluded". Clear the overrides again.

## Part K: Per-user software with two users (about 20 minutes; the experimental part)

You should have the second user `demo2` from Part B and have signed in as them once.

22. **Per-user install.** Sign in to the Windows machine as **demo2** and stay signed in (switch users). In the console import `Microsoft.VisualStudioCode`, then **New deployment → Install, Scope: Per user**, your device.
    ✅ The plan lists one job **per user profile** on the device (you and demo2). The demo2 job runs **inside demo2's session** (look in `C:\ProgramData\LibrePatch\logs\agent.log` for the helper starting). Verify as demo2: `Test-Path "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"` → True. The job for the user who is **signed out** shows **waiting for user logon**; sign that user in ✅ and it runs without anything else being clicked.
    🔒 *Check:* the installer ran as demo2, not as SYSTEM: `Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | % { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User }` shows `demo2`.

23. **Per-user policy.** With VS Code installed for demo2 (per user), open **Settings** and leave the default **Report only**. Run **Install, Machine-wide** of VS Code to the device.
    ✅ The result page says "1 per-user installation found; policy: report_only" and demo2's copy is untouched.
    Now set **Settings → Convert** and deploy the machine-wide install again (uninstall the machine copy first if needed). ✅ Two jobs: the machine install, and a **dependent** "Remove per-user Microsoft Visual Studio Code" job for demo2 that starts only after the machine install succeeded and detection passed, and runs in demo2's session. If the machine install fails, the removal is cancelled and demo2 keeps their copy.
    Try the package-level override (**Overrides → Per-user installs of this app**) ✅ it beats the organization default; the package page shows where the effective value comes from.

24. **Two users at once** (optional): with both users signed in (fast user switching), run a per-user uninstall deployment. ✅ Each user's job runs in their own session and only touches their own profile.

## Part L: Logs and audit (about 3 minutes)

25. **Audit log.** ✅ You see `catalog.import`, `catalog.upload`, `catalog.custom`, `catalog.override`, `deployment.create` (including whether unverified packages were confirmed), `deployment.cancel`, `job.retry`, `settings.update`. On the server: `docker compose ... exec server /librepatch-server admin verify-audit` ✅ chain intact.

## Clean up
```powershell
& "C:\Program Files\LibrePatch\Agent\slot-a\librepatch-agent.exe" uninstall
net user demo2 /delete
# remove any leftovers: C:\Program Files\7-Zip, VS Code, the test installers in C:\Temp
```
Revoke the device in the console. Revert the VM snapshot if you used one.

## What to tell me
- Any job that failed, with its **Details** log and `C:\ProgramData\LibrePatch\logs\agent.log` around it.
- Whether Part K worked at all (the helper starting in demo2's session, the logon queue, the dependent removal), and what the Task Manager "Users" tab showed for the installer processes.
- Whether any installer needed a silent switch the importer did not know (the package page shows "not deployable" or the install hung).
- How long a deployment took from **Start** to **succeeded** on an online device (I expect seconds plus the installer's own time).
- Whether the winget import worked from your network (if not: what the console said).
