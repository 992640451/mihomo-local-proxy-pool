# Contributing

[简体中文](CONTRIBUTING.md) · English

Thank you for improving Proxy Port Manager. Before proposing changes, check that they fit its single-machine, local-proxy-pool scope.

## Development environment

- Node.js 22 or newer.
- Docker Engine / Docker Desktop with Compose.

```bash
npm ci
npm test
npm run build
```

For Mihomo configuration, port mappings or Docker changes, also run:

```bash
docker compose config
docker build -t proxy-port-manager:dev .
```

After local code changes, update the running management container and wait for its health check:

```bash
npm run docker:update
```

For iterative development, keep `npm run docker:watch` running in a separate terminal so Compose rebuilds after relevant changes.

## Pull requests

- Address one clear problem per PR.
- Include appropriate tests for new features and bug fixes.
- Never commit `.env`, subscription URLs, node credentials, databases, generated configuration, or real runtime logs.
- For UI changes, include before/after screenshots and check keyboard navigation, focus, and narrow layouts.
- Update both Chinese and English READMEs and relevant guides when behavior changes. Preserve existing filenames and translation links.
- Release preparation must synchronize package/lockfile versions, the Compose image tag and both changelogs. The API contract version does not automatically follow application minor versions. See [Release engineering](RELEASING_EN.md).
- Describe motivation, implementation, verification, and compatibility impact.

Server routes, database schemas and API errors must also follow the [architecture and evolution guidelines](docs/ARCHITECTURE_EN.md). Append new database migrations; never rewrite a published migration.

## Reporting issues

Use issue templates for ordinary bugs. Include your OS, Node/Docker versions, reproduction steps and redacted logs. Report vulnerabilities privately according to the [security policy](SECURITY_EN.md).
