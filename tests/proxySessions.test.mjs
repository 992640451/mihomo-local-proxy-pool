import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import express from 'express'
import { ProxySessionStore } from '../server/proxySessionStore.mjs'
import { ensureEmbeddedCore, applyEmbeddedPort, deleteEmbeddedPort, startEmbeddedProxySession, endEmbeddedProxySession,
  getEmbeddedProxySession, syncEmbeddedCore, embeddedListeners, restoreEmbeddedCoreState, applyEmbeddedSubscriptionChange } from '../server/embeddedCore.mjs'
import { registerPortRoutes } from '../server/routes/ports.mjs'
import { versionedRegistrar } from '../server/automation/versioned.mjs'
import { apiSchemaValidator } from '../server/automation/validation.mjs'
import { createMutationGate } from '../server/recovery/mutationGate.mjs'

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ppm-proxy-sessions-'))
  const filename = path.join(directory, 'proxy-sessions.sqlite')
  let store = new ProxySessionStore({ filename }), groups = {}, failures = 0
  const definitions = ['a', 'b', 'c'].map(id => ({ id, active: true, raw: { name: id.toUpperCase(), type: 'http', server: `${id}.invalid`, port: 8080 } }))
  const healthy = new Set(['a', 'b', 'c']), connections = new Map(), calls = []
  const configPath = path.join(directory, 'config.yaml')
  const core = http.createServer(async (req, res) => {
    calls.push([req.method, req.url]); res.setHeader('Content-Type', 'application/json')
    const url = new URL(req.url, 'http://core')
    if (url.pathname === '/configs') {
      groups = Object.fromEntries(YAML.parse(await readFile(configPath, 'utf8'))['proxy-groups'].map(group => [group.name, { now: group.proxies[0], all: group.proxies }]))
      if (failures-- > 0) res.statusCode = 500 // Deliberately fail AFTER accepting the change.
      return res.end('{}')
    }
    if (url.pathname.endsWith('/delay')) {
      const node = decodeURIComponent(url.pathname.split('/')[2]).replace('ppm-node-', '')
      if (!healthy.has(node)) res.statusCode = 504
      return res.end(JSON.stringify({ delay: healthy.has(node) ? 5 : 0 }))
    }
    if (url.pathname.startsWith('/proxies/')) return res.end(JSON.stringify(groups[decodeURIComponent(url.pathname.split('/')[2])] || {}))
    if (url.pathname === '/connections') return res.end(JSON.stringify({ connections: [...connections.values()] }))
    if (url.pathname.startsWith('/connections/')) { connections.delete(decodeURIComponent(url.pathname.split('/')[2])); res.statusCode = 204; return res.end() }
    res.statusCode = 404; res.end('{}')
  })
  core.listen(0, '127.0.0.1'); await once(core, 'listening')
  const options = { statePath: path.join(directory, 'state.json'), configPath, controllerUrl: `http://127.0.0.1:${core.address().port}`,
    controllerConfigPath: configPath, controllerSecret: '', definitionProvider: async () => definitions, proxySessionStore: store, portRanges: '' }
  await ensureEmbeddedCore('', options)
  await applyEmbeddedPort({ source: '', ...options, port: 17900, protocol: 'Mixed', nodeIds: ['a', 'b', 'c'], strategy: 'session-round-robin' })
  const start = launchId => startEmbeddedProxySession('', 17900, { launchId, profileId: 'profile-one' }, options)
  const end = id => endEmbeddedProxySession('', 17900, id, options)
  t.after(async () => { core.closeAllConnections(); await new Promise(resolve => core.close(resolve)); store.close() })
  return { options, definitions, healthy, connections, calls, start, end, group: () => groups['PPM-17900'],
    failReload: count => { failures = count }, store: () => store,
    restart: async () => { store.close(); store = new ProxySessionStore({ filename }); options.proxySessionStore = store; await ensureEmbeddedCore('', options); await syncEmbeddedCore('', options) },
  }
}

test('sessions rotate A/B/C/A, remain pinned across reads/reloads, and refuse stale end or duplicate launch changes', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.group().all, ['REJECT'])
  let first
  for (const [index, node] of ['a', 'b', 'c', 'a'].entries()) {
    const result = await f.start(`launch-${index}`)
    assert.equal(result.session.nodeId, node)
    assert.deepEqual(f.group().all, [`ppm-node-${node}`])
    assert.ok(apiSchemaValidator('ProxySessionStatus')(result))
    assert.equal((await f.start(`launch-${index}`)).session.sessionId, result.session.sessionId)
    assert.equal((await getEmbeddedProxySession('', 17900, f.options)).session.nodeId, node)
    await syncEmbeddedCore('', f.options)
    assert.equal(f.group().now, `ppm-node-${node}`)
    if (first) { await f.end(first); assert.equal(f.group().now, `ppm-node-${node}`) }
    else first = result.session.sessionId
    await f.end(result.session.sessionId)
    assert.deepEqual(f.group().all, ['REJECT'])
  }
  assert.equal((await f.start('launch-0')).state, 'ended')
  await assert.rejects(() => startEmbeddedProxySession('', 17900, { launchId: 'launch-0', profileId: 'different' }, f.options), { code: 'PROXY_SESSION_CONFLICT' })
})

