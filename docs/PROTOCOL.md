# Agent ↔ Server Protocol (v1)

Status: **v1 implemented in Phase 1.** The normative source is `proto/auzring/agent/v1/*.proto` (`buf lint` runs in CI). This document explains intent, ordering and validation rules that protobuf can't express.

**Phase 1 scope:**
- Implemented: enrollment, approval polling, the `Connect` stream (Hello/HelloAck, Heartbeat, hardware inventory with Ack, SecurityEvent, GoAway), `RenewCertificate`, signing-certificate distribution, and agent-side envelope verification.
- Not yet: the server sends no `JobOffer` messages until Phase 3; software inventory deltas and `InventoryChunk` arrive in Phase 2; content download arrives in Phase 3.

**Message names in the `.proto` files:**

| This document | `.proto` |
|---|---|
| `Enrollment` | `EnrollmentService` |
| `AgentChannel` | `AgentChannelService` |
| `AgentMessage` | `ConnectRequest` |
| `ServerMessage` | `ConnectResponse` |

Both `EnrollResponse` and `EnrollStatusResponse` wrap a shared `EnrollResult`.

## 1. Transport
- **gRPC over HTTP/2 over TLS 1.3 only** (`MinVersion = MaxVersion = TLS13`). TLS 1.3 cipher suites aren't configurable in Go; all three are AEAD.
- Server port: **8443** by default, published directly from the server container. It's never terminated by Caddy or any other proxy.
- The agent supports an HTTPS `CONNECT` proxy (system WinHTTP setting or `config.json`). **A TLS-inspecting proxy breaks mTLS by design.** The customer must exempt the gateway host, and the RUNBOOK says so.
- The max message size is 4 MiB. Larger payloads (full inventory) are chunked.

## 2. Trust anchors and certificates

```
Root CA (ECDSA P-384, 20y)  — key encrypted with an owner passphrase; unlocked only for root operations
 ├── Issuing CA (P-384, 5y, pathlen 0, EKU serverAuth+clientAuth)   — key encrypted with server KEK
 │    ├── Gateway server cert (P-256, 90d, auto-renewed, SAN = configured gateway hostnames/IPs)
 │    └── Device client certs (P-256, 90d; CN = device UUID; URI SAN urn:auzring:device:<uuid>; EKU clientAuth)
 └── Job-signing cert (Ed25519, 2y, EKU = 1.3.6.1.4.1.32473.7231.1.1 "auzring job signing" (placeholder PEN, see DECISIONS D25), issued *directly* by root)
```

- **The agent pins the root** by SPKI SHA-256 from its enrollment bundle. It accepts a job-signing certificate only if the root issued it directly and it has the job-signing EKU. The issuing CA can't produce one, because of its EKU constraint and path rule. So stealing the TLS issuing key does **not** let an attacker sign jobs.
- **The device key is generated on the device.** It uses CNG: `Microsoft Platform Crypto Provider` (TPM 2.0) when available, otherwise `Microsoft Software Key Storage Provider` with `NCRYPT_MACHINE_KEY_FLAG` and export disabled. It's exposed to Go's TLS stack as a `crypto.Signer`. The private key never exists in agent memory or on disk in plaintext.
- **Placeholder:** 32473 is IANA's documentation PEN (RFC 5612). It will be replaced by a registered PEN before release; agents will accept both during the transition.
- **Backdating:** every certificate's `NotBefore` is backdated by `pkix.CertBackdate` (5 min) to tolerate clock skew. The intended lifetime is `NotAfter − NotBefore − 5 min`, and agents use that for renewal decisions.

## 3. Enrollment bundle

The MSI or command line takes one opaque string:

```
AURZ1.<base64url(JSON)>
{"v":1,"gw":"agents.example.com:8443","root":"sha256/<b64 SPKI hash>","tok":"<32-byte random b64url>","org":"<uuid>"}
```

The token is shown to the admin once. The server stores only `SHA-256("auzring/enroll-token/v1\0" || token)`, because the token is 256-bit random and a slow hash isn't needed. After the server accepts the enrollment (approved *or* pending), the agent erases the token from `config.json`.

**Install command:** `auzring-agent.exe install --server host:port --token AURZ1....`. `--server` overrides the gateway address inside the bundle; the root pin always comes from the bundle.

