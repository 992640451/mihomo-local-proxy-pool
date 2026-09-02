import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { SubscriptionService } from '../server/subscriptions/service.mjs'
import { createMutationGate } from '../server/recovery/mutationGate.mjs'

test('scheduled refresh keeps its recovery lease until the core synchronization finishes', async () => {
  const gate = createMutationGate(), subscription = { id: 'test', sourceType: 'url', enabled: true, refreshIntervalSeconds: 60, createdAt: 1 }
  const service = new SubscriptionService({ store: { list: () => [subscription] } })
  let release, entered, pending
  const reloading = new Promise(resolve => { entered = resolve })
  const reloadFinished = new Promise(resolve => { release = resolve })
  service.refresh = async () => subscription
  service.onScheduledRefresh = async () => { service.stopScheduler(); entered(); await reloadFinished }
  service.runScheduledRefresh = operation => { pending = gate.runMutation(operation); return pending }
  service.startScheduler(5)
  try {
    await Promise.race([reloading, delay(2000).then(() => { throw new Error('scheduler did not run') })])
    let status, restored = false
    const response = { status(value) { status = value; return this }, set() { return this }, json() {} }
    const restore = gate.restore(() => { restored = true })
    await restore({}, response)
    assert.equal(status, 409); assert.equal(restored, false)
    release(); await pending
    await restore({}, response)
    assert.equal(restored, true)
  } finally { release(); service.stopScheduler() }
})
