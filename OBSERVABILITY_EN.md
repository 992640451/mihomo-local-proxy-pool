# Observability

[简体中文](OBSERVABILITY.md) · English

Version 1.2.0 observability (roadmap milestone M3) supports the embedded Mihomo mode used by default Docker and portable deployments. It does not include webhooks or external notifications.

## Usage

1. In **Nodes (节点)**, inspect measured health, latest latency and check time. Filter by subscription, country or name, select nodes and click **Test selected (测速所选)**. Each page and batch supports up to 100 nodes; running jobs can be cancelled.
2. In **Observability (可观测性)**, inspect active port nodes, 24-hour success rates, hourly failure trends and consecutive problematic checks. Select a port to view history or verify it. **Verify** on the original port page writes to the same history.
3. Background probes are off by default. Enable them under **Observability → Background probe settings (后台检测设置)** if needed. Settings persist across restarts in the local database.

“Healthy” means measured, not merely imported. Missing measurements are unknown; results older than `max(10 minutes, probe interval × 2)` are stale. If the core is unreachable or a node is not loaded, historical success is not shown as current health. The UI reads core state every five seconds, pauses when hidden, and does not initiate latency tests by polling. Nodes from enabled subscriptions are loaded into the core so unassigned nodes can be tested; this does not add listeners or background health-check groups.

Latency tests use the single-node delay endpoint of the [Mihomo Controller API](https://wiki.metacubex.one/api/). They measure HTTP request latency, not download bandwidth. Active strategy nodes come from the core's `now` field. Load balancing generally has no single active node, so the UI does not guess one. Legacy external-core/Clash Verge deployments do not support this page; original port verification remains available.

## Traffic and resource budgets

| Setting | Default | Range |
| --- | --- | --- |
| Background probes | Off | Explicit opt-in |
| Interval | 900 seconds | 300–86400 seconds |
| Node concurrency | 3 | 1–6 |
| Per-request timeout | 5000 ms | 1000–10000 ms |
| Connections per port in background/observability page | 2 | 2–8 |
| History retention | 7 days | 1–30 days |
| Maximum samples | 20000 | 100–50000 |

Only one observation job runs across the service at a time. Nodes are concurrency-limited; ports and their connections are tested sequentially, using independent proxy connections. Original port-page verification defaults to eight attempts, with its interface allowing 2–20. A shared 15-second cooldown follows each job to prevent tabs from stacking traffic. Each scheduled round checks at most 100 nodes and 10 enabled ports, rotating excess targets across rounds without replaying a backlog. The next interval starts at job completion, with up to 30 seconds of scheduler-scan delay. Disabling background probes cancels a running background job, not manual jobs.

Single-node requests allow one extra second to receive the core's timeout response. Existing Mihomo strategy-group health checks run independently of this page's toggle.

## Interpreting metrics

- Success rate: successful exit connections / all exit connections in the last 24 hours. Node tests are excluded. No samples display “—”, not 0%.
- Consecutive problematic checks: consecutive retained check rounds, newest first, with at least one failed connection for the same target. Partial failures count; this is not the number of consecutive failed connections.
- Latency: average of successful samples; all-failed checks display “—”.
- Exit distribution: IPs, countries and counts per verification. Shared exit IPs do not prove round robin is broken.
- Hourly trend: the most recent 24 clock-hour buckets; gray means no samples, green means all succeeded, and red height represents failure ratio. The oldest bucket boundary may differ from the rolling 24-hour total window.
- Cancellation, process exit or restart does not count incomplete checks as failures. Results for completed nodes and ports remain; interrupted jobs are not replayed on restart.

Port history includes the protocol, strategy and node IDs at check time. Reusing a port number continues its history, so inspect the configuration summary. Only manual/scheduled active probes are stored; Mihomo's own history is read for live health, not duplicated into the database.

## Storage, security and third-party requests

`observability.sqlite` normally lives beside subscription/session databases, in Docker's `/data` volume or portable `data` directory. Override it with `OBSERVABILITY_DB`. History is pruned by both age and count; reducing limits irreversibly removes excess records.

Observation probes run only after a manual request or enabling scheduling. Node tests default to `https://www.gstatic.com/generate_204`, and exit lookup defaults to `https://ipwho.is/`. Providers see the proxy exit IP. Results stay local; no telemetry is uploaded. HTTP, Mixed and SOCKS5 ports use their corresponding protocols; SOCKS5 resolves DNS through the proxy.

Administrators may configure trusted test services using `OBSERVABILITY_TEST_URL` and `EGRESS_LOOKUP_URL`. Browser APIs do not accept arbitrary test URLs. Use services that permit these checks and respect their limits. Controller access stays on the backend; secrets and complete core responses are not sent to the frontend. Errors are redacted, and response bodies/history payloads are bounded.

Exit IPs are stored unencrypted in local history; protect database access. Raw subscriptions, node passwords and cookies are excluded. Configuration backups and diagnostic exports exclude observation samples and exit IPs, retaining only diagnostic component state and audit job summaries. To migrate history, stop the service and back up its data directory.

Observation jobs hold recovery leases even after a batch API returns 202 or the browser closes/navigates away. Restore cannot proceed until the job finishes or is cancelled.

## Interfaces and verification

All endpoints inherit administrator login and same-origin checks:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/observability` | Nodes, ports, core state and 24-hour summary with short caching |
| `GET /api/observability/status` | Settings, scheduler state, latest job and cooldown |
| `PATCH /api/observability/settings` | Validate and persist settings |
| `POST /api/observability/nodes/test` | `{ "nodeIds": ["…"] }`; returns 202 and a job ID |
| `POST /api/observability/cancel` | Cancel the current job |
| `GET /api/observability/history?kind=port&targetId=17900` | Target history, with `before` cursor and `limit` up to 100 |
| `POST /api/ports/:port/verify` | Original verification endpoint; accepts `attempts` and records port history |

`npm test` includes isolated store, Controller, scheduler, authentication, recovery-lock, HTTP and SOCKS5 mock-server tests without real subscriptions.

For browser regression checks, run `npm run build`, then `node tests/helpers/observability-preview.mjs`, and open `http://127.0.0.1:43021`. This helper uses temporary databases and purely local mock Controller/proxy services without login. Never expose it publicly. Stopping it cleans up only its own temporary data.
