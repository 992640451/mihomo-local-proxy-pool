# Security policy

[简体中文](SECURITY.md) · English

## Supported scope

Security fixes prioritize the latest published version and default Docker Compose deployment. The project binds to `127.0.0.1` by default. Deployers are responsible for the security consequences of changing bindings, reverse proxies, or firewalls.

## Reporting vulnerabilities

Use **Security → Report a vulnerability** in the GitHub repository to report privately. Do not include exploit details, subscription URLs, node credentials, controller secrets or usable session cookies in public issues, discussions or pull requests.

Include:

- Affected version or commit.
- Deployment method and operating system.
- Minimal reproduction and impact.
- Redacted logs or requests.
- Possible mitigations, if known.

Avoid publishing directly exploitable details before a fixed version is available.

## Deployment boundaries

- Management login is not authentication for proxy traffic.
- Give each script the minimum API scopes it needs and restrict credential-file access. Scopes apply to the entire instance. Changing administrator credentials or `AUTH_SESSION_VERSION` invalidates old tokens.
- Active probes send proxy requests to test providers, which can see exit IPs. Local history stores exit IPs unencrypted; restrict database access.
- Default proxy ports are for the local host only, not direct public exposure.
- `.env`, SQLite databases and generated Mihomo configuration may contain sensitive information. Restrict access and protect backups.
- Encrypted recovery packages contain recoverable subscription/node credentials. Use strong passphrases stored separately. Review redacted diagnostics before publishing them.
- If a reverse proxy uses a different browser origin, list it precisely in `APP_ALLOWED_ORIGINS`; do not use wildcards.
- If secrets enter Git history, rotate them immediately rather than only removing the file from the newest commit.
