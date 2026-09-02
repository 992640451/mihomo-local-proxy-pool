import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { ObservationStore } from '../server/observability/store.mjs'
import { ObservationService } from '../server/observability/service.mjs'
import { registerObservationRoutes } from '../server/routes/observability.mjs'
import { createMutationGate } from '../server/recovery/mutationGate.mjs'

test('observation routes run asynchronous jobs, enforce limits and return bounded history', async t => {
  const store = new ObservationStore(), mutationGate = createMutationGate()
  const service = new ObservationService({ store, mutationGate, loadCatalog: async () => ({ nodes: [{ id: 'node' }], listeners: [] }), controller: {
    delay: (_id, { signal }) => delay(1000, 42, { signal }), proxies: async () => ({}),
  } })
  const app = express(); app.use(express.json())
  registerObservationRoutes(app, { service, store, mutationGate })
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await service.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close() })
  const base = `http://127.0.0.1:${server.address().port}/api/observability`
  const request = (url, body, method = 'POST') => fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await request('/settings', { concurrency: 100 }, 'PATCH')).status, 400)
  const created = await request('/nodes/test', { nodeIds: ['node'] })
  assert.equal(created.status, 202)
  assert.equal((await created.json()).status, 'running')
  assert.equal((await request('/nodes/test', { nodeIds: ['node'] })).status, 409)
  await request('/cancel', {})
  await service.pending
  const rateLimited = await request('/nodes/test', { nodeIds: ['node'] })
  assert.equal(rateLimited.status, 429)
  assert.ok(rateLimited.headers.get('retry-after'))
  const history = await fetch(`${base}/history?kind=node&targetId=node`)
  assert.equal(history.headers.get('cache-control'), 'no-store')
  assert.deepEqual((await history.json()).items, [])
  assert.equal((await fetch(`${base}/history?kind=invalid`)).status, 400)
})
