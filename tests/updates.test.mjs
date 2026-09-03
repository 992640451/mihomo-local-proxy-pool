import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import test from 'node:test'
import express from 'express'
import YAML from 'yaml'
import { compareVersions, verifyManifest, UPDATE_REPOSITORY } from '../server/updates/manifest.mjs'
import { readJson, writeJson, inventory, snapshot, restoreSnapshot } from '../server/updates/files.mjs'
import { UpdateJobs } from '../server/updates/jobs.mjs'
import { executeUpdate } from '../server/updates/engine.mjs'
import { UpdateDiscovery } from '../server/updates/discovery.mjs'
import { registerUpdateRoutes } from '../server/routes/updates.mjs'
import { checkArchiveNames, PortableAdapter } from '../server/updates/portable.mjs'
import { checkListeners } from '../server/updates/runtime.mjs'
import { createUpdateManifest } from '../scripts/create-update-manifest.mjs'
import { validateUpdateSigning } from '../scripts/validate-update-signing.mjs'

function signed(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const manifest = { schemaVersion: 1, updaterProtocol: 1, repository: UPDATE_REPOSITORY, version: '1.3.0', minVersion: '1.2.0', maxVersion: '1.2.9', revision: 'b'.repeat(40), portable: {}, ...overrides }
  const bytes = Buffer.from(JSON.stringify(manifest))
  return { manifest, keys: { test: publicKey.export({ type: 'spki', format: 'pem' }) }, envelope: { algorithm: 'ed25519', keyId: 'test', payload: bytes.toString('base64'), signature: sign(null, bytes, privateKey).toString('base64') } }
}
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppm-update-test-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return root
}

test('release signing binds archive bytes, build identity and immutable container images', async t => {
  const root = await temporary(t), directory = path.join(root, 'assets')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pem = publicKey.export({ type: 'spki', format: 'pem' }), keyId = createHash('sha256').update(pem).digest('hex').slice(0, 16)
  const keys = { [keyId]: pem }
  await writeJson(path.join(root, 'package.json'), { version: '1.3.0' })
  await writeJson(path.join(root, 'release', 'update-policy.json'), { minVersion: '1.2.0', maxVersion: '1.2.0' })
  await writeJson(path.join(root, 'release', 'update-public-keys.json'), keys)
  await mkdir(directory)
  const name = 'proxy-port-manager-v1.3.0-windows-x64.zip'
  await writeFile(path.join(directory, name), 'fixture archive')
  await writeJson(path.join(directory, `${name}.build.json`), { version: '1.3.0', revision: 'b'.repeat(40) })
  const envelope = await createUpdateManifest({ root, directory, privateKey: privateKey.export({type:'pkcs8',format:'pem'}), image: `ghcr.io/${UPDATE_REPOSITORY}@sha256:${'c'.repeat(64)}`, coreImage: `docker.io/metacubex/mihomo@sha256:${'d'.repeat(64)}` })
  const { manifest } = verifyManifest(envelope, keys, '1.2.0')
  assert.equal(manifest.portable['windows-x64'].sha256, createHash('sha256').update('fixture archive').digest('hex'))
  assert.equal(manifest.portable['windows-x64'].bytes, 15)
  assert.equal(manifest.revision, 'b'.repeat(40))
  assert.deepEqual(await readJson(path.join(directory, 'update-manifest.json')), envelope)
  await assert.rejects(validateUpdateSigning({ root, privateKey: '' }), /缺少/)
  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
  await assert.rejects(validateUpdateSigning({ root, privateKey: other }), /不匹配/)
  await writeJson(path.join(root, 'release', 'update-policy.json'), { minVersion: '1.3.0', maxVersion: '1.3.0' })
  await assert.rejects(validateUpdateSigning({ root, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }), /来源版本范围/)
})

