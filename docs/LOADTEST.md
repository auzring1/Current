# Load testing

Phase 6 asks for a load test with 10,000 simulated agents, including a reconnect storm. This document describes the tool (`cmd/auzring-loadsim`), the method, how to run it, what to tune on the host, what to measure, what we measured in a small development sandbox, and the server defects the tool found.

**Read the results as "measured in the dev sandbox, not a capacity statement".** The sandbox is a 4-CPU, 15.7 GiB virtual machine on which the server, the load generator and PostgreSQL all run at the same time, over the loopback interface. Real capacity needs a run on separate hosts (section 6).

## 1. What is simulated

Each simulated agent is a goroutine, one TLS connection and a few kilobytes of state. It speaks the real gateway protocol and reuses the agent's own code wherever that is possible:

| Part | Real or simulated |
|---|---|
| Enrollment | Real: token from the enrollment string, a fresh P-256 key, a CSR, the pinned-root TLS check (`core.PinnedTLS`), the same checks on the answer as the agent. The key is a software key held in memory (the real agent uses CNG). |
| Channel | Real: gRPC over TLS 1.3 with the device certificate (`core.MutualTLS`, `core.DialOptions`), `Hello` / `HelloAck`, `GoAway` handling, resync requests. |
| Reconnect | Real: the agent's `core.Backoff` (full jitter, 1 s base, 5 min cap), the 10-minute healthy reset, and "retry hint plus 0 to 30 s" after a server `GoAway`. |
| Inventory | Real protocol, fake data: the agent's own `inventory.Manager` produces the hardware, users and software reports (a full snapshot in 250-item chunks, then revisioned deltas, with acknowledgements and resync). Every agent starts from one shared, read-only fixture of N items (`--inventory-size`). |
| Heartbeats | Real message. A real agent sends one only when something changed or every 30 minutes; the tool sends one every `--heartbeat` (default 1 minute, jittered) as a deliberate stress multiple. The protocol has **no acknowledgement for a heartbeat**, so only the send time can be measured. |
| Jobs | Real: the server signs jobs when it creates them; the agent verifies each envelope with `envelope.Verifier` (signature before parsing, device and organization, validity window, replay ledger), sends `JobUpdate` `ACCEPTED`, then `SUCCEEDED` through an outbox that is resent after a reconnect until acknowledged. An `INVENTORY_FULL` job also triggers an inventory sync and a heartbeat, as in the real agent. Nothing is executed (a `wu_scan` job is a no-op). The tool creates the jobs through the REST API (`POST /devices/{id}/refresh` or `.../windows-updates/scan`) like an operator's script. |
| Not simulated | Windows collectors and CNG/TPM keys, certificate renewal, Windows Update snapshots, installers and content download, the user-context helper, self-update, real heartbeat cadence, many source addresses. |

Nothing in the server is relaxed for the test: no backdoor, no skipped check. The tool needs only what an operator has: an enrollment token and an API token. The one server change made for it is that the enrollment rate limits became configurable (section 8).

## 2. Scenarios

* `steady`: ramp `--agents` at `--ramp-per-sec` (enrolling each one for real), wait until 99% are connected **and** their first inventory is acknowledged, then hold for `--duration` with heartbeats, inventory deltas (`--inventory-change-every`) and jobs (`--jobs-fraction`).
* `storm`: as `steady`, hold for `--storm-hold`, then drop every connection at once (`--storm-mode client`) and let each agent reconnect with its own backoff. The tool reports how long the fleet needs to reach 50%, 90%, 99% and 100% connected, the lowest connected count, how many attempts failed and how, then holds `--duration` more to show that it settles. `--storm-mode external` instead waits for you to restart the server (for example `kill -TERM`, then start it again): the clock starts when the connected count falls below 99%. `scripts/loadtest.sh --storm-mode server-restart` does this in local mode. A restart makes the server send `GoAway` with a 15 s retry hint, and the agents add up to 30 s of jitter, so that storm is spread out by design; the `client` mode is the harsh one.
* `churn`: for `--duration`, `--churn-per-sec` random agents per second drop and reconnect, each staying away up to `--churn-away`. It shows the steady cost of agents that come and go (laptops).

