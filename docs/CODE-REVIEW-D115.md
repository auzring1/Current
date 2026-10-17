# Code review D115: administrator permissions and remote fetching

Scope: a hostile read of the Go server and agent, with the most attention on (a) who may do what as an administrator or with
an API token and (b) everything that fetches something from the network. Decision record: D115. Threat-model changes:
`SECURITY.md` section 9l.

## How this was done, and how far it got

Read in full or in the parts that matter: authentication (sessions, rate limiter, TOTP, RBAC, middleware, API tokens), the
route table against the permission each route asks for, the settings, master-key, event-stream and agent-download handlers,
the catalog fetcher and content store, the agent-installer downloader, the winget index fetcher and its SQLite reader, the
gateway (enrollment, job content, connection hub), agent releases, the deployment planner's entry point, the agent job
engine (validation, download, install pipeline, vendor fetch), and the webhook and mail senders.

Checked with tools: `go vet` on Linux and Windows, `staticcheck` (clean apart from two unused helpers in a test file), the
race detector over the concurrent packages, a timed mutation run (20,000 random edits) over the index reader, and a
reproduction of the UTF-8 bug before it was fixed.

**Not read in depth:** `backup` (only its use of `os.Root` was checked), `pki`, `kek`/`masterkey`, `branding`, `groups`
filter compiler, `inventory` ingest, the Windows-only agent code (`platform_windows.go`, `selfupdate`, `wua_windows.go`; it
was cross-compiled and vetted, not run), `loadsim`, and the React console (searched for `dangerouslySetInnerHTML`,
`innerHTML`, `eval` and unsafe links; none found). This is a review, not a proof that nothing else is wrong.

## Bugs and vulnerabilities fixed

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | An API token with `settings:write` could read the master key and then confirm it (the two routes are allowed while the key is unconfirmed), clearing the console warning. | Both routes refuse tokens (`requireInteractive`). |
| 2 | Medium | Open event streams were never re-checked for API tokens, and for sessions only for existence: a revoked token, a disabled account or a removed role kept receiving fleet events (listed as R-6). | `reauthenticate` runs every minute and ends the stream. To make that possible the auth lookups return errors instead of writing HTTP responses. |
| 3 | Medium | Job results, installer log texts and other agent texts were cut by bytes. Cutting a multi-byte character makes protobuf refuse the message ("string field contains invalid UTF-8", reproduced) and PostgreSQL refuse the row, so a job result could become impossible to send. About a dozen copies of the pattern, one with a half fix. | `internal/shared/text.Truncate`, used at every site. |
| 4 | Medium | Webhooks refused link-local addresses only, so a settings-page webhook could call the server's own listeners (`127.0.0.1`, `0.0.0.0`). | Loopback and unspecified addresses are refused at connect time. **Behaviour change:** a receiver on the Docker host must be addressed by its LAN address. |
| 5 | Low | The rate limiter emptied itself when full, which also reset the bucket of an account under attack. | Drops the least recently seen tenth instead. |
| 6 | Low | Windows Update `support_url` from an endpoint was stored unchecked and shown as a link (a compromised endpoint could plant `javascript:`; the CSP blocks it today). | Only `http(s)` is stored. |
| 7 | Low | Deleting an agent release removed the stored file inside the database transaction, before commit. | Removed after the commit. |
| 8 | Low | The content store renamed a file to its hash without syncing it, and trusts files by name afterwards. | `Sync()` before the rename. |
| 9 | Low | The hand-written index reader parses network data in a background goroutine; a bug there would end the server. | Panic guard in `ParseMSIX`; `FuzzParseDB` added. |
| 10 | Low | Enrollment released its concurrency slot only on the normal path. | `defer`. |

## Clean-up

- Removed `addExisting` and the branch that led to it from `agentrel.AddRelease`: `InsertContentBlob` already is
  `ON CONFLICT DO UPDATE`, so the branch could not be reached (about 35 duplicated lines).
- Five identical `ptr[T]` helpers became `internal/shared/ptr.Of`.
- Five `var _ = x` lines that only kept an import alive were removed with the imports.
- `engine.go`: parenthesised a mixed `||`/`&&` condition; `loadSession` uses `errors.Is`.
- Auth resolution in `middleware.go` split into functions that return errors (it also removed a closure and three
  write-the-response-and-return-false helpers).
- `fetch.go`: a comment named a function that does not exist (`hashFile`); it now says `hashLocked`.

## Found and left alone (decide before changing)

1. **Stored files are never reclaimed.** `content_blobs` rows are never deleted, and the "is this file still used" check
   counts them, so a deleted agent release or custom package leaves its file on the content volume. Disk growth, not a
   security problem. Needs a delete query (and `make generate`).
2. **The agent installers are only as trustworthy as the GitHub release** (documented in 9k): the SHA-256 file comes from
   the same place as the binary, and the exe/MSI are not Authenticode-signed. This is the largest "remote fetching" gap.
   Signing the exe/MSI in the release workflow and pinning the subject (as agent self-update already does) would close it.
3. **No four-eyes approval or step-up MFA** (R-3, R-5). Note that `SECURITY.md` section 6 still lists four-eyes approval
   as a mitigation; R-3 says it is not implemented. An operator with `catalog:write` and `deployments:write` can upload a
   program and run it as SYSTEM on the fleet by design.
4. **Two concurrent enrollment-status polls for the same approved device can each get a certificate** (`GetDeviceByTicketHash`
   has no `FOR UPDATE`). Only the holder of the ticket can do this, and both certificates belong to the same key.
5. **Upload dedupe races a delete of the last reference** (`Store.Put` returns early when the file exists; a concurrent
   delete removes it). Very narrow; would need a lock around the reference count.
6. `sweepLimiters` is a goroutine without a stop, one per handler (only matters in tests).
7. The testdata files `internal/server/catalog/testdata/7zip.*.yaml` show as modified in the working copy because of line
   endings (CRLF on the maintainer's checkout). They were not touched or committed.

## What was and was not verified

Verified here: the full Go test suite against PostgreSQL 16 (baseline before the changes: 45 packages ok, none failing;
after the changes: 47 packages ok, none failing), `go vet` for Linux and Windows, `staticcheck`, the race detector on the
packages named above, `gofmt`.

Not verified: anything that runs only on real Windows, the real winget CDN and GitHub release downloads, the browser
end-to-end tests (`scripts/gui-e2e.sh`; no console code changed), and the Synology deployment. The fuzz run of the index
reader could not make progress in this sandbox (it stalled at zero executions per second after a few seconds, with no
failure); the timed mutation run above was used instead.
