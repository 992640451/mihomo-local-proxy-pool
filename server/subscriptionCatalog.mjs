import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { strategyFromProxyGroup, strategyOptionsFromProxyGroup } from '../shared/portConfig.js'

const COUNTRIES = [
  ['香港','HK','🇭🇰'],['日本','JP','🇯🇵'],['美国','US','🇺🇸'],['新加坡','SG','🇸🇬'],['台湾','TW','🇹🇼'],
  ['巴西','BR','🇧🇷'],['韩国','KR','🇰🇷'],['德国','DE','🇩🇪'],['英国','GB','🇬🇧'],['加拿大','CA','🇨🇦'],
  ['澳大利亚','AU','🇦🇺'],['澳洲','AU','🇦🇺'],['法国','FR','🇫🇷'],['荷兰','NL','🇳🇱'],['俄罗斯','RU','🇷🇺'],
  ['印度','IN','🇮🇳'],['南非','ZA','🇿🇦'],['迪拜','AE','🇦🇪'],['阿联酋','AE','🇦🇪'],['智利','CL','🇨🇱'],
  ['墨西哥','MX','🇲🇽'],['西班牙','ES','🇪🇸'],['瑞士','CH','🇨🇭'],['马来西亚','MY','🇲🇾'],['泰国','TH','🇹🇭'],
  ['越南','VN','🇻🇳'],['菲律宾','PH','🇵🇭'],['印尼','ID','🇮🇩'],['土耳其','TR','🇹🇷'],['意大利','IT','🇮🇹'],
]

export function classifyCountry(name) {
  const hit = COUNTRIES.find(([keyword]) => name.includes(keyword))
  if (!hit) return { country: '其他', code: 'ZZ', flag: '🌐' }
  return { country: hit[0] === '澳洲' ? '澳大利亚' : hit[0] === '迪拜' ? '阿联酋' : hit[0], code: hit[1], flag: hit[2] }
}