## 4. RPCs

```proto
service Enrollment {                        // TLS required, client cert NOT required
  rpc Enroll(EnrollRequest) returns (EnrollResponse);
  rpc EnrollStatus(EnrollStatusRequest) returns (EnrollResponse); // only while pending approval
}
service AgentChannel {                      // client cert REQUIRED (interceptor + VerifyConnection)
  rpc Connect(stream AgentMessage) returns (stream ServerMessage);
  rpc RenewCertificate(RenewRequest) returns (RenewResponse); // also allowed with an expired-but-in-grace cert
}
// Content: HTTPS GET on the same listener, mTLS required (see §8)
```

The listener uses `tls.VerifyClientCertIfGiven`. A gRPC interceptor allows the two `Enrollment` methods without a certificate and **rejects every other method unless a verified, active, non-revoked device certificate is present**.

### 4.1 Enroll
```
EnrollRequest  { token, csr_der (P-256), hostname, smbios_uuid, serial, os_build, arch, agent_version }
EnrollResponse { status [APPROVED|PENDING|REJECTED], device_id, ticket (if pending),
                 client_cert_der, issuing_ca_der, job_signing_certs_der[], retry_after_s }
```
**The server checks:**

- the token hash exists, isn't expired or revoked, and `used_count < max_uses` (incremented in the same transaction);
- the CSR is well-formed and self-signed with a P-256 key;
- rate limits: per source IP 10/min, per token 60/min, globally configurable.

Failures return one generic error. The detailed reason goes to the audit log only.

**Duplicate devices.** If `smbios_uuid`+`serial` matches an active device, the request becomes a **re-enrollment** that needs approval, regardless of the token setting. This stops one token from silently taking over an existing device's identity.

**Pending approval.** `EnrollStatus(ticket)` is called at the server-suggested interval (`retry_after_s`; 60 s by default, configurable with `AUZ_ENROLL_POLL_INTERVAL`) plus up to 1/3 jitter. This is the only polling in the protocol, and it only happens while pending. The ticket is stored hashed; when the device is approved, the next poll returns the client certificate and the ticket is invalidated.

### 4.2 Connect: stream messages
```
AgentMessage (oneof):
  Hello          { device_id, agent_version, boot_id, capabilities[], revs{software,hardware,users,wu},
                   outbox_pending, cert_not_after, local_policy_hash }
  Heartbeat      { uptime_s, pending_reboot, sessions[], free_disk_system }   // every 5 min, only if changed or 30 min elapsed
  JobAck         { job_id, attempt, state [ACCEPTED|REJECTED], reject_reason }
  JobProgress    { job_id, attempt, phase, percent, message }                 // throttled ≤ 1/5 s
  JobResult      { seq, job_id, attempt, outcome, exit_code, reboot_required, detection, log_tail ≤ 64 KiB,
                   started_at, finished_at }
  InventoryDelta { seq, section, base_rev, new_rev, upserts[], removes[] }
  InventoryChunk { seq, section, new_rev, index, total, items[] }
  SecurityEvent  { seq, kind [BAD_SIGNATURE|WRONG_DEVICE|REPLAY|EXPIRED|POLICY_CEILING|HASH_MISMATCH|SIGNER_MISMATCH], detail }

ServerMessage (oneof):
  HelloAck       { server_time, job_signing_certs[], signing_key_revocations[] (root-signed),
                   resync_sections[], config (SignedEnvelope) }
  JobOffer       { envelope: SignedEnvelope }
  JobCancel      { envelope: SignedEnvelope }      // cancel is itself a signed job of type CANCEL
  Ack            { seq }                            // agent may delete outbox entries ≤ seq for that stream
  ResyncRequest  { section }
  GoAway         { retry_after_s, reason }
```

**Delivery semantics:**

- **Agent to server is at-least-once.** Every result, delta and event carries a monotonically increasing per-agent `seq`, persisted in the bbolt outbox. The server processes it idempotently, keyed by `(device_id, seq)` for deltas and `(job_id, attempt)` for results, then sends `Ack{seq}`.
- **Server to agent:** a job stays `sent` until `JobAck`. On every `Hello`, the server re-offers all jobs for the device that are `sent`, not acked and not expired. The agent's ledger makes duplicate offers harmless.

