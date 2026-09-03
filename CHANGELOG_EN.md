# Changelog

[简体中文](CHANGELOG.md) · English

Public versions follow semantic versioning. This file records user-facing behavior; see Git history for implementation details.

## [Unreleased]

## [1.2.0] - 2026-09-03

### Added

- Live node health, cancellable batch latency tests, port verification history, 24-hour success rates and hourly failure trends.
- Opt-in background probes with concurrency, frequency and capacity limits; persistent history and settings.
- Versioned `/api/v1` and an 18-operation OpenAPI contract, with expiring and revocable scoped API tokens.
- `ppm doctor / backup / restore / ports list / subscriptions refresh` automation commands, credential files, JSON output and explicit exit codes.
- Configuration diffs, missing-node checks, 10-minute signed plans and explicit restore application in the UI and API; stale plans are rejected after configuration changes.

### Fixed

- Subscription import, edits, refresh and deletion commit only after Mihomo confirms reload. Failure restores previous snapshots, nodes and core configuration, records the error, and prevents invalid subscriptions from affecting later port operations.
- YAML parse errors return only codes and positions; UUID/private-key redaction is expanded, and historical audit records are redacted again on read.
- Diagnostics detect enabled but stopped schedulers, distinguishing no scheduled work from intentional pauses during backup/restore.

### Improved

- Release is manual-only. New version-tag pushes no longer trigger duplicate draft builds; Draft remains the default and public release requires explicit confirmation.
- Updated both READMEs and completed Chinese/English deployment, observability, automation, release, contribution, security, architecture, changelog and third-party guides with navigation.
- Portable bundles include all bilingual guides, the license and README image; regression checks cover documentation links, version consistency and API listings.

## [1.1.0] - 2026-09-02

### Added

- Independent M2 acceptance verifying six-platform signatures/SBOMs and pulling dual-architecture images by digest from an isolated GHCR package without creating a Release.
- At this version, tag pushes defaulted to Draft; official image pushes and public Releases required explicit manual confirmation.
- Six-platform portable release engineering, including Windows ARM64, per-archive CycloneDX SBOMs, metadata checksums and SBOM attestations.
- Final-archive tests for first startup, authentication, Mihomo health, graceful stop and restart with data isolated from user configuration.
- GHCR Linux amd64/arm64 images, dual-architecture container smoke tests, BuildKit SBOM/provenance, tag overwrite protection and digest-pinned deployment instructions.
- Source revision, UTC build time, target architecture and Node/Mihomo versions in Settings; `--no-open` for portable startup.
- Passphrase-encrypted configuration backup, restore validation and rollback on failure, excluding sessions and audit logs.
- Persistent server-side audit events, result filtering, retention settings and redaction before writes.
- Database, scheduler, Mihomo, port-configuration and storage diagnostics, with redacted exports.
- Browser security headers, same-origin mutation checks and bounded failed-login records.
- Release metadata validation, note extraction, artifact smoke tests and support for publishing historical tags.

### Improved

- Diagnostics, backup/restore and version information consolidated in System Settings; operation history now uses persistent server-side data.
- Application versions included in portable filenames for downloading, verification and archiving.

### Fixed

- Windows Git Bash could select GNU tar and interpret a drive letter as a remote host. Packaging, core extraction and verification now use the system archive tool.
- Recovery locks cover case/trailing-slash route variants and remain held until the operation completes, including after client disconnection.
- Backup export/import size limits are aligned with space reserved for encryption; oversized exports are rejected.
- Mihomo Windows ZIP archives are no longer mistaken for extracted executables when packaging.

## [1.0.0] - 2026-09-02

### Added

- Transactional versioned migrations for subscription/session databases, with automatic pre-upgrade rollback backups.
- Request IDs and consistent redacted API errors for all HTTP requests.
- Regression tests for migrations, errors and sensitive-data redaction.
- Self-contained Windows/Linux/macOS bundles with Node.js, the web UI and pinned Mihomo.
- Cross-platform `ppm start/stop/status/open` commands with foreground/background modes.
- Mihomo download manifests, SHA256 verification and a multi-platform GitHub Actions matrix.

### Improved

- Authentication, subscription, port and system routes split from the server entrypoint; extracted browser API client, state hooks and loosely coupled page components.
- Explicit runtime startup and graceful shutdown of the management service.
- Separate portable data, logs, runtime-state and core directories; loopback-only local ports by default.

## [0.1.1] - 2026-09-01

### Added

- HTTP and SOCKS5 copy buttons in the proxy-port list for complete proxy URLs.
- `docker:update` and `docker:watch` for reliable local container updates and continuous rebuilds.

### Improved

- Consistent subscription, listener and port-configuration wording in the UI and bilingual documentation.
- Removed specific subscription brands and node names from public source/tests.

## [0.1.0] - 2026-09-01

First public version, scoped to a single-machine local proxy pool.

### Added

- Native subscription database with URL/Mihomo/Clash YAML import, refresh and failure fallback.
- HTTP, SOCKS5 and Mixed local port pools.
- Manual, failover, lowest-latency, consistent-hashing and round-robin strategies.
- Listener checks and multi-connection exit-distribution verification.
- Dedicated Mihomo core, hot reload and container persistence.
- Secure initialization and a dedicated administrator-password reset flow.
- Optional Clash Verge remote-subscription migration.
- Docker Compose deployment, automated tests, CI, Dependabot and community templates.

### Security boundaries

- Default binding is `127.0.0.1`; direct public proxy hosting is unsupported.
- `.env`, subscription databases and generated Mihomo configuration are treated as sensitive.
- The public repository excludes local subscriptions, node credentials, runtime databases, logs and test screenshots.
