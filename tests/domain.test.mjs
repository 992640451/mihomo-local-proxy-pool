import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMihomoPortConfig, createInitialPorts, dedupePortsByPort, enrichPort, filterPorts, mergeSelectedNodeIds, nextAvailablePort, normalizePort, proxyAddressesForPort, removePortById, reorderPortNode, restorePortState, validatePortDraft } from '../src/domain.js'
import { classifyCountry } from '../server/subscriptionCatalog.mjs'

const nodes = [
  { id:'jp-a',provider:'示例订阅 A',country:'日本',name:'日本节点 A',code:'JP' },
  { id:'jp-b',provider:'示例订阅 A',country:'日本',name:'日本节点 B',code:'JP' },
  { id:'us-a',provider:'示例订阅 A',country:'美国',name:'美国节点 A',code:'US' },
  { id:'br-a',provider:'示例订阅 B',country:'巴西',name:'巴西节点 A',code:'BR' },
]
const ports = createInitialPorts(nodes)

test('creates default ports from dynamic subscription nodes', () => assert.deepEqual(ports.map(p=>[p.port,p.nodeId]), [[17891,'jp-a'],[17892,'jp-b'],[17893,'us-a']]))
test('allocates the first published embedded-core port', () => assert.equal(nextAvailablePort(ports),17900))
test('filters ports using dynamic countries', () => assert.deepEqual(filterPorts(ports,{provider:'全部订阅',country:'日本',status:'全部状态',query:'节点 A'},nodes).map(p=>p.port),[17891]))
test('keeps the global mixed port visible without assigning a fake node or country', () => {
  const globalPort={id:'mihomo-mixed-7897',port:7897,protocol:'MIXED',nodeId:'',nodeIds:[],isGlobal:true,routeName:'规则模式 · 动态路由',listenerName:'MIXED-PORT',enabled:true,managedBy:'mihomo'}
  assert.equal(enrichPort(globalPort,nodes).node,undefined)
  assert.deepEqual(filterPorts([globalPort],{provider:'全部订阅',country:'全部国家',status:'全部状态',query:'动态路由'},nodes).map(p=>p.port),[7897])
  assert.equal(filterPorts([globalPort],{provider:'示例订阅 A',country:'全部国家',status:'全部状态',query:''},nodes).length,0)
})
test('validates duplicate and free ports', () => { assert.match(validatePortDraft({port:17891,nodeId:'jp-a'},ports),/已被占用/); assert.equal(validatePortDraft({port:17900,nodeId:'jp-a'},ports),''); assert.match(validatePortDraft({port:17894,nodeId:'jp-a'},ports),/可用端口范围/) })
test('removes only requested port', () => assert.deepEqual(removePortById(ports,'port-17892').map(p=>p.port),[17891,17893]))
test('deduplicates repeated persisted ports by numeric port', () => {
  const repeated = [...ports, ...ports.map(port => ({ ...port, id:`duplicate-${port.id}` })), ...ports]
  assert.deepEqual(dedupePortsByPort(repeated).map(port=>port.port), [17891,17892,17893])
})
test('restores persisted defaults without appending a new default set on every refresh', () => {
  const repeated = Array.from({ length: 5 }, (_, copy) => ports.map(port => ({ ...port, id:`${port.id}-${copy}` }))).flat()
  assert.deepEqual(restorePortState(nodes, [], repeated).map(port=>port.port), [17891,17892,17893])
})
test('prefers current server listeners when a persisted custom port has the same number', () => {
  const listener = { id:'listener-17891',port:17891,protocol:'MIXED',nodeId:'jp-a',enabled:true,managedBy:'mihomo' }
  assert.deepEqual(restorePortState(nodes,[listener],ports).map(port=>[port.port,port.managedBy||'custom']), [[17891,'mihomo'],[17892,'custom'],[17893,'custom']])
})
test('classifies all subscription country labels including aliases', () => { assert.equal(classifyCountry('澳洲 01').code,'AU'); assert.equal(classifyCountry('迪拜专线').code,'AE'); assert.equal(classifyCountry('未知节点').code,'ZZ') })

test('migrates a legacy single-node port without losing compatibility', () => {
  assert.deepEqual(normalizePort({ nodeId:'jp-a' }), {
    nodeId:'jp-a', nodeIds:['jp-a'], strategy:'select',
    strategyOptions:{ healthCheckUrl:'https://www.gstatic.com/generate_204',intervalSeconds:60,timeoutMs:5000,toleranceMs:50,maxFailedTimes:3 },
  })
})

test('validates the minimum pool size for automatic strategies', () => {
  assert.match(validatePortDraft({port:17900,nodeIds:['jp-a'],strategy:'fallback'},ports),/至少需要 2 个节点/)
  assert.equal(validatePortDraft({port:17900,nodeIds:['jp-a','us-a'],strategy:'fallback'},ports),'')
})

test('filters a multi-node port by any member country and provider', () => {
  const pool=[{id:'pool',port:17894,protocol:'Mixed',nodeIds:['jp-a','us-a'],strategy:'fallback',enabled:true}]
  assert.equal(filterPorts(pool,{provider:'全部订阅',country:'美国',status:'全部状态',query:''},nodes).length,1)
  assert.equal(filterPorts(pool,{provider:'全部订阅',country:'日本',status:'全部状态',query:'美国节点 A'},nodes).length,1)
})

test('reorders fallback nodes while preserving the rest of the pool', () => {
  assert.deepEqual(reorderPortNode(['jp-a','us-a','br-a'],'us-a',-1),['us-a','jp-a','br-a'])
  assert.deepEqual(reorderPortNode(['jp-a','us-a','br-a'],'jp-a',-1),['jp-a','us-a','br-a'])
})

test('appends all visible nodes without changing the existing pool order', () => {
  assert.deepEqual(mergeSelectedNodeIds(['us-a','jp-a'],['jp-a','br-a']),['us-a','jp-a','br-a'])
  assert.deepEqual(mergeSelectedNodeIds(['us-a'],['br-a','br-a','']),['us-a','br-a'])
})

test('builds directly usable proxy addresses for every listener protocol', () => {
  assert.deepEqual(proxyAddressesForPort({ port:17900,protocol:'HTTP' }), [{ protocol:'HTTP',url:'http://127.0.0.1:17900' }])
  assert.deepEqual(proxyAddressesForPort({ port:17901,protocol:'SOCKS5' }), [{ protocol:'SOCKS5',url:'socks5h://127.0.0.1:17901' }])
  assert.deepEqual(proxyAddressesForPort({ port:17902,protocol:'Mixed' }), [
    { protocol:'HTTP',url:'http://127.0.0.1:17902' },
    { protocol:'SOCKS5',url:'socks5h://127.0.0.1:17902' },
  ])
})

test('builds Mihomo listener and consistent-hashing group for one port', () => {
  const config=buildMihomoPortConfig({port:17894,protocol:'Mixed',nodeIds:['jp-a','us-a'],strategy:'consistent-hashing'},nodes)
  assert.deepEqual(config.proxyGroup,{name:'PPM-17894',type:'load-balance',proxies:['日本节点 A','美国节点 A'],strategy:'consistent-hashing',url:'https://www.gstatic.com/generate_204',interval:60,timeout:5000,'max-failed-times':3})
  assert.deepEqual(config.listener,{name:'ppm-17894',type:'mixed',listen:'127.0.0.1',port:17894,proxy:'PPM-17894',udp:true})
})
