# Phase 6 demo script: hardening, load test, release pipeline

Goal: see what Phase 6 changed. The database-credential split and a backup through the new `maintenance` service, the install-directory protection and the MSI retest on a real Windows machine, a load test with thousands of simulated agents, a dry run of the release pipeline, and the fuzzers. Allow about 2.5 hours; Parts A to D are the core.

You need the Phase 1 to 5 setup ([PHASE5-DEMO.md](PHASE5-DEMO.md) and earlier): a running server stack on Docker, a console login with your authenticator, and a Windows 10/11 or Server 2019+ test machine **that you can revert**. The examples use the server name `renovatio.lab`. Parts E and F run on any Linux or macOS machine with Go 1.27.1 and Docker (the repository's dev setup); they do not need Windows.

**Be honest about what is new:** the install-directory check and the MSI fix are Windows-only code that has been compiled and vetted but never run on Windows. The release workflow (`release.yml`) has never run on GitHub, and nothing that needs Authenticode, a cloud KMS or Sigstore has been exercised. The load-test numbers come from a 4-CPU sandbox where server, load generator and database share one machine.

---

## Before you start: this build is a fresh install

This script describes the `rename-renovatio` branch, where **everything is called Renovatio**: the service (`RenovatioAgent`), the folders (`C:\Program Files\Renovatio`, `C:\ProgramData\Renovatio`), the environment variables (`RENOVATIO_...`), the database and its roles, the enrollment strings (`RNV1.`) and API tokens (`rnt_`), and the signing contexts. Nothing from an earlier build carries over, so start clean:

1. **Remove the old server stack** (from the old checkout, so the old compose project is found): `docker compose -f deploy/docker-compose.yml down -v`, then delete `deploy/secrets/` and `deploy/.env`. The secrets contain the old database and role names.
2. **Remove the old agent** on the test machine and the VM, with the *old* executable: `& "C:\Program Files\Auzring\Agent\slot-a\auzring-agent.exe" uninstall`, then delete `C:\Program Files\Auzring`, `C:\Program Files\AuzringSetup`, `C:\ProgramData\Auzring` and `C:\ProgramData\AuzringStage` if they are still there. Revoke or delete the old devices if you keep the server. <!-- old-name -->
3. Check out the branch, run `./scripts/init-secrets.sh`, copy `deploy/.env.example` to `deploy/.env` (set `RENOVATIO_HOSTNAME`), and bring the stack up as in [PHASE1-DEMO.md](PHASE1-DEMO.md). Enroll the machines again.

## Part A: Upgrade the stack (about 15 minutes)

Phase 6 changes how the database credentials are handed out. **Read the second paragraph before you restart.**

1. **Get the code and add the one new secret.**
   ```bash
   git fetch origin && git checkout phase-6
   ./scripts/init-secrets.sh        # on an existing install: adds deploy/secrets/postgres_admin_password only
   ```
   ✅ It says "Added … postgres_admin_password (new in Phase 6). Existing secrets were left untouched."

2. **Restart.** `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build`. Migrations run in the new one-shot **`maintenance`** service before the server starts.
   ```bash
   docker compose -f deploy/docker-compose.yml ps -a
   docker compose -f deploy/docker-compose.yml logs maintenance | grep -i migrat
   ```
   ✅ `maintenance` shows `Exited (0)`; the server is `healthy`. An **older database keeps a superuser owner** (PostgreSQL cannot demote that role). That still works; RUNBOOK 6 "Hardening an older database" explains how to move to the non-superuser owner a fresh install gets.

3. ✅ **The server no longer holds the owner credential.**
   ```bash
   docker inspect --format '{{json .Mounts}}' $(docker compose -f deploy/docker-compose.yml ps -q server) | tr ',' '\n' | grep -c "migrate_database_url\|postgres_"
   ```
   prints `0`. (Before Phase 6 the server container had `migrate_database_url`, a superuser connection.)

## Part B: Backup and restore through `maintenance` (about 15 minutes)

4. Backup and restore now run as `docker compose run --rm --no-deps -T maintenance …` (the running server cannot do them any more). With a passphrase for the demo:
   ```bash
   umask 077; openssl rand -base64 24 > backup-pass
   docker compose -f deploy/docker-compose.yml run --rm --no-deps -T -v $PWD/backup-pass:/pass:ro maintenance \
     backup --out - --passphrase-file /pass > renovatio.age
   ls -l renovatio.age
   docker compose -f deploy/docker-compose.yml run --rm --no-deps -T -v $PWD/backup-pass:/pass:ro maintenance \
     backup --verify - --passphrase-file /pass < renovatio.age
   ```
   ✅ A non-trivial file, and `--verify` prints row counts. The restore drill from [PHASE5-DEMO.md](PHASE5-DEMO.md) Part F works the same way with `maintenance restore`.

## Part C: Licensing (removed)

This part demonstrated license keys and the device cap. Both were removed when the project became open source (DECISIONS D100), so there is nothing to try here. Continue with Part D.

## Part D: On the Windows machine (about 30 minutes)

10. **MSI retest.** The first MSI build refused to install on Windows 11 (it believed it was Windows 8.1). Rebuild it from this branch (see `installer/windows/README.md`) and repeat step 24 of [PHASE5-DEMO.md](PHASE5-DEMO.md):
    ```powershell
    (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber    # 17763 or higher
    msiexec /i renovatio-agent-0.9.1-x64.msi /qn SERVER=renovatio.lab:8443 TOKEN=RNV1..... /l*v C:\Windows\Temp\renovatio-msi.log
    ```
    ✅ Exit code 0, service running, device online. If it fails again, `renovatio-msi.log` and `C:\ProgramData\Renovatio\logs\agent.log` are what I need.

11. **Folder squatting.** Before installing, as a **standard (non-admin) user** create the data folder: `mkdir C:\ProgramData\Renovatio`. Then, as Administrator, run `renovatio-agent.exe install …`.
    ✅ It refuses: "`C:\ProgramData\Renovatio` already exists and is owned by <user>, not SYSTEM or Administrators; inspect it, remove it and run install again". Remove the folder as Administrator and install again: ✅ it works, and `icacls C:\ProgramData\Renovatio` shows only SYSTEM and Administrators.
    (Also try a junction: `mklink /J C:\ProgramData\Renovatio C:\Temp`. ✅ Refused as "not a plain directory".)

12. **Account lockout counts MFA mistakes.** In a private window, sign in with the right password and give 10 wrong authenticator codes in a row (you will be sent back to the sign-in page after each fifth). ✅ The account locks for 15 minutes ("locked"), and the audit log has `auth.lockout`. To continue before the 15 minutes are up, run `docker compose -f deploy/docker-compose.yml exec server /renovatio-server admin unlock --email you@example.com`. (Before Phase 6 this took about 50 wrong codes.)

13. **API tokens die with the password.** Create an API token (Account security → API tokens). As an administrator reset that user's password (**Users → ⋮ → Set a temporary password**). ✅ The token no longer works (`401`).

## Part E: Load test (about 30 minutes, Linux, no Windows)

14. Start a local database that the script may create databases on, then run a small and a larger test:
    ```bash
    make dev-db        # prints: export RENOVATIO_TEST_PG_URL=...   (copy the line it prints and run it)
    scripts/loadtest.sh --agents 1000 --scenarios "steady storm" --duration 2m
    ```
    ✅ The script builds everything, starts a server, enrolls 1,000 simulated agents (real enrollment, mTLS, inventory, heartbeats and jobs) and writes `loadtest-results/<time>/summary.md`. A "storm" drops every connection at once and measures the time to recover. Our sandbox numbers are in [../LOADTEST.md](../LOADTEST.md), section 7; compare yours.
    For 10,000 agents raise the open-file limit first (`ulimit -n 30000`) and read section 5 (host tuning, notably `net.core.netdev_max_backlog`).

## Part F: Release pipeline dry run (about 20 minutes, Linux/macOS)

15. A rehearsal with throw-away keys; nothing is signed with a real certificate or sent anywhere:
    ```bash
    scripts/release-dryrun.sh            # a few minutes; add --with-repro for the build-twice comparison
    ```
    ✅ It builds the agent, the server and the web bundle reproducibly, writes CycloneDX SBOMs and checksums, signs a release manifest through the KMS contract (with a fake `aws`), shows that a manifest signed by the wrong key and a tampered binary are refused, and verifies the assembled release directory. Output is in `dist-release/dryrun/` (git-ignored).
    `scripts/verify-reproducible.sh` builds the same commit twice in different directories, time zones and umasks and compares SHA-256s: ✅ identical.
    How customers verify real releases: [../VERIFYING_RELEASES.md](../VERIFYING_RELEASES.md).

16. **Fuzzers.** `make fuzz` runs 20 seconds on each of 19 fuzz targets (about 7 minutes) (job envelopes, enrollment strings, release manifests and bundles, job-body validators, the uninstall-key scanner, installer arguments, archives, backups and others). ✅ No crash. (A crash would leave a failing input under `testdata/fuzz/` to commit as a regression test.)

## Part G: The rename to Renovatio (about 20 minutes, Windows)

The product is **Renovatio**; the company is Auzring (DECISIONS D89, D91).

18. **Names you can see.** Install the agent from this branch (step 3 of [PHASE5-DEMO.md](PHASE5-DEMO.md), with `renovatio-agent.exe`). ✅ `services.msc` shows **Renovatio Agent** with the service name `RenovatioAgent` (`Get-Service RenovatioAgent`); the program is in `C:\Program Files\Renovatio\Agent\slot-a\renovatio-agent.exe` and the data in `C:\ProgramData\Renovatio`. Right-click the exe → Properties → Details: product name *Renovatio*, description *Renovatio Agent*, company *Auzring* (the version fields say 0.0.0.0 for now; the release pipeline does not stamp the real version into them yet). The console title, sign-in page and the authenticator entry say Renovatio.

19. **Nothing of the old name is left on the machine.** ✅ `Get-ChildItem 'C:\Program Files','C:\ProgramData' | Where-Object Name -like '*Auzring*'` returns nothing, and `Get-Service | Where-Object Name -like '*Auzring*'` returns nothing (after step 2 of "Before you start"). <!-- old-name -->

20. **Self-update still works under the new names.** Roll out the "good" release from [PHASE5-DEMO.md](PHASE5-DEMO.md) Part B, built with `scripts/release-demo.sh` from this branch. ✅ Both slot folders appear under `C:\Program Files\Renovatio\Agent`, the service restarts once, and the job succeeds; the scheduled task `\Renovatio\rollback-check` exists only while an update is being confirmed.

21. **MSI.** Build the MSI from this branch and install it on a clean machine (step 24 of [PHASE5-DEMO.md](PHASE5-DEMO.md)). ✅ One entry **Renovatio Agent** (the company, Auzring, as publisher) in Apps & features; `msiexec /x` removes the service and both folders. (The MSI's upgrade code is unchanged, but its service and folder names are not, so do not install it over an agent from an earlier build.)

## What to send back

- Pass or fail for each ✅, with logs for anything that failed.
- Especially: the **MSI install** (step 10), the **folder-squatting refusal** (step 11) and Those cannot be tested without a real Windows machine and a real stack.

## Known gaps to keep in mind

See [SECURITY.md §9f](../SECURITY.md) (open risks R-1 to R-10: no ACL check on uninstaller executables, no root-signed key revocation, no four-eyes approval, no scheduled audit verification and others), §9e (release pipeline). `release.yml`, Authenticode signing, the cloud KMS paths and the MSI build inside the workflow are written but unexecuted. No real vendor release key (O7) or code-signing certificate (O5) exists yet; everything above uses throw-away keys. The 10,000-agent run was done once, in a sandbox.
