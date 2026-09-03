# Web updates

[简体中文](UPDATING.md) · English

Web updates support standard Windows/Linux/macOS portable bundles and Docker Compose installations enrolled with an independent updater. Only higher stable releases with compatible, trusted signed manifests can be installed.

## Regular updates

After signing in, use the global version control or **Settings → Version updates**. A new-release tip appears at most once per version per day. You can postpone it or ignore that version while keeping the update window accessible.

Review the release notes and select **Update and restart automatically**. After downloading and checking the release, the updater counts down for five seconds, stops the services, creates a complete recovery point, installs the new version and starts it. Proxy connections may briefly disconnect. The page reconnects and reports success only after the running version, databases, subscription decryption, core and enabled listeners pass verification. Closing the browser does not cancel the task.

Cancellation can be requested during preparation, download and the countdown. Once service shutdown begins, installation or recovery continues. Automatic checks are enabled by default but never install automatically; you can disable them and still check manually. Network failures do not affect ordinary proxy use.

## First portable upgrade

Portable bundles register the updater on their first normal startup starting with version 1.3.0. Public versions 1.2.0 and earlier have no web update control and need one manual upgrade. Stop the old service, back up the complete `data` and `core` directories, unpack the new release into a writable directory, migrate the data and start the new copy. When moving core configuration and caches, keep the new bundle's Mihomo executable. Do not run both copies simultaneously.

Keep using the original installation's launchers after web updates. New application files are stored under `releases/<version>` and selected by `.ppm-updates/active-release.json`; the existing data and core configuration directories remain in use. Do not move these directories independently.

Custom databases or key files outside the registered data directory, and overlapping data paths, require a manual upgrade or a supported layout before enrollment.

## Docker enrollment

Update the source and run `npm run docker:update`. With both original services healthy, run this from the existing deployment directory:

```text
npm run updates:setup-docker
```

Pass additional Compose files in their original order:

```text
npm run updates:setup-docker -- --compose-file compose.yaml --compose-file compose.legacy.yaml
```

If a trusted updater image has already been built locally, add `--updater-image proxy-port-manager-updater:1` to reuse it without rebuilding or checking base images online.

Enrollment verifies the actual project, containers and persistent mounts, builds the independent updater and retains the existing volumes and ports. The updater runs as uid 1000 with the group needed for Docker socket access. The management container does not receive the socket. Re-running enrollment resumes the registered deployment.

The effective deployment configuration is stored in `.local/updater/control/deployment.compose.json`. It may contain secrets; `.local` is ignored by Git. Use the project name printed by the setup script for later management, for example:

```text
docker compose -p proxy-port-manager -f .local/updater/control/deployment.compose.json ps
docker compose -p proxy-port-manager -f .local/updater/control/deployment.compose.json logs --tail 100 updater
```

Do not overwrite this deployment with the original Compose template, which lacks the updater enrollment and selected image digests. `npm run docker:update` supports source development while preserving enrollment and refuses recreation during pending web updates. Managed production deployments use web updates; `docker:watch` is intended for source development before updater enrollment. Without enrollment, the page provides release information and enrollment guidance.

## Failures and recovery

Download failures leave the original service running. A backup failure after shutdown restarts the original service. Installation, migration, startup or verification failures restore the program and complete data from the same recovery point. Failed automatic recovery is reported explicitly.

From the original portable installation directory on Windows:

```text
.\bin\ppm.cmd recover-update
```

On Linux/macOS:

```text
./ppm recover-update
```

For Docker, stop the resident updater before running recovery once, then restart it. Substitute the registered project name:

```text
docker compose -p proxy-port-manager -f .local/updater/control/deployment.compose.json stop updater
docker compose -p proxy-port-manager -f .local/updater/control/deployment.compose.json run --rm --no-deps updater node server/updates/worker.mjs --directory /updates --once --recover
docker compose -p proxy-port-manager -f .local/updater/control/deployment.compose.json up -d --no-deps updater
```

Portable task records and recovery points are under `.ppm-updates`. Docker public task state is under `.local/updater/state`; authoritative records and recovery points are under `.local/updater/control`. Recovery points include complete keys and need the same protection as the original data. Old recovery points are not removed automatically; manage disk space after confirming stability.

Restoring an old snapshot after a successful upgrade would discard later changes, so silent downgrades are not provided. The existing encrypted configuration export is not a complete upgrade recovery point. Do not delete persistent volumes or use `docker compose down -v`.

## Publisher configuration

1. `release/update-public-keys.json` contains the trusted public keys shipped with the application and updater. Generate an initial key with `npm run updates:keygen`; its private key is stored only in ignored `.local/update-signing`. Never commit it or regenerate the key for each release.
2. Set the matching private key as the repository Actions Secret `UPDATE_SIGNING_PRIVATE_KEY`. Existing installations can accept a key only if its public counterpart is already built in. Distribute replacement public keys through a release signed by the old key before rotating.
3. Use a new version and declare the tested source-version range in `release/update-policy.json`. The initial range is 1.2.0; the target must be higher. Preparing a version does not publish it, and old public bundles still need the first manual upgrade.
4. Stable publication checks signing configuration before pushing images. It then signs `update-manifest.json`, binding portable archives, the source revision and the application/core image digests. Missing or mismatched keys block publication. Prereleases do not enter the stable update channel.
5. The current updater protocol is 1. The independent updater is not replaced in the middle of a transaction. A future protocol change needs a compatible enrollment path.

See the [design background](UPGRADE_DESIGN.md) for transaction and recovery details.
