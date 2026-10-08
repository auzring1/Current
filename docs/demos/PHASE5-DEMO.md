# Phase 5 demo script: agent self-update, people and sites, automation, backup, MSI

Goal: see the agent update itself from a vendor-signed release (and roll itself back from a broken one), give a technician access to one site only, use a security key and an API token, let policies keep software current, read the reports and verify the audit log, take a backup and restore it, and install the agent from an MSI. Allow about 3 hours; Parts A to D are the core. Parts F to H need nothing special; Part I (MSI) needs a Windows machine with the .NET SDK and WiX (or a build from the Windows CI job).

You need the Phase 1 to 4 setup ([PHASE1-DEMO.md](PHASE1-DEMO.md) to [PHASE4-DEMO.md](PHASE4-DEMO.md)): a running server stack, a console login with your authenticator, and a Windows 10/11 or Server 2019+ test machine **that you can revert** (a VM snapshot). The examples assume the server name `auzring.lab`.

**Be honest about what is new:** the Windows side of self-update (switching the service to the other slot, the SYSTEM scheduled task that rolls back, the deliberate service restart, the Authenticode comparison) and the MSI have only been compiled for Windows and tested against a simulated platform on Linux. This is the first time they run on a real machine. If something fails here, keep `C:\ProgramData\Auzring\logs\agent.log`, `rollback-check.log` and the job's log tail.

---

## Part A: Upgrade the server (about 10 minutes)

1. **Get the Phase 5 code and restart the stack.** Data and secrets are kept; migrations `00006`, `00007` and `00008` run automatically.
   ```bash
   git fetch origin && git checkout phase-5
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
   docker compose -f deploy/docker-compose.yml logs server | grep -i migrat
   ```
   ✅ The server is `healthy`. The menu has new entries: **Users**, **Sites**, **Agent updates**, **Software policies**, **Reports**, **Audit log**.