test('parallel starts grant exactly one lease; active sessions guard port mutation and subscription activation', async t => {
  const f = await fixture(t)
  const results = await Promise.allSettled([f.start('parallel-one'), f.start('parallel-two')])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  await assert.rejects(() => applyEmbeddedPort({ source: '', ...f.options, port: 17900, nodeIds: ['a'], strategy: 'select' }), { code: 'PROXY_SESSION_CONFLICT' })
  await assert.rejects(() => deleteEmbeddedPort({ source: '', ...f.options, port: 17900 }), { code: 'PROXY_SESSION_CONFLICT' })
  await assert.rejects(() => restoreEmbeddedCoreState('', { ports: {} }, f.options), { code: 'PROXY_SESSION_CONFLICT' })
  await applyEmbeddedPort({ source: '', ...f.options, port: 17901, nodeIds: ['b'], strategy: 'select' })
  assert.equal(f.group().now, 'ppm-node-a')
  await assert.rejects(() => applyEmbeddedSubscriptionChange('', async activate => {
    const previous = f.definitions[0].raw.server
    f.definitions[0].raw.server = 'changed.invalid'
    try { await activate() } finally { f.definitions[0].raw.server = previous }
  }, f.options), /会话节点被修改/)
  assert.equal(f.group().now, 'ppm-node-a')
})

test('node failures never rotate an active session; only new sessions skip unhealthy alternatives', async t => {
  const f = await fixture(t), a = await f.start('failure-a')
  f.healthy.delete('a'); f.healthy.delete('b')
  await syncEmbeddedCore('', f.options)
  assert.equal(f.group().now, 'ppm-node-a')
  await f.end(a.session.sessionId)
  const c = await f.start('failure-c'); assert.equal(c.session.nodeId, 'c')
  await f.end(c.session.sessionId)
  await assert.rejects(() => f.start('failure-none'), { code: 'NO_ALTERNATIVE_NODE' })
  assert.deepEqual(f.group().all, ['REJECT'])
  assert.equal(f.store().lastNode(17900), 'c')
})

test('restart preserves successful binding/cursor and quarantines interrupted transitions', async t => {
  const f = await fixture(t), a = await f.start('restart-a')
  await f.restart()
  assert.equal(f.group().now, 'ppm-node-a')
  assert.equal((await f.start('restart-a')).session.sessionId, a.session.sessionId)
  await f.end(a.session.sessionId)
  const b = await f.start('restart-b'); assert.equal(b.session.nodeId, 'b')
  f.store().save({ ...f.store().current(17900), state: 'ending' })
  await f.restart()
  assert.equal(f.group().now, 'REJECT')
  assert.equal(f.store().current(17900).state, 'recovery-required')
  await assert.rejects(() => f.start('restart-c'), /请先结束/)
  await f.end(b.session.sessionId)
  assert.equal((await f.start('restart-c')).session.nodeId, 'c')
})

test('lost core acknowledgements leave recoverable state; finishing only drains the affected port', async t => {
  const f = await fixture(t)
  f.failReload(1)
  await assert.rejects(() => f.start('uncertain-one'), { code: 'PROXY_SESSION_START_FAILED' })
  assert.equal(f.store().current(17900).state, 'recovery-required')
  await f.end(f.store().current(17900).sessionId)
  const a = await f.start('uncertain-two')
  f.connections.set('mine', { id: 'mine', chains: ['ppm-node-a', 'PPM-17900'] })
  f.connections.set('other', { id: 'other', chains: ['ppm-node-a', 'PPM-17901'] })
  await f.end(a.session.sessionId)
  assert.deepEqual([...f.connections.keys()], ['other'])
  assert.equal(f.calls.some(([method, url]) => method === 'DELETE' && url === '/connections'), false)
})

test('versioned session API validates inputs, scopes and returns actual lifecycle state', async t => {
  const f = await fixture(t), app = express()
  app.use(express.json()); app.use((req, _res, next) => { req.auth = { type: 'token', scopes: req.headers['x-test-scope'] === 'read' ? ['read'] : ['read', 'ports:write'] }; next() })
  registerPortRoutes(versionedRegistrar(app), { embeddedCore: true, coreOptions: f.options, defaultConfigDir: () => '', mutationGate: createMutationGate() })
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const request = (suffix, body, scope) => fetch(`http://127.0.0.1:${server.address().port}/api/v1/ports/17900/${suffix}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'x-test-scope': scope || 'write' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  assert.equal((await request('sessions', { launchId: 'http-test' }, 'read')).status, 403)
  assert.equal((await request('sessions', {})).status, 400)
  assert.equal((await request('sessions', { launchId: 'http-test', nodeId: 'injected' })).status, 400)
  const response = await request('sessions', { launchId: 'http-test' }), result = await response.json()
  assert.equal(response.status, 200); assert.equal(result.state, 'active')
  assert.ok(apiSchemaValidator('ProxySessionStatus')(result))
  assert.equal((await (await request('session', null, 'read')).json()).session.nodeId, 'a')
  assert.equal((await (await request(`sessions/${result.session.sessionId}/end`, {})).json()).state, 'ended')
})
