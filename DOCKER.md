# Docker deployment

The production stack serves the React application and Express API on
`127.0.0.1:4173` and runs a dedicated Mihomo sidecar. Proxy listeners are
published on the local-only TCP/UDP ranges `127.0.0.1:17891-17893` and
`127.0.0.1:17900-17999`. Port `17894` is left to the existing local service.

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
events are deliberately excluded. A restore validates and decrypts the whole
package before changing data; if applying the restored Mihomo state fails, the
service restores the previous subscriptions and port configuration.

The same page checks subscription, session and audit databases, the refresh
scheduler, Mihomo controller, catalog consistency, and writable storage. Its
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

Containers in another Compose project can use, for example,
`http://host.docker.internal:17892`. Host applications use
`http://127.0.0.1:17892`.

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

### 登录状态记忆

登录页默认勾选“记住密码”。服务端不会保存明文密码，而是签发随机的 HttpOnly 会话凭证；该凭证默认可在 30 天内恢复登录，并在退出登录、密码版本变化或到期后立即失效。取消勾选时只签发浏览器会话 Cookie，关闭浏览器后需要重新登录。

可通过 `AUTH_REMEMBER_IDLE_SECONDS` 和 `AUTH_REMEMBER_MAX_SECONDS` 调整长期会话的空闲与绝对有效期。普通会话继续使用 `AUTH_SESSION_IDLE_SECONDS` 和 `AUTH_SESSION_MAX_SECONDS`。
