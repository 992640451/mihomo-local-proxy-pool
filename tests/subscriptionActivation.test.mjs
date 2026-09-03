import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import express from 'express'
import { SubscriptionStore } from '../server/subscriptions/store.mjs'
import { SubscriptionService } from '../server/subscriptions/service.mjs'
import { applyEmbeddedPort, applyEmbeddedSubscriptionChange, ensureEmbeddedCore } from '../server/embeddedCore.mjs'
import { AuditStore } from '../server/audit/store.mjs'
import { DiagnosticService } from '../server/diagnostics/service.mjs'
import { createMutationGate } from '../server/recovery/mutationGate.mjs'
import { registerSubscriptionRoutes } from '../server/routes/subscriptions.mjs'
import { registerReliabilityRoutes } from '../server/routes/reliability.mjs'
import { requestContext } from '../server/http/requestContext.mjs'

const config = (name = 'good', type = 'http') => YAML.stringify({ proxies: [{ name, type, server: `${name}.example.invalid`, port: 8080 }] })

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppm-activation-test-'))
  const store = new SubscriptionStore({ filename: path.join(root, 'subscriptions.sqlite'), masterKey: 'synthetic-test-only' })
  const remote = new Map()
  const service = new SubscriptionService({ store, fetchOptions: {
    allowPrivateNetworks: true,
    request: async url => new Response(remote.get(url.pathname) || config(), { headers: { etag: 'candidate-etag' } }),
  } })
  const options = { statePath: path.join(root, 'state.json'), configPath: path.join(root, 'config.yaml'),
    definitionProvider: () => service.getDefinitions({ includeOrphaned: true, includeDisabled: true }), controllerSecret: '' }
  let reloaded = null, rejectAll = false, onReload
  const controller = http.createServer(async (_req, res) => {
    const candidate = YAML.parse(await readFile(options.configPath, 'utf8'))
    await onReload?.(candidate)
    const invalid = candidate.proxies.some(node => node.type === 'invalid-protocol')
    if (invalid || rejectAll) { res.writeHead(400); res.end('invalid candidate'); return }
    reloaded = candidate
    res.writeHead(204); res.end()
  })
  controller.listen(0, '127.0.0.1'); await once(controller, 'listening')
  options.controllerUrl = `http://127.0.0.1:${controller.address().port}`
  await ensureEmbeddedCore('', options)
  service.applyChange = change => applyEmbeddedSubscriptionChange('', change, options)
  t.after(async () => { service.stopScheduler(); await service.changeQueue; controller.closeAllConnections(); await new Promise(resolve => controller.close(resolve)); store.close(); await rm(root, { recursive: true, force: true }) })
  return { store, service, options, remote, currentCore: () => reloaded, rejectAll: () => { rejectAll = true }, onReload: callback => { onReload = callback } }
}

test('core rejection rolls back subscription metadata, all snapshots, nodes, and runtime files', async t => {
  const { store, service, options, currentCore } = await fixture(t)
  const subscription = await service.create({ name: 'original', content: config() })
  await service.update(subscription.id, { content: config('renamed') })
  const before = store.exportRecovery(), snapshots = store.db.prepare('SELECT * FROM subscription_snapshots ORDER BY id').all()
  const previousConfig = await readFile(options.configPath, 'utf8'), previousState = await readFile(options.statePath, 'utf8')
  await assert.rejects(() => service.update(subscription.id, { name: 'rejected-name', url: 'https://example.invalid/new', content: config('bad', 'invalid-protocol') }), /核心重载失败/)
  const after = store.exportRecovery()
  for (const key of ['name', 'url', 'snapshot', 'nodes', 'lastSuccessAt', 'etag', 'lastModified']) assert.deepEqual(after[0][key], before[0][key], key)
  assert.deepEqual(store.db.prepare('SELECT * FROM subscription_snapshots ORDER BY id').all(), snapshots)
  assert.match(store.get(subscription.id).lastError, /核心重载失败/)
  assert.equal(await readFile(options.configPath, 'utf8'), previousConfig)
  assert.equal(await readFile(options.statePath, 'utf8'), previousState)
  assert.deepEqual(currentCore(), YAML.parse(previousConfig))
  // Failure must not poison the queue or prevent a subsequent valid update.
  await service.update(subscription.id, { content: config('repaired') })
  assert.equal(store.get(subscription.id).lastError, null)
})

