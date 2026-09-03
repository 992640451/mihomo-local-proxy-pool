import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import { ApiTokenStore } from '../server/automation/tokenStore.mjs'
import { versionedRegistrar } from '../server/automation/versioned.mjs'
import { API_OPERATIONS, buildOpenApi } from '../server/automation/contract.mjs'
import { apiSchemaValidator } from '../server/automation/validation.mjs'
import { SessionStore } from '../server/sessionStore.mjs'
import { SubscriptionStore } from '../server/subscriptions/store.mjs'
import { SubscriptionService } from '../server/subscriptions/service.mjs'
import { RecoveryService } from '../server/recovery/service.mjs'
import { AuditStore } from '../server/audit/store.mjs'
import { createMutationGate } from '../server/recovery/mutationGate.mjs'
import { registerAuthRoutes } from '../server/routes/auth.mjs'
import { registerTokenRoutes } from '../server/routes/tokens.mjs'
import { registerAutomationRoutes } from '../server/routes/automation.mjs'
import { registerSubscriptionRoutes } from '../server/routes/subscriptions.mjs'
import { registerPortRoutes } from '../server/routes/ports.mjs'
import { registerRuntimeRoute } from '../server/routes/system.mjs'
import { registerReliabilityRoutes } from '../server/routes/reliability.mjs'
import { requestContext } from '../server/http/requestContext.mjs'
import { apiNotFound, apiUnhandledError } from '../server/http/responses.mjs'
import { createOriginGuard } from '../server/security/http.mjs'
import { validatePortConfig } from '../shared/portConfig.js'

const content = 'proxies:\n  - { name: example, type: ss, server: example.invalid, port: 443, cipher: aes-128-gcm, password: fixture-node-secret }'

