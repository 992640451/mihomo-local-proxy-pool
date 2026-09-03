# Architecture and evolution guidelines

[简体中文](ARCHITECTURE.md) · English

This document records module boundaries and compatibility rules for feature development, database changes and pull-request reviews.

## Runtime boundaries

- `server/index.mjs` creates runtime dependencies, wires middleware and manages process lifecycle.
- `server/routes/` separates HTTP routes by authentication, subscriptions, ports and system state.
- `server/http/` provides request context and consistent responses, not business rules.
- `server/security/` provides reusable security boundaries. Redact before returning errors, writing logs or exporting diagnostics.
- `server/database/` provides versioned migrations; individual stores declare their own ordered migrations.
- `server/automation/` owns the explicit v1 allowlist, OpenAPI, request validation and token storage. New UI endpoints do not automatically become token-accessible.
- `server/observability/` separates Controller access, storage and scheduling. Jobs hold recovery leases; background probes default to off.
- `server/recovery/` handles encrypted backups, diffs, signed plans, exclusion and rollback. `server/audit/` and `server/diagnostics/` handle redacted operational information.
- `src/api.js` is the browser API boundary for requests and error-response compatibility.
- `src/components/` holds shared UI, `src/pages/` page-level components, and `src/hooks/` reusable state logic.

## Database migrations

Subscription, session, API-token, audit and observation databases use SQLite `PRAGMA user_version`:

1. Versions increase consecutively from 1. Never modify published migrations.
2. Each migration runs inside one `BEGIN IMMEDIATE` transaction.
3. Before upgrading an existing database, perform a WAL checkpoint and create a sibling backup containing the old version and timestamp.
4. Failure must roll back without advancing `user_version`.
5. New migrations need tests for fresh databases, previous-version upgrades, rollback and data preservation.
6. Refuse to open newer unsupported schemas so old binaries cannot damage new data.

Migration backups are emergency upgrade rollback aids, not replacements for stopped-service data-directory backups or encrypted configuration exports. Configuration recovery packages exclude authentication, sessions, tokens, audit events and observation history/settings.

## Versioned API and recovery boundaries

`server/automation/contract.mjs` defines the 18 `/api/v1` operations. Application 1.2.0 and API v1 evolve independently. Additive response fields are compatible; breaking changes require a new API major version. Unversioned endpoints reject API tokens. See [Automation](../AUTOMATION_EN.md) for scopes and CLI conventions.

Configuration apply requires a signed, unexpired plan tied to the same package and configuration digest. Conflicting operations are excluded during changes. Subscription activation waits for core reload confirmation and restores snapshots/core configuration on failure. The database and external core are not a distributed transaction: rollback failures must be explicit, not described as unconditional atomic commits.

## API error contract

Successful responses retain each resource's structure. Failures use:

```json
{
  "error": {
    "code": "SUBSCRIPTION_REFRESH_FAILED",
    "message": "Subscription refresh failed",
    "detail": "Redacted, actionable diagnostic information",
    "requestId": "c534f90b-7a9b-4c15-8905-e88a477db736",
    "meta": {}
  }
}
```

- `code` is a stable machine-readable identifier.
- `message` is a stable user-facing description; actual UI/API messages may be Chinese.
- `detail` and `meta` are optional and must be redacted.
- Every request returns `X-Request-Id`. Safe client IDs are preserved; otherwise the server generates one.
- Never return raw subscriptions, complete subscription URLs, node credentials, authentication cookies, controller secrets or user home directories in errors.

## Change checks

For application/server changes, run at least:

```bash
npm test
npm run build
docker compose --env-file .env.example config --quiet
npm run docker:update
```

Database, error-response and security-boundary changes also require matching upgrade and leak-regression tests.