## 5. Signed job envelope

```proto
message SignedEnvelope {
  bytes  payload   = 1;  // serialized JobEnvelope; signature covers exactly these bytes
  bytes  signature = 2;  // Ed25519( "auzring/job/v1\x00" || payload )
  bytes  key_id    = 3;  // SHA-256 of signing cert SPKI
}
message JobEnvelope {
  uint32 version = 1;               // 1
  string job_id = 2;                // UUIDv7
  string org_id = 3;
  string device_id = 4;
  string target_user_sid = 5;       // "" = machine scope
  int64  issued_at = 6; int64 not_before = 7; int64 expires_at = 8;   // unix seconds
  bytes  nonce = 9;                 // 16 random bytes
  uint32 attempt = 10;
  string deployment_id = 11;
  MaintenanceWindow window = 12;    // optional; evaluated on device
  JobType type = 13;
  oneof body {
    InstallBody install = 20; UninstallBody uninstall = 21; WuScanBody wu_scan = 22;
    WuInstallBody wu_install = 23; WuHideBody wu_hide = 24; RebootBody reboot = 25;
    InventoryBody inventory = 26; AgentUpdateBody agent_update = 27; CancelBody cancel = 28;
    ConfigBody config = 29;
  }
}
```

The agent verifies the signature over the raw bytes **before** parsing them. That removes any canonical-encoding ambiguity. The domain-separation prefix stops a signature made for a different purpose (for example a license document) from being reused as a job.

**Agent verification order.** A failure at any step rejects the job and emits a `SecurityEvent`.

1. `key_id` maps to a known job-signing certificate that chains directly to the pinned root, has the job-signing EKU, is in its validity period, and isn't on the root-signed revocation list.
2. The Ed25519 signature is valid.
3. The payload parses, `version` is supported, and `type` matches the `body` case.
4. `device_id` and `org_id` match this agent's certificate identity.
5. `issued_at − 5 min ≤ now ≤ expires_at`. Also `expires_at − issued_at ≤ 30 days`; this cap is enforced by the agent so the replay ledger stays bounded.
6. `job_id` isn't in the executed/accepted ledger. Entries are kept until `expires_at + 24 h`.
7. `type` is allowed by the **local policy ceiling**: set at install time through an MSI property, stored in the ACL-protected `config.json`, and impossible for the server to raise.
8. Body validation: schema, allow-listed argument tokens, SHA-256 present for every installer, scope consistent with `target_user_sid`.

**Clock.** The agent records `server_time − local_time` from `HelloAck` and uses the adjusted clock for checks while that offset is fresh (under 24 h). The raw clock is used offline. If the skew exceeds 5 min, the agent reports it as a health warning.

**Signing-key rotation.**

1. The admin unlocks the root.
2. The server issues a new job-signing certificate.
3. `HelloAck` delivers it.
4. The agent accepts both certificates until the old one expires or is revoked.

**Revocation** statements are signed by the **root** (`"auzring/revoke/v1\x00" || key_id || revoked_at`). A stolen job-signing key can therefore never be used to sign itself back into validity.

### 5.1 Install body (abridged)
```
InstallBody {
  package_ref { catalog_package_id, identifier, version }
  scope [MACHINE|USER]
  installer { type, nested_type, nested_path, sha256, size, signer_pin?, sources[] (content-server and/or vendor URL),
              args[] (pre-built, per-type token list), success_codes[], code_map{code→outcome} }
  detection[] { kind, params }        // evaluated pre-check (skip if satisfied) and post-check
  preconditions { min_free_mb, os_build_min, arch, on_ac_power, not_metered, no_active_user? }
  timeout_s, max_retries, retry_backoff_s
  reboot { allow [NEVER|IF_REQUIRED_OUTSIDE_ACTIVE_HOURS|DEADLINE], deadline_at, notify }
  dependencies[] (InstallBody, ordered)
  upgrade_behavior [INSTALL|UNINSTALL_PREVIOUS], allow_downgrade
}
```

## 6. Inventory deltas