async function fixture(t, { legacyListeners = [] } = {}) {
  const tokenStore = new ApiTokenStore({ credentialVersion: 'test' })
  const sessionStore = new SessionStore({ idleMs: 60000, absoluteMs: 3600000, credentialVersion: 'test' })
  const subscriptionStore = new SubscriptionStore({ masterKey: 'fixture-master-key-for-automation' })
  const subscriptionService = new SubscriptionService({ store: subscriptionStore })
  const auditStore = new AuditStore(), mutationGate = createMutationGate()
  let ports = {}
  const loadLiveCatalog = async () => ({ nodes: subscriptionService.getDefinitions().map(node => ({ id: node.id, name: node.raw.name })), providers: subscriptionService.list(), countries: [], listeners: [...legacyListeners, ...Object.values(ports)] })
  const recoveryService = new RecoveryService({ subscriptionStore, exportPorts: async () => ({ version: 2, ports: structuredClone(ports) }), restorePorts: async state => { ports = structuredClone(state.ports); return { ports: Object.keys(ports).length } } })
  const app = express(); app.use(requestContext); app.use(createOriginGuard()); app.use(express.json())
  const { requireAuth } = registerAuthRoutes(app, { configured: true, username: 'test-admin', passwordSalt: 'test-salt', passwordHash: scryptSync('test-password', 'test-salt', 64).toString('hex'), sessionStore, tokenStore, sessionIdleMs: 60000, sessionAbsoluteMs: 3600000, auditStore })
  app.use('/api', requireAuth)
  registerTokenRoutes(app, { configured: true, tokenStore, auditStore })
  const api = versionedRegistrar(app, { auditStore })
  registerAutomationRoutes(api, { recoveryService, loadLiveCatalog, mutationGate, auditStore })
  registerSubscriptionRoutes(api, { subscriptionService, subscriptionMode: 'native', loadLiveCatalog, mutationGate, auditStore })
  registerRuntimeRoute(api, { startedAt: Date.now(), appVersion: 'test', embeddedCore: false, loadLiveCatalog })
  registerReliabilityRoutes(api, { recoveryService, diagnosticService: { run: async () => ({ status: 'ok', checks: [] }) }, mutationGate, auditStore })
  registerPortRoutes(api, { embeddedCore: true, defaultConfigDir: () => '', loadLiveCatalog, mutationGate, auditStore,
    applyEmbeddedPort: async input => {
      const config = validatePortConfig(input, { availableNodeIds: new Set(subscriptionService.getDefinitions().map(item => item.id)) }); ports[config.port] = config; return config
    }, deleteEmbeddedPort: async ({ port }) => { const removed = !!ports[port]; delete ports[port]; return { port: Number(port), removed } },
    embeddedPortStatus: async (_source, port) => ({ port: Number(port), strategy: 'select', reachable: true, activeNodeId: null, activeNodeName: null, nodes: [] }),
    verifyProxyPool: async () => ({ attempts: 2, successes: 2, failures: 0 }),
  })
  app.use('/api', apiNotFound); app.use(apiUnhandledError)
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); for (const store of [tokenStore, sessionStore, subscriptionStore, auditStore]) store.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (path, { secret, cookie, method = 'GET', body, headers } = {}) => fetch(`${base}/api${path}`, { method, headers: { ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const login = await request('/auth/login', { method: 'POST', body: { username: 'test-admin', password: 'test-password' } })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  return { request, cookie, tokenStore, auditStore }
}

test('v1 uses deny-by-default scopes; bearer credentials cannot access UI APIs or mint tokens', async t => {
  const f = await fixture(t)
  assert.equal((await f.request('/v1/runtime')).status, 401)
  const created = await f.request('/tokens', { method: 'POST', cookie: f.cookie, body: { name: 'read-only', scopes: ['read'] } })
  assert.equal(created.status, 201); assert.equal(created.headers.get('cache-control'), 'no-store')
  const token = await created.json(), auth = { secret: token.secret }
  for (const operation of API_OPERATIONS) {
    const endpoint = operation.path.replace(':id', 'test').replace(':port', '17900')
    const response = await f.request(`/v1${endpoint}`, { ...auth, method: operation.method.toUpperCase(), ...(operation.method === 'post' || operation.method === 'put' || operation.method === 'patch' ? { body: {} } : {}) })
    if (operation.scopes.some(scope => scope !== 'read')) {
      assert.equal(response.status, 403, operation.operationId)
      assert.equal((await response.json()).error.code, 'INSUFFICIENT_SCOPE')
    } else {
      assert.equal(response.status, 200, operation.operationId)
      const output = await response.json(), validate = apiSchemaValidator(operation.output)
      assert.ok(validate(output), `${operation.operationId}: ${JSON.stringify(validate.errors)}`)
    }
  }
  for (const endpoint of ['/runtime', '/tokens', '/recovery/inspect']) assert.equal((await f.request(endpoint, { ...auth, cookie: f.cookie })).status, 401)
  for (const endpoint of ['/v1/tokens', '/v1/recovery/restore', '/v1/observability/settings']) assert.equal((await f.request(endpoint, { ...auth, method: 'POST', body: {} })).status, 404)
  assert.equal((await f.request('/v1/runtime', { secret: 'bad', cookie: f.cookie })).status, 401)
  const list = await f.request('/tokens', { cookie: f.cookie })
  const text = JSON.stringify(await list.json()); assert.ok(!text.includes(token.secret)); assert.ok(!text.includes('digest'))
  assert.ok(f.tokenStore.list()[0].lastUsedAt)
  assert.equal((await f.request('/tokens', { cookie: f.cookie, method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: { name: 'blocked', scopes: ['read'] } })).status, 403)
  assert.equal((await f.request(`/tokens/${token.id}`, { cookie: f.cookie, method: 'DELETE' })).status, 204)
  assert.equal((await f.request('/v1/runtime', auth)).status, 401)
  const audit = f.auditStore.list({ limit: 100 }).events
  assert.ok(audit.some(event => event.actor === `api/${token.id}`))
  assert.equal(JSON.stringify(audit).includes(token.secret), false)
})

test('v1 read schemas allow global listeners without nodes while port writes still reject empty pools', async t => {
  const listener = { id: 'mihomo-mixed-17890', port: 17890, protocol: 'MIXED', nodeId: '', nodeIds: [], isGlobal: true, enabled: true }
  const f = await fixture(t, { legacyListeners: [listener] })
  const token = f.tokenStore.create({ name: 'port-test', scopes: ['ports:write'] })
  for (const [endpoint, schema, field] of [['/v1/ports', 'Ports', 'ports'], ['/v1/subscriptions/catalog', 'Catalog', 'listeners']]) {
    const response = await f.request(endpoint, { secret: token.secret })
    assert.equal(response.status, 200)
    const output = await response.json(), validate = apiSchemaValidator(schema)
    assert.deepEqual(output[field], [listener])
    assert.ok(validate(output), `${schema}: ${JSON.stringify(validate.errors)}`)
  }
  const rejected = await f.request('/v1/ports/17900', { secret: token.secret, method: 'PUT', body: { nodeIds: [], protocol: 'Mixed' } })
  assert.equal(rejected.status, 400)
  assert.equal((await rejected.json()).error.code, 'INVALID_REQUEST')
})

test('v1 subscription/port management, encrypted export and guarded apply satisfy response schemas', async t => {
  const f = await fixture(t)
  const subscriptionToken = f.tokenStore.create({ name: 'subscriptions', scopes: ['subscriptions:write'] })
  const portToken = f.tokenStore.create({ name: 'ports', scopes: ['ports:write'] })
  const admin = f.tokenStore.create({ name: 'backup', scopes: ['subscriptions:write', 'ports:write'] })
  for (const token of [subscriptionToken, portToken]) assert.equal((await f.request('/v1/config/export', { secret: token.secret, method: 'POST', body: { password: 'test-password' } })).status, 403)
  assert.equal((await f.request('/v1/ports/17900', { secret: subscriptionToken.secret, method: 'PUT', body: {} })).status, 403)
  assert.equal((await f.request('/v1/subscriptions', { secret: portToken.secret, method: 'POST', body: {} })).status, 403)
  const validated = async (endpoint, schema, options) => {
    const response = await f.request(`/v1${endpoint}`, { secret: admin.secret, ...options })
    assert.ok(response.ok, `${endpoint}: ${response.status}`)
    const value = await response.json(), validate = apiSchemaValidator(schema)
    assert.ok(validate(value), `${schema}: ${JSON.stringify(validate.errors)}`); return value
  }
  const subscription = await validated('/subscriptions', 'Subscription', { method: 'POST', body: { name: 'fixture', content } })
  await validated(`/subscriptions/${subscription.id}`, 'Subscription', { method: 'PATCH', body: { priority: 10 } })
  const catalog = await validated('/subscriptions/catalog', 'Catalog')
  assert.equal(JSON.stringify(catalog).includes('fixture-node-secret'), false)
  assert.equal((await f.request('/v1/ports/17900', { secret: portToken.secret, method: 'PUT', body: { nodeId: catalog.nodes[0].id, enabled: 'false' } })).status, 400)
  await validated('/ports/17900', 'PortResult', { method: 'PUT', body: { nodeIds: [catalog.nodes[0].id], protocol: 'HTTP' } })
  await validated('/ports', 'Ports')
  await validated('/ports/17900/verify', 'Verification', { method: 'POST', body: { attempts: 2 } })
  assert.equal((await f.request(`/v1/subscriptions/${subscription.id}`, { secret: admin.secret, method: 'DELETE' })).status, 409)
  const backup = await validated('/config/export', 'RecoveryPackage', { method: 'POST', body: { password: 'test-password' } })
  assert.equal(JSON.stringify(backup).includes('fixture-node-secret'), false)
  const importBody = { recoveryPackage: backup, password: 'test-password' }
  const plan = await validated('/config/plan', 'ConfigurationPlan', { method: 'POST', body: importBody })
  await validated('/ports/17900', 'PortDeletion', { method: 'DELETE' })
  const stale = await f.request('/v1/config/apply', { secret: admin.secret, method: 'POST', body: { ...importBody, planToken: plan.planToken } })
  assert.equal(stale.status, 409); assert.equal((await stale.json()).error.code, 'CONFIGURATION_PLAN_STALE')
  const nextPlan = await validated('/config/plan', 'ConfigurationPlan', { method: 'POST', body: importBody })
  assert.deepEqual(nextPlan.changes.ports.added, ['17900'])
  await validated('/config/apply', 'RecoveryResult', { method: 'POST', body: { ...importBody, planToken: nextPlan.planToken } })
  assert.equal((await validated('/ports', 'Ports')).ports.length, 1)
  await validated('/ports/17900', 'PortDeletion', { method: 'DELETE' })
  assert.equal((await f.request(`/v1/subscriptions/${subscription.id}`, { secret: admin.secret, method: 'DELETE' })).status, 204)
  assert.equal((await f.request('/v1/ports/not-a-port/status', { secret: admin.secret })).status, 400)
  // New UI handlers remain unversioned unless explicitly placed on the allowlist.
  assert.equal(buildOpenApi().paths['/tokens'], undefined)
})
