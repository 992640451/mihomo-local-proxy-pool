# Automation API and CLI

[简体中文](AUTOMATION.md) · English

Version 1.2.0 introduces `/api/v1`, scoped API tokens, an OpenAPI contract, and `ppm` automation commands (roadmap milestone M4). Application and API versions are independent: application 1.2.0 does not change the API path to `/api/v1.2`.

## Create and revoke tokens

Configure administrator authentication, sign in through the browser, and open **System Settings → API tokens (系统设置 → API 令牌)**. Create a separate token for each script. Save the secret immediately: it is shown only once, and you can then clear its display. Names allow up to 80 characters; validity is 1–365 days, defaulting to 90. At most 100 tokens may be active. To expand permissions, create a replacement and revoke the old token.

| Scope | Allowed operations |
| --- | --- |
| `read` | Runtime, redacted diagnostics, subscription lists/catalog, port lists/group status, OpenAPI |
| `subscriptions:write` | Includes read; import, update, delete, and refresh subscriptions |
| `ports:write` | Includes read; create/replace, delete, and actively verify port pools |
| Both write scopes | Also export credential-containing encrypted configuration, plan and apply restores |

Tokens cannot manage other tokens, clear audit history, or call UI-only endpoints. Cross-origin writes remain subject to Origin checks. Configuration backups contain subscription URLs and node credentials, so both management scopes are required even though the backup is encrypted. Scopes apply to the whole instance, not individual subscriptions or ports. Subscription writes may reload the core and affect dependent ports.

The server stores only SHA-256 digests in `api-tokens.sqlite`, normally beside subscription/session databases. Override the path with `API_TOKEN_DB`. Without a persistent directory, the default is in-memory and tokens are lost on restart; Docker and portable deployments persist them by default. Changing the administrator account, password hash, or `AUTH_SESSION_VERSION` invalidates old tokens.

Revocation blocks subsequent requests, not operations already authorized. Last-used time records successful authentication, at most once per minute, even if the operation is subsequently denied for insufficient scope. Audit actors appear as `api/<token ID>`, never the secret. Creation prunes inactive history to at most 900 entries in addition to the 100 active tokens.

## CLI quick start

Use `./ppm` in a portable bundle (on Windows, run `.\bin\ppm.cmd` from the extraction root), or `node scripts/launcher.mjs` from source. Update older Windows scripts to the entry point under `bin`; the old root entry point is no longer provided. Automation commands only connect to a running service: they do not start it, initialize portable configuration, or modify `.env`.

Store secrets in files readable only by you and set their paths in the process environment. Do not put secrets in Git, command arguments, or CI logs. `PPM_API_TOKEN` and `PPM_BACKUP_PASSWORD` environment variables are also supported; use protected CI secrets for injection. Files take precedence, and reading removes only one trailing newline. New backup/plan files use Unix mode `0600`; restrict directory ACLs on Windows too.

```powershell
$env:PPM_API_URL = 'http://127.0.0.1:4173'
$env:PPM_API_TOKEN_FILE = 'C:\private\ppm-api-secret.txt'
$env:PPM_BACKUP_PASSWORD_FILE = 'C:\private\ppm-backup-password.txt'
.\bin\ppm.cmd doctor
.\bin\ppm.cmd ports list
.\bin\ppm.cmd subscriptions refresh --all
.\bin\ppm.cmd subscriptions refresh '<subscription-id>'
.\bin\ppm.cmd backup 'backup-2026-09-02.json'
.\bin\ppm.cmd restore 'backup-2026-09-02.json' --plan 'restore-plan.json'
# Review changes, missingNodes, unavailableNodes, and errors before applying:
.\bin\ppm.cmd restore 'backup-2026-09-02.json' --apply --plan 'restore-plan.json'
```

On Linux/macOS, set the same variables using `export PPM_API_TOKEN_FILE=/private/ppm-api-secret.txt`, and so on. All commands accept `--url` to override `PPM_API_URL`, whose default is `http://127.0.0.1:4173`; the source development API normally uses port 4180.

Remote URLs must use HTTPS. HTTP is allowed only for `127.0.0.1`, `localhost`, or `[::1]`. A deployment path prefix is allowed, but embedded credentials, queries, and fragments are not. The CLI rejects redirects, does not retry automatically, and times out each request after 120 seconds. Keep the service's loopback binding; do not publicly expose the management port just for scripts.

Output is JSON. Exit codes are `0` for success, `1` for argument/file/HTTP/authentication errors, and `2` for non-healthy diagnostics, partial batch-refresh failure, or a restore plan that cannot be applied. `refresh --all` refreshes only enabled remote subscriptions; an empty set succeeds. A manual single-subscription refresh is not restricted by enabled state. If a write times out, inspect current state before retrying to avoid duplicate imports or restores. Output files are created exclusively; existing backups/plans are never overwritten. Use a new filename when planning again.