2. **Build the demo releases.** This makes a throw-away release key in `dist-demo/` (git-ignored) and three agents: 0.9.0 (install first), 0.9.1 (good), 0.9.2 (deliberately broken), plus signed `.azr` bundles for 0.9.1 and 0.9.2.
   ```bash
   scripts/release-demo.sh
   ```
   It prints a line `AUZ_RELEASE_PUBLIC_KEYS=<hex>`. Add that line to `deploy/.env` and recreate the server: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d server`. ✅ Still healthy. (An official build carries the vendor key inside it; this only exists because you are testing with your own key. **Never use the demo key for real machines.**)

## Part B: Self-update, the good release (about 25 minutes)

3. **Install agent 0.9.0.** Copy `dist-demo/auzring-agent-0.9.0.exe` to `C:\Temp` on the Windows machine and, from an elevated PowerShell, with a fresh token from **Enrollment → New token**:
   ```powershell
   cd C:\Temp
   & "C:\Program Files\Auzring\Agent\slot-a\auzring-agent.exe" uninstall    # skip if never installed
   .\auzring-agent-0.9.0.exe install --server auzring.lab:8443 --token AURZ1.....
   ```
   Approve the device if asked. ✅ Online; the device page says agent version **0.9.0**.
   *(Agents from before Phase 5 cannot update themselves, which is why you reinstall.)*

4. **Publish 0.9.1.** **Agent updates → Upload a release**: choose `auzring-agent-0.9.1.exe` and `auzring-agent-0.9.1.azr`. ✅ The release is listed with its version, size, hash and key id. Try uploading the `.exe` with the `.azr` of 0.9.2: ✅ it is refused (hash mismatch). Upload a copy of the `.azr` edited in a text editor: ✅ refused (bad signature).

5. **Roll it out.** In **Rollout**, pick 0.9.1 as the target release, leave pilot groups empty, soak 0, and save. Within about a minute ✅ a job "Update the agent to 0.9.1" appears on the device's **Jobs** tab and goes `sent → accepted → running`.
   🔍 On the machine: `Get-Service AuzringAgent` — the service restarts once. `dir "C:\Program Files\Auzring\Agent"` shows both `slot-a` and `slot-b`; `Get-Content C:\ProgramData\Auzring\update.json` shows the state moving `switching → healthy`.
   ✅ After the restart the job ends **succeeded** (it is completed by the new agent when it has connected), the device page says **0.9.1**, and `schtasks /query /tn "\Auzring\rollback-check"` says the task no longer exists (it is cancelled once the new version is confirmed healthy).

6. ✅ The **Agent updates** page shows 1 device on 0.9.1, 0 failed. **Audit log** has `agent.update_job` entries.

## Part C: The broken release rolls itself back (about 20 minutes)

7. **Shorten the wait.** The rollback check normally runs 10 minutes after the switch. For the demo, set `"update_rollback_minutes": 2` in `C:\ProgramData\Auzring\config.json` (valid range 1 to 60) and restart the service: `Restart-Service AuzringAgent`.

8. Upload `auzring-agent-0.9.2.exe` + `.azr` and make 0.9.2 the target release. ✅ The device updates to 0.9.2, which starts but **never connects** (it is a build that stays silent on purpose).
   ✅ About 2 minutes later the scheduled task `\Auzring\rollback-check` runs the *old* binary, which puts slot-a/0.9.1 back and restarts the service. The device is **online with version 0.9.1** again, and the job ends **failed: did not become healthy** (visible on the Jobs tab and in `rollback-check.log`).
   ✅ Because it was the first release to fail, the rollout does **not** keep retrying forever: the device is retried at most 3 times; **Withdraw** the 0.9.2 release afterwards (it is never offered again).

9. Optional, for a pilot: create two groups, set **pilot groups** and a soak of 1 hour with 90% success. ✅ Devices outside the pilot show "waiting for pilot". With the broken release, ✅ the rollout pauses itself (banner "put on hold", audit `agent.rollout_hold`) as soon as the pilot device fails.

## Part D: People, sites, tokens and security keys (about 30 minutes)

10. **Sites and a limited technician.** **Sites → Add site** `Branch`. **Enrollment → New token → Site: Branch** and enroll a second device with it (or move one). **Users → Add user**: email `tech@example.com`, role *Operator* **on site Branch**. Copy the temporary password.
    ✅ Sign in as that user in a private window: you are made to choose a new password and to set up a second factor. Afterwards the user sees **only** the Branch devices, no fleet-wide pages (no Users, Sites, Update policy), and asking for another site's device by URL gives *not found*.

11. **Security key.** As yourself, **Account security → Add security key**. ✅ The browser asks for the key; it is listed. Sign out and in again: ✅ you can use the key instead of the authenticator code. (Works at `https://` addresses and `localhost`; the key is bound to the hostname.)

12. **API token.** **Account security → API tokens → New token**, scope *devices:read*, 30 days. Copy the `azt_…` token (shown once).
    ```bash
    curl -s --cacert <your CA> -H "Authorization: Bearer azt_..." https://auzring.lab/api/v1/devices | head -c 300
    ```
    ✅ Device list. Try `POST /api/v1/users` with the same token: ✅ 403 (tokens never manage users). Revoke the token in the console and repeat: ✅ 401. The audit log marks the calls made with the token (`via_api_token`).

13. **Last-administrator guard.** Try to disable or demote the only administrator: ✅ refused.

## Part E: Software policies, reports and audit (about 25 minutes)

14. **Keep an app current.** Import `7zip.7zip` (an older version first if you can: **Catalog → Import**, pick a version) and install it on the test machine. **Software policies → Add policy → Keep the package at its newest version**, package 7-Zip, your group, wait `0` days. ✅ Within 5 minutes a deployment named after the policy appears under **Deployments**, created by `policy:<id>` in the audit log, and 7-Zip is updated on the machine.

15. **New-device baseline.** Add a policy **Install on devices that newly join the groups** with a small package (for example Notepad++). Enroll another machine (or a VM) into the group. ✅ The package is installed on the new device and **not** on the machines that were already there.

16. **Reports.** Open **Reports**. ✅ Counts for devices, online, compliance, restart needed, not seen for a week and recent job results; the numbers match the device list. **Export patch compliance (CSV)** and open it: ✅ one row per device; a cell starting with `=` would be neutralized.

17. **Audit log.** Filter by action `user.`, then by outcome `failure`. ✅ Results narrow. **Export CSV** works. Click **Verify the chain**: ✅ "intact, N entries checked".
    🔒 Prove tampering is detected (on a scratch copy only): in the database as the owner, `UPDATE audit_log SET outcome='failure' WHERE id=<some id>` is refused by the trigger; the chain is also checked from the command line: `docker compose -f deploy/docker-compose.yml exec server auzring-server admin verify-audit`.

