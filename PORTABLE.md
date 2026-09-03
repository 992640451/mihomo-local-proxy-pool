# Portable server deployment

[简体中文](PORTABLE_ZH.md) · English

The portable distribution runs Proxy Port Manager as a local service
and opens its existing web interface in the default browser. It does not require
Docker, Git, or a system-wide Node.js installation.

## Windows double-click setup (recommended)

1. Download a Windows portable ZIP from [Releases](https://github.com/992640451/mihomo-local-proxy-pool/releases): choose an asset containing `windows-x64.zip` for an x64 PC or `windows-arm64.zip` for ARM. Do not choose `Source code`.
2. Right-click → **Extract All** into a writable folder, keeping the whole folder together. Do not run from inside the ZIP or move individual `.cmd` files to the desktop; create a shortcut instead.
3. Double-click **`启动管理器.cmd` (Start Manager)**. On first start, save `管理账号` (username) and `管理密码` (password). The password appears only when generated; it is not stored in plaintext or background logs.
4. Your default browser opens when the manager and bundled Mihomo are ready. The default URL is `http://127.0.0.1:4173`; use the URL printed in the window. After saving the password, press any key to close that window. The service keeps running in the background.

Double-clicking Start Manager again checks the existing instance and reopens its page if healthy. **`打开管理页面.cmd` (Open Dashboard)** only opens a running instance. **`停止管理器.cmd` (Stop Manager)** stops the manager and bundled Mihomo, preserving `data`. Closing the browser or startup window does not stop the service. There is no auto-start; start manually after rebooting the PC.

These Chinese-named launchers ship with Windows bundles starting at **1.2.0**; public availability depends on Release assets. For older bundles without them, follow the included command-line guide. Double-click [START_HERE.txt](START_HERE.txt) ([简体中文](开始使用.txt)) in the bundle for a short guide.

See [README: First use](README_EN.md#first-use) for subscription import, port creation and app configuration. Dashboard port `4173` is not a proxy port; the app does not change system proxy settings.

## Windows command line (advanced)

The command line is only needed for scripts or foreground debugging. Open PowerShell in the extracted folder:

```powershell
# Foreground: keep the window open; press Ctrl+C to stop
.\bin\ppm.cmd start

# Or run in the background, as the double-click launcher does
.\bin\ppm.cmd start --background
.\bin\ppm.cmd status
.\bin\ppm.cmd open
.\bin\ppm.cmd stop
```

For headless operation, add `--no-open`. Even if the first start uses `--background`,
the generated password is shown once in the current terminal, not the background
application log. Save it immediately.

The Windows CLI has moved to `bin/ppm.cmd`; the root no longer contains the old entry point or the Linux/macOS `ppm` script. Update existing scripts and CLI shortcuts to the new path shown above. `.\` means "in the current directory". Everyday users only need the three Chinese-named launchers. Running `start --background` again reopens a healthy instance instead of failing with a duplicate-start error. `data` stays at the extraction root, not inside `bin`; do not move or delete `bin`.

## Windows startup troubleshooting

- **Missing launcher or Node.js not found**: ensure this is not `Source code` or an older bundle. Extract everything, including `runtime/node.exe`, `core/mihomo.exe`, `app` and `bin/ppm.cmd`. No separate Node.js installation is needed.
- **Cannot run or blocked file**: check x64 / arm64 compatibility, official source and [release checksums](RELEASING_EN.md#verify-downloads-and-deploy-images). Check for security-software quarantine; do not simply disable protection or run untrusted copies.
- **Startup failure / occupied ports**: keep the window's error and inspect `data/logs/application.log` and `data/logs/mihomo.log`. Do not run Docker, old bundles or another copy on the same ports. Default management port `4173` and controller port `19090` must be available.
- **Existing process is unhealthy**: double-click Stop Manager and confirm success before restarting; do not delete lock files to force a second instance.
- **No browser opens**: visit the printed URL or use Open Dashboard; if stopped, start the manager first.
- **First startup fails after printing credentials**: save the password before troubleshooting. Configuration may already exist, so the password will not be shown again. Do not delete `data/config.env` to reinitialize; it also contains keys required to decrypt subscriptions.
- **Forgotten administrator password**: the portable launcher does not currently offer a password-reset command. Do not reuse Docker initialization commands. Stop the service, privately back up `data`, and ask the maintainers through [project Issues](https://github.com/992640451/mihomo-local-proxy-pool/issues) for recovery that preserves encryption keys. Share only the version and redacted errors, never `data`, configuration, passwords or subscription links.

## Linux and macOS

```bash
./ppm start
./ppm start --background
./ppm status
./ppm open
./ppm stop
```

## Data and updates

Portable data is stored in `data` at the extraction root, not inside `bin`. Stop the
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
