# Release engineering

[简体中文](RELEASING.md) · English

Examples use **1.3.0**. M2 is a release-engineering roadmap milestone, not an application version. Version preparation, a local commit, pushing a tag and publishing a Release are separate steps. Changing the version does not mean it is published. Use a new semantic version for subsequent releases; never overwrite a public version.

The version currently being prepared is **1.3.0**, which introduces web updates. Existing installations need one manual upgrade first; see the [English upgrade guide](docs/UPDATING_EN.md) / [简体中文](docs/UPDATING.md). For subsequent releases, update the version numbers in the examples below.

## Preparation

1. In the same commit, update `package.json`, both the top-level and `packages[""]` versions in `package-lock.json`, the management image tag in `compose.yaml`, and nonempty version sections in `CHANGELOG.md` / `CHANGELOG_EN.md`. Update both READMEs and guides when features or instructions change; READMEs do not need an application version number. API v1's contract version does not automatically follow application minor versions.
2. Wait for CI: unit/integration tests, web build, Docker lifecycle smoke tests and final Windows/Linux x64 portable-bundle tests.
3. Check `release/core-manifest.json`: all targets must use the same Mihomo version and have SHA-256 hashes. When upgrading Mihomo, also synchronize its Compose version and subscription User-Agent.
4. Check the Release workflow's Node version against Dockerfile. Windows/Linux/macOS support x64 and arm64, built on native runners rather than copying host Node across targets.
5. Actions must be allowed to publish Packages and generate attestations. After the first release, check GHCR package visibility and repository association. A pre-existing package without repository access may reject `GITHUB_TOKEN` pushes.

### Update signing preflight

Before publishing a stable release, configure the private key matching `release/update-public-keys.json` as the repository Actions Secret `UPDATE_SIGNING_PRIVATE_KEY`. Keep the same signing key across releases. Before any image push, the workflow checks the key, built-in public key and supported source-version range; missing or mismatched configuration stops publication.

Local checks do not print the private key:

```text
node scripts/validate-update-signing.mjs --root . --key-file .local/update-signing/<key-id>.pem
npm run release:validate -- --tag v1.3.0
```

The final `update-manifest.json` is published with the archives, metadata and checksums. Existing installations must complete the initial enrollment described in the upgrade guide. Web updates accept only higher stable versions with manifests signed by a built-in trusted key.

## Triggers and permissions

- Pushing a `v*` tag automatically starts Release. Tags must use `vX.Y.Z` or `vX.Y.Z-beta.1` syntax and agree with the package, lockfile, Compose and both changelogs. After all checks pass, the workflow pushes GHCR and publishes Release without requiring Run workflow.
- Ordinary branch pushes do not start Release; tag deletions skip the pipeline. Automatic and manual runs for the same tag share a concurrency group without cancelling a running release.
- Manual runs default to `publish=false`: create/update a Draft, **without logging in to or pushing GHCR**, while retaining CI artifacts and generating GitHub attestations.
- Manual runs with `publish=true` also publish the image and Release after validation. Prerelease tags retain prerelease status without forcing latest status; public versions remain protected against overwrites.
- Local builds/validation do not publish anything. Do not include `.env` or real subscriptions in build contexts.

The workflow uses the built-in `GITHUB_TOKEN` with job-specific permissions such as `contents: write`, `packages: write`, `id-token: write` and `attestations: write`; no additional personal token is required. Repository or organization policies must allow these operations. Existing GHCR packages need repository access, and packages intended for direct public downloads need their visibility checked.

Ordinary CI and the separate M2 Acceptance triggers are unchanged. New tags must point to commits containing this automatic release configuration; historical tags retain their original workflows. Automatic releases use tooling and source from the tag, with subsequent builds pinned to the validated source SHA.

### Publish automatically by pushing a tag

The `v1.3.0` below is only a format example. Replace it with a new, unpublished tag matching the source version. Commit version preparation first, keep the worktree clean, and ensure `HEAD` is the intended release commit.

**PowerShell / CMD / Bash / Zsh, from the source directory:**

```text
git status --short
npm run release:validate -- --tag v1.3.0
git push origin main
```

