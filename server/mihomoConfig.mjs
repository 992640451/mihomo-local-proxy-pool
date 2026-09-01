import { randomBytes } from 'node:crypto'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { loadSubscriptionCatalog } from './subscriptionCatalog.mjs'
import { buildProxyGroup, LISTENER_TYPES, PORT_STRATEGIES, validatePortConfig } from '../shared/portConfig.js'

const MARKER_START = '/* PROXY_PORT_MANAGER_OVERRIDES_START */'
const MARKER_END = '/* PROXY_PORT_MANAGER_OVERRIDES_END */'
let mutationQueue = Promise.resolve()

function serializeMutation(operation) {
  const result = mutationQueue.then(operation, operation)
  mutationQueue = result.catch(() => {})
  return result
}

async function isFile(value) {
  try { return (await stat(value)).isFile() } catch { return false }
}

export async function resolveMihomoPaths(source) {
  if (await isFile(source)) return { configDir: path.dirname(source), runtimeConfigPath: source, scriptPath: null }
  const profilesPath = path.join(source, 'profiles.yaml')
  const profiles = YAML.parse(await readFile(profilesPath, 'utf8')) || {}
  const active = (profiles.items || []).find(item => item.uid === profiles.current)
  const scriptUid = active?.option?.script
  const script = (profiles.items || []).find(item => item.uid === scriptUid && item.type === 'script')
  return {
    configDir: source,
    runtimeConfigPath: path.join(source, 'clash-verge.yaml'),
    scriptPath: script?.file ? path.join(source, 'profiles', script.file) : null,
  }
}

function extractOverrides(scriptText) {
  const start = scriptText.indexOf(MARKER_START), end = scriptText.indexOf(MARKER_END)
  if (start < 0 || end < start) return {}
  const block = scriptText.slice(start, end)
  const match = block.match(/const PROXY_PORT_MANAGER_OVERRIDES = (\{[\s\S]*?\});/)
  if (!match) return {}
  return JSON.parse(match[1])
}

function overrideBlock(overrides) {
  const data = JSON.stringify(overrides, null, 2)
  return `${MARKER_START}
const PROXY_PORT_MANAGER_OVERRIDES = ${data};
function applyProxyPortManagerOverrides(config) {
  config.listeners = Array.isArray(config.listeners) ? config.listeners : [];
  const ports = new Set(Object.keys(PROXY_PORT_MANAGER_OVERRIDES).map(Number));
  config.listeners = config.listeners.filter(listener => listener && !ports.has(Number(listener.port)));
  config['proxy-groups'] = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : [];
  const groupNames = new Set(Object.entries(PROXY_PORT_MANAGER_OVERRIDES).map(([port, item]) => item.proxyGroup?.name || \`PPM-\${port}\`));
  config['proxy-groups'] = config['proxy-groups'].filter(group => group && !groupNames.has(group.name));
  for (const [port, item] of Object.entries(PROXY_PORT_MANAGER_OVERRIDES)) {
    if (!item.enabled) continue;
    const proxies = Array.isArray(config.proxies) ? config.proxies : [];
    const proxyName = item.proxyGroup?.name || item.proxy;
    const required = item.proxyGroup?.proxies || [item.proxy];
    const missing = required.find(name => !proxies.some(proxy => proxy && proxy.name === name));
    if (missing) throw new Error(\`端口 \${port} 的节点不存在：\${missing}\`);
    if (item.proxyGroup) config['proxy-groups'].push(item.proxyGroup);
    config.listeners.push({ name: \`ppm-\${port}\`, type: item.type, listen: '127.0.0.1', port: Number(port), proxy: proxyName, udp: true });
  }
  return config;
}
${MARKER_END}`
}