## Part F: Backup and restore drill (about 20 minutes)

18. Generate a key and take a backup (RUNBOOK §6):
    ```bash
    age-keygen -o auzring-backup.key        # note the public key age1...
    umask 077; set -o pipefail
    docker compose -f deploy/docker-compose.yml run --rm --no-deps -T maintenance \
      backup --out - --recipient age1... > auzring.age
    ls -l auzring.age
    ```
    ✅ A non-trivial file. `file auzring.age` says it is age-encrypted (not readable without the key). Verify it: `docker compose -f deploy/docker-compose.yml run --rm -T --no-deps -v $PWD/auzring-backup.key:/k:ro maintenance backup --verify - --identity-file /k < auzring.age` ✅ prints the row counts.

19. **Restore on a scratch copy** (never over the live stack): follow RUNBOOK §6.5 on another host or a second compose project with a copy of `deploy/secrets/`. ✅ `restore` ends with "audit chain intact"; you can sign in with your existing password and authenticator; devices appear and the audit log verifies.

## Part G: Upgrade check for the agent from Phase 4 (about 5 minutes)

20. If you still have a Phase 4 agent running, select it in **Devices**. ✅ It stays online and keeps working, and a self-update job sent to it ends **rejected: this agent version does not support job type agent_update**. That is the expected message: reinstall it once (Part B step 3).

## Part H: Trust checks (about 10 minutes)

21. **Local ceiling.** Reinstall the agent with `--allowed-jobs inventory,wu_scan` (no `agent_update`) and try to roll out 0.9.1: ✅ the job ends `rejected` with the ceiling as the reason.
22. **The server cannot invent a release.** The server's job signature is not enough: on the console (or via the API) there is no way to make agents run a binary the vendor key did not sign. ✅ Your upload attempts in step 4 prove it at the server; the agent repeats the check itself.

## Part I: MSI (needs Windows build tools, about 20 minutes)

23. On a Windows build machine with PowerShell 7, the .NET SDK and Go (see `installer/windows/README.md`):
    ```powershell
    go build -trimpath -ldflags "-s -w -X github.com/auzring1/auzring/internal/shared/version.Version=0.9.1" -o auzring-agent.exe ./cmd/auzring-agent
    ./installer/windows/build.ps1 -AgentExe .\auzring-agent.exe -Version 0.9.1
    ```
    ✅ `auzring-agent-0.9.1-x64.msi` is produced and ICE validation passes. (WiX needs its EULA accepted once — see the README.)
24. On the test VM (elevated) with a fresh token:
    ```powershell
    msiexec /i auzring-agent-0.9.1-x64.msi /qn SERVER=auzring.lab:8443 TOKEN=AURZ1..... /l*v C:\Windows\Temp\auzring-msi.log
    ```
    ✅ Exit code 0 (`$LASTEXITCODE`), service `AuzringAgent` running, the device appears. In the log the token shows as `***`.
    Run the same command again: ✅ exit 0 and **no** second enrollment (the device identity is unchanged). Run it with an empty `TOKEN=`: ✅ exit 1603 with the launch-condition message. `msiexec /x auzring-agent-0.9.1-x64.msi /qn` removes everything; revoke the device in the console.

## What to send back

- Pass or fail for each ✅, with `agent.log`, `rollback-check.log` and `update.json` for any self-update that went wrong.
- Especially: did the service switch and restart cleanly (step 5), did the broken release roll back by itself (step 8), did the security key work (step 11), did the MSI install and uninstall cleanly (steps 23–24)? Those are the parts that could not be tested without a real Windows machine and hardware.

## Known gaps to keep in mind

See [SECURITY.md §9d](../SECURITY.md): Windows self-update, rollback and the MSI are unverified on real machines until you run this; there is no real vendor release key (O7) or code-signing certificate (O5) yet, so Authenticode checking is only enforced in release builds; site scoping covers the device pages only (the catalog, policies and fleet-wide pages stay organization-wide); WebAuthn has only been tested with a virtual authenticator; and a backup of the secrets directory is your job (RUNBOOK §6.1).
