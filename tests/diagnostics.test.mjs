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