export function updateProfileScript(scriptText, port, item) {
  const overrides = extractOverrides(scriptText)
  overrides[String(port)] = item
  const block = overrideBlock(overrides)
  const start = scriptText.indexOf(MARKER_START), end = scriptText.indexOf(MARKER_END)
  if (start >= 0 && end >= start) return `${scriptText.slice(0, start)}${block}${scriptText.slice(end + MARKER_END.length)}`
  const returnPattern = /return\s+config\s*;/
  if (!returnPattern.test(scriptText)) throw new Error('活动配置脚本缺少 return config;，无法安装持久化端口覆盖')
  return `${scriptText.replace(returnPattern, 'return applyProxyPortManagerOverrides(config);')}\n\n${block}\n`
}

export function removeProfileScriptOverride(scriptText, port) {
  const overrides = extractOverrides(scriptText)
  const key = String(port)
  if (!Object.prototype.hasOwnProperty.call(overrides, key)) return scriptText
  delete overrides[key]
  const block = overrideBlock(overrides)
  const start = scriptText.indexOf(MARKER_START), end = scriptText.indexOf(MARKER_END)
  return `${scriptText.slice(0, start)}${block}${scriptText.slice(end + MARKER_END.length)}`
}

async function atomicWrite(filePath, content) {
  const temporary = `${filePath}.ppm-${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, filePath)
}

async function reloadMihomo(runtimeConfigPath) {
  const url = process.env.MIHOMO_CONTROLLER_URL
  if (!url) return { reloaded: false, reloadRequired: true }
  const hostPath = process.env.MIHOMO_HOST_CONFIG_PATH || runtimeConfigPath
  const secret = process.env.MIHOMO_CONTROLLER_SECRET || ''
  const response = await fetch(`${url.replace(/\/$/, '')}/configs?force=true`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({ path: hostPath }),
  })
  if (!response.ok) throw new Error(`Mihomo 重载失败：HTTP ${response.status} ${await response.text()}`)
  return { reloaded: true, reloadRequired: false }
}

async function applyMihomoPortMutation({ source, port, nodeId, nodeIds, strategy, strategyOptions, protocol = 'Mixed', enabled = true }) {
  const catalog = await loadSubscriptionCatalog(source)
  const normalized = validatePortConfig({ port, nodeId, nodeIds, strategy, strategyOptions, protocol, enabled }, { availableNodeIds: new Set(catalog.nodes.map(item => item.id)) })
  const selectedNodes = normalized.nodeIds.map(id => catalog.nodes.find(item => item.id === id))
  const node = selectedNodes[0]
  const type = LISTENER_TYPES[normalized.protocol]
  const proxyGroup = buildProxyGroup(normalized, selectedNodes.map(item => item.name))
  const numericPort = normalized.port
  const paths = await resolveMihomoPaths(source)
  const runtimeOriginal = await readFile(paths.runtimeConfigPath, 'utf8')
  const runtimeDoc = YAML.parse(runtimeOriginal) || {}
  const scriptOriginal = paths.scriptPath ? await readFile(paths.scriptPath, 'utf8') : null
  const item = { proxy: node.name, proxyGroup, type, enabled: normalized.enabled }
  runtimeDoc.listeners = Array.isArray(runtimeDoc.listeners) ? runtimeDoc.listeners : []
  runtimeDoc.listeners = runtimeDoc.listeners.filter(listener => Number(listener?.port) !== numericPort)
  runtimeDoc['proxy-groups'] = Array.isArray(runtimeDoc['proxy-groups']) ? runtimeDoc['proxy-groups'] : []
  runtimeDoc['proxy-groups'] = runtimeDoc['proxy-groups'].filter(group => group?.name !== proxyGroup.name)
  if (normalized.enabled) {
    runtimeDoc['proxy-groups'].push(proxyGroup)
    runtimeDoc.listeners.push({ name: `ppm-${numericPort}`, type, listen: '127.0.0.1', port: numericPort, proxy: proxyGroup.name, udp: true })
  }
  const runtimeNext = YAML.stringify(runtimeDoc)
  const scriptNext = scriptOriginal === null ? null : updateProfileScript(scriptOriginal, numericPort, item)
  try {
    if (scriptNext !== null) await atomicWrite(paths.scriptPath, scriptNext)
    await atomicWrite(paths.runtimeConfigPath, runtimeNext)
    const reload = await reloadMihomo(paths.runtimeConfigPath)
    const verified = YAML.parse(await readFile(paths.runtimeConfigPath, 'utf8')) || {}
    const listener = (verified.listeners || []).find(value => Number(value.port) === numericPort)
    if (normalized.enabled && listener?.proxy !== proxyGroup.name) throw new Error('写入后校验失败：监听策略组不一致')
    if (!normalized.enabled && listener) throw new Error('写入后校验失败：监听仍存在')
    return { ...normalized, proxy: node.name, routeName: `${PORT_STRATEGIES[normalized.strategy].label} · ${normalized.nodeIds.length} 节点`, listener, proxyGroup, ...reload }
  } catch (error) {
    await atomicWrite(paths.runtimeConfigPath, runtimeOriginal).catch(() => {})
    if (scriptOriginal !== null) await atomicWrite(paths.scriptPath, scriptOriginal).catch(() => {})
    await reloadMihomo(paths.runtimeConfigPath).catch(() => {})
    throw error
  }
}

export function applyMihomoPort(options) {
  return serializeMutation(() => applyMihomoPortMutation(options))
}

async function deleteMihomoPortMutation({ source, port }) {
  const numericPort = Number(port)
  if (!Number.isInteger(numericPort) || numericPort < 1024 || numericPort > 65535) throw new Error('端口必须是 1024–65535 的整数')
  const paths = await resolveMihomoPaths(source)
  const runtimeOriginal = await readFile(paths.runtimeConfigPath, 'utf8')
  const runtimeDoc = YAML.parse(runtimeOriginal) || {}
  const listeners = Array.isArray(runtimeDoc.listeners) ? runtimeDoc.listeners : []
  const listenerRemoved = listeners.some(listener => Number(listener?.port) === numericPort)
  runtimeDoc.listeners = listeners.filter(listener => Number(listener?.port) !== numericPort)
  const groupName = `PPM-${numericPort}`
  const groups = Array.isArray(runtimeDoc['proxy-groups']) ? runtimeDoc['proxy-groups'] : []
  const groupRemoved = groups.some(group => group?.name === groupName)
  runtimeDoc['proxy-groups'] = groups.filter(group => group?.name !== groupName)
  const runtimeNext = listenerRemoved || groupRemoved ? YAML.stringify(runtimeDoc) : runtimeOriginal
  const scriptOriginal = paths.scriptPath ? await readFile(paths.scriptPath, 'utf8') : null
  const scriptNext = scriptOriginal === null ? null : removeProfileScriptOverride(scriptOriginal, numericPort)
  const overrideRemoved = scriptOriginal !== null && scriptNext !== scriptOriginal
  const changed = listenerRemoved || groupRemoved || overrideRemoved
  try {
    if (overrideRemoved) await atomicWrite(paths.scriptPath, scriptNext)
    if (listenerRemoved || groupRemoved) await atomicWrite(paths.runtimeConfigPath, runtimeNext)
    const reload = changed ? await reloadMihomo(paths.runtimeConfigPath) : { reloaded: false, reloadRequired: false }
    const verified = YAML.parse(await readFile(paths.runtimeConfigPath, 'utf8')) || {}
    if ((verified.listeners || []).some(value => Number(value?.port) === numericPort)) throw new Error('删除后校验失败：监听仍存在')
    if ((verified['proxy-groups'] || []).some(value => value?.name === groupName)) throw new Error('删除后校验失败：策略组仍存在')
    return { port: numericPort, removed: changed, listenerRemoved, groupRemoved, overrideRemoved, ...reload }
  } catch (error) {
    if (listenerRemoved || groupRemoved) await atomicWrite(paths.runtimeConfigPath, runtimeOriginal).catch(() => {})
    if (overrideRemoved) await atomicWrite(paths.scriptPath, scriptOriginal).catch(() => {})
    if (changed) await reloadMihomo(paths.runtimeConfigPath).catch(() => {})
    throw error
  }
}

export function deleteMihomoPort(options) {
  return serializeMutation(() => deleteMihomoPortMutation(options))
}
