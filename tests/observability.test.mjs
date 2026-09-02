import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ObservationStore } from '../server/observability/store.mjs'
import { ObservationService } from '../server/observability/service.mjs'
import { ObservationController } from '../server/observability/controller.mjs'
import { OBSERVABILITY_DEFAULTS, observationState, validateObservabilitySettings } from '../shared/observability.js'
import { createMutationGate } from '../server/recovery/mutationGate.mjs'

function fixture(t, overrides = {}) {
  const store = new ObservationStore()
  const catalog = { nodes: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, name: `Node ${i}` })), listeners: [{ port: 17900, protocol: 'SOCKS5', enabled: true, strategy: 'fallback', nodeIds: ['n0', 'n1'] }] }
  const controller = { delay: async () => 30, proxies: async () => ({ 'ppm-node-n0': { alive: true, history: [] }, 'PPM-17900': { now: 'ppm-node-n0' } }) }
  const verifyPool = async options => ({ ...options, attempts: options.attempts, successes: 1, failures: options.attempts - 1, uniqueExitCount: 1,
    distribution: [{ ip: '192.0.2.1', country: '美国', count: 1, averageLatencyMs: 50 }],
    samples: Array.from({ length: options.attempts }, (_, i) => i ? { ok: false, error: 'token=secret failed' } : { ok: true, latencyMs: 50 }) })
  const mutationGate = createMutationGate()
  const service = new ObservationService({ store, controller, verifyPool, mutationGate, loadCatalog: async () => catalog, probeHost: '127.0.0.1', ...overrides })
  t.after(async () => { await service.stop(); store.close() })
  return { service, store, catalog, controller, mutationGate }
}

test('observation settings are opt-in, bounded and strictly typed', () => {
  assert.equal(OBSERVABILITY_DEFAULTS.enabled, false)
  for (const patch of [{ enabled: 'false' }, { concurrency: 0 }, { concurrency: 7 }, { intervalSeconds: 299 }, { timeoutMs: 10001 }, { attempts: 9 }, { retentionDays: 31 }, { maxSamples: 50001 }, { constructor: 1 }, { testUrl: 'http://localhost' }]) {
    assert.throws(() => validateObservabilitySettings(patch))
  }
  assert.equal(validateObservabilitySettings({ enabled: true }).enabled, true)
  assert.equal(observationState({ healthy: true, checkedAt: null }), 'unknown')
  assert.equal(observationState({ healthy: false, checkedAt: 1 }, 2), 'failed')
  assert.equal(observationState({ healthy: true, checkedAt: 1 }, 700000), 'stale')
})

test('history survives restart, settings persist and running tasks become interrupted', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ppm-observation-'))
  const filename = path.join(directory, 'observations.sqlite')
  let store = new ObservationStore({ filename })
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }) })
  store.updateSettings({ retentionDays: 3 })
  store.setMeta('job', { id: 'job', status: 'running', completed: 2 })
  store.record({ kind: 'node', targetId: 'n', successes: 0, error: 'password=private https://example.com/sub/secret?token=hidden' })
  store.close()
  store = new ObservationStore({ filename })
  assert.equal(store.settings.retentionDays, 3)
  assert.equal(store.meta('job').status, 'interrupted')
  assert.equal(store.meta('job').completed, 2)
  const body = JSON.stringify(store.history({ kind: 'node' }))
  assert.doesNotMatch(body, /private|hidden|\/secret/)
  assert.equal(store.history({ kind: 'node' }).items.length, 1)
})

test('history enforces age and capacity, paginates and separates node and port rates', t => {
  const { store } = fixture(t)
  store.updateSettings({ maxSamples: 100, retentionDays: 1 })
  for (let i = 0; i < 105; i++) store.record({ kind: 'node', targetId: `n${i}`, successes: 1 })
  assert.equal(store.health().sampleCount, 100)
  const page = store.history({ kind: 'node', limit: 10 })
  assert.equal(page.items.length, 10)
  assert.ok(store.history({ kind: 'node', before: page.nextBefore, limit: 10 }).items.every(item => item.id < page.nextBefore))
  store.record({ kind: 'port', targetId: '17900', successes: 2, attempts: 2 })
  store.record({ kind: 'port', targetId: '17900', successes: 1, attempts: 2 })
  store.record({ kind: 'port', targetId: '17900', successes: 0, attempts: 2 })
  const summary = store.summary('port', '17900')
  assert.equal(summary.successRate, 50)
  assert.equal(summary.consecutiveFailures, 2)
  assert.equal(summary.trend.length, 24)
  assert.equal(summary.trend.reduce((n, b) => n + b.failures, 0), 3)
  store.record({ kind: 'port', targetId: 'old', successes: 0, checkedAt: Date.now() - 86400001 })
  assert.equal(store.history({ targetId: 'old' }).items.length, 0)
  store.prune(Date.now() + 86400001)
  assert.equal(store.health().sampleCount, 0)
})

test('snapshot does not declare untested nodes healthy or trigger active probes', async t => {
  const { service, controller } = fixture(t)
  controller.delay = () => { throw new Error('must not be called') }
  const snapshot = await service.snapshot()
  assert.equal(snapshot.nodes[0].healthy, null)
  assert.equal(snapshot.nodes[0].state, 'unknown')
  assert.equal(snapshot.nodes[1].loaded, false)
  assert.equal(snapshot.ports[0].activeNodeName, 'Node 0')
  assert.equal(snapshot.summary.successRate, null)
})