test('release workflow validates stable publication signing before dependent image jobs', async () => {
  const workflow = YAML.parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
  const steps = workflow.jobs.validate.steps
  const preflight = steps.findIndex(step => step.run?.includes('validate-update-signing.mjs'))
  assert.ok(preflight >= 0 && preflight < steps.findIndex(step => step.name === 'Install, test and build'))
  assert.match(steps[preflight].if, /publish/i)
  assert.match(steps[preflight].if, /prerelease != 'true'/)
  assert.equal(steps[preflight].env.UPDATE_SIGNING_PRIVATE_KEY, '${{ secrets.UPDATE_SIGNING_PRIVATE_KEY }}')
  assert.ok([workflow.jobs.container.needs].flat().includes('validate'))
})
test('signed update targets reject tampering, unknown keys, downgrades, unsupported sources and mutable images', () => {
  const { envelope, keys } = signed()
  assert.equal(verifyManifest(envelope, keys, '1.2.0').manifest.version, '1.3.0')
  assert.throws(() => verifyManifest({ ...envelope, payload: Buffer.from('{}').toString('base64') }, keys, '1.2.0'), /签名/)
  assert.throws(() => verifyManifest(envelope, {}, '1.2.0'), /签名/)
  assert.throws(() => verifyManifest(envelope, keys, '1.3.0'), /更高/)
  assert.throws(() => verifyManifest(envelope, keys, '1.1.0'), /中间版本/)
  const bad = signed({ docker: { image: `ghcr.io/${UPDATE_REPOSITORY}:latest`, coreImage: 'latest' } })
  assert.throws(() => verifyManifest(bad.envelope, bad.keys, '1.2.0'), /摘要/)
  assert.equal(compareVersions('1.10.0', '1.9.99'), 1)
  assert.throws(() => compareVersions('1.3.0-beta.1', '1.2.0'))
})
test('archives reject traversal, absolute paths and links before extraction', () => {
  checkArchiveNames(['release/', 'release/app/server/index.mjs'], ['drwx test', '-rwx test'])
  for (const name of ['../data/config.env', 'x/../../data', '/etc/passwd', 'C:\\Windows\\x', 'x\\..\\data']) assert.throws(() => checkArchiveNames([name], ['-rwx test']))
  assert.throws(() => checkArchiveNames(['app/link'], ['lrwx test']))
})

test('portable installation activates a prepared release outside the running runtime', async t => {
  const root = await temporary(t), directory = path.join(root, '.ppm-updates'), prepared = path.join(directory, 'prepared')
  await mkdir(prepared, { recursive: true }); await writeFile(path.join(prepared, 'version'), '1.3.0')
  const adapter = new PortableAdapter({ installRoot: root }, directory)
  await adapter.install({ prepared, targetVersion: '1.3.0' })
  const pointer = await readJson(path.join(directory, 'active-release.json'))
  assert.equal(await readFile(path.join(pointer.root, 'version'), 'utf8'), '1.3.0')
  assert.equal(pointer.version, '1.3.0')
  await adapter.restore({ previousPointer: null })
  assert.equal(await readJson(path.join(directory, 'active-release.json')), null)
})

