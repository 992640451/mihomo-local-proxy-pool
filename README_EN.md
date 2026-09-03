<p align="center">
  <img src="assets/readme-hero.png" alt="Three proxy nodes merging into one local port connected to a desktop app" width="100%" />
</p>

<h1 align="center">Proxy Port Manager</h1>

<p align="center">
  Turn multiple Mihomo / Clash nodes into one stable and observable local proxy port.
</p>

<p align="center">
  <a href="README.md">简体中文</a> · English
</p>

<p align="center">
  <a href="https://github.com/992640451/mihomo-local-proxy-pool/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/992640451/mihomo-local-proxy-pool/ci.yml?branch=main&style=flat-square" alt="CI" /></a>
  <a href="https://github.com/992640451/mihomo-local-proxy-pool/releases/latest"><img src="https://img.shields.io/github/v/release/992640451/mihomo-local-proxy-pool?style=flat-square" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/992640451/mihomo-local-proxy-pool?style=flat-square" alt="MIT License" /></a>
  <a href="https://github.com/992640451/mihomo-local-proxy-pool/stargazers"><img src="https://img.shields.io/github/stars/992640451/mihomo-local-proxy-pool?style=flat-square" alt="GitHub Stars" /></a>
  <img src="https://img.shields.io/badge/scope-localhost-34d399?style=flat-square" alt="Localhost only" />
</p>

<p align="center">
  <a href="#3-minute-start"><strong>3-minute start</strong></a> ·
  <a href="#first-use"><strong>First use</strong></a> ·
  <a href="#connect-your-app"><strong>Connect an app</strong></a> ·
  <a href="#faq"><strong>FAQ</strong></a>
</p>

---

```text
Subscription nodes  ──►  127.0.0.1:17900  ──►  Browser / crawler / dev tool
                           fixed local entry
```

Your application only needs one local address. Proxy Port Manager and Mihomo handle node selection, failover, health checks, and round-robin routing.

## Why use it?

| One stable address | Automatic routing | Visible and verifiable |
| --- | --- | --- |
| Your app configuration stays unchanged when nodes change | Failed nodes are skipped automatically, with five routing strategies | Manage pools in a browser and verify listeners and exit distribution |

It is designed for local development, crawlers, automation tools, and applications that need a stable HTTP or SOCKS5 proxy entry.

## What's new in 1.2.0

