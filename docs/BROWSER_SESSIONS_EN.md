# Browser session rotation

Use one proxy port per browser profile. Select **会话轮换** (session rotation) with at least two ordered nodes. Start a session before opening the browser; close the profile before ending the session. Requests, destinations and idle periods do not change the selected node. A new session chooses a healthy node different from the previous one. If none is available, starting fails. Mid-session failures retain the node and never fall back to a direct connection.

This feature requires the managed embedded Mihomo deployment (Docker or portable). Existing connection-based round robin keeps its behavior. Sessions survive application/core restarts; interrupted transitions require ending the old session before starting again. Scheduled port probes skip session ports. Manual verification requires an active session and does not rotate it.

## Launch Roxy from the web UI

Enable Roxy's local API, then open **Settings → Browser integrations** in the manager. Enter the API port (default `50000`) and API Key, and select **Test and connect**. Edit a session-rotation port and select the Roxy team, project, and window from the discovered lists. IDs are stored internally; manual ID fields are only a fallback when discovery is unavailable.

With proxy synchronization enabled, the manager updates the selected window to use `127.0.0.1:<port>`. The port card then offers **Launch Roxy**. It pins the node before changing the proxy and opening the window, monitors `browser/connection_info`, and ends the session after the window closes. Docker deployments translate the local endpoint to `host.docker.internal` automatically. Roxy and the manager must run on the same computer.

## CLI launcher and regular browsers

Copy the [Roxy configuration](examples/session-roxy.json) or [Chromium configuration](examples/session-chromium.json) to a private local file. Set the port, unique profile ID and browser configuration. Configure the browser's proxy to use that port. Obtain a manager token with `ports:write` scope and save it separately.

```powershell
$env:PPM_API_URL = 'http://127.0.0.1:4173'
$env:PPM_API_TOKEN_FILE = 'C:\Private\ppm-token.txt'
$env:ROXY_API_KEY_FILE = 'C:\Private\roxy-key.txt'
node scripts/launcher.mjs launch 'C:\Private\browser-session.json'
```

Portable installations can use `bin/ppm.cmd` instead of `node scripts/launcher.mjs`. Run the launcher on the browser's host, not inside Docker. Roxy needs its local API enabled and actual string workspace/profile IDs. Its adapter uses the documented `browser/open` and `browser/connection_info` endpoints; verify support in your installed client. See the [official API reference](https://roxybrowser.cn/docs/api-documentation/api-endpoint.html).

The CLI launcher binds a node before opening the browser, waits for the profile to exit, then ends that exact session. Wait for `ended` before immediately relaunching. An already-running matching Roxy profile returns `already-running` without rotation. CLI Roxy configurations still require IDs; normal Roxy use should use the web binding above. Launching from Roxy's original button bypasses this workflow.

The command adapter requires `lifecycle: process`: the spawned executable must own an independent process that stays alive for the full session. It must not forward startup to another process. The Chromium example uses a dedicated profile directory and disables background mode. Use manual start/end if your program does not satisfy this process contract.

Keep the launcher running. On uncertain startup, lost browser status or launcher failure, the node remains bound. Check that the browser is closed before manually ending the session. API keys are read from files/environment, never command-line arguments or browser child-process environment.

## CLI and recovery

```text
ppm ports session 17900
ppm ports start 17900 my-launch-0001 profile-17900
ppm ports end 17900 SESSION_ID_FROM_START
```

Reuse the same `launchId` only when retrying one logical start. A new run needs a new ID. Only `state: active` permits launching; other start states return CLI exit code 2. Historical retries do not rotate again. Ending an old session never terminates a newer session. Stored `active` state describes a binding, not current node health.

Session state is stored in `proxy-sessions.sqlite` next to the embedded core state (override with `PROXY_SESSION_DB`). Recovery exports include strategy configuration but not live proxy sessions; close outstanding sessions before applying recovery. Node identity does not guarantee a fixed public IP.

Run `npm test`, `npm run build`, and `node tests/proxySessionCore.integration.mjs PATH_TO_MIHOMO` for validation. The real-core test uses isolated local fixtures.
