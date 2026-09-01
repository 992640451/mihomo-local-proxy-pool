import { randomBytes } from 'node:crypto'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { loadSubscriptionCatalog } from './subscriptionCatalog.mjs'

const MARKER_START = '/* PROXY_PORT_MANAGER_OVERRIDES_START */'
const MARKER_END = '/* PROXY_PORT_MANAGER_OVERRIDES_END */'

const listenerTypes = { Mixed: 'mixed', MIXED: 'mixed', HTTP: 'http', SOCKS5: 'socks' }

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
  for (const [port, item] of Object.entries(PROXY_PORT_MANAGER_OVERRIDES)) {
    if (!item.enabled) continue;
    const proxies = Array.isArray(config.proxies) ? config.proxies : [];
    if (!proxies.some(proxy => proxy && proxy.name === item.proxy)) throw new Error(\`端口 \${port} 的节点不存在：\${item.proxy}\`);
    config.listeners.push({ name: \`ppm-\${port}\`, type: item.type, listen: '127.0.0.1', port: Number(port), proxy: item.proxy, udp: true });
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

export async function applyMihomoPort({ source, port, nodeId, protocol = 'Mixed', enabled = true }) {
  const numericPort = Number(port)
  if (!Number.isInteger(numericPort) || numericPort < 1024 || numericPort > 65535) throw new Error('端口必须是 1024–65535 的整数')
  const catalog = await loadSubscriptionCatalog(source)
  const node = catalog.nodes.find(item => item.id === nodeId)
  if (!node) throw new Error('所选节点不存在或订阅已更新')
  const type = listenerTypes[protocol]
  if (!type) throw new Error('仅支持 Mixed、HTTP、SOCKS5 协议')
  const paths = await resolveMihomoPaths(source)
  const runtimeOriginal = await readFile(paths.runtimeConfigPath, 'utf8')
  const runtimeDoc = YAML.parse(runtimeOriginal) || {}
  const scriptOriginal = paths.scriptPath ? await readFile(paths.scriptPath, 'utf8') : null
  const item = { proxy: node.name, type, enabled: Boolean(enabled) }
  runtimeDoc.listeners = Array.isArray(runtimeDoc.listeners) ? runtimeDoc.listeners : []
  runtimeDoc.listeners = runtimeDoc.listeners.filter(listener => Number(listener?.port) !== numericPort)
  if (enabled) runtimeDoc.listeners.push({ name: `ppm-${numericPort}`, type, listen: '127.0.0.1', port: numericPort, proxy: node.name, udp: true })
  const runtimeNext = YAML.stringify(runtimeDoc)
  const scriptNext = scriptOriginal === null ? null : updateProfileScript(scriptOriginal, numericPort, item)
  try {
    if (scriptNext !== null) await atomicWrite(paths.scriptPath, scriptNext)
    await atomicWrite(paths.runtimeConfigPath, runtimeNext)
    const reload = await reloadMihomo(paths.runtimeConfigPath)
    const verified = YAML.parse(await readFile(paths.runtimeConfigPath, 'utf8')) || {}
    const listener = (verified.listeners || []).find(value => Number(value.port) === numericPort)
    if (enabled && listener?.proxy !== node.name) throw new Error('写入后校验失败：Listener 节点不一致')
    if (!enabled && listener) throw new Error('写入后校验失败：Listener 仍存在')
    return { port: numericPort, nodeId: node.id, proxy: node.name, protocol, enabled: Boolean(enabled), listener, ...reload }
  } catch (error) {
    await atomicWrite(paths.runtimeConfigPath, runtimeOriginal).catch(() => {})
    if (scriptOriginal !== null) await atomicWrite(paths.scriptPath, scriptOriginal).catch(() => {})
    throw error
  }
}

export async function deleteMihomoPort({ source, port }) {
  const numericPort = Number(port)
  if (!Number.isInteger(numericPort) || numericPort < 1024 || numericPort > 65535) throw new Error('端口必须是 1024–65535 的整数')
  const paths = await resolveMihomoPaths(source)
  const runtimeOriginal = await readFile(paths.runtimeConfigPath, 'utf8')
  const runtimeDoc = YAML.parse(runtimeOriginal) || {}
  const listeners = Array.isArray(runtimeDoc.listeners) ? runtimeDoc.listeners : []
  const listenerRemoved = listeners.some(listener => Number(listener?.port) === numericPort)
  runtimeDoc.listeners = listeners.filter(listener => Number(listener?.port) !== numericPort)
  const runtimeNext = listenerRemoved ? YAML.stringify(runtimeDoc) : runtimeOriginal
  const scriptOriginal = paths.scriptPath ? await readFile(paths.scriptPath, 'utf8') : null
  const scriptNext = scriptOriginal === null ? null : removeProfileScriptOverride(scriptOriginal, numericPort)
  const overrideRemoved = scriptOriginal !== null && scriptNext !== scriptOriginal
  const changed = listenerRemoved || overrideRemoved
  try {
    if (overrideRemoved) await atomicWrite(paths.scriptPath, scriptNext)
    if (listenerRemoved) await atomicWrite(paths.runtimeConfigPath, runtimeNext)
    const reload = changed ? await reloadMihomo(paths.runtimeConfigPath) : { reloaded: false, reloadRequired: false }
    const verified = YAML.parse(await readFile(paths.runtimeConfigPath, 'utf8')) || {}
    if ((verified.listeners || []).some(value => Number(value?.port) === numericPort)) throw new Error('删除后校验失败：Listener 仍存在')
    return { port: numericPort, removed: changed, listenerRemoved, overrideRemoved, ...reload }
  } catch (error) {
    if (listenerRemoved) await atomicWrite(paths.runtimeConfigPath, runtimeOriginal).catch(() => {})
    if (overrideRemoved) await atomicWrite(paths.scriptPath, scriptOriginal).catch(() => {})
    throw error
  }
}