export function buildNativeCatalog(subscriptions, definitions) {
  const active = definitions.filter(item => item.active !== false)
  const nodes = active.map(item => {
    const name = String(item.raw?.name || ''), geo = classifyCountry(name)
    return { id: item.id, providerId: item.providerId, provider: item.provider, name, city: geo.country, ...geo, delay: null, healthy: true }
  })
  const countries = [...new Map(nodes.map(node => [node.code, { name: node.country, code: node.code, flag: node.flag, count: 0 }])).values()]
  countries.forEach(country => { country.count = nodes.filter(node => node.code === country.code).length })
  countries.sort((a,b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
  return {
    source: 'Proxy Port Manager 原生订阅库', updatedAt: new Date().toISOString(),
    providers: subscriptions.filter(item => item.enabled).map(item => ({
      id: item.id, name: item.name, file: null, nodeCount: item.nodeCount,
      lastSuccessAt: item.lastSuccessAt, lastError: item.lastError,
    })),
    countries, nodes, listeners: [],
  }
}

async function loadVergeCatalog(configDir) {
  const profiles = YAML.parse(await readFile(path.join(configDir, 'profiles.yaml'), 'utf8')) || {}
  const remotes = (profiles.items || []).filter(item => item.type === 'remote' && item.file)
  const nodes = []
  for (const profile of remotes) {
    const doc = YAML.parse(await readFile(path.join(configDir, 'profiles', profile.file), 'utf8')) || {}
    for (const raw of doc.proxies || []) {
      if (!raw?.name) continue
      const geo = classifyCountry(String(raw.name))
      const hash = createHash('sha1').update(`${profile.uid}:${raw.name}`).digest('hex')
      nodes.push({ id: hash.slice(0, 16), providerId: profile.uid, provider: profile.name, name: String(raw.name), city: geo.country, ...geo, delay: null, healthy: true })
    }
  }
  const countries = [...new Map(nodes.map(n => [n.code, { name: n.country, code: n.code, flag: n.flag, count: 0 }])).values()]
  countries.forEach(c => { c.count = nodes.filter(n => n.code === c.code).length })
  countries.sort((a,b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
  let listeners = []
  try {
    const runtimeDoc = YAML.parse(await readFile(path.join(configDir, 'clash-verge.yaml'), 'utf8')) || {}
    listeners = listenersFromDocument(runtimeDoc, nodes)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return {
    source: 'Clash Verge Rev 本地订阅配置', updatedAt: new Date().toISOString(),
    providers: remotes.map(p => ({ id: p.uid, name: p.name, file: p.file, nodeCount: nodes.filter(n => n.providerId === p.uid).length })),
    countries, nodes, listeners,
  }
}

function listenersFromDocument(doc, nodes) {
  const groups = new Map((doc['proxy-groups'] || []).map(group => [group.name, group]))
  const byName = new Map(nodes.map(node => [node.name, node]))
  const resolveNode = routeName => {
    const direct = byName.get(routeName)
    if (direct) return direct
    const candidates = groups.get(routeName)?.proxies || []
    return candidates.map(name => byName.get(name)).find(Boolean)
  }
  const listeners = (doc.listeners || []).filter(item => item?.port).map((item, index) => {
    const routeGeo = classifyCountry(`${item.name || ''} ${item.proxy || ''}`)
    const group = groups.get(item.proxy)
    const groupNodes = (group?.proxies || []).map(name => byName.get(name)).filter(Boolean)
    const node = groupNodes[0] || resolveNode(item.proxy)
      || nodes.find(value => routeGeo.code !== 'ZZ' && value.code === routeGeo.code) || nodes[0]
    const nodeIds = groupNodes.length ? groupNodes.map(value => value.id) : node ? [node.id] : []
    return {
      id: `mihomo-listener-${item.port}-${index}`, port: Number(item.port), protocol: ({ mixed: 'Mixed', http: 'HTTP', socks: 'SOCKS5' })[String(item.type || 'mixed').toLowerCase()] || 'Mixed',
      listen: item.listen || '127.0.0.1', routeName: item.proxy || item.name || 'DIRECT', listenerName: item.name || `LISTENER-${item.port}`,
      nodeId: nodeIds[0] || '', nodeIds, strategy: strategyFromProxyGroup(group), strategyOptions: strategyOptionsFromProxyGroup(group),
      enabled: true, managedBy: 'mihomo', lastChecked: '服务端监听',
    }
  })
  if (doc['mixed-port']) {
    const routeMode = String(doc.mode || 'rule').toLowerCase()
    const modeLabel = { rule: '规则模式', global: '全局模式', direct: '直连模式' }[routeMode] || routeMode
    listeners.unshift({ id: `mihomo-mixed-${doc['mixed-port']}`, port: Number(doc['mixed-port']), protocol: 'MIXED', listen: doc['bind-address'] || '127.0.0.1', routeName: `${modeLabel} · 动态路由`, listenerName: 'MIXED-PORT', nodeId: '', nodeIds: [], isGlobal: true, routeMode, enabled: true, managedBy: 'mihomo', lastChecked: '服务端监听' })
  }
  return listeners
}

async function loadMihomoCatalog(configPath) {
  const doc = YAML.parse(await readFile(configPath, 'utf8')) || {}
  const provider = process.env.CATALOG_PROVIDER_NAME || '阿里云 Mihomo'
  const nodes = (doc.proxies || []).filter(raw => raw?.name).map(raw => {
    const name = String(raw.name), geo = classifyCountry(name)
    const id = createHash('sha1').update(`mihomo:${name}`).digest('hex').slice(0, 16)
    return { id, providerId: 'mihomo-local', provider, name, city: geo.country, ...geo, delay: null, healthy: true }
  })
  const listeners = listenersFromDocument(doc, nodes)
  const countries = [...new Map(nodes.map(n => [n.code, { name: n.country, code: n.code, flag: n.flag, count: 0 }])).values()]
  countries.forEach(c => { c.count = nodes.filter(n => n.code === c.code).length })
  countries.sort((a,b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
  return { source: '服务器 Mihomo 配置', updatedAt: new Date().toISOString(), providers: [{ id: 'mihomo-local', name: provider, file: configPath, nodeCount: nodes.length }], countries, nodes, listeners }
}

export async function loadSubscriptionCatalog(source = defaultConfigDir()) {
  const info = await stat(source)
  return info.isFile() ? loadMihomoCatalog(source) : loadVergeCatalog(source)
}

export function defaultConfigDir() {
  if (process.env.MIHOMO_CONFIG_PATH) return process.env.MIHOMO_CONFIG_PATH
  if (process.platform !== 'win32') return '/etc/mihomo/config.yaml'
  return process.env.CLASH_VERGE_CONFIG_DIR || path.join(process.env.APPDATA || '', 'io.github.clash-verge-rev.clash-verge-rev')
}
