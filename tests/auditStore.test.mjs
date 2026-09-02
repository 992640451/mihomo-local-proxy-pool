import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import test from 'node:test'
import { AuditStore } from '../server/audit/store.mjs'

test('persists paginated audit events while redacting messages and metadata', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppm-audit-'))
  const store = new AuditStore({ filename: path.join(root, 'audit.sqlite'), retentionDays: 30, maxEvents: 100 })
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  store.record({
    actor: 'admin', action: 'subscription.create', outcome: 'failure', targetType: 'subscription',
    message: 'fetch https://example.com/private?token=abcd password=hunter2 failed',
    requestId: 'request-1', metadata: { url: 'https://example.com/private?token=abcd', password: 'hunter2' },
  })
  store.record({ actor: 'admin', action: 'port.apply', targetType: 'port', targetId: '17900', message: '端口已应用' })

  const first = store.list({ limit: 1 })
  assert.equal(first.events.length, 1)
  assert.equal(first.events[0].action, 'port.apply')
  assert.equal(first.hasMore, true)
  const second = store.list({ before: first.nextBefore, limit: 10, outcome: 'failure' })
  assert.equal(second.events.length, 1)
  assert.doesNotMatch(JSON.stringify(second.events[0]), /hunter2|abcd|\/private/)
  assert.equal(second.events[0].metadata.password, '<redacted>')
  assert.equal(store.health().eventCount, 2)
})

test('enforces audit retention and maximum event count', () => {
  const store = new AuditStore({ retentionDays: 1, maxEvents: 2 })
  store.record({ action: 'old', message: 'old', createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000 })
  store.record({ action: 'one', message: 'one' })
  store.record({ action: 'two', message: 'two' })
  store.record({ action: 'three', message: 'three' })
  store.prune()
  assert.deepEqual(store.list({ limit: 10 }).events.map(item => item.action), ['three', 'two'])
  assert.equal(store.clear(), 2)
  store.close()
})
