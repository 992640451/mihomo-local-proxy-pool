# Docker deployment

[简体中文](DOCKER_ZH.md) · English

The production stack serves the React application and Express API on
`127.0.0.1:4173` and runs a dedicated Mihomo sidecar. Proxy listeners are
published on the local-only TCP/UDP ranges `127.0.0.1:17891-17893` and
`127.0.0.1:17900-17999`. Port `17894` is outside the default published ranges.

## Start

1. Run `npm run init` to generate `.env` and a one-time management password.
2. Run `docker compose config`.
3. Run `docker compose build --pull`.
4. Run `docker compose up -d`.
5. Check `http://127.0.0.1:4173/healthz`.

The API generates `/mihomo/config.yaml` from the selected nodes in its native
subscription database. The named volume `proxy-mihomo-data` is mounted
into both containers, and the API hot-reloads the sidecar through its private
controller.

## Native subscription storage

The application owns subscription import and refresh. New installations use
`native` mode. To import existing Clash Verge remote profiles, set
`SUBSCRIPTION_MODE=hybrid`, configure `CATALOG_SOURCE`, and start with
`docker compose -f compose.yaml -f compose.legacy.yaml up -d`. The migration writes into
`/data/subscriptions.sqlite`, preserving the legacy node IDs used by existing
managed ports. Subscription URLs, source YAML snapshots, and individual proxy
definitions are encrypted with AES-256-GCM using `SUBSCRIPTION_MASTER_KEY` (the
Compose default reuses the long Mihomo controller secret).

Use the Subscription page to preview and import a Mihomo/Clash YAML URL or pasted
YAML. Each successful refresh is activated transactionally. An invalid or failed
download only records the error and keeps the last known-good snapshot. Node IDs
are reconciled by protocol and endpoint identity, so renames and list reordering
do not break port pools. The server performs each subscription's refresh schedule
even when no browser is open and regenerates/hot-reloads the embedded Mihomo
configuration after a change.

Subscription downloads reject private, loopback, and reserved destinations. If
the host uses Mihomo/Clash Fake-IP DNS, the server recognizes the default Fake-IP
ranges, resolves the real A/AAAA records through DNS-over-HTTPS, validates them,
and pins the connection to those validated addresses. The default DoH endpoints
are Cloudflare and Google. Override them with a comma-separated
`SUBSCRIPTION_DOH_URLS` value and set the per-query timeout with
`SUBSCRIPTION_DOH_TIMEOUT_MS`. Custom endpoints must use HTTPS. Do not enable
`SUBSCRIPTION_ALLOW_PRIVATE_NETWORKS` merely to work around Fake-IP, because it
disables the destination safety check entirely.

Every subscription has editable name, enabled state, refresh interval, optional
replacement URL, and an integer priority from `-10000` to `10000`. Higher values
sort first. The same server-side ordering is used by the Subscription page, node
definitions, and subscription selectors on the Nodes and Port Pool pages. Existing
databases add the priority column automatically during startup.

After checking the migrated subscriptions, set `SUBSCRIPTION_MODE=native` in
`.env` and return to ordinary `docker compose up -d`. Native mode no longer reads
the Clash Verge files at runtime; keep the `/data`
volume, which now contains both `subscriptions.sqlite` and `sessions.sqlite`.

## Reliability, backup, and diagnostics

The Operation Log page reads persistent, redacted events from
`/data/audit.sqlite`. `AUDIT_RETENTION_DAYS` defaults to 30 days and
`AUDIT_MAX_EVENTS` defaults to 10000 events. Audit data is operational history,
not part of a configuration recovery package.

System Settings can create a passphrase-encrypted JSON recovery package that
contains subscriptions, their encrypted-at-rest source material in re-encrypted
portable form, stable node IDs, and managed port pools. Login sessions and audit
events, administrator credentials, API tokens, observation history and probe
schedules are deliberately excluded. Restore requires reviewing a diff first,
then explicitly applying a signed plan within 10 minutes. A configuration change
invalidates the plan. Restore replaces the entire configuration, deleting resources
absent from the package; it does not change container port mappings. On apply or
core reload failure, the service attempts to roll back. If rollback also fails,
inspect the reported error and actual state instead of retrying blindly.

The same page checks subscription, session, API-token, audit and observation
databases, both schedulers, Mihomo controller, catalog consistency, and writable storage. Its
downloadable diagnostics are redacted and safe to inspect before attaching to a
public issue. Always inspect the file yourself before sharing it.

Cookie-authenticated browser mutations are same-origin checked. Reverse proxies
that intentionally use a different browser origin must list it in the
comma-separated `APP_ALLOWED_ORIGINS` setting. Do not use a wildcard.

Management endpoints (all protected by the existing login session) are:

