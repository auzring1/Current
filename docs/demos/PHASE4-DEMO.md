# Phase 4 demo script: Windows and driver updates

Goal: see what Windows Update offers a real Windows machine from the console, approve updates by hand and by rule, roll them out through rings, watch an install, use the three restart policies (including the visible countdown), hide an update, and see how Current reports a machine whose updates are controlled by WSUS or Windows Update for Business. Allow about 90 minutes plus the time Windows needs to install updates; Parts A to F are the core.

You need the Phase 1 to 3 setup ([PHASE1-DEMO.md](PHASE1-DEMO.md) to [PHASE3-DEMO.md](PHASE3-DEMO.md)): a running server stack, a console login with your authenticator, and a Windows 10/11 or Server 2019+ test machine. **Use a VM you can revert, and prefer one that is a few months behind on patches** (an old snapshot, or a freshly installed ISO that has never run Windows Update). A fully patched machine has nothing to install, and you will only see the empty state. The examples assume the server name `current.lab`. For Part G you want a second enrolled machine (optional but it is the only way to see a ring wait for another ring).

**Be honest about what is new:** this is the first time the Windows Update Agent (WUA, driven through COM) and the restart countdown run on a real machine. They have only been compiled for Windows, covered by tests against a scripted stand-in, and run read-only on a CI runner. If a scan or an install fails here, that is useful information: keep `C:\ProgramData\Current\logs\agent.log` and the job's log tail from the console.

The Windows machine needs internet access to Windows Update (or to your WSUS server if it uses one; see Part H).

---

## Part A: Upgrade the server and the agent (about 10 minutes)

1. **Get the Phase 4 code and restart the stack.** Data and secrets are kept; migrations `00004` and `00005` run automatically.
   ```bash
   git fetch origin && git checkout phase-4
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
   docker compose -f deploy/docker-compose.yml logs server | grep -i migrat
   ```
   ✅ The server is `healthy`. The console has two new menu entries, **Windows updates** and **Update policy**.

2. **Build the Phase 4 agent** and copy it to the Windows machine (`C:\Temp`):
   ```bash
   GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o current-agent.exe ./cmd/current-agent
   ```
   Older agents cannot run Windows Update jobs and there is no agent self-update until Phase 5, so reinstall: in PowerShell as Administrator
   ```powershell
   cd C:\Temp
   & "C:\Program Files\Current\Agent\slot-a\current-agent.exe" uninstall      # skip if never installed
   ```
   then **Enrollment → New token** in the console and
   ```powershell
   .\current-agent.exe install --server current.lab:8443 --token CUR1.....
   ```
   Approve the device if asked. ✅ It is **online**.

## Part B: First scan (about 10 minutes)

3. Open the device and click the **Windows updates** tab. Within a minute or two of enrolling, the agent scans on its own; to ask right away click **Scan now** (it can take several minutes the first time, and the button shows a spinner).
   ✅ "Last scan <time>", and a table of updates with state (*missing*, *downloaded*, *hidden*, *needs restart*, *failed*), classification, severity and an approval column that says **pending** for everything.
   ✅ No yellow policy banner on a plain test VM. If you see one, read Part H first.
   🔍 *Check on the machine:* `Get-Content C:\ProgramData\Current\logs\agent.log -Tail 40` shows the scan; `(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0").Updates.Count` should be close to the number in the console (drivers are excluded by default).

4. Open **Windows updates** (left menu). ✅ The same updates appear fleet-wide with "1 missing". Click one: the detail shows which device misses it.

## Part C: Approve and install by hand (about 20 minutes)

5. Tick one **small** update (a definition update or a .NET update is quick; avoid the big cumulative update for now) and click **Approve**. ✅ The row says **approved**; nothing installs yet, because no ring covers the machine.

6. **Install now on one device.** Open the device → **Windows updates**, tick that update and click **Install selected → Install** (leave "Do not restart"). ✅ "Install queued". Follow it on the **Jobs** tab: `sent → accepted → running → succeeded` (or `succeeded_reboot` if Windows wants a restart). Open the job: ✅ one line per update with the result.
   🔍 On the machine: `Get-HotFix | Sort InstalledOn -Descending | Select -First 3`, or Settings → Windows Update → Update history, shows it.
   ✅ After the job, the device rescans by itself and the update disappears from the table (or the device shows **This device is waiting for a restart**).

7. **Hide an update.** Tick another update and click **Hide**. ✅ Its state becomes *hidden* after the job finishes, and Windows Update on the machine no longer offers it (Settings → Windows Update). Tick it again and click **Unhide** to restore it.

## Part D: Rings and rules (about 20 minutes)

8. **Update policy → Rings → Add ring.** Name `Pilot`, order `1`. For *Groups* pick a group that contains your test machine (create one on **Groups** first: a static group with just this device, or a dynamic one such as "Product name contains 7-Zip"). Delay `0`, soak `1` hour, success needed `90`%. Leave the restart policy at *Never*. Save. ✅ The ring appears in the table.
   (A device belongs to the first ring, in order, that lists one of its groups. A second ring comes in Part G.)

9. Approved updates now reach the ring. Approve another small update on **Windows updates**. ✅ Within about a minute a Windows-update install job appears on the device's **Jobs** tab, and the update installs. (The scheduler runs once a minute; jobs are created ahead of time and carry the ring's window and restart policy.)

