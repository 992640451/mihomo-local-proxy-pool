import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import YAML from 'yaml'
import { applyMihomoPort, deleteMihomoPort, removeProfileScriptOverride, resolveMihomoPaths, updateProfileScript } from '../server/mihomoConfig.mjs'
import { loadSubscriptionCatalog } from '../server/subscriptionCatalog.mjs'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppm-mihomo-'))
  await mkdir(path.join(root, 'profiles'))
  await writeFile(path.join(root, 'profiles.yaml'), YAML.stringify({
    current: 'active',
    items: [
      { uid: 'script-1', type: 'script', file: 'active.js' },
      { uid: 'active', type: 'remote', name: 'fixture', file: 'active.yaml', option: { script: 'script-1' } },
    ],
  }))
  await writeFile(path.join(root, 'profiles', 'active.yaml'), YAML.stringify({ proxies: [
    { name: '新加坡 01', type: 'ss', server: 'sg.example' },
    { name: '巴西 01', type: 'ss', server: 'br.example' },
  ] }))
  await writeFile(path.join(root, 'profiles', 'active.js'), 'function main(config) {\n  return config;\n}\n')
  await writeFile(path.join(root, 'clash-verge.yaml'), YAML.stringify({
    mode: 'rule',
    'mixed-port': 7897,
    proxies: [{ name: '新加坡 01' }, { name: '巴西 01' }],
    listeners: [{ name: 'legacy', type: 'mixed', listen: '127.0.0.1', port: 17893, proxy: '巴西 01', udp: true }],
  }))
  return root
}

test('resolves the active Clash Verge script and reads real listeners from the generated config', async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }))
  const paths = await resolveMihomoPaths(root)
  assert.equal(paths.scriptPath, path.join(root, 'profiles', 'active.js'))
  const catalog = await loadSubscriptionCatalog(root)
  assert.equal(catalog.listeners.find(item => item.port === 17893)?.routeName, '巴西 01')
  assert.deepEqual(catalog.listeners.find(item => item.port === 7897), {
    id: 'mihomo-mixed-7897', port: 7897, protocol: 'MIXED', listen: '127.0.0.1',
    routeName: '规则模式 · 动态路由', listenerName: 'MIXED-PORT', nodeId: '', nodeIds: [],
    isGlobal: true, routeMode: 'rule', enabled: true, managedBy: 'mihomo', lastChecked: '服务端监听',
  })
})

test('applies a port to runtime YAML and installs an idempotent persistent script override', async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }))
  const catalog = await loadSubscriptionCatalog(root)
  const sg = catalog.nodes.find(node => node.code === 'SG')
  const result = await applyMihomoPort({ source: root, port: 17893, nodeId: sg.id, protocol: 'Mixed', enabled: true })
  assert.equal(result.proxy, '新加坡 01')
  assert.equal(result.reloadRequired, true)
  const runtime = YAML.parse(await readFile(path.join(root, 'clash-verge.yaml'), 'utf8'))
  assert.deepEqual(runtime.listeners.filter(item => item.port === 17893).map(item => item.proxy), ['PPM-17893'])
  assert.deepEqual(runtime['proxy-groups'].find(item => item.name === 'PPM-17893'), { name:'PPM-17893',type:'select',proxies:['新加坡 01'] })
  const script = await readFile(path.join(root, 'profiles', 'active.js'), 'utf8')
  assert.match(script, /return applyProxyPortManagerOverrides\(config\);/)
  assert.equal(script.match(/PROXY_PORT_MANAGER_OVERRIDES_START/g)?.length, 1)
  const second = updateProfileScript(script, 17893, { proxy: '新加坡 01', type: 'mixed', enabled: true })
  assert.equal(second.match(/PROXY_PORT_MANAGER_OVERRIDES_START/g)?.length, 1)
})