- Sections: `HARDWARE`, `USERS`, `SOFTWARE`, `WU`. Each section has its own revision counter.
- An item key is the stable tuple `(source, scope, user_sid, item_key)` for software, and an equivalent tuple for the other sections.
- **The agent** stores the last section snapshot it *sent and had acked*, together with `rev`. A delta is `base_rev = acked rev`, `new_rev = base_rev + 1`.
- **The server** applies a delta only if `base_rev == stored rev`. Otherwise it sends `ResyncRequest{section}`, and the agent streams a full `InventoryChunk` set, which the server replaces atomically when the final chunk arrives.
- Full inventory is sent on enrollment, on `INVENTORY_FULL` jobs, and on resync.
- Limits: 25k software rows per device and 1 KiB per string field. Rows over the limit are truncated with a flag, and the device is marked `inventory_truncated`.

## 7. Liveness and reconnect
- Transport: gRPC keepalive every 90 s with a 20 s timeout. The server's enforcement policy allows a minimum of 60 s.
- Online means a live stream (tracked in the server hub). `last_seen_at` is written on connect, on disconnect and on each heartbeat; heartbeats are sent only when something changed, or every 30 min, so idle agents cost almost nothing.
- Reconnect uses exponential backoff with **full jitter**: `sleep = rand(0, min(300 s, 1 s × 2^n))`. The counter resets after 10 min of a healthy stream. After a server-initiated close (`GoAway` or shutdown), the agent waits `retry_after` plus a random 0 to 30 s to avoid a reconnect stampede.
- **Revocation is immediate:**
  1. The admin revokes the device.
  2. The device row is set to `revoked` and its certificate serials are marked revoked.
  3. The hub sends `GoAway` and closes the stream at once.
  4. Revocation is enforced at three points: **every TLS handshake** (`VerifyConnection` looks up the certificate and device state in the database, with no cache), **every new gRPC stream or call** (so an already-open HTTP/2 connection cannot be reused), and the live stream itself, which the hub ends with `GoAway{reason:"revoked"}`. An agent that receives `revoked` marks itself rejected and stops reconnecting.
- **Certificate renewal.**
  - The agent renews when less than 1/3 of the lifetime (excluding the backdate) remains, measured on **server-corrected time**. It checks on a timer of lifetime/10, clamped to 1 s–1 h. `HelloAck.renew_certificate` also triggers renewal.
  - The agent sends `RenewCertificate` with a CSR from a **new** key (CNG name `Auzring-Agent-Device-<generation>`), stores the new certificate, deletes the old key, and reconnects.
  - When the device first connects with the new certificate, the server revokes the older ones (`revoke_reason='superseded'`).
  - An expired certificate can still call `RenewCertificate`, and only that RPC, for up to 180 days (`AUZ_DEVICE_RENEW_GRACE`) if the device is active. After that the device must re-enroll.
  - Renewals are rate-limited to 5 per device per hour.

## 8. Content download
- `GET /v1/content/{sha256}` on the gateway listener requires mTLS and supports `Range`.
- **Authorization:** content is served only if the requesting device has a non-expired job whose envelope references that hash. Devices can't enumerate or download other content.
- Vendor URLs are fetched directly by the agent over HTTPS with the system trust store. The integrity guarantee is always the SHA-256 in the signed envelope, never the transport.

## 9. Service ↔ helper IPC (local only)
- Transport: an anonymous pipe pair created by the service. Only the helper's end is inherited (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`). There's no named pipe and no listening endpoint.
- Framing: `uint32 length (≤ 1 MiB) || protobuf`.
- Message flow:
  1. The service sends `HelperTask{envelope (SignedEnvelope), staged_path, sha256, deadline}`.
  2. The helper sends zero or more `HelperProgress` messages.
  3. The helper sends exactly one `HelperResult`.
- The helper re-verifies the envelope (§5 steps 1 to 6 and 8, plus `target_user_sid == own token SID`).
- The service validates `HelperResult` against the schema and size limits, and treats every field as untrusted.

## 10. Versioning
- Package `auzring.agent.v1`. Changes within v1 only add fields or messages. `Hello.capabilities` advertises optional features, such as `wu`, `userctx` and `appx`.
- The server supports the current and previous agent minor versions at the same time. A breaking change becomes a `v2` service on the same listener.
