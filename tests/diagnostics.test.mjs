import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { DiagnosticService } from '../server/diagnostics/service.mjs'

test('reports component health and exports only masked subscription diagnostics', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppm-diagnostics-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataFile = path.join(root, 'subscriptions.sqlite')
  await writeFile(dataFile, '')
  const service = new DiagnosticService({
    appVersion: '1.0.0',
    subscriptionStore: {
      health: () => ({ ok: true, schemaVersion: 1, subscriptions: 1, activeNodes: 2 }),
      list: () => [{ id: 'one', name: 'Primary', sourceType: 'url', enabled: true, priority: 0, nodeCount: 2, lastError: 'fetch https://example.com/private?token=secret failed' }],
    },
    subscriptionService: { schedulerStatus: () => ({ running: true, refreshing: 0, refreshingIds: [], scheduledSubscriptions: 1 }) },
    sessionStore: { health: () => ({ ok: true, schemaVersion: 1, activeSessions: 1 }) },
    auditStore: { health: () => ({ ok: true, schemaVersion: 1, eventCount: 0 }), list: () => ({ events: [] }) },
    embeddedCore: true,
    embeddedCoreStatus: async () => ({ enabled: true, reachable: true, version: '1.0.0' }),
    loadLiveCatalog: async () => ({ providers: [{}], nodes: [{}, {}], listeners: [] }),
    dataFiles: [dataFile],
  })
  const result = await service.run()
  assert.equal(result.status, 'ok')
  assert.equal(result.checks.length, 7)
  const exported = await service.export()
  assert.doesNotMatch(JSON.stringify(exported), /token=secret|\/private/)
  assert.equal(exported.subscriptions[0].name, 'Primary')
  assert.equal(exported.environment.nodeVersion, process.version)
})

test('enabled but stopped schedulers fail diagnostics, while disabled or paused ones do not', async () => {
  let subscription = { running: false, scheduledSubscriptions: 1 }, observation = { settings: { enabled: true }, schedulerRunning: false }
  const service = new DiagnosticService({
    subscriptionService: { schedulerStatus: () => subscription },
    observationService: { status: () => observation },
    sessionStore: { health: () => ({ ok: true }) }, auditStore: { health: () => ({ ok: true }) },
    loadLiveCatalog: async () => ({ providers: [], nodes: [], listeners: [] }),
  })
  let result = await service.run()
  assert.equal(result.status, 'error')
  assert.equal(result.errors, 2)
  assert.ok(result.checks.filter(item => item.name.endsWith('Scheduler')).every(item => item.status === 'error'))
  observation = { settings: { enabled: false }, schedulerRunning: false }
  subscription = { running: false, scheduledSubscriptions: 0 }
  assert.equal((await service.run()).status, 'ok')
  subscription = { running: false, scheduledSubscriptions: 1, paused: true }
  result = await service.run()
  assert.equal(result.status, 'warning')
  assert.equal(result.warnings, 1)
  subscription = { running: true, scheduledSubscriptions: 1, paused: false }
  observation = { settings: { enabled: true }, schedulerRunning: true }
  assert.equal((await service.run()).status, 'ok')
})