A run passes when 99% of the fleet is connected (95% for churn), the hold phases have fewer than 1% connection or protocol failures, the storm recovered to 99%, and every job the tool created completed.

## 3. What is measured

All latencies come from the client's clock, in the same process, and are histograms with about 3% resolution (`internal/loadsim/stats.go`). Each phase (`ramp`, `hold`, `storm`, `after-storm`, `churn`) has its own set.

| Metric | Meaning |
|---|---|
| `enroll` | Dial plus the `Enroll` RPC. Includes waiting for a free enrollment slot on the server. |
| `connect` | `NewClient` until the transport is ready: TCP, TLS 1.3 with the client certificate (the server checks the certificate against the database here), HTTP/2 settings. |
| `stream_open` | Opening the `Connect` stream on a ready transport (the server checks the device again). |
| `handshake` | `Hello` sent until `HelloAck` received. Includes the server's device lookup and its `SetDeviceOnline` write. |
| `ack_hardware`, `ack_inventory_users`, `ack_inventory_snapshot`, `ack_inventory_delta` | Report sent until the server's `Ack`, so a database write round trip. A snapshot is measured from the first chunk. |
| `heartbeat_send` | How long `Send` took. There is no server answer to measure. |
| Jobs: dispatch | REST request started until the agent verified the offer. |
| Jobs: result RTT | The agent sent the result until the server acknowledged it (so it recorded it). |
| Jobs: end to end | REST request started until the result was acknowledged. |
| Storm: `time_to_connected_s` | Seconds after the drop until 50/90/99/100% of the agents hold a stream **opened after the drop**. |
| `fail.*` counters | Failures by stage and class, for example `fail.connect.tls`, `fail.recv.reset`. These are the client's view of what the server refused or dropped. |
| `failed_session_age` | How old a stream was when it failed on its own. A cluster of equal ages points at a timer or a common event. |
| Server's own view | `GET /reports/overview` at the end: online and active devices as the server counts them. |
| Server process | With `--server-pid`: CPU, resident memory, threads and descriptors every 2 s, per phase. |
| PostgreSQL | With `--pg-url`: commits, rows inserted and updated per second, backends, active queries, lock waiters, and the audit entries written. |
| Kernel | `scripts/loadtest.sh` records TCP counters before and after each scenario: listen overflows and drops, aborts on timeout, resets, retransmissions, and packets dropped in the input queue (`softnet`). |

## 4. How to run

### 4.1 One command, local server

```
export AUZ_TEST_PG_URL='postgres://postgres:PASSWORD@127.0.0.1:5432/postgres?sslmode=disable'   # a superuser; any PostgreSQL 16
scripts/loadtest.sh --agents 1000 --scenarios "steady storm" --duration 2m
```

The script builds the server, the load generator and the bootstrap tool into `loadtest-results/<timestamp>/bin`, creates a fresh database on that PostgreSQL, starts the server binary (dev mode, HTTP on :18080, gateway on :18443, enrollment limits raised for the test), completes first-run setup through the REST API, runs the scenarios and writes `<scenario>.json`, `<scenario>.md`, `summary.md` and `server.log` there. It drops the database when it ends. It needs `psql`, `python3`, `openssl` and Go. `loadtest-results/` is git-ignored: it holds device private keys (`identities.json`) and an API token, so keep it private and delete it when done.

Options: `--agents`, `--scenarios`, `--duration`, `--ramp-per-sec`, `--heartbeat`, `--inventory-size`, `--inventory-change-every`, `--jobs-fraction`, `--storm-mode client|server-restart`, `--out`, `--ports HTTP:GATEWAY`, `--external`. The scenarios run in order on the same fleet identities (the identity cache), so the first one pays for enrollment and the later ones start from enrolled devices; because the simulated agents start without state, every run begins with a full inventory resync, as a fleet whose agents lost their local database would.