test('writes an ordered fallback group to runtime YAML and the persistent script', async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }))
  const catalog = await loadSubscriptionCatalog(root)
  const sg = catalog.nodes.find(node => node.code === 'SG'), br = catalog.nodes.find(node => node.code === 'BR')
  await applyMihomoPort({ source: root, port: 17893, nodeIds: [sg.id, br.id], strategy: 'fallback', protocol: 'Mixed', enabled: true })
  const runtime = YAML.parse(await readFile(path.join(root, 'clash-verge.yaml'), 'utf8'))
  const group = runtime['proxy-groups'].find(item => item.name === 'PPM-17893')
  assert.equal(group.type, 'fallback')
  assert.deepEqual(group.proxies, ['新加坡 01', '巴西 01'])
  assert.equal(runtime.listeners.find(item => item.port === 17893).proxy, group.name)
  const script = await readFile(path.join(root, 'profiles', 'active.js'), 'utf8')
  assert.match(script, /"type": "fallback"/)
  assert.match(script, /"巴西 01"/)
})

test('restores runtime YAML and profile script when controller reload fails', async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }))
  const runtimePath = path.join(root, 'clash-verge.yaml'), scriptPath = path.join(root, 'profiles', 'active.js')
  const runtimeBefore = await readFile(runtimePath, 'utf8'), scriptBefore = await readFile(scriptPath, 'utf8')
  const catalog = await loadSubscriptionCatalog(root), sg = catalog.nodes.find(node => node.code === 'SG')
  const previousUrl = process.env.MIHOMO_CONTROLLER_URL
  process.env.MIHOMO_CONTROLLER_URL = 'http://127.0.0.1:1'
  try { await assert.rejects(applyMihomoPort({ source: root, port: 17893, nodeId: sg.id })) }
  finally { if (previousUrl === undefined) delete process.env.MIHOMO_CONTROLLER_URL; else process.env.MIHOMO_CONTROLLER_URL = previousUrl }
  assert.equal(await readFile(runtimePath, 'utf8'), runtimeBefore)
  assert.equal(await readFile(scriptPath, 'utf8'), scriptBefore)
})

test('deletes an added port from runtime YAML and its persistent script override', async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }))
  const catalog = await loadSubscriptionCatalog(root), sg = catalog.nodes.find(node => node.code === 'SG')
  await applyMihomoPort({ source: root, port: 17894, nodeId: sg.id, protocol: 'Mixed', enabled: true })
  const result = await deleteMihomoPort({ source: root, port: 17894 })
  assert.deepEqual({ removed:result.removed, listenerRemoved:result.listenerRemoved, overrideRemoved:result.overrideRemoved }, { removed:true, listenerRemoved:true, overrideRemoved:true })
  const runtime = YAML.parse(await readFile(path.join(root, 'clash-verge.yaml'), 'utf8'))
  assert.equal(runtime.listeners.some(item => item.port === 17894), false)
  const script = await readFile(path.join(root, 'profiles', 'active.js'), 'utf8')
  assert.doesNotMatch(script, /"17894"/)
  assert.equal(removeProfileScriptOverride(script, 17894), script)
})

test('restores deleted listener and override when controller reload fails', async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }))
  const runtimePath = path.join(root, 'clash-verge.yaml'), scriptPath = path.join(root, 'profiles', 'active.js')
  const catalog = await loadSubscriptionCatalog(root), sg = catalog.nodes.find(node => node.code === 'SG')
  await applyMihomoPort({ source: root, port: 17894, nodeId: sg.id })
  const runtimeBefore = await readFile(runtimePath, 'utf8'), scriptBefore = await readFile(scriptPath, 'utf8')
  const previousUrl = process.env.MIHOMO_CONTROLLER_URL
  process.env.MIHOMO_CONTROLLER_URL = 'http://127.0.0.1:1'
  try { await assert.rejects(deleteMihomoPort({ source: root, port: 17894 })) }
  finally { if (previousUrl === undefined) delete process.env.MIHOMO_CONTROLLER_URL; else process.env.MIHOMO_CONTROLLER_URL = previousUrl }
  assert.equal(await readFile(runtimePath, 'utf8'), runtimeBefore)
  assert.equal(await readFile(scriptPath, 'utf8'), scriptBefore)
})