test('readiness checks enabled listeners without requiring disabled ports to listen', async t => {
  const server = net.createServer(socket => socket.end()).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  await checkListeners([{ port: server.address().port }, { port: 0, enabled: false }], '127.0.0.1')
})
test('version discovery caches requests, respects offline preference and recalculates after upgrade', async t => {
  const directory = await temporary(t), fixture = signed(); let calls = 0
  const fetcher = async url => {
    calls++
    return new Response(JSON.stringify(url.includes('/api.github.com/') ? { tag_name: 'v1.3.0', body: 'Release notes', assets: [{ name: 'update-manifest.json' }] } : fixture.envelope))
  }
  const first = new UpdateDiscovery({ directory, version: '1.2.0', keys: fixture.keys, fetcher })
  assert.equal((await first.check({ online: false })).hasUpdate, false); assert.equal(calls, 0)
  const result = await first.check()
  assert.equal(result.hasUpdate, true); assert.ok(result.digest); assert.equal(calls, 2)
  await Promise.all([first.check(), first.check({ force: true })]); assert.equal(calls, 2)
  const restarted = new UpdateDiscovery({ directory, version: '1.3.0', keys: fixture.keys, fetcher })
  assert.equal((await restarted.check()).hasUpdate, false); assert.equal(calls, 2)
})
test('a missing manifest gives update guidance; network failure never claims up-to-date', async t => {
  const directory = await temporary(t)
  const service = new UpdateDiscovery({ directory, version: '1.2.0', keys: {}, fetcher: async () => new Response(JSON.stringify({ tag_name: 'v1.3.0', assets: [] })) })
  const result = await service.check(); assert.equal(result.hasUpdate, true); assert.match(result.unsupportedReason, /清单/)
  const broken = new UpdateDiscovery({ directory: path.join(directory, 'broken'), version: '1.2.0', keys: {}, fetcher: async () => { throw new Error('offline') } })
  assert.match((await broken.check()).warning, /offline/)
})
test('concurrent requests serialize and survive a new coordinator instance', async t => {
  const directory = await temporary(t), jobs = new UpdateJobs(directory)
  const request = { version: '1.3.0', digest: 'a'.repeat(64), envelope: {}, currentVersion: '1.2.0', idempotencyKey: 'test-request-12345678' }
  const results = await Promise.all([jobs.submit(request), jobs.submit(request)])
  assert.equal(results[0].id, results[1].id)
  assert.equal((await new UpdateJobs(directory).latest()).targetVersion, '1.3.0')
  await assert.rejects(jobs.submit({ ...request, version: '1.4.0', idempotencyKey: 'different-request-1234' }), /另一个/)
})
test('Docker recovery records are private and cannot be overwritten by the web task mirror', async t => {
  const directory = await temporary(t), shared = path.join(directory, 'shared'), control = path.join(directory, 'private')
  const web = new UpdateJobs(shared)
  const job = await web.submit({ version: '1.3.0', digest: 'a'.repeat(64), envelope: {}, currentVersion: '1.2.0', idempotencyKey: 'test-request-12345678' })
  const worker = new UpdateJobs(shared, control), trusted = await worker.get(job.id)
  await worker.save(trusted, { state: 'installing', changed: true, previousCompose: { secret: 'private-value' } })
  assert.equal((await web.get(job.id)).previousCompose, undefined)
  await writeJson(web.file(job.id), { id: job.id, state: 'queued', previousCompose: { secret: 'attacker' } })
  assert.equal((await worker.get(job.id)).previousCompose.secret, 'private-value')
})
test('complete snapshots restore exact file sets, WAL and keys; corrupt backups do not mutate live data', async t => {
  const directory = await temporary(t), data = path.join(directory, 'data'), backup = path.join(directory, 'backup')
  await mkdir(data); await writeFile(path.join(data, 'db.sqlite'), 'old'); await writeFile(path.join(data, 'config.env'), 'secret')
  await snapshot([data], backup)
  await writeFile(path.join(data, 'db.sqlite'), 'new'); await writeFile(path.join(data, 'db.sqlite-wal'), 'new-wal')
  await restoreSnapshot([data], backup, path.join(directory, 'failed'))
  assert.equal(await readFile(path.join(data, 'db.sqlite'), 'utf8'), 'old')
  assert.equal((await inventory(data)).length, 2)
  await writeFile(path.join(backup, '0', 'config.env'), 'corrupt')
  await assert.rejects(restoreSnapshot([data], backup, path.join(directory, 'failed2')), /不匹配/)
  assert.equal(await readFile(path.join(data, 'config.env'), 'utf8'), 'secret')
})

