import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { applyEmbeddedPort, deleteEmbeddedPort, embeddedListeners, ensureEmbeddedCore } from '../server/embeddedCore.mjs'
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
  assert.equal(config.proxies[0].server, 'a.example')
  assert.match(config.proxies[0].name, /^ppm-node-/)
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
  const proxy = config.proxies.find(item => item.name === listener.proxy)
  assert.equal(proxy.type, 'hysteria2')
  assert.equal(proxy.server, 'b.example')
  assert.equal(proxy.password, 'secret')
  assert.equal((await embeddedListeners(f.root, { statePath: f.statePath })).find(item => item.port === 17892).routeName, '美国 B')
})

test('deletes an embedded listener and preserves the other ports', async () => {
  const f = await fixture()
  await ensureEmbeddedCore(f.root, { statePath: f.statePath, configPath: f.configPath, controllerUrl: '' })
  const removed = await deleteEmbeddedPort({ source: f.root, port: 17891, statePath: f.statePath, configPath: f.configPath, controllerUrl: '' })
  assert.equal(removed.removed, true)
  const config = YAML.parse(await readFile(f.configPath, 'utf8'))
  assert.equal(config.listeners.some(item => item.port === 17891), false)
})