### 4.2 Against a server you already run

```
export LOADTEST_API=https://auzring.example.com       # REST base URL
export LOADTEST_GATEWAY=agents.example.com:8443       # as in the gateway certificate
export LOADTEST_API_TOKEN=...                         # scopes: enrollment:write devices:read devices:write updates:write reports:read
scripts/loadtest.sh --external --agents 10000 --scenarios "steady storm"
```

For docker compose, start the stack as the README says, finish setup in the console, create an API token with those scopes, and use the variables above. This path (compose plus `--external`) is documented but **was not run here**: the sandbox has no Docker daemon. Raise the enrollment limits first (`AUZ_ENROLL_RATE_PER_IP`, `AUZ_ENROLL_RATE_PER_TOKEN`, in the compose environment) or enrolling the fleet takes about `agents / 10` minutes; and set the open-file limit of the server container (section 5). Do not point the tool at a production system: it enrolls thousands of devices and writes to the audit log.

### 4.3 The tool directly

```
go build -o auzring-loadsim ./cmd/auzring-loadsim
AUZ_LOADSIM_API_TOKEN=... ./auzring-loadsim --api http://127.0.0.1:8080 --server localhost:8443 \
  --agents 10000 --ramp-per-sec 100 --scenario storm --identity-cache ids.json --report storm.json --report-md storm.md
```

`--enrollment AURZ1...` (or `AUZ_LOADSIM_ENROLLMENT`) uses an existing token; without it the tool mints one through the API. `--identity-cache FILE` keeps the enrolled identities (mode 0600, **contains private keys**), bound to the server's CA, so later runs skip enrollment. Run `./auzring-loadsim -h` for every flag. The exit status is 2 when the success criteria are not met (`--no-fail` to ignore).

The in-process test `test/e2e/loadsim_test.go` runs 50 agents through the steady, storm and churn scenarios against the same server code in about 40 seconds, and `internal/loadsim/stats_test.go` tests the histogram, counters and recovery clock. Both run in `go test -race ./...`.

## 5. Host tuning for thousands of connections

* **Open files.** Each connection is one descriptor in the server and one in the load generator, plus database and log descriptors. Allow at least `agents + 1000` per process, in the shell that starts it: `ulimit -n 65536` (the hard limit must allow it: `/etc/security/limits.conf`, or `LimitNOFILE=65536` in a systemd unit). The sandbox allowed 20,000, which is why 10,000 agents is about the most it can hold per process. In docker compose set `ulimits: nofile: {soft: 65536, hard: 65536}` on the server service; `deploy/docker-compose.yml` does not set one today, and the default depends on the Docker installation. Go raises its own soft limit to the hard limit at start-up.
* **Ephemeral ports.** A load generator on one address can hold at most about 28,000 connections to one server address and port (`net.ipv4.ip_local_port_range`, default 32768-60999). A storm closes and reopens every connection, and closed sockets stay in TIME_WAIT for a minute, so 10,000 agents is the practical limit for one source address. Widen the range (`net.ipv4.ip_local_port_range="1024 65535"`), or generate load from several hosts or addresses.
* **Input queue.** If you run the load generator and the server on one host, set `net.core.netdev_max_backlog` well above its default of 1000 (the sandbox test used 65536). With the default, the loopback input queue overflowed during a 10,000-agent storm, and the kernel then reset about 1,000 to 1,700 established connections 30 to 70 seconds later (section 7.3). Across a real network, check the same counter on the server (`/proc/net/softnet_stat`).
* **Accept queue.** `net.core.somaxconn` (4096 in the sandbox) and `net.ipv4.tcp_max_syn_backlog` bound the connections waiting to be accepted; the script's `ListenOverflows`/`ListenDrops` lines tell you if they were exceeded (they were not).
* **Connection tracking.** A firewall or NAT between the fleet and the server needs a connection table for every agent (`net.netfilter.nf_conntrack_max`) and an idle timeout above the 90-second gRPC keepalive.
* **PostgreSQL.** The server's pool is fixed at 32 connections (`internal/server/store`); keep `max_connections` comfortably above that (and above any other users). The database in the sandbox ran with default settings (128 MB shared buffers, WAL on the same disk).
* **CPU and memory.** Expect roughly 215 KB of server memory per connected agent in this build (section 7.1) plus the base process, and about the same in the load generator. Give the two processes separate cores; `GOMAXPROCS` defaults to all of them.
* **Load generator placement.** For a capacity number, run the generator on one or more other hosts, with the server on the hardware you will use, and PostgreSQL where you will run it.

