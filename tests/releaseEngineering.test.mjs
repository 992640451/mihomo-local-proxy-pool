import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import YAML from 'yaml'
import { buildMetadata, capture, extendSbom, writeJson } from '../scripts/build-metadata.mjs'
import { readBuildInfo } from '../server/runtime/buildInfo.mjs'
import { portableMatrix, readReleaseMetadata } from '../scripts/release-utils.mjs'
import { verifyMihomoArchive } from '../scripts/fetch-mihomo.mjs'
import { smokeEnvironment } from '../scripts/smoke-portable.mjs'
import { isMissingManifest } from '../scripts/assert-image-unpublished.mjs'
import { imagePlatforms, verifyPredicates } from '../scripts/verify-image-attestations.mjs'
import { tarCommand } from '../scripts/archive-tools.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppm-release-tests-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  await writeJson(path.join(root, 'package.json'), { version: '1.2.3' })
  return root
}

test('Windows archives use system bsdtar regardless of Git Bash PATH precedence', () => {
  assert.equal(tarCommand('win32', { SystemRoot: 'D:\\Windows', PATH: 'C:\\Program Files\\Git\\usr\\bin' }), 'D:\\Windows\\System32\\tar.exe')
  assert.equal(tarCommand('win32', { SYSTEMROOT: 'C:\\Windows' }), 'C:\\Windows\\System32\\tar.exe')
  assert.throws(() => tarCommand('win32', {}), /系统归档工具/)
  assert.throws(() => tarCommand('win32', { SystemRoot: 'relative' }), /系统归档工具/)
  assert.equal(tarCommand('linux', {}), 'tar')
  assert.equal(tarCommand('darwin', {}), 'tar')
})

test('Windows system tar round-trips an absolute drive-letter ZIP without PATH lookup', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t)
  const archive = path.join(root, 'archive.zip')
  await writeFile(path.join(root, 'payload.txt'), 'archive regression')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'))
  env.Path = root
  const tar = tarCommand()
  capture(tar, ['-a', '-cf', archive, '-C', root, 'payload.txt'], { env })
  assert.equal(capture(tar, ['-tf', archive], { env }), 'payload.txt')
  assert.equal(capture(tar, ['-xOf', archive, 'payload.txt'], { env }), 'archive regression')
})

test('validates and exposes only versioned, non-sensitive build metadata', async t => {
  const root = await fixture(t)
  const metadata = await buildMetadata(root, { revision: 'a'.repeat(40), builtAt: '2026-09-02T00:00:00Z', target: 'linux-arm64' })
  await writeJson(path.join(root, 'build-info.json'), { ...metadata, secret: 'must-not-leak' })
  const info = readBuildInfo(root)
  assert.equal(info.revision, 'a'.repeat(40))
  assert.equal(info.builtAt, '2026-09-02T00:00:00.000Z')
  assert.equal(info.secret, undefined)
  await assert.rejects(buildMetadata(root, { revision: 'not-a-sha' }), /SHA/)
  await assert.rejects(buildMetadata(root, { revision: 'a'.repeat(40), builtAt: 'bad' }), /时间/)
  await writeJson(path.join(root, 'build-info.json'), { ...metadata, version: '0.0.0' })
  assert.equal(readBuildInfo(root).revision, null)
  await writeFile(path.join(root, 'build-info.json'), 'bad JSON')
  assert.equal(readBuildInfo(root).target, 'source')
})

test('requires package and lockfile versions to match the release tag', async t => {
  const root = await fixture(t)
  await writeFile(path.join(root, 'CHANGELOG.md'), '## [1.2.3]\n\n- example\n')
  await writeJson(path.join(root, 'package-lock.json'), { version: '1.2.3', packages: { '': { version: '1.2.2' } } })
  await assert.rejects(readReleaseMetadata(root, 'v1.2.3'), /package-lock/)
  await writeJson(path.join(root, 'package-lock.json'), { version: '1.2.3', packages: { '': { version: '1.2.3' } } })
  assert.equal((await readReleaseMetadata(root, 'v1.2.3')).version, '1.2.3')
})