async function engineFixture(t, failure) {
  const directory = await temporary(t), data = path.join(directory, 'data'), jobs = new UpdateJobs(directory), events = []
  await mkdir(data); await writeFile(path.join(data, 'db'), 'original')
  const job = await jobs.submit({ version: '1.3.0', digest: 'a'.repeat(64), envelope: {}, currentVersion: '1.2.0', idempotencyKey: 'test-request-12345678' })
  const adapter = {
    roots: [data],
    async preflight() { events.push('preflight'); if (failure === 'preflight') throw new Error('preflight failed') },
    async prepare() { events.push('prepare'); if (failure === 'download') throw new Error('download failed') },
    async stop() { events.push('stop') }, async capture() { events.push('capture') },
    async install() { events.push('install'); await writeFile(path.join(data, 'db'), 'migrated'); await writeFile(path.join(data, 'extra-wal'), 'new'); if (failure === 'install') throw new Error('migration failed') },
    async start(_job, rollback) { events.push(rollback ? 'start-old' : 'start-new'); if (!rollback && failure === 'start') throw new Error('start failed') },
    async restore() { events.push('restore') },
    async verify(version) { events.push(`verify-${version}`); if (version === '1.3.0' && failure === 'verify') throw new Error('wrong version'); return { version, revision: version === '1.3.0' ? 'b'.repeat(40) : 'a'.repeat(40) } },
    async commit() { events.push('commit') },
  }
  return { directory, data, jobs, job, adapter, events }
}
for (const failure of [null, 'download', 'install', 'start', 'verify']) test(`independent update transaction handles ${failure || 'success'} with data-consistent recovery`, async t => {
  const f = await engineFixture(t, failure)
  await executeUpdate({ ...f, manifest: { revision: 'b'.repeat(40) }, countdownMs: 0 })
  const result = await f.jobs.get(f.job.id)
  assert.equal(result.state, failure === 'download' ? 'failed' : failure ? 'rolled_back' : 'succeeded')
  assert.equal(await readFile(path.join(f.data, 'db'), 'utf8'), failure ? 'original' : 'migrated')
  assert.equal(await readJson(path.join(f.directory, 'maintenance.json')), null)
  if (failure === 'download') assert.equal(f.events.includes('stop'), false)
  else assert.ok(f.events.indexOf('stop') < f.events.indexOf('install'))
})
test('failed snapshot restarts the unchanged original service; no incomplete backup is restored', async t => {
  const f = await engineFixture(t)
  f.adapter.roots = [path.join(f.directory, 'missing-data')]
  await executeUpdate({ ...f, manifest: {}, countdownMs: 0 })
  assert.equal(f.job.state, 'failed'); assert.ok(f.events.includes('start-old')); assert.ok(!f.events.includes('install')); assert.ok(!f.events.includes('restore'))
})
test('interrupted installation resumes recovery; committed updates never roll back later writes', async t => {
  const f = await engineFixture(t)
  await snapshot([f.data], path.join(f.directory, 'recovery', f.job.id))
  await writeFile(path.join(f.data, 'db'), 'partially migrated')
  await f.jobs.save(f.job, { state: 'installing', changed: true })
  await executeUpdate({ ...f, manifest: {} })
  assert.equal(f.job.state, 'rolled_back'); assert.equal(await readFile(path.join(f.data, 'db'), 'utf8'), 'original')
  await f.jobs.save(f.job, { state: 'committed', actualVersion: '1.3.0' })
  await writeFile(path.join(f.data, 'db'), 'post-commit write')
  await executeUpdate({ ...f, manifest: {} })
  assert.equal(f.job.state, 'succeeded'); assert.equal(await readFile(path.join(f.data, 'db'), 'utf8'), 'post-commit write')
})
test('only administrator sessions may start updates, and accepted work returns a job without waiting', async t => {
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.auth = { type: req.headers['x-test-auth'] || 'token' }; next() })
  let starts = 0
  registerUpdateRoutes(app, { service: { status: async () => ({}), submit: async () => { starts++; return { id: 'job', state: 'queued' } } } })
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/api/system/updates/jobs`
  assert.equal((await fetch(url, { method: 'POST' })).status, 403)
  assert.equal((await fetch(url, { method: 'POST', headers: { 'x-test-auth': 'local' } })).status, 403)
  assert.equal((await fetch(url, { method: 'POST', headers: { 'x-test-auth': 'session' } })).status, 202)
  assert.equal(starts, 1)
})