test('snapshot prefers the newest measurement and marks unavailable core data stale', async t => {
  const { service, store, controller } = fixture(t)
  const at = Date.now()
  store.record({ kind: 'node', targetId: 'n0', checkedAt: at - 1000, successes: 0 })
  controller.proxies = async () => ({ 'ppm-node-n0': { alive: true, history: [{ time: new Date(at).toISOString(), delay: 90 }] } })
  const first = await service.snapshot()
  assert.equal(first.nodes[0].state, 'healthy')
  assert.equal(first.nodes[0].delay, 90)
  service.snapshotCache = null
  controller.proxies = async () => { throw new Error('connection refused') }
  const second = await service.snapshot()
  assert.equal(second.reachable, false)
  assert.equal(second.nodes[0].state, 'stale')
})

test('node batches cap concurrency, reject overlap, redact failures and cool down', async t => {
  const { service, store, controller } = fixture(t)
  let active = 0, peak = 0
  controller.delay = async id => {
    active++; peak = Math.max(peak, active)
    await delay(15); active--
    if (id === 'n2') throw new Error('password=classified')
    return 20
  }
  await service.startNodes(['n0', 'n1', 'n2', 'n3', 'n4', 'n5'])
  await assert.rejects(() => service.startNodes(['n0']), error => error.status === 409)
  await service.pending
  assert.equal(peak, 3)
  assert.equal(store.history({ kind: 'node' }).items.length, 6)
  assert.equal(service.status().job.failures, 1)
  assert.doesNotMatch(JSON.stringify(store.history({ kind: 'node' })), /classified/)
  await assert.rejects(() => service.startNodes(['n0']), error => error.status === 429)
})

test('cancel and shutdown abort in-flight nodes without recording phantom failures', async t => {
  const { service, controller, store } = fixture(t)
  controller.delay = (_id, { signal }) => delay(10000, 50, { signal })
  await service.startNodes(['n0', 'n1', 'n2', 'n3'])
  await service.stop()
  assert.equal(service.status().job.status, 'cancelled')
  assert.equal(store.health().sampleCount, 0)
  assert.equal(service.active, null)
})

test('batches keep a recovery lease after returning their job id', async t => {
  const { service, controller, mutationGate } = fixture(t)
  controller.delay = (_id, { signal }) => delay(10000, 50, { signal })
  await service.startNodes(['n0'])
  let status, payload, restored = false
  const res = { status(code) { status = code; return this }, set() { return this }, json(body) { payload = body; return this } }
  await mutationGate.restore(async () => { restored = true })({}, res)
  assert.equal(status, 409)
  assert.equal(payload.error.code, 'CONFIGURATION_BUSY')
  assert.equal(restored, false)
  service.cancel(); await service.pending
  await mutationGate.restore(async () => { restored = true })({}, res)
  assert.equal(restored, true)
})

test('port observations capture protocol, partial failures, exit distribution and configuration', async t => {
  const { service, store } = fixture(t)
  const result = await service.verifyPort(17900, 2)
  assert.equal(result.protocol, 'SOCKS5')
  const history = store.history({ targetId: '17900' }).items[0]
  assert.equal(history.successes, 1)
  assert.equal(history.failures, 1)
  assert.equal(history.latencyMs, 50)
  assert.equal(history.configuration.strategy, 'fallback')
  assert.equal(history.distribution[0].ip, '192.0.2.1')
  assert.doesNotMatch(JSON.stringify(history), /secret/)
})

test('invalid, disabled and oversized targets never trigger requests', async t => {
  const { service, catalog } = fixture(t)
  await assert.rejects(() => service.startNodes([]))
  await assert.rejects(() => service.startNodes(['missing']))
  await assert.rejects(() => service.startNodes(Array(101).fill('n0')))
  await assert.rejects(() => service.verifyPort(17900, 21))
  await assert.rejects(() => service.verifyPort(17899), error => error.status === 404)
  catalog.listeners[0].enabled = false
  await assert.rejects(() => service.verifyPort(17900), /停用/)
  assert.equal(service.active, null)
})

test('scheduler is off by default and rotates bounded batches without overlapping', async t => {
  let now = Date.now()
  const { service, store, catalog } = fixture(t, { clock: () => now })
  now += 1000000
  await service.tick()
  assert.equal(store.meta('job'), null)
  catalog.nodes = Array.from({ length: 120 }, (_, i) => ({ id: `n${i}` }))
  service.settings({ enabled: true, intervalSeconds: 300 })
  now += 300000
  await service.tick(); await service.pending
  assert.equal(service.status().job.total, 101)
  assert.equal(store.history({ kind: 'node', targetId: 'n119' }).items.length, 0)
  now += 300000
  await service.tick(); await service.pending
  assert.equal(store.history({ kind: 'node', targetId: 'n119' }).items.length, 1)
  service.settings({ enabled: false })
  now += 300000
  const previous = service.status().job.id
  await service.tick()
  assert.equal(service.status().job.id, previous)
})

test('controller requests only named nodes, times out, and does not expose response bodies', async () => {
  let requested, options
  const controller = new ObservationController({ url: 'http://core:9090', secret: 'private', fetchImpl: async (url, config) => {
    requested = url; options = config
    return new Response(JSON.stringify({ delay: 42 }))
  } })
  assert.equal(await controller.delay('id/a', { timeoutMs: 1500 }), 42)
  assert.match(requested, /ppm-node-id%2Fa\/delay\?url=/)
  assert.equal(options.headers.Authorization, 'Bearer private')
  assert.ok(options.signal instanceof AbortSignal)
  assert.equal(options.redirect, 'error')
  controller.fetchImpl = async () => new Response('sensitive', { status: 502 })
  await assert.rejects(() => controller.proxies(), error => !error.message.includes('sensitive'))
  controller.fetchImpl = async () => new Response(JSON.stringify({ delay: 0 }))
  await assert.rejects(() => controller.delay('id', { timeoutMs: 1500 }), /有效延迟/)
  await assert.rejects(() => new ObservationController({ url: '' }).proxies(), error => error.status === 501)
})
