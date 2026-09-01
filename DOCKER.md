# Docker deployment

The production stack serves the React application and Express API on
`127.0.0.1:4173` and runs a dedicated Mihomo sidecar. Proxy listeners are
published on the local-only TCP/UDP ranges `127.0.0.1:17891-17893` and
`127.0.0.1:17900-17999`. Port `17894` is left to the existing local service.

## Start

1. Copy `.env.example` to `.env` and set the catalog bind-mount source and auth values.
2. Run `docker compose config`.
3. Run `docker compose build --pull`.
4. Run `docker compose up -d`.
5. Check `http://127.0.0.1:4173/healthz`.

The API generates `/mihomo/config.yaml` from the selected nodes across every
local Clash Verge subscription. The named volume `proxy-mihomo-data` is mounted
into both containers, and the API hot-reloads the sidecar through its private
controller. Clash Verge does not need to switch profiles and does not carry the
managed listeners.

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

The database contains a SHA-256 digest of each random browser session token, not
the usable token itself. `AUTH_SESSION_IDLE_SECONDS` controls inactivity expiry,
`AUTH_SESSION_MAX_SECONDS` controls absolute expiry, and
`AUTH_SESSION_TOUCH_SECONDS` limits how often activity is written to disk.
Increment `AUTH_SESSION_VERSION` to revoke all existing sessions without changing
the account password.

### 登录状态记忆

登录页默认勾选“记住密码”。服务端不会保存明文密码，而是签发随机的 HttpOnly 会话凭证；该凭证默认可在 30 天内恢复登录，并在退出登录、密码版本变化或到期后立即失效。取消勾选时只签发浏览器会话 Cookie，关闭浏览器后需要重新登录。

可通过 `AUTH_REMEMBER_IDLE_SECONDS` 和 `AUTH_REMEMBER_MAX_SECONDS` 调整长期会话的空闲与绝对有效期。普通会话继续使用 `AUTH_SESSION_IDLE_SECONDS` 和 `AUTH_SESSION_MAX_SECONDS`。
