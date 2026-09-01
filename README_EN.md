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

> [!IMPORTANT]
> This project manages subscriptions you are authorized to use. It does not provide proxy nodes. It binds to `127.0.0.1` by default and is intended for a single-machine local proxy pool, not a public proxy service.

## 3-minute start

### 1. Requirements

- Git
- Node.js 22 or newer
- Docker Desktop, or Docker Engine with Compose

On Windows, make sure Docker Desktop is using Linux containers.

### 2. Install and start

```bash
git clone https://github.com/992640451/mihomo-local-proxy-pool.git
cd mihomo-local-proxy-pool
npm run init
docker compose up -d --build
```

`npm run init` creates a machine-local `.env`, random secrets, and an administrator password. Save the password shown in your terminal; it is never committed to the repository.

### 3. Open the dashboard

Visit **http://127.0.0.1:4173** and sign in with the credentials printed during initialization.

Check that the service is ready:

```bash
docker compose ps
curl http://127.0.0.1:4173/healthz
```

The management service is ready when the response contains `status: ok`.

## First use

1. Open **Subscriptions** and enter a subscription URL or paste Mihomo / Clash YAML.
2. Open **Proxy Ports** and select **Create Port Pool**.
3. Use port `17900`, choose `Mixed`, and select at least one node.
4. Save, then run **Check**. “Listener reachable” means the port is ready.
5. Use the copy button beside the port and paste the proxy address into your application.

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
- Encrypted native subscription storage with last-known-good fallback.
- HTTP, SOCKS5, and Mixed local port pools.
- Health checks, failed-node skipping, and Mihomo hot reload.
- Listener checks and multi-connection exit-distribution verification.
- Persistent sessions, subscriptions, and port-pool state.
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
docker compose up -d --build

# Stop while keeping data
docker compose down
```

Do not run `docker compose down -v` unless you intend to delete subscriptions, sessions, and port-pool data.

### Reset the administrator password

```bash
npm run init -- --reset-password
docker compose up -d --force-recreate proxy-port-manager
```

This resets only administrator credentials and preserves the subscription encryption key.

## Data and security

- `.env` contains machine-local secrets, is ignored by Git, and must not be shared.
- Subscription URLs, raw YAML, and sensitive node fields are encrypted with AES-256-GCM before being stored in SQLite.
- Compose binds to `127.0.0.1` by default. Do not change it to `0.0.0.0` without additional authentication and network isolation.
- `proxy-session-data` stores subscriptions, sessions, and pools; `proxy-mihomo-data` stores Mihomo runtime configuration.

Report security issues privately according to [SECURITY.md](SECURITY.md).

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

More: [Docker deployment](DOCKER.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Project status

This is an early release focused on a single-machine local proxy pool. Public proxy hosting, multi-tenancy, billing, and distributed scheduling are out of scope.

If this project helps you, consider giving it a Star so more people who need a local proxy pool can find it.

## License

[MIT License](LICENSE)
