import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { applyEmbeddedPort, deleteEmbeddedPort, embeddedListeners, ensureEmbeddedCore, exportEmbeddedCoreState, restoreEmbeddedCoreState } from '../server/embeddedCore.mjs'
import { loadSubscriptionCatalog } from '../server/subscriptionCatalog.mjs'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppm-embedded-')), profilesDir = path.join(root, 'profiles')
  await mkdir(profilesDir)
  await writeFile(path.join(root, 'profiles.yaml'), YAML.stringify({
    current: 'active',
    items: [
      { uid: 'active', type: 'remote', name: '订阅 A', file: 'a.yaml' },
      { uid: 'other', type: 'remote', name: '订阅 B', file: 'b.yaml' },
    ],
  }))
  await writeFile(path.join(profilesDir, 'a.yaml'), YAML.stringify({ proxies: [{ name: '日本 A', type: 'http', server: 'a.example', port: 443 }] }))
  await writeFile(path.join(profilesDir, 'b.yaml'), YAML.stringify({ proxies: [{ name: '美国 B', type: 'hysteria2', server: 'b.example', port: 8443, password: 'secret' }] }))
  await writeFile(path.join(root, 'clash-verge.yaml'), YAML.stringify({ listeners: [{ name: 'ppm-17891', type: 'mixed', listen: '127.0.0.1', port: 17891, proxy: '日本 A' }] }))
  return { root, statePath: path.join(root, 'data', 'state.json'), configPath: path.join(root, 'core', 'config.yaml') }
}

test('migrates listeners and builds an independent Mihomo configuration', async () => {
  const f = await fixture()
  const result = await ensureEmbeddedCore(f.root, { statePath: f.statePath, configPath: f.configPath, controllerUrl: '', controllerSecret: 'test-secret' })
  assert.equal(result.migrated, true)
  const config = YAML.parse(await readFile(f.configPath, 'utf8'))
  assert.equal(config['external-controller'], '0.0.0.0:9090')
  assert.equal(config.secret, 'test-secret')
  assert.equal(config.listeners[0].port, 17891)
  assert.equal(config.listeners[0].listen, '0.0.0.0')
  assert.equal(config.listeners[0].proxy, 'PPM-17891')
  assert.deepEqual(config['proxy-groups'][0], { name: 'PPM-17891', type: 'select', proxies: [config.proxies[0].name] })
  assert.equal(config.proxies[0].server, 'a.example')
  assert.match(config.proxies[0].name, /^ppm-node-/)
})

test('binds the portable core controller and listeners to loopback', async () => {
  const f = await fixture()
  await ensureEmbeddedCore(f.root, {
    statePath: f.statePath,
    configPath: f.configPath,
    controllerUrl: '',
    listenerHost: '127.0.0.1',
    controllerAddress: '127.0.0.1:19090',
  })
  const config = YAML.parse(await readFile(f.configPath, 'utf8'))
  assert.equal(config['allow-lan'], false)
  assert.equal(config['bind-address'], '127.0.0.1')
  assert.equal(config['external-controller'], '127.0.0.1:19090')
  assert.equal(config.listeners[0].listen, '127.0.0.1')
  const listener = (await embeddedListeners(f.root, { statePath: f.statePath, listenerHost: '127.0.0.1' }))[0]
  assert.equal(listener.listen, '127.0.0.1')
})

test('upgrades a v1 state file to v2 and keeps a rollback backup', async () => {
  const f = await fixture()
  const catalogId = (await loadSubscriptionCatalog(f.root)).nodes.find(item => item.name === '日本 A').id
  await mkdir(path.dirname(f.statePath), { recursive: true })
  const legacy = `${JSON.stringify({ version: 1, ports: { 17891: { nodeId: catalogId, protocol: 'Mixed', enabled: true } } }, null, 2)}\n`
  await writeFile(f.statePath, legacy)
  const result = await ensureEmbeddedCore(f.root, { statePath: f.statePath, configPath: f.configPath, controllerUrl: '' })
  assert.equal(result.migrated, true)
  assert.equal(await readFile(`${f.statePath}.v1.bak`, 'utf8'), legacy)
  const state = JSON.parse(await readFile(f.statePath, 'utf8'))
  assert.equal(state.version, 2)
  assert.equal(state.ports['17891'].nodeId, catalogId)
  assert.deepEqual(state.ports['17891'].nodeIds, [catalogId])
  assert.equal(state.ports['17891'].strategy, 'select')
})

test('applies a node from an inactive subscription without switching profiles', async () => {
  const f = await fixture()
  await ensureEmbeddedCore(f.root, { statePath: f.statePath, configPath: f.configPath, controllerUrl: '' })
  const catalogId = (await loadSubscriptionCatalog(f.root)).nodes.find(item => item.name === '美国 B').id
  const result = await applyEmbeddedPort({ source: f.root, port: 17892, nodeId: catalogId, protocol: 'Mixed', statePath: f.statePath, configPath: f.configPath, controllerUrl: '' })
  assert.equal(result.proxy, '美国 B')
  assert.equal(result.embeddedCore, true)
  const config = YAML.parse(await readFile(f.configPath, 'utf8'))
  const listener = config.listeners.find(item => item.port === 17892)
  const group = config['proxy-groups'].find(item => item.name === listener.proxy)
  const proxy = config.proxies.find(item => item.name === group.proxies[0])
  assert.equal(proxy.type, 'hysteria2')
  assert.equal(proxy.server, 'b.example')
  assert.equal(proxy.password, 'secret')
  const saved = (await embeddedListeners(f.root, { statePath: f.statePath })).find(item => item.port === 17892)
  assert.equal(saved.routeName, '手动选择 · 1 节点')
  assert.equal(saved.protocol, 'Mixed')
  assert.deepEqual(saved.nodeIds, [catalogId])
  assert.equal(saved.strategy, 'select')
})