## Configuration planning and restore

Backups use the existing `ppm-recovery` v1 AES-256-GCM/scrypt format. Plaintext payloads are limited to 24 MiB and files to 33 MiB; passphrases must be 8–256 characters. Packages contain subscriptions, snapshots, raw node configuration/credentials, and port pools. They exclude administrator authentication, sessions, API tokens, audit events, observation history/probe schedules, host paths, and container networking. Restoring does not resurrect old tokens or change the target host's published ports.

1. `POST /api/v1/config/export` exports the encrypted package.
2. `POST /api/v1/config/plan` decrypts and validates it, returning added, modified, and deleted subscription/node/port IDs and unchanged counts. `missingNodes` identifies nonexistent nodes referenced by ports and blocks application; `unavailableNodes` warns about orphaned nodes or disabled subscriptions. Port ranges, protocols, strategies and node counts use the same validators as restore. Planning neither writes configuration nor reloads the core.
3. `POST /api/v1/config/apply` requires the returned `planToken` and the same package/passphrase. Signed plans bind the package contents, the current complete-configuration digest, and a 10-minute expiry. Restart invalidates them. Refreshing subscriptions, editing ports, or changing the package in between returns `409 CONFIGURATION_PLAN_STALE`; plan again.

Configuration operations acquire exclusive leases and pause subscription scheduling to obtain consistent snapshots. In-flight manual writes, background refresh/core reloads, or observation jobs cause `409 CONFIGURATION_BUSY`; planning does not terminate them. Direct external database/file edits bypass application locks, so stop the service before maintenance.

Apply is a **full replacement**: resources absent from the package are deleted. Apply or core reload failure triggers an attempt to restore the previous configuration. The database and external core are not a distributed transaction: if rollback also fails, inspect the error and actual state instead of retrying blindly. Planning cannot guarantee external core health, disk space, or network availability.

The UI uses the same planning workflow, displaying up to 100 IDs per category; the CLI returns complete details. `modified` compares complete persisted resources, including snapshots and refresh metadata, so refreshing alone may count as a modification.

## API contract and compatibility

After browser login, open `/api/v1/openapi.json`, or retrieve it with `Authorization: Bearer <token>`. The contract follows [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html). `server/automation/contract.mjs` maintains the explicit route allowlist and contract together; new UI routes are not automatically exposed. Neither OpenAPI nor other v1 endpoints are anonymous.

The contract currently defines 18 operations. Requests are validated against its JSON Schemas; responses may gain fields, which clients should ignore if unknown. Each operation's `x-required-scopes` lists scopes required together; it is not an OAuth login flow.

```text
GET    /api/v1/runtime
GET    /api/v1/diagnostics
GET    /api/v1/subscriptions/catalog
GET    /api/v1/subscriptions
POST   /api/v1/subscriptions
PATCH  /api/v1/subscriptions/{id}
DELETE /api/v1/subscriptions/{id}
POST   /api/v1/subscriptions/{id}/refresh
POST   /api/v1/subscriptions/refresh-all
GET    /api/v1/ports
PUT    /api/v1/ports/{port}
DELETE /api/v1/ports/{port}
GET    /api/v1/ports/{port}/status
POST   /api/v1/ports/{port}/verify
POST   /api/v1/config/export
POST   /api/v1/config/plan
POST   /api/v1/config/apply
GET    /api/v1/openapi.json
```

Errors retain `{ "error": { "code", "message", "requestId", "detail"?, "meta"? } }`. Common statuses: 401 invalid token; 403 insufficient scope; 404 unavailable route; 409 configuration busy/stale plan; 413 oversized request; 429 active-probe rate limit; 501 unsupported deployment mode.

Catalogs and subscription lists omit raw node credentials, but hostnames, node/subscription names, and ports are still management information: do not publish responses. Configuration export/restore requires native/hybrid subscription storage and the embedded core; unsupported modes return structured errors.

Unversioned `/api/...` endpoints remain for browser sessions and compatible clients, without a stable contract for new scripts, and reject API tokens. The old session-based `/api/recovery/restore` remains; new scripts and the UI use plan-protected config endpoints. v1 does not expose observation-schedule writes, arbitrary TCP probes, or token management. Future breaking changes require a new major API version, not deletion or reinterpretation of existing contract fields.

## Verification

`npm test` covers token digests, expiry, revocation and restart; the complete scope matrix; Origin protection; response Schemas; restore diffs/stale plans; failure rollback; exclusive CLI file creation and redirect rejection.

For isolated browser checks, run `node tests/helpers/observability-preview.mjs --auth` after building. The temporary instance uses `preview-admin` / `synthetic-preview-password` only as synthetic test credentials. It does not read `.env` or operate on real subscriptions/ports and removes its own temporary directory on exit. Never use these test credentials for deployment.
