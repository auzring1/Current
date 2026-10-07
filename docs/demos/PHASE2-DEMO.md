# Phase 2 demo script: software inventory

Goal: see everything installed on a real Windows machine (machine-wide, per-user, offline profiles, MSI, Store apps), watch installs and uninstalls show up within about a minute, search the whole fleet, build a dynamic group ("laptops with Chrome older than 130"), and export a CSV that cannot run formulas. Allow about 40 minutes.

You need the Phase 1 setup from [PHASE1-DEMO.md](PHASE1-DEMO.md): a running server stack, a console login with your authenticator, and a Windows test machine (a VM, or your own PC; the agent runs as a service and only reads data). Phase 1's agent has no self-update yet, so the agent is reinstalled in step 3.

The examples assume the server name `auzring.lab` as in Phase 1.

---

## Part A: Upgrade the server (about 5 minutes)

1. **Get the Phase 2 code and restart the stack.** Your data and secrets are kept; the database migration (`00002_inventory`) runs automatically.
   ```bash
   git fetch origin && git checkout phase-2
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
   docker compose -f deploy/docker-compose.yml logs server | grep -i migrat
   ```
   ✅ The log shows the migration applied and the server is `healthy`. The console still signs you in with your existing account.

2. **Build the new agent** (any machine with Go 1.27):
   ```bash
   GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o auzring-agent.exe ./cmd/auzring-agent
   ```
   Copy it to the Windows machine (for example `C:\Temp`).

## Part B: Reinstall the agent and see the first inventory (about 10 minutes)

3. On the Windows machine, in **PowerShell as Administrator**:
   ```powershell
   cd C:\Temp
   & "C:\Program Files\Auzring\Agent\slot-a\auzring-agent.exe" uninstall      # skip if the agent was never installed
   ```
   In the console create a new enrollment token (**Enrollment → New token**, approval **off** is fine), then:
   ```powershell
   .\auzring-agent.exe install --server auzring.lab:8443 --token AURZ1.....
   ```
   If the old device is still listed, it is now **revoked** or **pending** (same hardware re-enrolls and needs approval; approving it retires the old identity). Approve the new one.

4. Open the device (**Devices → click the device**). ✅ New tabs: **Overview, Hardware, Software, Users, Client certificates**.
   - **Software** lists what Windows lists under *Settings → Apps*, plus Microsoft Store apps. ✅ Compare it with *Settings → Apps → Installed apps*: names and versions agree. The column **Installed for** shows "all users" or a user name for per-user installs; **Type** shows the source (`reg64`, `reg32`, `hku`, `msi`, `appx`, `portable`). Tick **Show system components** to include hidden components (updates, runtimes).
   - **Users** lists the local/domain profiles on the machine with last logon, whether the user is signed in right now, and whether they are an administrator.
   - **Hardware** now has a **BitLocker** column per disk (`protected`, `unprotected`, `encrypting`, `unsupported` on editions without BitLocker, or empty if it could not be read).

5. **Check the agent's cost.** In PowerShell:
   ```powershell
   $p = (Get-CimInstance Win32_Service -Filter "Name='AuzringAgent'").ProcessId
   Get-Process -Id $p | Select WS, CPU
   Get-Content C:\ProgramData\Auzring\logs\agent.log -Tail 20     # "full software inventory sent", items=N
   ```
   ✅ Working set stays well under 30 MB after the scan; the log shows a single full snapshot and then nothing while idle.

## Part C: Change detection (about 10 minutes)

6. **Machine-wide change.** Create a fake product (no installer needed) and watch it appear:
   ```powershell
   $k = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\DemoBrowser"
   New-Item $k -Force | Out-Null
   New-ItemProperty $k -Name DisplayName -Value "Demo Browser" | Out-Null
   New-ItemProperty $k -Name DisplayVersion -Value "129.0.6668.1" | Out-Null
   New-ItemProperty $k -Name Publisher -Value "Demo Corp" | Out-Null
   ```
   ✅ Within about a minute (30 s quiet period) **Demo Browser 129.0.6668.1** appears in the device's Software tab *without reloading*. The agent log shows `software delta sent upserts=1 removes=0`.
   Tick **Change history** ✅ one `added` entry. (The very first inventory creates no history.)

7. **Upgrade and uninstall.**
   ```powershell
   Set-ItemProperty $k -Name DisplayVersion -Value "130.0.1"
   ```
   ✅ Software tab shows 130.0.1; history shows `version 129.0.6668.1 → 130.0.1`.
   Then `Remove-Item $k` ✅ the row disappears and history shows `removed`. Recreate it at 129.x again for the next part.