test('failed initial URL import retains only a retryable error record', async t => {
  const { service, store, remote } = await fixture(t)
  remote.set('/bad', config('bad', 'invalid-protocol'))
  await assert.rejects(() => service.create({ name: 'bad', url: 'https://example.invalid/bad' }), /核心重载失败/)
  const failed = store.list()[0]
  assert.equal(failed.nodeCount, 0)
  assert.equal(failed.activeSnapshotId, null)
  assert.equal(failed.lastSuccessAt, null)
  assert.match(failed.lastError, /核心重载失败/)
  remote.set('/bad', config('fixed'))
  assert.equal((await service.create({ name: 'fixed', url: 'https://example.invalid/bad' })).id, failed.id)
  assert.equal(store.list().length, 1)
})

test('batch and scheduled refresh report core rejection and preserve last successful version', async t => {
  const { service, store, remote } = await fixture(t)
  const good = await service.create({ name: 'good', url: 'https://example.invalid/good' })
  const bad = await service.create({ name: 'bad', url: 'https://example.invalid/bad' })
  remote.set('/good', config('updated'))
  remote.set('/bad', config('bad', 'invalid-protocol'))
  const results = await service.refreshAll()
  assert.equal(results.find(item => item.id === good.id).ok, true)
  assert.equal(results.find(item => item.id === bad.id).ok, false)
  assert.equal(store.get(bad.id).activeSnapshotId, bad.activeSnapshotId)
  let resolve
  const event = new Promise(done => { resolve = done })
  service.onScheduledRefresh = result => { service.stopScheduler(); resolve(result) }
  store.db.prepare('UPDATE subscriptions SET last_attempt_at=1, refresh_interval_seconds=60 WHERE id=?').run(bad.id)
  service.startScheduler(5)
  const timeout = setTimeout(() => resolve(null), 3000)
  const failure = await event; clearTimeout(timeout)
  assert.equal(failure?.ok, false)
  assert.equal(store.get(bad.id).activeSnapshotId, bad.activeSnapshotId)
  assert.match(store.get(bad.id).lastError, /核心重载失败/)
})

test('port writes queued behind a rejected subscription use only the restored definitions', async t => {
  const { service, options, store, onReload } = await fixture(t)
  const original = await service.create({ name: 'good', content: config() })
  const node = service.getDefinitions()[0]
  let entered, release
  const rejected = new Promise(resolve => { entered = resolve }), wait = new Promise(resolve => { release = resolve })
  onReload(async candidate => { if (candidate.proxies.some(item => item.type === 'invalid-protocol')) { entered(); await wait } })
  const badUpdate = service.update(original.id, { content: config('bad', 'invalid-protocol') })
  const rejection = assert.rejects(badUpdate, /核心重载失败/)
  await rejected
  const portWrite = applyEmbeddedPort({ source: '', port: 17900, nodeId: node.id, ...options })
  release(); await rejection; await portWrite
  assert.equal(store.get(original.id).activeSnapshotId, original.activeSnapshotId)
  const core = YAML.parse(await readFile(options.configPath, 'utf8'))
  assert.equal(core.listeners[0].port, 17900)
  assert.ok(core.proxies.every(item => item.type === 'http'))
})

test('rollback failure is explicit and deletion also restores subscription rows', async t => {
  const { service, store, rejectAll } = await fixture(t)
  const original = await service.create({ name: 'original', content: config() })
  rejectAll()
  await assert.rejects(() => service.remove(original.id), /回滚失败/)
  assert.equal(store.get(original.id).activeSnapshotId, original.activeSnapshotId)
  assert.match(store.get(original.id).lastError, /回滚失败/)
})