This branch is version **1.2.0**. Available public bundles and images are listed under [Releases](https://github.com/992640451/mihomo-local-proxy-pool/releases). Updating source code does not automatically update published downloads.

- **Node and port observability**: measured node health, batch latency tests, port verification history, and 24-hour failure trends. Background probes are off by default, with configurable traffic and history limits.
- **Script automation**: `/api/v1`, OpenAPI, revocable scoped tokens, and `ppm doctor / backup / restore / ports list / subscriptions refresh`.
- **Restore planning**: review subscription, node, and port additions, changes, and deletions before explicitly applying a signed plan. Plans expire after 10 minutes and must be regenerated if configuration changes.
- **Reliability fixes**: subscription changes commit only after Mihomo confirms reload, with rollback on failure; improved YAML-error and historical-audit redaction and scheduler diagnostics.

See [Observability](OBSERVABILITY_EN.md), [Automation API and CLI](AUTOMATION_EN.md), and the [full changelog](CHANGELOG_EN.md).

> [!IMPORTANT]
> This project manages subscriptions you are authorized to use. It does not provide proxy nodes. It binds to `127.0.0.1` by default and is intended for a single-machine local proxy pool, not a public proxy service.

## 3-minute start

Proxy Port Manager supports two local deployment modes:

- **Docker Compose** for development machines, NAS devices, and long-running hosts.
- **Portable server bundles** for Windows, Linux, and macOS. They include Node.js and Mihomo, open the existing web UI in a browser, and do not require Docker or Git.

### Windows portable deployment

Download the portable ZIP for your architecture (x64 or arm64) from [Releases](https://github.com/992640451/mihomo-local-proxy-pool/releases), extract it into a writable directory, then run:

```powershell
.\ppm.cmd start
```

The first start prints a generated administrator password and opens your browser after Mihomo and the management service are ready. Save the password. To manage a background instance:

```powershell
.\ppm.cmd start --background
.\ppm.cmd status
.\ppm.cmd open
.\ppm.cmd stop
```

Portable state is stored in the `data` directory beside the launcher. Stop the service and back up that directory before upgrading; do not overwrite it with the new bundle. See [Portable deployment](PORTABLE.md).

### Linux / macOS portable deployment

Download the `.tar.gz` for your system and architecture (x64 or arm64), extract it, and enter the directory:

```bash
./ppm start
# To run without automatically opening a browser:
./ppm start --background --no-open
./ppm status
./ppm stop
```

The default management URL is also `http://127.0.0.1:4173`. Even in background mode, the generated password is shown only once in the current terminal on first start. Save it immediately.

### Docker Compose

#### 1. Requirements

- Git
- Node.js 22 or newer
- Docker Desktop, or Docker Engine with Compose

On Windows, make sure Docker Desktop is using Linux containers.

#### 2. Install and start

```bash
git clone https://github.com/992640451/mihomo-local-proxy-pool.git
cd mihomo-local-proxy-pool
npm run init
docker compose up -d --build
```

`npm run init` creates a machine-local `.env`, random secrets, and an administrator password. Save the password shown in your terminal; it is never committed to the repository.

#### 3. Open the dashboard

Visit [http://127.0.0.1:4173](http://127.0.0.1:4173) and sign in with the credentials printed during initialization.

Check that the service is ready:

```bash
docker compose ps
curl http://127.0.0.1:4173/healthz
```

The management service is ready when the response contains `status: ok`.

## First use

1. Open **Subscriptions (订阅)** and enter a subscription URL or paste Mihomo / Clash YAML.
2. Open **Proxy Ports (代理端口)** and select **Create Port Pool (新建端口池)**.
3. Use port `17900` and choose `Mixed`. For one node, select **Manual (手动选择)**; the default **Failover (主备切换)** requires at least two nodes.
4. Save, then run **Check (检测)** and confirm it reports “Listener reachable”.
5. Use the protocol icon beside the port and paste the proxy address into your application.
6. Test selected nodes in **Nodes (节点)** and view verification history in **Observability (可观测性)**. Enable background probes explicitly if needed.

“Listener reachable” only confirms that a port accepts connections. Also click **Verify (验证)** to check access to the exit-lookup service through the proxy. Node tests measure request latency, not download bandwidth.

For round-robin routing, select at least two nodes and choose **Round Robin**. Round robin applies to new connections; an established TCP connection does not move between nodes.

## Connect your app

Assume you created a Mixed listener on port `17900`:

### Command line

```bash
# HTTP / HTTPS
curl --proxy http://127.0.0.1:17900 https://api.ipify.org

# SOCKS5 with remote DNS resolution
curl --proxy socks5h://127.0.0.1:17900 https://api.ipify.org
```

In Windows PowerShell, use `curl.exe` instead of `curl` when necessary.

### Environment variables

```text
HTTP_PROXY=http://127.0.0.1:17900
HTTPS_PROXY=http://127.0.0.1:17900
ALL_PROXY=socks5h://127.0.0.1:17900
```

Browsers, IDEs, downloaders, and crawlers usually accept the same settings: host `127.0.0.1` and the port you created.

## Verify round robin

1. Select at least two healthy nodes for the pool.
2. Choose **Round Robin** and save.
3. Click **Verify** in the port list.
4. The service opens eight independent connections and reports success rate, exit-IP distribution, and average latency.

Multiple exit IPs usually indicate that rotation is working. Different nodes may share the same public exit, so one unique IP does not always mean round robin failed. Check node health and Mihomo logs as well.

## Choose a strategy

| Strategy | Best for | Behavior |
| --- | --- | --- |
| Manual | Pinning one node | Always uses the selected node |
| Failover | Reliability | Tries backup nodes in order after a failure |
| Lowest latency | Speed | Selects a currently faster healthy node |
| Consistent hashing | Stable routing per target | Tries to keep the same target on the same node |
| Round robin | Spreading new connections | Rotates new connections across healthy nodes |

Automatic strategies only use nodes that pass health checks. The service rejects invalid pools, unpublished ports, or nodes removed by a subscription update and explains the reason.

## Core features

- Import subscription URLs or paste Mihomo / Clash YAML.
- Encrypted subscription storage with last-known-good fallback.
- HTTP, SOCKS5, and Mixed local port pools.
- Health checks, failed-node skipping, and Mihomo hot reload.
- Listener checks and multi-connection exit-distribution verification.
- Live node health, bounded batch latency tests, persistent port verification history, and 24-hour failure trends. Background probes are off by default; see the [observability guide](OBSERVABILITY_EN.md).
- Persistent sessions, subscriptions, and port-pool state.
- Passphrase-encrypted configuration backups with automatic rollback on restore failure.
- Persistent server-side audit events and redacted diagnostic exports.
- Scoped API tokens, a versioned API, OpenAPI, and automation commands; restore planning and explicit application.
- Optional migration from Clash Verge remote subscriptions.

## How it works

```text
Local application
   │ HTTP / SOCKS5
   ▼
127.0.0.1:17900 ──► Mihomo strategy group ──► healthy node ──► Internet
                              ▲
                              │ local Controller API
Browser ──► 127.0.0.1:4173 ───┘
```

Compose publishes `17891-17893` and `17900-17999` by default. If startup reports a port conflict, check the entire range.

## Common commands

```bash
# Status
docker compose ps

# Logs
docker compose logs -f --tail=100

# Update
git pull --ff-only
npm run docker:update

# Stop while keeping data
docker compose down
```

Do not run `docker compose down -v` unless you intend to delete subscriptions, sessions, and port-pool data.

After changing local code, run `npm run docker:update`. It rebuilds and force-recreates only the management service, then waits for a passing health check. The Mihomo container and persistent data are preserved.

For an active development session, keep this running in a separate terminal:

```bash
npm run docker:watch
```

Compose watches application source, server code, dependencies, and container configuration, and rebuilds the management service after relevant changes. Press `Ctrl+C` to stop watching; the running containers remain available.

### Reset the administrator password

```bash
npm run init -- --reset-password
docker compose up -d --force-recreate proxy-port-manager
```

This resets only administrator credentials and preserves the subscription encryption key.

## Data and security

- `.env` contains machine-local secrets, is ignored by Git, and must not be shared.
- Subscription URLs, raw YAML, and sensitive node fields are encrypted with AES-256-GCM before being stored in SQLite.
- System Settings can download a passphrase-encrypted recovery package. Restore is a full replacement: resources missing from the package are deleted, so preview the plan first. The package excludes administrator credentials, sessions, API tokens, audit events, observation history and probe schedules, and does not change the target host's port mappings.
- Recovery payloads are limited to 24 MiB and encrypted files to 33 MiB. Oversized payloads are rejected during export so backups remain importable.
- Audit events are redacted before storage. Diagnostic exports exclude complete subscription URLs, node credentials, cookies, and controller secrets.
- Compose binds to `127.0.0.1` by default. Do not change it to `0.0.0.0` without additional authentication and network isolation.
- `proxy-session-data` stores subscriptions, sessions, API-token digests, audit events, observation history/settings, and pools; `proxy-mihomo-data` stores Mihomo runtime configuration.
- Management login does not authenticate proxy traffic. API secrets are shown only once; give each script the minimum scopes it needs and keep secrets out of command arguments, repositories, and logs.

Report security issues privately according to the [security policy](SECURITY_EN.md).

## Migrate from Clash Verge

New installations do not depend on Clash Verge. To import existing Clash Verge remote subscriptions, follow [DOCKER.md](DOCKER.md). Switch back to native subscription mode after migration.

## FAQ

<details>
<summary><strong>The proxy connects, but the exit does not change</strong></summary>

Round robin operates on new connections. Disable connection reuse or run separate `curl` processes, and confirm that at least two nodes pass health checks.

</details>

<details>
<summary><strong>The port is not listening</strong></summary>

Run `docker compose ps` and `docker compose logs mihomo-core`. Confirm that the port is inside the published range and is not already used by another program.

</details>

<details>
<summary><strong>Initialization says .env already exists</strong></summary>

This prevents accidental key replacement. An existing installation does not need initialization again. If you forgot the password, run `npm run init -- --reset-password`.

</details>

<details>
<summary><strong>Will rebuilding containers delete my data?</strong></summary>

No. Docker volumes persist by default. Data is preserved across `docker compose down` and image rebuilds unless you explicitly delete the volumes.

</details>

## Development

```bash
npm ci
npm test
npm run build
npm run dev
```

Development uses frontend port `4173` and API port `4180`; do not start it alongside a Docker or portable instance using those ports. Actual proxy features also require a configured Mihomo instance. For isolated UI checks after building, use `node tests/helpers/observability-preview.mjs --auth` with temporary data and a mock core; see the [automation guide](AUTOMATION_EN.md).

## Documentation

Existing filenames are preserved, and each guide links to its translation. English documentation does not imply an English UI: the management interface currently uses primarily Chinese labels.

| Topic | 简体中文 | English |
| --- | --- | --- |
| Docker deployment | [阅读](DOCKER_ZH.md) | [Read](DOCKER.md) |
| Portable deployment | [阅读](PORTABLE_ZH.md) | [Read](PORTABLE.md) |
| Observability | [阅读](OBSERVABILITY.md) | [Read](OBSERVABILITY_EN.md) |
| Automation API and CLI | [阅读](AUTOMATION.md) | [Read](AUTOMATION_EN.md) |
| Releases and verification | [阅读](RELEASING.md) | [Read](RELEASING_EN.md) |
| Changelog | [阅读](CHANGELOG.md) | [Read](CHANGELOG_EN.md) |
| Contributing | [阅读](CONTRIBUTING.md) | [Read](CONTRIBUTING_EN.md) |
| Security policy | [阅读](SECURITY.md) | [Read](SECURITY_EN.md) |
| Architecture and evolution | [阅读](docs/ARCHITECTURE.md) | [Read](docs/ARCHITECTURE_EN.md) |
| Third-party notices | [阅读](THIRD_PARTY_NOTICES_ZH.md) | [Read](THIRD_PARTY_NOTICES.md) |

## Project status

This is an early release focused on a single-machine local proxy pool. Public proxy hosting, multi-tenancy, billing, and distributed scheduling are out of scope.

If this project helps you, consider giving it a Star so more people who need a local proxy pool can find it.

## License

[MIT License](LICENSE)