8. **Per-user software and offline profiles.**
   - Create a second local user and sign in once so its profile exists: `net user demo2 "Demo-Passw0rd-2026" /add`, then sign in as `demo2` (Switch user) and sign out again.
   - Sign back in as yourself and add a per-user entry **into demo2's hive while it is offline**, so the agent has to load it read-only:
     ```powershell
     reg load HKU\demo2 C:\Users\demo2\NTUSER.DAT
     reg add "HKU\demo2\Software\Microsoft\Windows\CurrentVersion\Uninstall\Demo2Tool" /v DisplayName /d "Demo2 Tool" /f
     reg add "HKU\demo2\Software\Microsoft\Windows\CurrentVersion\Uninstall\Demo2Tool" /v DisplayVersion /d "2.0" /f
     reg unload HKU\demo2
     ```
   - Make the agent rescan: `Restart-Service AuzringAgent` (the daily reconcile does this on its own).
   ✅ **Demo2 Tool 2.0** appears with **Installed for = the demo2 user**, `source hku`. No sign-in as demo2 was needed.
   - 🔒 *Check:* hash the profile hive before and after a rescan; it must not change: `Get-FileHash C:\Users\demo2\NTUSER.DAT` (the agent opens it read-only via `RegLoadAppKey`).

9. **Real installers** (optional): install any MSI or Store app (for example 7-Zip, VLC or a Store app such as Windows Terminal) and uninstall it. ✅ Both changes appear within about a minute, with the right source (`reg64`/`msi`/`appx`).

## Part D: Fleet search, groups and export (about 10 minutes)

10. **Fleet-wide search.** Open **Software** and search `demo`. ✅ One row **Demo Browser** (publisher Demo Corp) with 1 device and 1 version. Click it: the drawer lists each version and the devices that have it; click a version to filter. (With more devices enrolled, this answers "which devices have app X and which versions".)

11. **Normalization.** Search `7-zip` (if installed): "7-Zip 23.01 (x64 edition)" and "7-Zip 24.08" are **one product** with two versions.

12. **Dynamic group.** Open **Groups → New group**, name it `Old demo browser`.
    - Keep the first condition **Has software** `demo browser`, set **version <** `130`.
    - **Preview matches** ✅ shows your device (Demo Browser is 129.x). Change the version to `129` and preview again ✅ 0 devices (129.0.6668.1 is not older than 129).
    - Add **+ Device condition → Form factor is one of** (default laptop types), or *Operating system contains* `windows`, and preview again to see the AND behaviour. Use **NOT** to invert a condition.
    - **Save group**, then click the group's name ✅ the member list. Change Demo Browser's version in the registry (step 7) and re-open the group: ✅ membership follows within a minute, because it is recomputed on demand.
    - 🔒 *Check:* a filter the server does not accept (for example an empty software name) shows a clear error instead of running.

13. **CSV export.** First plant a hostile name:
    ```powershell
    $k2 = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\DemoFormula"
    New-Item $k2 -Force | Out-Null
    New-ItemProperty $k2 -Name DisplayName -Value '=HYPERLINK("http://example.invalid","click")' | Out-Null
    New-ItemProperty $k2 -Name DisplayVersion -Value "1.0" | Out-Null
    ```
    Then **Software → Export CSV** and open the file in Excel or LibreOffice.
    ✅ The row shows the text `'=HYPERLINK(...)` as plain text, not a clickable formula. In a text editor the cell starts with `'=`.
    Also try **Groups → (group) → Export CSV** ✅ a device list.
    Open **Audit log** ✅ two `inventory.export` entries with who, when and which report.
    - 🔒 *Check:* the **read-only** role cannot export (it has no `inventory:export`); the API answers 403.

## Part E: Resilience (about 5 minutes)

14. **Lost connection.** On the Windows machine run `Stop-Service AuzringAgent`, change a registry entry (for example set Demo Browser to 131.0), `Start-Service AuzringAgent`. ✅ After reconnecting, the console shows 131.0 (the agent sends what changed since the last acknowledged state).

15. **Server restored from an older backup (simulated).** On the server:
    ```bash
    docker compose -f deploy/docker-compose.yml exec postgres psql -U auzring_owner -d auzring -c "UPDATE devices SET software_rev = 0, software_count = 0; DELETE FROM software_installs;"
    docker compose -f deploy/docker-compose.yml restart server
    ```
    ✅ The software list is empty for a moment, then **repopulates by itself**: the agent's Hello revision no longer matches, so the server asks for a full snapshot. The agent log shows `full software inventory sent`.

## Clean up
```powershell
Remove-Item HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\DemoBrowser, HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\DemoFormula -ErrorAction SilentlyContinue
net user demo2 /delete
```
Remove the agent with `auzring-agent.exe uninstall` when you are done.

## What to tell me
Anything that looks wrong in the Software tab compared with *Settings → Apps*, any missing Store apps, any BitLocker value that looks wrong for your machine, and how long the 30-second change detection felt. The Windows-only collectors have been run by CI on a clean runner only; your real machine is the first full-profile test.
