# Phase 6 demo script: hardening, licensing, load test, release pipeline

Goal: see what Phase 6 changed. The database-credential split and a backup through the new `maintenance` service, license keys and the device cap, the install-directory protection and the MSI retest on a real Windows machine, a load test with thousands of simulated agents, a dry run of the release pipeline, and the fuzzers. Allow about 2 hours; Parts A to D are the core.

You need the Phase 1 to 5 setup ([PHASE5-DEMO.md](PHASE5-DEMO.md) and earlier): a running server stack on Docker, a console login with your authenticator, and a Windows 10/11 or Server 2019+ test machine **that you can revert**. The examples use the server name `renovatio.lab`. Parts E and F run on any Linux or macOS machine with Go 1.27.1 and Docker (the repository's dev setup); they do not need Windows.

**Be honest about what is new:** the install-directory check and the MSI fix are Windows-only code that has been compiled and vetted but never run on Windows. The release workflow (`release.yml`) has never run on GitHub, and nothing that needs Authenticode, a cloud KMS or Sigstore has been exercised. The load-test numbers come from a 4-CPU sandbox where server, load generator and database share one machine.

---

## Part A: Upgrade the stack (about 15 minutes)

Phase 6 changes how the database credentials are handed out. **Read the second paragraph before you restart.**

1. **Get the code and add the one new secret.**
   ```bash
   git fetch origin && git checkout phase-6
   ./scripts/init-secrets.sh        # on an existing install: adds deploy/secrets/postgres_admin_password only
   ```
   ✅ It says "Added … postgres_admin_password (new in Phase 6). Existing secrets were left untouched."

2. **Restart.** `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build`. Migration `00009` (licenses) runs in the new one-shot **`maintenance`** service before the server starts.
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

## Part C: Licensing (about 25 minutes)

You act as the vendor. The demo uses a throw-away license key; real keys are an owner decision (O8) and do not exist yet.

5. **Make a demo license key and give the server its public half.**
   ```bash
   mkdir -p dist-demo && go run ./cmd/renovatio-license keygen --out dist-demo/license.key
   ```
   It prints `public key hex …`. Put `AUZ_LICENSE_PUBLIC_KEYS=<that hex>` in `deploy/.env` and recreate the server (`up -d server`). Open **License** (administrators only). ✅ State **Unlicensed (evaluation)**, "0 of 25 devices".

6. **The evaluation cap.** If you have 25 or fewer devices nothing happens; to see the cap you can lower it by installing a small license below. Sign a license for 3 devices, valid 30 days:
   ```bash
   go run ./cmd/renovatio-license sign --key dist-demo/license.key --licensee "Demo GmbH" --max-devices 3 \
       --expires "$(date -u -d '+30 days' +%F)" --out dist-demo/three.lic
   cat dist-demo/three.lic
   ```
   Paste the text (it starts with `AZL1.`) into **License → Install license**. ✅ State **Licensed**, "N of 3 devices", the history shows one entry, the audit log has `license.install`.

7. **What a full license does and does not do.** With 3 devices already enrolled, create an enrollment token and try to enroll a 4th machine (or a test VM).
   ✅ The installer prints `device limit reached: … An administrator can install a license under License …`; the agent service keeps retrying every 15 minutes. A pending device cannot be approved (the console says why). ✅ **Everything else keeps working**: the 3 enrolled devices stay online and can be patched, deployments and sign-in work, and revoking a device frees its slot. Re-enrolling a known machine (same hardware) is always allowed.

8. **Refusals.** Try pasting `AZL1.garbage.garbage`, and a license signed by another key (`keygen --out dist-demo/other.key` and sign with that). ✅ Both are refused with a reason and audited (`license.invalid`); the installed license is untouched. Install a bigger license (`--max-devices 100`, new run of `sign`): ✅ the waiting 4th machine enrolls by itself within 15 minutes, or at once if you restart its service.

9. **Update period.** Sign a license with `--updates-until 2026-01-01` and try to upload or roll out an agent release from [PHASE5-DEMO.md](PHASE5-DEMO.md) (released after that date). ✅ "License: updates ended" — and Windows, driver and software updates are unaffected.

## Part D: On the Windows machine (about 30 minutes)

10. **MSI retest.** The first MSI build refused to install on Windows 11 (it believed it was Windows 8.1). Rebuild it from this branch (see `installer/windows/README.md`) and repeat step 24 of [PHASE5-DEMO.md](PHASE5-DEMO.md):
    ```powershell
    (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber    # 17763 or higher
    msiexec /i renovatio-agent-0.9.1-x64.msi /qn SERVER=renovatio.lab:8443 TOKEN=AURZ1..... /l*v C:\Windows\Temp\renovatio-msi.log
    ```
    ✅ Exit code 0, service running, device online. If it fails again, `renovatio-msi.log` and `C:\ProgramData\Auzring\logs\agent.log` are what I need.

11. **Folder squatting.** Before installing, as a **standard (non-admin) user** create the data folder: `mkdir C:\ProgramData\Auzring`. Then, as Administrator, run `renovatio-agent.exe install …`.
    ✅ It refuses: "`C:\ProgramData\Auzring` already exists and is owned by <user>, not SYSTEM or Administrators; inspect it, remove it and run install again". Remove the folder as Administrator and install again: ✅ it works, and `icacls C:\ProgramData\Auzring` shows only SYSTEM and Administrators.
    (Also try a junction: `mklink /J C:\ProgramData\Auzring C:\Temp`. ✅ Refused as "not a plain directory".)

12. **Account lockout counts MFA mistakes.** In a private window, sign in with the right password and give 10 wrong authenticator codes in a row (you will be sent back to the sign-in page after each fifth). ✅ The account locks for 15 minutes ("locked"), and the audit log has `auth.lockout`. To continue before the 15 minutes are up, run `docker compose -f deploy/docker-compose.yml exec server /renovatio-server admin unlock --email you@example.com`. (Before Phase 6 this took about 50 wrong codes.)

13. **API tokens die with the password.** Create an API token (Account security → API tokens). As an administrator reset that user's password (**Users → ⋮ → Set a temporary password**). ✅ The token no longer works (`401`).

## Part E: Load test (about 30 minutes, Linux, no Windows)

14. Start a local database that the script may create databases on, then run a small and a larger test:
    ```bash
    make dev-db        # prints: export AUZ_TEST_PG_URL=...   (copy the line it prints and run it)
    scripts/loadtest.sh --agents 1000 --scenarios "steady storm" --duration 2m
    ```
    ✅ The script builds everything, signs itself a throw-away license, starts a server, enrolls 1,000 simulated agents (real enrollment, mTLS, inventory, heartbeats and jobs) and writes `loadtest-results/<time>/summary.md`. A "storm" drops every connection at once and measures the time to recover. Our sandbox numbers are in [../LOADTEST.md](../LOADTEST.md), section 7; compare yours.
    For 10,000 agents raise the open-file limit first (`ulimit -n 30000`) and read section 5 (host tuning, notably `net.core.netdev_max_backlog`).

## Part F: Release pipeline dry run (about 20 minutes, Linux/macOS)

15. A rehearsal with throw-away keys; nothing is signed with a real certificate or sent anywhere:
    ```bash
    scripts/release-dryrun.sh            # a few minutes; add --with-repro for the build-twice comparison
    ```
    ✅ It builds the agent, the server and the web bundle reproducibly, writes CycloneDX SBOMs and checksums, signs a release manifest through the KMS contract (with a fake `aws`), shows that a manifest signed by the wrong key and a tampered binary are refused, and verifies the assembled release directory. Output is in `dist-release/dryrun/` (git-ignored).
    `scripts/verify-reproducible.sh` builds the same commit twice in different directories, time zones and umasks and compares SHA-256s: ✅ identical.
    How customers verify real releases: [../VERIFYING_RELEASES.md](../VERIFYING_RELEASES.md).

16. **Fuzzers.** `make fuzz` runs 20 seconds on each of 19 fuzz targets (about 7 minutes) (job envelopes, enrollment strings, release manifests and bundles, license documents, job-body validators, the uninstall-key scanner, installer arguments, archives, backups and others). ✅ No crash. (A crash would leave a failing input under `testdata/fuzz/` to commit as a regression test.)

## What to send back

- Pass or fail for each ✅, with logs for anything that failed.
- Especially: the **MSI install** (step 10), the **folder-squatting refusal** (step 11) and whether the evaluation cap and the license install behaved as described (steps 5–8). Those cannot be tested without a real Windows machine and a real stack.

## Known gaps to keep in mind

See [SECURITY.md §9f](../SECURITY.md) (open risks R-1 to R-10: no ACL check on uninstaller executables, no root-signed key revocation, no four-eyes approval, no scheduled audit verification and others), §9e (release pipeline) and §9g (licensing). Licensing is deterrence only. `release.yml`, Authenticode signing, the cloud KMS paths and the MSI build inside the workflow are written but unexecuted. No real vendor release key (O7), code-signing certificate (O5) or license key exists yet; everything above uses throw-away keys. The 10,000-agent run was done once, in a sandbox.