Wait for CI on the target commit to pass, then create and push the tag:

```text
git tag -a v1.3.0 -m "Release 1.3.0"
git push origin v1.3.0
git ls-remote --tags origin refs/tags/v1.3.0
```

After the push, follow the automatic run under [Actions → Release](https://github.com/992640451/mihomo-local-proxy-pool/actions/workflows/release.yml). It reruns tests, builds and verifies portable bundles and containers, generates checksums, SBOMs, attestations and release notes, then pushes the image and publishes Release. Maintainers still prepare versions and changelogs; the workflow does not commit code or create version tags.

If another Actions workflow pushes the tag using `GITHUB_TOKEN`, GitHub will not trigger a new `push` workflow. That upstream automation should explicitly call `workflow_dispatch` with `tag` and `publish=true`. Tags pushed locally by maintainers trigger the workflow directly. See [GitHub's trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

### Manual drafts and publication

Use the manual entry only for an existing, unpublished tag with no automatic release in progress. Pushing a new version tag starts automatic public release; a later `publish=false` run neither changes it to draft mode nor cancels that automatic run.

Under Actions → Release → Run workflow, select a branch containing the release configuration, normally `main`, enter the existing tag, and leave `publish` unchecked to build a draft. Alternatively, use an authenticated GitHub CLI (PowerShell / CMD / Bash / Zsh):

```text
gh workflow run release.yml --repo 992640451/mihomo-local-proxy-pool --ref main -f tag=v1.3.0 -f publish=false
```

After reviewing the draft, run again with the same tag and `publish=true` (or check the box). It reruns validation and builds, then pushes GHCR and publishes Release on success. Merely publishing the draft from the Releases page is not equivalent: it does not execute image publication.

The `tag` input **does not create a tag**. An unpushed tag fails during `actions/checkout`, skipping subsequent builds. Bare `1.3.0` is not valid tag syntax. Already public tags are rejected by overwrite protection. Do not move an old tag to release new code.

Manual runs use tooling from the selected workflow commit and source pinned to the requested tag; these may differ. Attestations record workflow provenance, while `.build.json` records the actual source SHA. Full M2 engineering requires build-info support and a matching Dockerfile in the target source. Use compatible workflows for older tags; do not fabricate modern metadata for historical binaries.

## Pipeline and artifacts

### M2 acceptance without creating a Release

Push `codex/m2-acceptance` or manually run **M2 Acceptance** to validate the current commit without a version tag: six native builds, startup/restart, artifact SHA-256 and reverse verification of provenance/SBOM signatures.

It writes only to the isolated GHCR package `ghcr.io/<owner>/<repository>/m2-acceptance`, with `run-<run-id>-<attempt>` tags. It never writes official version/SHA/latest image tags or creates Git tags/Releases. Test images remain for auditing rather than being automatically deleted. Test artifacts remain for seven days; final evidence for 30 days.

Acceptance pulls the just-pushed image by digest, starts both amd64/arm64, checks BuildKit SPDX/SLSA manifests for both, and verifies GitHub signatures from the OCI registry. Only a successful final `verify` job produces `m2-acceptance-evidence` with the exact source revision, six-platform metadata, image digest and checksums. Local tests or older CI cannot substitute for that result.

### Official versions

`Version/tag checks → six-platform portable builds and lifecycle tests → Linux dual-architecture container tests → GHCR → Release`

The source tag's core manifest defines the target matrix. Do not claim support for absent targets. Each platform produces:

- `proxy-port-manager-vX.Y.Z-<platform>-<arch>.zip` / `.tar.gz`.
- Matching `.cdx.json`: CycloneDX SBOM covering the installed npm build graph, including frontend/build tools, plus SHA-256 of distributed Node.js/Mihomo binaries. It is not a complete native-transitive-dependency inventory, nor does it imply all build dependencies load at runtime.
- Matching `.build.json`: application version, source SHA, UTC build time, target, Node/Mihomo versions and core archive verification details.
- `SHA256SUMS.txt` covering archives, SBOMs and metadata.
- GitHub provenance attestations and SBOM attestations binding each SBOM to its archive digest.

Archives contain `sbom.cdx.json` and `app/build-info.json`. Tests extract the final archive, compare internal files with sidecars, then use bundled Node/Mihomo to verify first initialization, web pages, authentication, core health, stop and restart. They use isolated temporary data/ports without importing real subscriptions or sending public proxy probes and clean up afterward.

Windows 1.3.0 bundles also include three Chinese-named double-click launchers and `开始使用.txt` / `START_HERE.txt`. The internal entry is `bin/ppm.cmd`; the Windows root must not contain `ppm.cmd` or Unix `ppm`. Linux/macOS bundles keep root-level `ppm`. Windows archive tests rename the install folder to include Chinese, spaces and special characters, then use real `cmd.exe` to verify first-start credentials, background operation, repeated starts, the open entry, stop and restart. Automated tests pass `--no-open` to avoid opening browsers; manually confirm default-browser opening before publication.

Container tags are `ghcr.io/<owner>/<repository>:vX.Y.Z` and `:sha-<full-source-SHA>`, with `linux/amd64` and `linux/arm64`, BuildKit SBOM/provenance and OCI version labels. This image is the management service; Mihomo remains a separate Compose service. Temporary containers first verify each architecture's web page, login, build info and lifecycle. The final combined image uses the same source, lockfile and build time.

The workflow rejects existing version/SHA image tags. GHCR tags themselves are not immutable storage: pin deployments to the Release's `image@sha256:…`. No moving `latest` image tag is created.

## Local verification

```bash
npm ci
npm test
npm run build
npm run release:validate -- --tag v1.3.0
npm run portable:package
node scripts/prepare-release-asset.mjs --source-root . --output .artifacts/verified --version 1.3.0 --platform windows --arch x64 --require-verified-core
node scripts/create-checksums.mjs --directory .artifacts/verified --expected 1
npm run docker:update
node scripts/smoke-container.mjs --image proxy-port-manager:1.3.0 --version 1.3.0
```

Adjust version and host target; platform names are `windows`, `linux`, and `macos`. `portable:package` requires an existing web build. A custom `--core` is allowed locally but is not manifest-verified and is rejected by the public-release gate. Source mode without `build-info.json` displays missing metadata instead of treating startup time as build time.

Without `--check-remote`, local `release:validate` checks versions, changelog and build metadata; it neither requires a tag to exist nor checks whether it is public. The Release workflow additionally verifies the actual tag and public status.

## Verify downloads and deploy images

```bash
sha256sum -c SHA256SUMS.txt
gh attestation verify <downloaded-archive> --repo <owner>/<repository>
gh attestation verify <downloaded-archive> --repo <owner>/<repository> --predicate-type https://cyclonedx.org/bom
```

On Windows, use `Get-FileHash -Algorithm SHA256 <archive>` and compare with the checksum file. If you downloaded only some artifacts, verify their entries rather than expecting the entire checksum file to pass.

For a prebuilt image, set the management service's `image` in your existing Compose setup to `ghcr.io/<owner>/<repository>@sha256:<digest>`, then run `docker compose up -d --no-build --pull always`. Preserve `.env`, volumes, ports and security settings. A standalone management image without Mihomo does not replace the full stack.

## Failures and retries

- Core verification, SBOM, tests or architecture failures block public release. Do not bypass gates by uploading artifacts manually.
- GitHub Release and GHCR are not transactional together. If image publication succeeds and Release fails, the image remains. Do not delete and repush distributed images.
- Prefer **Re-run failed jobs** in the same Actions run. A failed release job can reuse a successful container job. If the container job failed after pushing, overwrite protection may block retries; inspect manually or use a new version.
- Use a new tag if a full rebuild is necessary. Public releases cannot be overwritten by this workflow; draft artifacts may be replaced.
- Platforms not run locally are validated by GitHub native runners. Local success is not six-platform remote-release success.

## References

[GitHub runner matrix](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [artifact attestations](https://github.com/actions/attest), [Docker build-push-action](https://github.com/docker/build-push-action), and [npm SBOM](https://docs.npmjs.com/cli/v11/commands/npm-sbom/).
