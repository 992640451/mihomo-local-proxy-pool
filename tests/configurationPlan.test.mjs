import assert from 'node:assert/strict'
import test from 'node:test'
import { RecoveryService } from '../server/recovery/service.mjs'
import { ConfigurationPlanSigner, configurationDigest, configurationChanges } from '../server/recovery/plan.mjs'
import { encryptRecoveryPayload } from '../server/recovery/crypto.mjs'
import { validateEmbeddedCoreState } from '../server/embeddedCore.mjs'
import { apiSchemaValidator } from '../server/automation/validation.mjs'

function fixture() {
  let state = { subscriptions: [], ports: { version: 2, ports: {} } }, writes = 0, suspended = false
  const service = new RecoveryService({
    subscriptionStore: { exportRecovery: () => structuredClone(state.subscriptions), replaceRecovery: value => { writes++; state.subscriptions = structuredClone(value) } },
    exportPorts: async () => { assert.ok(suspended); return structuredClone(state.ports) },
    restorePorts: async value => { writes++; state.ports = structuredClone(value); return { ports: Object.keys(value.ports).length } },
    validatePorts: (ports, subscriptions) => validateEmbeddedCoreState(ports, new Set(subscriptions.flatMap(item => item.nodes.map(node => node.id))), { portRanges: '17900-17910' }),
    suspend: () => { suspended = true }, resume: () => { suspended = false },
  })
  const pack = data => encryptRecoveryPayload({ format: 'ppm-recovery-data', version: 1, data }, 'test-password')
  return { service, pack, state: () => state, writes: () => writes, suspended: () => suspended }
}

test('configuration dry-run is read-only, shows changes and requires unchanged signed plan to apply', async () => {
  const f = fixture()
  const packageData = await f.pack(f.state())
  const plan = await f.service.plan(packageData, 'test-password')
  assert.equal(f.writes(), 0); assert.equal(f.suspended(), false)
  assert.equal(plan.canApply, true)
  assert.equal(apiSchemaValidator('ConfigurationPlan')(plan), true)
  assert.deepEqual(plan.changes.ports, { added: [], modified: [], deleted: [], unchanged: 0 })
  await assert.rejects(() => f.service.restore(packageData, 'test-password', { requirePlan: true }), { code: 'CONFIGURATION_PLAN_STALE' })
  assert.equal(f.writes(), 0)
  f.state().ports.ports['17901'] = { nodeId: 'removed', protocol: 'HTTP' }
  await assert.rejects(() => f.service.restore(packageData, 'test-password', { requirePlan: true, planToken: plan.planToken }), { status: 409 })
  assert.equal(f.writes(), 0)
  const nextPlan = await f.service.plan(packageData, 'test-password')
  assert.deepEqual(nextPlan.changes.ports.deleted, ['17901'])
  await f.service.restore(packageData, 'test-password', { requirePlan: true, planToken: nextPlan.planToken })
  assert.equal(f.writes(), 2); assert.deepEqual(f.state().ports.ports, {}); assert.equal(f.suspended(), false)
})

test('dry-run reports missing nodes and invalid port ranges without mutating', async () => {
  const f = fixture()
  const data = { subscriptions: [], ports: { version: 2, ports: { 17900: { nodeIds: ['missing'], protocol: 'HTTP' } } } }
  const plan = await f.service.plan(await f.pack(data), 'test-password')
  assert.equal(plan.canApply, false); assert.equal(plan.planToken, null)
  assert.deepEqual(plan.missingNodes, [{ port: 17900, nodeIds: ['missing'] }])
  assert.deepEqual(plan.changes.ports.added, ['17900'])
  assert.equal(f.writes(), 0)
  assert.throws(() => validateEmbeddedCoreState({ version: 2, ports: { 18000: { nodeId: 'valid' } } }, new Set(['valid']), { portRanges: '17900-17910' }), /范围/)
  for (const ports of [null, [], 'invalid']) await assert.rejects(() => f.service.plan({ ...data, ports }, 'test-password'))
})

test('plans are bound to exact package and state, expire in ten minutes and invalidate on restart', () => {
  const signer = new ConfigurationPlanSigner(), recoveryPackage = { encrypted: 'payload' }, revision = configurationDigest({ b: 2, a: 1 })
  assert.equal(revision, configurationDigest({ a: 1, b: 2 }))
  const plan = signer.sign(revision, recoveryPackage, 1000)
  signer.verify(plan.planToken, revision, recoveryPackage, 1001)
  assert.throws(() => signer.verify(plan.planToken, revision, recoveryPackage, 601000), { status: 409 })
  assert.throws(() => signer.verify(plan.planToken, revision, { encrypted: 'different' }, 1001), { status: 409 })
  assert.throws(() => new ConfigurationPlanSigner().verify(plan.planToken, revision, recoveryPackage, 1001), { status: 409 })
  assert.throws(() => signer.verify(`${plan.planToken}x`, revision, recoveryPackage, 1001), { status: 409 })
  assert.throws(() => signer.verify(`${plan.planToken.split('.')[0]}.${'界'.repeat(43)}`, revision, recoveryPackage, 1001), { status: 409 })
})

test('configuration diff reports additions, modifications, deletions and unavailable node impact without secrets', () => {
  const before = { subscriptions: [{ id: 'old', name: 'old', enabled: true, nodes: [{ id: 'gone', active: true }] }, { id: 'same', name: 'same', enabled: true, nodes: [{ id: 'n1', active: true, raw: { password: 'private' } }] }], ports: { ports: { 17900: { nodeIds: ['gone'] }, 17901: { nodeIds: ['n1'], enabled: true } } } }
  const after = { subscriptions: [{ id: 'same', name: 'renamed', enabled: false, nodes: [{ id: 'n1', active: true, raw: { password: 'updated-private' } }] }, { id: 'new', enabled: true, nodes: [{ id: 'n2', active: false }] }], ports: { ports: { 17901: { nodeIds: ['n1'], enabled: false }, 17902: { nodeIds: ['n2'] } } } }
  const diff = configurationChanges(before, after)
  for (const [kind, values] of Object.entries({ subscriptions: ['new', 'same', 'old'], nodes: ['n2', 'n1', 'gone'], ports: ['17902', '17901', '17900'] })) {
    assert.deepEqual(diff.changes[kind].added, [values[0]])
    assert.deepEqual(diff.changes[kind].modified, [values[1]])
    assert.deepEqual(diff.changes[kind].deleted, [values[2]])
  }
  assert.deepEqual(diff.unavailableNodes, [{ port: 17901, nodeIds: ['n1'] }, { port: 17902, nodeIds: ['n2'] }])
  assert.equal(JSON.stringify(diff).includes('private'), false)
})