## 6. How to fill in a result table for your environment

Record the environment first (CPUs, RAM, kernel, PostgreSQL version and settings, open-file limit, whether the generator shares the host), then one row per run. `summary.md` has all the numbers.

| Run | Agents | Ramp to 99% (s) | connect p50 / p99 (ms) | handshake p50 / p99 (ms) | ack delta p50 / p99 (ms) | job end to end p50 / p99 (ms) | Storm: s to 99% | Failed attempts in the storm | Server CPU avg / peak (%) | Server RSS (MB) | DB commits/s avg / peak |
|---|---:|---:|---|---|---|---|---:|---:|---|---:|---|
| steady | | | | | | | | | | | |
| storm | | | | | | | | | | | |
| churn | | | | | | | | | | | |

## 7. Results from the development sandbox

**Not a capacity statement.** 4 vCPUs, 15.7 GiB RAM, Linux 6.18, PostgreSQL 16.15 with default settings on the same machine, open-file limit 20,000, Go 1.27.1. The server (`auzring-server serve`, dev mode, log level info), the load generator and PostgreSQL competed for the same four CPUs. Every simulated agent had 120 software items; heartbeats every 60 s; each agent changed 3 items about every 2 minutes; jobs for 1% of the fleet every 30 s (`inventory` kind; the server's own scheduler also queued a `wu_scan` job per device on its first connection). Ramp 100 agents per second. `netdev_max_backlog` was the default 1000 unless stated. Code at the commit that contains this file. Raw reports are not committed.

### 7.1 Steady state

| | 1,000 agents | 10,000 agents |
|---|---:|---:|
| Result | pass | pass |
| Ramp: 99% connected / first inventory acknowledged | 11.9 s / 12.0 s | 147 s / 149 s |
| Enrollments per second during the ramp | about 84 | about 68 |
| connect p50 / p99 (ms) | 17 / 49 | 22 / 70 |
| handshake (Hello to HelloAck) p50 / p99 (ms) | 12 / 33 | 17 / 61 |
| ack of the first software snapshot p50 / p99 (ms) | 36 / 79 | 49 / 133 |
| ack of a delta, hold phase p50 / p99 (ms) | 6.5 / 14.8 | 7.0 / 22.8 |
| heartbeat `Send` p50 / p99 (ms) | 0.06 / 0.32 | 0.04 / 0.33 |
| Jobs: created / completed / lost | 42 / 42 / 0 | 417 / 417 / 0 |
| Job dispatch p50 / p95 (ms) | 30 / 136 | 10 / 81 |
| Job result RTT p50 / p95 (ms) | 3.0 / 4.9 | 4.4 / 9.0 |
| Job end to end p50 / p95 / p99 (ms) | 93 / 199 / 203 | 72 / 131 / 157 |
| Server CPU, ramp avg (% of one core) | 150 | 154 |
| Server CPU, hold avg / peak (%) | 4 / 31 | 41 / 76 |
| Server resident memory | 239 MB | 2.17 GB |
| Server descriptors | 1,039 | 10,057 |
| Load generator resident memory / goroutines | 225 MB / 9,028 | 2.1 GB / 90,039 |
| PostgreSQL commits per second, ramp avg / peak | 1,117 / 1,286 | 1,031 / 1,271 |
| PostgreSQL rows inserted per second, ramp | 9,694 | 8,449 |
| PostgreSQL commits per second, hold avg / peak | 74 / 468 | 343 / 862 |
| Server's own count at the end | 1,000 online of 1,000 | 10,000 online of 10,000 |

The 10,000-agent ramp is limited by enrollment (section 7.4), not by connections: the same fleet reconnecting from a cached identity was fully connected and synchronized in 107 to 123 s at the same 100 per second ramp. Server memory grows by about 214 KB per connected agent (239 MB to 2.17 GB over 9,000 agents), and the simulated agents cost about the same.

### 7.2 Reconnect storm (every connection dropped at once, real backoff)

| | 1,000 agents | 10,000 agents |
|---|---:|---:|
| Time until 50% / 90% / 99% / 100% connected | 4.1 / 4.4 / 4.5 / 4.5 s | 23.4 / 25.0 / 25.7 / 25.8 s |
| Lowest connected count after the drop | 0 | 240 |
| Reconnect attempts / failed attempts | 1,000 / 0 | 13,238 / 3,238 |
| Failed attempts by class | none | TLS handshake 2,768, EOF 377, unavailable 72, reset 21 |
| connect p50 / p99 (ms) | 1,527 / 3,121 | 8,523 / 14,361 |
| handshake p50 / p99 (ms) | 1,963 / 2,584 | 9,529 / 22,280 |
| Server CPU during the storm, avg | 141% | see note |
| PostgreSQL commits per second during the storm, avg / peak | 848 / 848 | 2,524 / 6,210 |
| Rejections or rate limiting by the server | none | none logged (see below) |
| After the storm | stable | **951 sessions reset by the kernel 30 to 48 s after being re-established, then reconnected** (section 7.3) |
| Result | pass | recovered; the tool reports a failure because of the 951 resets |

* "Failed attempts" are connections that did not complete: the agent backed off and tried again, and all of them eventually did. The server logged no warning or error for them and no rate limiter is involved in a reconnect: the cause is that the server cannot finish thousands of TLS handshakes, each of which needs several database lookups, within its 15-second connection timeout when they all arrive within one or two seconds (the agent's first retry delay is a random time up to 1 s). Handshake latency in the storm was 9.5 s at the median and 22 s at p99.
* Time to recover is dominated by the server's handshake throughput on shared CPUs: about 400 reconnects per second at 10,000 agents (the 1,000-agent storm managed about 250 per second with less contention at the start). It scales roughly linearly with fleet size: 4.5 s for 1,000, 26 s for 10,000.
* Five 10,000-agent storms were run during development with slightly different builds; time to 99% was 25.7 to 31.8 s in all of them, and failed attempts were 1,200 to 5,300.
* The CPU peak of the storm phase in the 10,000-agent run was mis-measured by the sampler in this particular run (fixed afterwards: samples closer than 0.5 s are skipped). The storm used between two and four of the four cores for the server and the generator together; the averages in `summary.md` are reliable, the peaks of runs before that fix are not.

### 7.3 Kernel resets in the 10,000-agent storm (environment artifact, explained)

In four of five 10,000-agent storms, between 290 and 1,700 sessions that had been re-established during the storm were reset ("connection reset by peer") 30 to 70 seconds later, in groups, with nothing logged by the server. The kernel counter `TCPAbortOnTimeout` was exactly equal to the number of resets (951 in the run above), `/proc/net/softnet_stat` showed packets dropped by the loopback input queue (`netdev_max_backlog` = 1000), and gRPC sets `TCP_USER_TIMEOUT` to its 20-second keepalive timeout, so a connection whose data stays unacknowledged for 20 s is aborted. After raising `net.core.netdev_max_backlog` to 65536 the same storm showed **no** `TCPAbortOnTimeout`, no softnet drops and no resets (recovery to 99% in 23.1 s; 2,171 failed attempts of 12,172, all retried successfully). It did not happen with 1,000 or 3,000 agents. So this is a property of running both ends on one host under CPU saturation, not of the server. On a real network the equivalent is a saturated NIC queue or middlebox; check the same counters on the server before concluding anything.

### 7.4 Bottlenecks and defects found

Fixed, with a test each:

1. **Deadlocks in concurrent inventory ingest (server bug).** Every software snapshot upserted the device's titles with `INSERT ... ON CONFLICT DO UPDATE` in map-iteration (random) order, which locks every title the device has until commit. Devices with common software (every Windows machine has the same few hundred titles) that sent inventory at the same time deadlocked ("deadlock detected", SQLSTATE 40P01) and, when the lock waits were long, hit the statement timeout; the stream was closed with an error and the agent reconnected and resent. It appeared with only 50 agents. Titles are now created with `ON CONFLICT DO NOTHING` in sorted order and read back by a second statement, so a device that only references existing titles takes no lock on them. Test: `TestConcurrentSnapshotsOfCommonSoftwareDoNotDeadlock` (24 devices, 60 shared titles). Files: `db/queries/software.sql`, `internal/server/inventory/ingest.go`.
2. **An enrollment burst starved the mTLS handshakes of database connections (server bug).** Enrollment holds a transaction that waits for the enrollment-token row lock and for the audit-chain lock, so enrollments run one at a time anyway, but each one held one of the pool's 32 database connections while waiting. With 10,000 devices enrolling at 100 per second the pool was fully occupied by enrollments, every mTLS handshake (which looks the device up in the database, with a 5 s timeout) failed, and all agents retried. Before the fix the 10,000-agent steady run could not finish its ramp in 6 minutes (9,797 connected; 73,134 connection attempts, 63,336 of them failed TLS handshakes). At most 8 enrollment transactions now run at the same time (`gate` in `internal/server/gateway/gate.go`, test `TestGate*`); the others wait for a slot. After the fix the ramp finished in 106 to 147 s with no failed attempts, at the cost of long `enroll` latencies for the queued devices (p50 16 s at 10,000; an agent waits up to its 60 s call timeout and retries).
3. **Enrollment rate limits could not be changed although the protocol document said they could.** 10 enrollments per minute per source address and 60 per token (burst the same) were hard-coded, so enrolling a fleet from one NAT address takes `devices / 10` minutes (100 minutes for 1,000). They are now `AUZ_ENROLL_RATE_PER_IP` and `AUZ_ENROLL_RATE_PER_TOKEN` (attempts per minute, defaults unchanged at 10 and 60, test in `internal/server/config`). This is an operator setting, not a test backdoor; the test server raises it, nothing else is relaxed. The runbook says when to raise it.

Not fixed (design or larger changes), for the owner to decide:

4. **Enrollment throughput is about 70 to 95 devices per second at most**, with the 8-slot gate and any number of tokens' worth of load. Each enrollment locks the token row (`FOR UPDATE`, held to commit) and takes the global audit-chain advisory lock twice (`device.enroll`, certificate issue), so they serialize. Splitting a rollout over several tokens avoids only the first. Not isolated which of the two dominates.
5. **Database work per connection.** One connect costs at least seven round trips and three writes: the device-certificate and device lookups run in the TLS handshake and again for the stream (four reads), then `GetDevice`, `SetDeviceOnline`, `RevokeSupersededCerts`, the job dispatcher's queries, and `SetDeviceOffline` on disconnect. The storm drove PostgreSQL to 2,500 commits per second on average and 6,200 at peak. Reusing the handshake's lookup for the stream of the same connection, or not revoking superseded certificates on every connect, would remove about half of it; but the "no cache" rule for revocation (PROTOCOL §7) is deliberate, so this is a design decision.
6. **The 15-second connection timeout turns a slow storm into a retry storm.** `grpc.ConnectionTimeout(15 s)` closes connections whose TLS handshake and HTTP/2 setup have not finished in 15 s; with 10,000 handshakes arriving at once, handshake latency is 10 to 20 s, so 20 to 25% of the attempts are cut off and come back, which is extra work at the worst moment. A bounded number of concurrent handshakes (queueing instead of everyone being slow together) or a longer timeout would help; a naive limiter around the handshake would let idle connections hold all the slots, so it needs care. The agent's first retry delay (a random time up to 1 s) also puts a whole fleet's reconnects into about one second after a network blip; after a server restart the agents are spread over 15 to 45 s by the `GoAway` hint.
7. **Database pool of 32 connections is fixed.** At 10,000 agents with 60-second heartbeats the pool was never the limit after fix 2 (lock waiters at most 7 in the ramp, none in the hold), but it caps parallelism during storms.
8. **Heartbeats cost one autocommit `UPDATE` plus an event publication each.** At the real cadence (a heartbeat only when something changed or every 30 minutes) 10,000 agents produce about 6 per second; the test's 60-second cadence produced 167 per second and was easily absorbed (hold phase: server CPU 41% of one core on average, 343 commits per second including inventory deltas and jobs).
9. **Memory is about 215 KB per connected agent** in the server, mostly per-connection buffers and goroutines (two goroutines plus the transport's own). 10,000 agents need about 2.2 GB; 50,000 would need about 11 GB on this build.

### 7.5 What 10,000 meant here, and what was not reached

10,000 simulated agents did run, from one process, on one host: steady (pass) and storm (recovered; see 7.3). Limits met: the open-file limit of 20,000 per process (about 10,000 agents), the ephemeral port range (about 28,000 per source address; a storm needs the old sockets in TIME_WAIT as well) and the shared four CPUs. More than 10,000 agents was not tried. Nothing was run against docker compose, over a real network, with a separate load-generator host, with a least-privilege database role (the sandbox server used the superuser, as `scripts/gui-e2e.sh` does) or with TLS in front of the REST API.

## 8. Changes made to the product by this work

| Change | Why | Tested by |
|---|---|---|
| Software titles inserted with `DO NOTHING` in sorted order (`db/queries/software.sql`, `internal/server/inventory/ingest.go`) | Deadlocks and lock queueing between devices | `TestConcurrentSnapshotsOfCommonSoftwareDoNotDeadlock` |
| Enrollment gate of 8 transactions (`internal/server/gateway/gate.go`, `enroll.go`) | Enrollment bursts starved handshakes of database connections | `TestGateBoundsConcurrency`, `TestGateGivesUpWhenTheContextEnds`, `TestLoadsim*` |
| `AUZ_ENROLL_RATE_PER_IP`, `AUZ_ENROLL_RATE_PER_TOKEN` (`internal/server/config`) | Limits were hard-coded; defaults unchanged | `TestEnrollRateLimits*` |
| `core.PinnedTLS`, `core.MutualTLS`, `core.DialOptions` exported (`internal/agent/core`) | The load generator uses the agent's own trust and dial settings; no behaviour change | existing agent tests |

## 9. Known gaps of the tool

* One process and one source address; no per-agent source addresses, no network impairment (latency, loss), no TLS inspection or proxy.
* Software keys and in-memory state; certificates are not renewed during a run (a run is shorter than a third of a certificate's life; the identity cache skips certificates that expire within an hour).
* Inventory is the same fixture for everyone, so the server's title table stays small (120 titles) and the per-device item count is fixed; real fleets have more variety. Deltas change 3 items.
* Heartbeats have no acknowledgement in the protocol, so no round trip is measured for them.
* Windows Update snapshots and content downloads are not exercised, and the `wu_scan` jobs are no-ops.
* The REST API is exercised only for tokens, job creation and the overview; the console's own load (SSE streams, device lists with 10,000 rows) is not tested.
* The server-process and PostgreSQL samplers need the same host (`--server-pid`, `--pg-url`); the kernel counters in the script cover the whole host.
