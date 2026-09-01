# Repository workflow

- After changing application, server, shared, dependency, or container files, run `npm run docker:update` before handing the work back. This rebuilds and recreates the local application container and waits for its health check.
- During an iterative local development session, prefer `npm run docker:watch`; keep it running so Compose rebuilds the application container whenever relevant project files change.
- Do not use `docker compose down -v` unless the user explicitly asks to delete persistent subscriptions, sessions, and port-pool data.