test('release targets are derived from verified core manifest, including Windows ARM64', async () => {
  const manifest = JSON.parse(await readFile('release/core-manifest.json', 'utf8'))
  assert.equal(portableMatrix(manifest).include.length, 6)
  assert.ok(portableMatrix(manifest).include.some(item => item.runner === 'windows-11-arm'))
  delete manifest.targets['win32-arm64']
  assert.equal(portableMatrix(manifest).include.length, 5)
  assert.throws(() => portableMatrix({ targets: { 'win32-x64': { sha256: '' } } }), /SHA256/)
})

test('Mihomo checksum rejects corruption and missing verification', () => {
  const archive = Buffer.from('test archive')
  const hash = createHash('sha256').update(archive).digest('hex')
  assert.equal(verifyMihomoArchive(archive, hash), hash)
  assert.throws(() => verifyMihomoArchive(Buffer.from('corrupted'), hash), /SHA256/)
  assert.throws(() => verifyMihomoArchive(archive, undefined), /SHA256/)
})

test('registry guard distinguishes missing tags from auth and network failures', () => {
  assert.equal(isMissingManifest('ERROR: ghcr.io/test/app:v1.0.0: not found\n'), true)
  assert.equal(isMissingManifest('manifest unknown'), true)
  for (const message of ['unauthorized', 'connection refused', 'host not found', 'failed to fetch anonymous token: 403 Forbidden']) assert.equal(isMissingManifest(message), false)
})

test('SBOM preserves frontend/build graph and binds bundled native components', () => {
  const original = { bomFormat: 'CycloneDX', metadata: { component: { 'bom-ref': 'app' } }, components: [{ name: 'react', 'bom-ref': 'react' }], dependencies: [{ ref: 'app', dependsOn: ['react'] }] }
  const native = { name: 'node', 'bom-ref': 'node', hashes: [{ alg: 'SHA-256', content: 'a'.repeat(64) }] }
  const sbom = extendSbom(original, { builtAt: '2026-09-02T00:00:00Z', target: 'win32-x64' }, [native])
  assert.deepEqual(sbom.dependencies[0].dependsOn, ['react', 'node'])
  assert.equal(sbom.components[0].name, 'react')
  assert.equal(original.components.length, 1)
  assert.throws(() => extendSbom({}, {}, []), /CycloneDX/)
})

test('smoke environment does not inherit subscription, controller or login settings', () => {
  const env = smokeEnvironment('/temporary/package', 12345, 12346)
  assert.equal(env.PPM_ROOT, '/temporary/package')
  assert.equal(env.PPM_MANAGEMENT_PORT, '12345')
  assert.equal(env.SUBSCRIPTION_DB, undefined)
  assert.equal(env.AUTH_USERNAME, undefined)
  assert.equal(env.PPM_MIHOMO_BINARY, undefined)
})

test('checksums include matching SBOM and metadata, exclude the checksum itself', async t => {
  const root = await fixture(t)
  const archive = 'proxy-port-manager-v1.2.3-windows-x64.zip'
  await writeFile(path.join(root, archive), 'test archive')
  const args = ['scripts/create-checksums.mjs', '--directory', root, '--expected', '1']
  assert.throws(() => capture(process.execPath, args), /缺少/)
  for (const suffix of ['.build.json', '.cdx.json']) await writeJson(path.join(root, archive + suffix), {})
  capture(process.execPath, args)
  const checksums = await readFile(path.join(root, 'SHA256SUMS.txt'), 'utf8')
  assert.match(checksums, /zip\.cdx\.json/)
  assert.match(checksums, /zip\.build\.json/)
  capture(process.execPath, args)
  assert.equal(await readFile(path.join(root, 'SHA256SUMS.txt'), 'utf8'), checksums)
})