10. **Auto-approval rule.** **Update policy → Auto-approval rules → Add rule**: name `Critical security`, classification *Security Updates*, severity *Critical*, no drivers, wait `0` days. Save. ✅ Critical security updates the fleet knows about turn **approved (rule)** on the next minute tick, and your own decisions are untouched. Decline one that the rule approved and then **Reset to pending**: ✅ the rule does not take the decision back from you while it is a manual one, and a pending update is approved by the rule again.

## Part E: Maintenance window and restart policy (about 20 minutes)

11. Edit the `Pilot` ring: tick **Only install inside a maintenance window**, set days to today and a start time **two minutes from now** with 60 minutes duration. Approve another update. ✅ The job waits (`waiting`, reason "window") until the window opens, then runs. The window is in the machine's local time, not the server's.

12. **Restart after install.** Edit the ring: *Restart after installing* → **Outside active hours, with a countdown**, active hours `00:00`–`23:59` (so "now" is inside active hours), countdown 5 minutes. Approve an update that needs a restart (cumulative updates usually do).
    ✅ After the install the device shows **This device is waiting for a restart**, and **no restart happens** (inside active hours). Now change the active hours to `01:00`–`02:00` (so now is outside them). Within a minute: ✅ the machine shows the Windows shutdown notice "…will restart in 5 minutes" to anyone signed in. Abort it on the machine with `shutdown /a`: ✅ the machine stays up, the console keeps saying it is waiting for a restart, and the plan does **not** start a second countdown on its own (an aborted restart is a decision, use **Restart now…** to try again). Repeat once and let the countdown run out to see the machine restart and the console warning go away after the next report.

13. **Restart now (manual).** On a device that is waiting for a restart click **Restart now…**, leave 15 minutes and confirm. ✅ A restart job succeeds and the countdown appears on the machine; `shutdown /a` aborts it. (Without a countdown of at least one minute the console and API refuse.)

## Part F: Drivers and sources (about 10 minutes)

14. **Update policy → Update source**: tick **Include drivers** and Save. ✅ "Devices will rescan"; within a few minutes the device's **Windows updates** tab lists driver updates (badge *driver*) if Windows Update has any for this hardware. A VM often has none: that is normal. Untick it again.

15. Choose **Microsoft Update** as the service and Save. ✅ The next scan also lists updates for Office and other Microsoft products if installed. Switch back to *whatever each device is configured for*.

## Part G: Staged rollout and failure holds (needs two devices, about 30 minutes)

16. Put device 1 in ring `Pilot` (soak 1 hour, success needed 90%) and device 2 in ring `Broad` (order 2). Approve an update both machines miss. ✅ Device 1 gets a job. Device 2 gets nothing and the update shows no job for it: `Pilot` has to soak first. (To avoid waiting an hour, edit `Pilot` to soak `0` hours after device 1 reported its result: ✅ Device 2 then gets the job on the next tick.)

17. **A failing update stops the rollout.** To force a failure, on device 1 stop the Windows Update service and disable it before the job runs (`Set-Service wuauserv -StartupType Disabled; Stop-Service wuauserv`), approve a new update, and wait for the job to fail. ✅ **Update policy → Held updates** shows the update with the ring and the reason; device 2 does **not** get it. Re-enable the service, then **Release** the hold: ✅ the update continues to `Broad`. (Automatic retries on device 1 stop after 3 failures, no sooner than 24 hours apart.)

## Part H: Policy conflicts (about 10 minutes)

18. On the Windows machine, pretend a WSUS server is configured (PowerShell as Administrator):
    ```powershell
    $k = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate"
    New-Item -Path "$k\AU" -Force | Out-Null
    Set-ItemProperty $k WUServer "http://wsus.example.invalid:8530"
    Set-ItemProperty "$k\AU" UseWUServer 1 -Type DWord
    ```
    Click **Scan now**. ✅ The device tab shows a yellow banner **"Windows updates on this device are managed by another policy"**, effective source *wsus*, with the server name, and the machine appears under **Update policy → Devices managed by another update policy**. The scan itself will likely report an error (the fake server does not exist): ✅ it appears as **The last scan failed** with the cause.
    Remove the test policy: `Remove-Item -Recurse "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate"`. ✅ After the next scan the banner is gone. **Current never writes these policies**; the check proves that.

## Part I: Checks that matter for trust (about 15 minutes)

19. **Local ceiling.** Reinstall the agent with `--allowed-jobs inventory,software_install` (no `wu_*`). Click **Scan now**. ✅ The job ends `rejected` with the ceiling as the reason; the server cannot override it.

20. **Audit.** **Audit log** shows `wu.decision`, `wu.auto_approve`, `wu.install`, `wu.hide`, `wu.scan`, `wu.ring_create`, `wu.rule_create`, `wu.hold`, `wu.hold_release` and `device.reboot` with who did what. 🔒 Verify the chain still checks: `docker compose -f deploy/docker-compose.yml exec server current-server admin verify-audit`.

## What to send back

- Pass or fail for each ✅ above, with the agent log (`C:\ProgramData\Current\logs\agent.log`) and the job log for anything that failed.
- Especially: did the first scan (step 3) and the first install (step 6) work on a real machine, did the restart countdown appear (step 12), and did the policy banner appear (step 18)? Those are the parts that could not be tested without a real Windows installation.

## Known gaps to keep in mind

See [SECURITY.md §9c](../SECURITY.md): the WUA COM code and the restart countdown are unverified on real machines until you run this; there is no loop guard beyond three attempts per device and update; feature updates are treated like any other update; approvals and rings are organization-wide; devices outside every ring are never updated automatically.
