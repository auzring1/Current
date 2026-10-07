# Runbook

Status: covers Phase 1 (server, web console, agent enrollment and connectivity). Later phases extend it.

## 1. Requirements

| Component | Requirement |
|---|---|
| Server host | Linux with Docker Engine 24+ and Compose v2. 2 vCPU, 4 GB RAM and 40 GB disk are enough for Phase 1 and ~2k devices. Sizing for 10k devices comes from the Phase 6 load test. |
| DNS | One name for the server, e.g. `auzring.example.com`. Browsers use `https://<name>`, agents use `<name>:8443`. |
| Inbound firewall to the server | 443/tcp (console). 80/tcp only for Let's Encrypt HTTP challenges. 8443/tcp from every managed endpoint (agent gateway). |
| Outbound from endpoints | 8443/tcp to the server only. |
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
| Gateway certificate | Renewed automatically 30 days before expiry, and re-issued when `AUZ_GATEWAY_SANS` or the hostname changes. Agents trust the CA, not the leaf, so nothing is needed on endpoints. |
| Device certificates | 90-day lifetime. Agents renew automatically when 1/3 of the lifetime remains, and up to 180 days after expiry (for laptops that were offline). |

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
| Agent `rejected` | The device was revoked or rejected. Uninstall, then reinstall with a new token. |
| Logs | Agent: `C:\ProgramData\Auzring\logs\agent.log` (JSON, rotated at 5 MB × 3). Server: `docker compose ... logs server` (JSON; never contains request bodies, cookies or tokens). |
| Console says "Cross-origin request rejected" | `AUZ_PUBLIC_URL` (derived from `AUZ_HOSTNAME` and `AUZ_PUBLIC_PORT_SUFFIX`) must match exactly the URL in the browser's address bar. |