- `GET /api/subscriptions`
- `POST /api/subscriptions/preview`
- `POST /api/subscriptions`
- `PATCH /api/subscriptions/:id`
- `POST /api/subscriptions/:id/refresh`
- `POST /api/subscriptions/refresh-all`
- `DELETE /api/subscriptions/:id`

Host applications use, for example, `http://127.0.0.1:17900` after creating that
listener. A container's `127.0.0.1` refers to itself; host-loopback published ports
are not a portable cross-container endpoint. Do not assume
`host.docker.internal` can access them. Cross-project container access requires
an explicitly designed private network and access controls; do not expose host
ports on `0.0.0.0` just to make a container connect.

## Observability and automation

Version 1.2.0 adds node latency tests, port history, and 24-hour failure trends.
Background probes are off by default. Settings and history persist in
`/data/observability.sqlite`; active probes contact the configured test services
through your proxies. See [Observability](OBSERVABILITY_EN.md) for limits and privacy.

Create a token in System Settings → API tokens. Token digests persist in
`/data/api-tokens.sqlite`. Use `/api/v1` or run the CLI from a source checkout or
portable bundle, pointing `PPM_API_URL` at `http://127.0.0.1:4173` on the host.
The container image does not include the launcher. See [Automation](AUTOMATION_EN.md)
for scopes, credential files, backup and restore planning.

## Update and stop

Back up your data before upgrading. For a consistent full data-directory backup,
stop the stack first; the encrypted configuration export does not include every
database. Keep `.env` and both named volumes.

```bash
git pull --ff-only
npm run docker:update
docker compose ps
# Stop without deleting data:
docker compose down
```

`docker:update` rebuilds and recreates only the management service, waits for its
health check, and preserves the Mihomo container and volumes. During development,
keep `npm run docker:watch` running in a separate terminal. Never use
`docker compose down -v` unless you intend to delete the persistent data.
For digest-pinned GHCR deployment, see [Release engineering](RELEASING_EN.md).

## Persistent login sessions

Authenticated sessions are stored in `/data/sessions.sqlite`. Compose mounts the
named volume `proxy-session-data` at `/data`, so a valid browser session survives
application, container, and host restarts. Normal `docker compose down` and
recreation keep this volume. Deleting the volume intentionally revokes every
session.

Managed port assignments are stored in `/data/embedded-core.json`. The generated
Mihomo configuration and core runtime data are stored in the separate
`proxy-mihomo-data` volume. Normal `docker compose down` preserves both volumes.

## Port pool strategies

Each managed listener points to its own Mihomo proxy group. The web application
and API support these strategies:

- `select`: fixed/manual node selection.
- `fallback`: use the first healthy node in the configured order.
- `url-test`: periodically select the lowest-latency node.
- `consistent-hashing`: keep the same target on the same healthy node when possible.
- `round-robin`: distribute new connections across healthy nodes.

Automatic strategies require at least two nodes. Health-check URL, interval,
timeout, maximum failed checks, and URL-test tolerance are validated by the API
before the configuration is written. Strategy changes are written atomically and
hot-reloaded through the private Mihomo controller. Existing TCP connections are
not migrated when the active node changes; new connections use the new selection.

Port state uses schema version 2 and stores the ordered `nodeIds`, strategy, and
health-check options. The legacy `nodeId` field remains as the primary-node alias
for rollback compatibility. On the first upgrade from version 1, the service keeps
`/data/embedded-core.json.v1.bak` and converts each legacy port to a one-node
`select` group.

`GET /api/ports/:port/status` reports the active node and per-node health data
returned by the embedded Mihomo controller. The endpoint requires the same login
session as the other management APIs.

The database contains a SHA-256 digest of each random browser session token, not
the usable token itself. `AUTH_SESSION_IDLE_SECONDS` controls inactivity expiry,
`AUTH_SESSION_MAX_SECONDS` controls absolute expiry, and
`AUTH_SESSION_TOUCH_SECONDS` limits how often activity is written to disk.
Increment `AUTH_SESSION_VERSION` to revoke all existing sessions without changing
the account password.

### Remembered login

The login page selects “Remember password” (记住密码) by default. The server does
not store the plaintext password; it issues a random HttpOnly session cookie,
valid for up to 30 days by default. Logout, credential-version changes, or expiry
invalidate it. Without this option, the cookie is a browser-session cookie;
browser session-restoration behavior can affect whether it survives closing a window.

Use `AUTH_REMEMBER_IDLE_SECONDS` and `AUTH_REMEMBER_MAX_SECONDS` for remembered
sessions. Ordinary sessions use `AUTH_SESSION_IDLE_SECONDS` and
`AUTH_SESSION_MAX_SECONDS`. Changing administrator credentials or
`AUTH_SESSION_VERSION` also invalidates existing API tokens.
