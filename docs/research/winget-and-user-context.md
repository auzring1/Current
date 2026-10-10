# Research: winget under SYSTEM vs. a user token, and user-context execution

This note is the "research and document first" step the brief asks for. It covers how winget behaves in each context, and how the agent will run code in a user's session safely.

The confidence column says whether each fact is **confirmed** from a primary source during Phase 0, or is **to verify** in the Phase 3 spike on real VMs. Nothing marked "to verify" is load-bearing until a test proves it.

## 1. Facts about winget

| # | Fact | Source | Confidence |
|---|---|---|---|
| W1 | winget ships inside App Installer, which is an MSIX package. MSIX packages are registered per user and **cannot be registered for NT AUTHORITY\SYSTEM**. So the **winget CLI is not supported in the system context**. | Microsoft Learn, *Troubleshoot WinGet*, "System Context" ([source](https://github.com/MicrosoftDocs/windows-dev-docs/blob/docs/hub/package-manager/winget/troubleshooting.md)) | Confirmed |
| W2 | "The Microsoft.WinGet.Client PowerShell module can be used in the system context **with applications that are installed machine wide**." | Same page | Confirmed |
| W3 | Running SYSTEM-context winget through `Microsoft.WinGet.Client` needs PowerShell 7 in an MTA apartment. Many management tools can't run that. | [winget-cli#3049](https://github.com/microsoft/winget-cli/issues/3049) and community write-ups ([call4cloud](https://call4cloud.nl/cloudy-with-a-chance-of-winget/)) | Confirmed (community) |
| W4 | Common RMM workaround: resolve `winget.exe` under `C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_*` and run it as SYSTEM. It often half-works: sources fail to initialize, agreements aren't accepted, and there's no PATH. | Community reports (above) | Confirmed (community); we will **not** rely on it |
| W5 | `winget install --scope user` run as SYSTEM installs into **SYSTEM's own profile** (`C:\Windows\System32\config\systemprofile\...`). Shortcuts break and the real user never sees the app. | Brief and community reports | To verify (Phase 3 spike; observation only) |
| W6 | `Repair-WinGetPackageManager` assumes a logged-on user and is unreliable under SYSTEM. | Brief | To verify (we don't depend on it) |
| W7 | winget manifests (schema 1.6+) contain everything an installer engine needs: `InstallerUrl`, `InstallerSha256`, `InstallerType`, `NestedInstallerType`/`NestedInstallerFiles`, `Scope`, `Architecture`, `InstallerSwitches` (Silent, SilentWithProgress, Custom, Log, InstallLocation, Upgrade), `InstallerSuccessCodes`, `ExpectedReturnCodes`, `UpgradeBehavior`, `ProductCode`, `AppsAndFeaturesEntries` (DisplayName, ProductCode, UpgradeCode), `ElevationRequirement`, `Dependencies`, `MinimumOSVersion`. | winget-pkgs manifest schema ([microsoft/winget-cli/schemas](https://github.com/microsoft/winget-cli/tree/master/schemas/JSON/manifests)) | Confirmed |
| W8 | Manifests often lack `Scope` or reliable silent switches, especially for `exe` installers. Defaults by installer type fill most gaps (Inno, NSIS, MSI, Burn), but plain `exe` with no `Silent` switch can't be automated safely. | Manifest review | Confirmed; this is why the `verified` flag exists |
| W9 | The pre-indexed winget source (`source2.msix` on the winget CDN) is a signed MSIX containing a SQLite index. Manifests are fetched individually from the same CDN. | winget-cli source | To verify: exact index format and whether it carries per-manifest hashes (Phase 3 spike) |

### What that means for us
- **We do not run winget to install anything.** The winget repository is our *catalog* (W7). The agent's own installer engine does download, hash check, Authenticode check and silent run. This sidesteps W1 to W6 entirely, gives exact exit codes and logs, and lets us enforce hashes.
- `Microsoft.WinGet.Client` / COM is kept as an **optional fallback, machine scope only** (W2), for installer types our engine doesn't handle yet. It's off by default and audited when used.
- User-scope packages run **as the user**, through our helper, with the same engine code (§2).

## 2. Running code in the user's session

| # | Fact | Confidence |
|---|---|---|
| U1 | `WTSQueryUserToken(sessionId)` returns the primary token of the user logged on to that session. The caller must be LocalSystem (it needs `SE_TCB_NAME`), which our service is. | Confirmed (Win32 docs) |
| U2 | Under UAC, for an administrator the returned token is the **filtered (limited) token**. The elevated token is only reachable through `TokenLinkedToken`, which we never request. So the helper runs non-elevated by default, which is what we want. | To verify on 10/11 in the Phase 3 spike |
| U3 | `CreateEnvironmentBlock` + `LoadUserProfile` + `CreateProcessAsUser` with `lpDesktop = "winsta0\\default"` gives a normal user process with the right `%APPDATA%`/`%LOCALAPPDATA%`, which per-user installers need. | Confirmed (Win32 docs) |
| U4 | `STARTUPINFOEX` with `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` passes **only** the listed handles to the child. That lets us give the helper one end of an anonymous pipe. There's no pipe name, so nothing else can squat on it or connect to it. | Confirmed (Win32 docs) |
| U5 | Any process running as the same user at the same integrity level can open the helper process and tamper with it. **This can't be prevented, and it doesn't matter for security**, because the helper never has more rights than the user. The service treats everything the helper says as untrusted data. | Design conclusion |
| U6 | `SERVICE_CONTROL_SESSIONCHANGE` (`WTS_SESSION_LOGON`, `WTS_SESSION_UNLOCK`, `WTS_REMOTE_CONNECT`) tells the service a user session is available, so we don't need to poll. | Confirmed |
| U7 | Fast user switching and RDP mean one device can have several active sessions. `WTSEnumerateSessions` + `WTSQuerySessionInformation(WTSUserName/WTSSessionInfoEx)` map SIDs to sessions. | Confirmed |
| U8 | Offline profiles: `RegLoadAppKey` loads an `NTUSER.DAT` **privately**, without mounting it under HKU or needing `SeRestorePrivilege`. If the hive is locked, the user is logged on and we read `HKU\<SID>` instead. | **Spike result (Windows CI, 2026-10-07): a direct `RegLoadAppKey` with a read-only mask modified the hive file** (a `reg save` file changed its hash after load/close). The agent therefore copies the hive and its `.LOG1`/`.LOG2` into a temporary directory under the protected data directory and loads the copy (D40). Whether a clean, never-loaded real profile is also rewritten is still to confirm in the Phase 3 VM matrix; the copy makes it irrelevant for safety |
| U9 | Per-user AppX: `Windows.Management.Deployment.PackageManager.FindPackagesForUser(sid)` (WinRT) lists packages for any user when called as SYSTEM. | **Not done in Phase 2.** The collector reads `AppxAllUserStore` from the registry instead (decision D33); the Windows CI job logs per-source counts so the registry route can be compared against `Get-AppxPackage -AllUsers` in the Phase 3 VM matrix. WinRT from Go stays a Phase 3 item |

### How others solve this (from the brief, used as design input)
- **Action1** converts per-user installs to machine-wide when patching, because binaries in user-writable paths can be tampered with by a compromised standard user.
- **Patch My PC** patches machine-wide installs through the normal update path. User-scope apps are separate catalog entries that need a user-context install channel.
- **Intune Enterprise App Catalog** has a per-app system/user setting and installs through the management extension rather than the winget client.
- **Winget-AutoUpdate** uses two scheduled tasks: one as SYSTEM, and one as the user at logon.

Our design combines these. Per-app policy (Report only / Update in place / Convert to machine-wide / Remove) gives admins the Action1 behaviour as a choice. Our own engine matches the Intune approach. Session-change events, with a SYSTEM-principal logon task as backup, give the Winget-AutoUpdate coverage without a scheduled task running as the user. A user-principal task would need a user-to-SYSTEM IPC channel, and we deliberately don't have one.

## 3. Spike plan (first days of Phase 2 and Phase 3)
1. Confirm U2 (filtered token) on Windows 10 22H2 and 11 24H2, with an admin user and a standard user.
2. Confirm W5 and record what breaks, for the docs.
3. `RegLoadAppKey` on a copied profile: check the hive hash before and after (U8).
4. WinRT `FindPackagesForUser` from Go under SYSTEM (U9).
5. winget `source2.msix`: verify its signature on Linux and document the index schema (W9).

## 4. Phase 3 spike status (honest record)

What the Phase 3 build could and could not establish. Nothing below was observed on a real multi-user Windows VM; the sandbox this phase was built in is Linux-only with no outbound access to the winget CDN.

| Item | Result |
|---|---|
| **W7/W8 (manifests carry what an engine needs; switches are unreliable for plain `exe`)** | Confirmed against real manifests committed as fixtures (7-Zip: several installer entries across architectures and types, no `Scope`; VS Code: root-level fields inherited by every installer, user and machine variants). The importer therefore maps `wix`→MSI and `nullsoft`→NSIS, derives default silent switches per installer type, and marks an `exe` with no silent switch **unsupported** instead of guessing |
| **W9 (winget CDN index format and signature)** | **Not done.** The CDN could not be reached or verified from the build environment, so the catalog imports manifests from the `winget-pkgs` repository on GitHub (D41). A probe from a network that can reach `cdn.winget.microsoft.com` is still needed before index sync can be built |
| **W5 (`--scope user` under SYSTEM installs into the SYSTEM profile)** | Not tested; irrelevant to the design because Current never runs the winget CLI (D11) |
| **U2 (WTSQueryUserToken returns a filtered token for an admin user)** | Implemented as designed (`helper_windows.go` takes the primary token and never the linked token); **not yet confirmed** on Windows 10/11 with an admin and a standard user |
| **U8 (offline hive load leaves the hive untouched)** | Done in Phase 2 (D40) |
| **U9 (WinRT `FindPackagesForUser` from Go)** | Not done; MSIX is marked unsupported in Phase 3 (D46) |
| **Job Object tree tracking with installers that respawn** | Implemented (kill-on-close Job Object, whole-tree wait and timeout kill); `TestWinRunExitCodeAndTimeout` covers a hung child tree on the Windows CI runner. Real-world respawning EXE installers (Chrome, Zoom) still need the VM matrix |

Next spikes, in order: run `test/vm-matrix/run.ps1` on a Windows 11 VM with one admin and one standard user (this settles U2 and the helper); probe the winget CDN index; try `PackageManager` for MSIX.