async function apiFixture(t) {
  const f = await fixture(t), auditStore = new AuditStore(), mutationGate = createMutationGate()
  const loadLiveCatalog = async () => ({ providers: f.service.list(), nodes: f.service.getDefinitions(), listeners: [] })
  const diagnosticService = new DiagnosticService({ subscriptionStore: f.store, subscriptionService: f.service,
    sessionStore: { health: () => ({ ok: true }) }, auditStore, loadLiveCatalog })
  let exports = 0
  const app = express(); app.use(requestContext); app.use(express.json())
  registerSubscriptionRoutes(app, { subscriptionService: f.service, loadLiveCatalog, mutationGate, auditStore })
  registerReliabilityRoutes(app, { diagnosticService, mutationGate, auditStore,
    recoveryService: { create: async () => { exports++; return { recoveryPackage: {}, summary: {} } } } })
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); auditStore.close() })
  const request = (endpoint, body, method = body === undefined ? 'GET' : 'POST') => fetch(`http://127.0.0.1:${server.address().port}/api${endpoint}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  return { ...f, auditStore, request, exports: () => exports }
}

test('API errors, batch results, stored failures and diagnostic exports never expose malformed YAML secrets', async t => {
  const { request, store, remote, auditStore } = await apiFixture(t)
  const uuid = '11111111-2222-3333-4444-555555555555'
  const invalid = `proxies:\n - name: malformed\n   uuid: ${uuid}\n   uuid: ${uuid}\n`
  for (const endpoint of ['/subscriptions/preview', '/subscriptions']) {
    const response = await request(endpoint, { name: 'invalid', content: invalid })
    assert.equal(response.status, 400)
    const body = await response.text()
    assert.match(body, /YAML 解析失败/)
    assert.ok(!body.includes(uuid))
  }
  const imported = await request('/subscriptions', { name: 'remote', url: 'https://example.invalid/remote' })
  assert.equal(imported.status, 201)
  const subscription = await imported.json()
  remote.set('/remote', invalid)
  const batch = await request('/subscriptions/refresh-all', {})
  assert.equal(batch.status, 200)
  const result = await batch.json()
  assert.equal(result.results[0].ok, false)
  assert.ok(!JSON.stringify(result).includes(uuid))
  assert.equal(store.get(subscription.id).activeSnapshotId, subscription.activeSnapshotId)
  assert.ok(!JSON.stringify(store.db.prepare('SELECT last_error FROM subscriptions').all()).includes(uuid))
  assert.ok(!JSON.stringify(auditStore.db.prepare('SELECT message,metadata_json FROM audit_events').all()).includes(uuid))
  const diagnostic = await request('/diagnostics/export')
  assert.equal(diagnostic.status, 200)
  const output = await diagnostic.json()
  assert.equal(output.format, 'ppm-diagnostics')
  assert.ok(output.recentFailures.length > 0)
  assert.ok(!JSON.stringify(output).includes(uuid))
})

test('API rejects a bad candidate and excludes recovery export until the transaction settles', async t => {
  const { request, store, onReload, exports } = await apiFixture(t)
  const imported = await request('/subscriptions', { name: 'original', content: config() })
  const original = await imported.json()
  let entered, release
  const pending = new Promise(resolve => { entered = resolve }), wait = new Promise(resolve => { release = resolve })
  onReload(async candidate => { if (candidate.proxies.some(item => item.type === 'invalid-protocol')) { entered(); await wait } })
  const update = request(`/subscriptions/${original.id}`, { content: config('bad', 'invalid-protocol') }, 'PATCH')
  await pending
  try {
    const backup = await request('/recovery/export', { password: 'test-only-password' })
    assert.equal(backup.status, 409)
    assert.equal(exports(), 0)
  } finally { release() }
  const response = await update
  assert.equal(response.status, 400)
  assert.match(await response.text(), /核心重载失败/)
  assert.equal(store.get(original.id).activeSnapshotId, original.activeSnapshotId)
  assert.match(store.get(original.id).lastError, /核心重载失败/)
  assert.equal((await request('/recovery/export', { password: 'test-only-password' })).status, 200)
  assert.equal(exports(), 1)
})
