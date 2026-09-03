# Portable server deployment

[简体中文](PORTABLE_ZH.md) · English

The portable distribution runs Proxy Port Manager as a local background service
and opens its existing web interface in the default browser. It does not require
Docker, Git, or a system-wide Node.js installation.

## Windows

Extract the archive into a writable directory and run:

```powershell
.\ppm.cmd start
```

The first start prints a generated administrator password. Save it immediately.
The browser opens `http://127.0.0.1:4173` after both the management service and
the bundled Mihomo core are healthy.

To keep the service running without an open terminal:

```powershell
.\ppm.cmd start --background
.\ppm.cmd status
.\ppm.cmd open
.\ppm.cmd stop
```

For headless operation, add `--no-open`. Even if the first start uses `--background`,
the generated password is shown once in the current terminal, not the background
application log. Save it immediately.

## Linux and macOS

```bash
./ppm start
./ppm start --background
./ppm status
./ppm open
./ppm stop
```

## Data and updates

Portable data is stored in the `data` directory next to the launcher. Stop the
service before copying that directory to preserve a consistent set of subscriptions,
encryption keys, login sessions, API tokens, audit events, observations and managed
ports. Extract updates into a new directory, copy your backed-up `data` into it,
then start the new launcher; do not run both copies at once. Keep the old directory
and backup until the new instance is verified. Do not point an older binary at a
database already upgraded by a newer version. Updating must not replace `data`. For a portable
configuration backup, use System Settings to download a passphrase-encrypted
recovery package. It includes subscriptions and managed ports but deliberately
excludes administrator credentials, login sessions, API tokens, audit history,
observation history and probe schedules. Restore is a full replacement, requires
a preview and a valid signed plan, and does not change host port mappings.

For headless workflows, create a scoped token in System Settings and use `ppm doctor`,
`ppm ports list`, `ppm subscriptions refresh --all`, `ppm backup backup.json`, or
`ppm restore backup.json --plan plan.json`. Restore only previews changes unless
`--apply --plan plan.json` is provided. Token state persists in `data/api-tokens.sqlite`.
See [Automation](AUTOMATION_EN.md) for secure credential-file configuration and the v1 API contract.

Node latency tests, port verification history and optional scheduled probes are
available in version 1.2.0. Background probes default to off; settings and samples
persist in `data/observability.sqlite`. See [Observability](OBSERVABILITY_EN.md).

System Settings also runs component diagnostics and exports a redacted JSON file
for troubleshooting. Operation history is persisted in `data/audit.sqlite` and
is subject to the configured retention and maximum-event limits.

The management API, Mihomo controller, and generated proxy listeners bind to
loopback by default. Do not expose them to a LAN or the public internet without
TLS, authentication, and explicit network isolation.

## Building a portable archive

Build the web application and download the pinned, SHA256-verified Mihomo binary
for the current operating system and architecture:

```bash
npm run portable:build
```

To build with an explicitly supplied core after `npm run build`, run
`npm run portable:package -- --core /path/to/mihomo`. Custom cores are not marked
as manifest-verified and cannot pass the public-release gate.

The archive is written under `.artifacts/portable`. Build each operating system
and architecture on a matching CI runner; Node.js and Mihomo are native binaries.

The release matrix covers Windows, Linux, and macOS on x64 and arm64. Each
archive includes a CycloneDX SBOM and build metadata, with matching sidecar files
covered by `SHA256SUMS.txt`. The SBOM records the npm build graph (including the
frontend and build tools) plus bundled Node/Mihomo binaries, not their complete
native transitive dependencies. System Settings shows source revision, UTC build
time, target and runtime versions. For headless use, pass `--no-open` to `start`
or `restart`, including when using `--background`.

See [Release engineering](RELEASING_EN.md) for CI gates, artifact verification,
GHCR images and recovery from interrupted releases.