test('persists an ordered fallback pool and points the listener at its proxy group', async () => {
  const f = await fixture()
  await ensureEmbeddedCore(f.root, { statePath: f.statePath, configPath: f.configPath, controllerUrl: '' })
  const catalog = await loadSubscriptionCatalog(f.root)
  const primary = catalog.nodes.find(item => item.name === '日本 A').id
  const backup = catalog.nodes.find(item => item.name === '美国 B').id
  await applyEmbeddedPort({
    source: f.root, port: 17892, nodeIds: [primary, backup], strategy: 'fallback', protocol: 'Mixed',
    strategyOptions: { healthCheckUrl: 'https://www.gstatic.com/generate_204', intervalSeconds: 30, timeoutMs: 2000, maxFailedTimes: 2 },
    statePath: f.statePath, configPath: f.configPath, controllerUrl: '',
  })
  const config = YAML.parse(await readFile(f.configPath, 'utf8'))
  const group = config['proxy-groups'].find(item => item.name === 'PPM-17892')
  assert.equal(group.type, 'fallback')
  assert.deepEqual(group.proxies, [`ppm-node-${primary}`, `ppm-node-${backup}`])
  assert.equal(group.interval, 30)
  assert.equal(group.timeout, 2000)
  assert.equal(group['max-failed-times'], 2)
  assert.equal(config.listeners.find(item => item.port === 17892).proxy, group.name)
  const state = JSON.parse(await readFile(f.statePath, 'utf8'))
  assert.equal(state.version, 2)
  assert.equal(state.ports['17892'].nodeId, primary)
  assert.deepEqual(state.ports['17892'].nodeIds, [primary, backup])
})

test('serializes concurrent port mutations without losing either port', async () => {
  const f = await fixture()
  await ensureEmbeddedCore(f.root, { statePath: f.statePath, configPath: f.configPath, controllerUrl: '' })
  const nodes = (await loadSubscriptionCatalog(f.root)).nodes
  const primary = nodes.find(item => item.name === '日本 A').id, backup = nodes.find(item => item.name === '美国 B').id
  const common = { source: f.root, protocol: 'Mixed', statePath: f.statePath, configPath: f.configPath, controllerUrl: '' }
  await Promise.all([
    applyEmbeddedPort({ ...common, port: 17892, nodeId: primary }),
    applyEmbeddedPort({ ...common, port: 17900, nodeIds: [primary, backup], strategy: 'fallback' }),
  ])
  const state = JSON.parse(await readFile(f.statePath, 'utf8'))
  assert.ok(state.ports['17892'])
  assert.ok(state.ports['17900'])
  const config = YAML.parse(await readFile(f.configPath, 'utf8'))
  assert.ok(config.listeners.some(item => item.port === 17892))
  assert.ok(config.listeners.some(item => item.port === 17900))
})

test('deletes an embedded listener and preserves the other ports', async () => {
  const f = await fixture()
  await ensureEmbeddedCore(f.root, { statePath: f.statePath, configPath: f.configPath, controllerUrl: '' })
  const removed = await deleteEmbeddedPort({ source: f.root, port: 17891, statePath: f.statePath, configPath: f.configPath, controllerUrl: '' })
  assert.equal(removed.removed, true)
  const config = YAML.parse(await readFile(f.configPath, 'utf8'))
  assert.equal(config.listeners.some(item => item.port === 17891), false)
  assert.equal(config['proxy-groups'].some(item => item.name === 'PPM-17891'), false)
})

test('restores a validated embedded-core state and rejects missing node references', async () => {
  const f = await fixture()
  const options = { statePath: f.statePath, configPath: f.configPath, controllerUrl: '' }
  await ensureEmbeddedCore(f.root, options)
  const original = await exportEmbeddedCoreState(options)
  const node = (await loadSubscriptionCatalog(f.root)).nodes.find(item => item.name === '美国 B').id
  await applyEmbeddedPort({ source: f.root, port: 17892, nodeId: node, protocol: 'Mixed', ...options })
  assert.equal((await exportEmbeddedCoreState(options)).ports['17892'].nodeId, node)
  const restored = await restoreEmbeddedCoreState(f.root, original, options)
  assert.equal(restored.ports, 1)
  assert.equal((await exportEmbeddedCoreState(options)).ports['17892'], undefined)
  await assert.rejects(() => restoreEmbeddedCoreState(f.root, {
    version: 2,
    ports: { 17900: { nodeId: 'missing', nodeIds: ['missing'], strategy: 'select', protocol: 'Mixed', enabled: true } },
  }, options), /节点不存在/)
  assert.deepEqual(await exportEmbeddedCoreState(options), original)
})

test('loads active unassigned nodes for measurement without creating extra listeners', async () => {
  const f = await fixture()
  const definitions = [
    { id: 'fresh', active: true, subscriptionEnabled: true, raw: { name: 'fresh', type: 'http', server: 'example.com', port: 443 } },
    { id: 'disabled', active: true, subscriptionEnabled: false, raw: { name: 'disabled', type: 'http', server: 'example.com', port: 443 } },
    { id: 'orphan', active: false, subscriptionEnabled: true, raw: { name: 'orphan', type: 'http', server: 'example.com', port: 443 } },
  ]
  await ensureEmbeddedCore(f.root, { statePath: f.statePath, configPath: f.configPath, controllerUrl: '', definitionProvider: () => definitions })
  const config = YAML.parse(await readFile(f.configPath, 'utf8'))
  assert.deepEqual(config.proxies.map(proxy => proxy.name), ['ppm-node-fresh'])
  assert.deepEqual(config.listeners, [])
  assert.deepEqual(config['proxy-groups'], [])
})