test('release workflow is manual-only with an explicit tag and a safe publish default', async () => {
  const workflow = YAML.parse(await readFile('.github/workflows/release.yml', 'utf8'))
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  const inputs = workflow.on.workflow_dispatch.inputs
  assert.equal(inputs.tag.required, true)
  assert.equal(inputs.tag.type, 'string')
  assert.equal(inputs.publish.type, 'boolean')
  assert.equal(inputs.publish.default, false)
  assert.equal(workflow.concurrency.group, 'release-${{ inputs.tag }}')
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
  assert.equal(workflow.env.RELEASE_TAG, '${{ inputs.tag }}')
  assert.equal(workflow.env.TOOLING_REF, '${{ github.sha }}')
})

test('release workflow gates publication behind portable and container smoke tests', async () => {
  const workflow = YAML.parse(await readFile('.github/workflows/release.yml', 'utf8'))
  assert.deepEqual(workflow.jobs.release.needs, ['validate', 'build-portable', 'container'])
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false)
  const steps = workflow.jobs.container.steps
  const build = steps.find(item => item.id === 'build')
  assert.equal(build.with.sbom, true)
  assert.equal(build.with.provenance, 'mode=max')
  assert.equal(build.with.platforms, 'linux/amd64,linux/arm64')
  assert.equal(build.with.push, "${{ github.event_name == 'workflow_dispatch' && inputs.publish }}")
  assert.ok(steps.some(item => item.run?.includes('assert-image-unpublished')))
  assert.ok(workflow.jobs['build-portable'].steps.some(item => item.with?.['sbom-path']))
  const publish = workflow.jobs.release.steps.find(item => item.name === 'Create or update draft release')
  assert.equal(publish.env.PUBLISH_RELEASE, "${{ github.event_name == 'workflow_dispatch' && inputs.publish }}")
})

test('registry verification requires both architectures and paired SBOM/provenance manifests', () => {
  const manifests = ['amd64', 'arm64'].flatMap(architecture => [
    { digest: architecture, platform: { os: 'linux', architecture } },
    { digest: `${architecture}-attestation`, annotations: { 'vnd.docker.reference.digest': architecture, 'vnd.docker.reference.type': 'attestation-manifest' } },
  ])
  assert.equal(imagePlatforms({ manifests }).length, 2)
  assert.throws(() => imagePlatforms({ manifests: manifests.slice(0, 2) }), /amd64 和 arm64/)
  assert.throws(() => imagePlatforms({ manifests: manifests.filter(item => item.platform) }), /attestation/)
  const layers = ['https://spdx.dev/Document', 'https://slsa.dev/provenance/v0.2'].map(type => ({ annotations: { 'in-toto.io/predicate-type': type } }))
  assert.equal(verifyPredicates({ layers }).length, 2)
  assert.throws(() => verifyPredicates({ layers: layers.slice(1) }), /SBOM/)
  assert.throws(() => verifyPredicates({ layers: layers.slice(0, 1) }), /provenance/)
})

test('acceptance uses an isolated registry package, verifies signatures, and never creates a Release', async () => {
  const content = await readFile('.github/workflows/m2-acceptance.yml', 'utf8')
  const workflow = YAML.parse(content)
  assert.deepEqual(workflow.on.push.branches, ['codex/m2-acceptance'])
  assert.equal(workflow.on.push.tags, undefined)
  assert.deepEqual(workflow.jobs.verify.needs, ['validate', 'portable', 'registry'])
  assert.match(content, /\/m2-acceptance"/)
  assert.match(content, /--bundle-from-oci/)
  assert.match(content, /--source-digest/)
  assert.match(content, /--predicate-type https:\/\/cyclonedx.org\/bom/)
  assert.doesNotMatch(content, /contents: write|gh release (create|edit)|git (tag|push)|:latest/)
})
