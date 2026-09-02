# Portable server deployment

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

## Linux and macOS

```bash
./ppm start
./ppm start --background
./ppm status
./ppm stop
```

## Data and updates

Portable data is stored in the `data` directory next to the launcher. Back up
that directory to preserve subscriptions, encryption keys, login sessions, and
managed ports. Updating the application must not replace `data`. For a portable
configuration backup, use System Settings to download a passphrase-encrypted
recovery package. It includes subscriptions and managed ports but deliberately
excludes login sessions and server audit history.

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

Use `--core /path/to/mihomo` to build with an explicitly supplied core instead.

The archive is written under `.artifacts/portable`. Build each operating system
and architecture on a matching CI runner; Node.js and Mihomo are native binaries.

The release matrix covers Windows, Linux, and macOS on x64 and arm64. Each
archive includes a CycloneDX SBOM and build metadata, with matching sidecar files
covered by `SHA256SUMS.txt`. The SBOM records the npm build graph (including the
frontend and build tools) plus bundled Node/Mihomo binaries, not their complete
native transitive dependencies. System Settings shows source revision, UTC build
time, target and runtime versions. For headless use, pass `--no-open` to `start`
or `restart`, including when using `--background`.

See [Release engineering](RELEASING.md) for CI gates, artifact verification,
GHCR images and recovery from interrupted releases.
