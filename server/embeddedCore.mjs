import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'

const LISTENER_TYPES = { Mixed: 'mixed', MIXED: 'mixed', HTTP: 'http', SOCKS5: 'socks', SOCKS: 'socks' }

async function exists(filename) {
  try { await stat(filename); return true } catch { return false }
}

async function atomicWrite(filename, content) {
  await mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.ppm-${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, filename)
}

function nodeId(providerId, name, fileSource = false) {
  return createHash('sha1').update(fileSource ? `mihomo:${name}` : `${providerId}:${name}`).digest('hex').slice(0, 16)
}

async function loadDefinitions(source) {
  const info = await stat(source)
  if (info.isFile()) {
    const doc = YAML.parse(await readFile(source, 'utf8')) || {}
    return (doc.proxies || []).filter(item => item?.name).map(raw => ({
      id: nodeId('mihomo-local', raw.name, true), providerId: 'mihomo-local', provider: 'Mihomo 本地配置', raw,
    }))
  }
  const profiles = YAML.parse(await readFile(path.join(source, 'profiles.yaml'), 'utf8')) || {}
  const definitions = []
  for (const profile of (profiles.items || []).filter(item => item.type === 'remote' && item.file)) {
    const filename = path.join(source, 'profiles', profile.file)
    if (!await exists(filename)) continue
    const doc = YAML.parse(await readFile(filename, 'utf8')) || {}
    for (const raw of doc.proxies || []) {
      if (!raw?.name) continue
      definitions.push({ id: nodeId(profile.uid, raw.name), providerId: profile.uid, provider: profile.name, raw })
    }
  }
  return definitions
}

function defaultOptions(options = {}) {
  return {
    statePath: options.statePath || process.env.EMBEDDED_CORE_STATE_PATH || '/data/embedded-core.json',
    configPath: options.configPath || process.env.EMBEDDED_CORE_CONFIG_PATH || '/mihomo/config.yaml',
    controllerUrl: options.controllerUrl === undefined ? (process.env.EMBEDDED_CORE_CONTROLLER_URL || '') : options.controllerUrl,
    controllerSecret: options.controllerSecret === undefined ? (process.env.EMBEDDED_CORE_SECRET || '') : options.controllerSecret,
    controllerConfigPath: options.controllerConfigPath || process.env.EMBEDDED_CORE_HOST_CONFIG_PATH || '/home/mihomo/config.yaml',
    portRanges: options.portRanges === undefined ? (process.env.EMBEDDED_CORE_PORT_RANGES || '') : options.portRanges,
  }
}

function portAllowed(port, ranges) {
  if (!ranges) return true
  return String(ranges).split(',').some(part => {
    const [start, end = start] = part.trim().split('-').map(Number)
    return Number.isInteger(start) && Number.isInteger(end) && port >= start && port <= end
  })
}

async function readState(options) {
  try {
    const parsed = JSON.parse(await readFile(options.statePath, 'utf8'))
    return { version: 1, ports: parsed?.ports && typeof parsed.ports === 'object' ? parsed.ports : {} }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return null
  }
}

async function migrateState(source, definitions) {
  const state = { version: 1, ports: {} }
  const sourceInfo = await stat(source)
  const runtimePath = sourceInfo.isFile() ? source : path.join(source, 'clash-verge.yaml')
  if (!await exists(runtimePath)) return state
  const runtime = YAML.parse(await readFile(runtimePath, 'utf8')) || {}
  for (const listener of runtime.listeners || []) {
    const port = Number(listener?.port)
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !listener?.proxy) continue
    const candidates = definitions.filter(item => item.raw.name === listener.proxy)
    if (!candidates.length) continue
    const chosen = candidates[0]
    state.ports[String(port)] = {
      nodeId: chosen.id,
      protocol: ({ mixed: 'Mixed', http: 'HTTP', socks: 'SOCKS5' })[String(listener.type || '').toLowerCase()] || 'Mixed',
      enabled: true,
    }
  }
  return state
}

function buildConfig(state, definitions, secret) {
  const byId = new Map(definitions.map(item => [item.id, item]))
  const proxies = new Map(), listeners = []
  for (const [portText, item] of Object.entries(state.ports).sort(([a], [b]) => Number(a) - Number(b))) {
    if (!item.enabled) continue
    const definition = byId.get(item.nodeId)
    if (!definition) throw new Error(`端口 ${portText} 的订阅节点已不存在：${item.nodeId}`)
    const internalName = `ppm-node-${definition.id}`
    if (!proxies.has(internalName)) proxies.set(internalName, { ...definition.raw, name: internalName })
    listeners.push({
      name: `ppm-${portText}`,
      type: LISTENER_TYPES[item.protocol] || 'mixed',
      listen: '0.0.0.0',
      port: Number(portText),
      proxy: internalName,
      udp: true,
    })
  }
  return {
    'allow-lan': true,
    'bind-address': '*',
    mode: 'rule',
    'log-level': 'info',
    ipv6: true,
    'external-controller': '0.0.0.0:9090',
    secret,
    proxies: [...proxies.values()],
    listeners,
    rules: ['MATCH,DIRECT'],
  }
}

async function reloadCore(options) {
  if (!options.controllerUrl) return { reloaded: false, reloadRequired: true }
  const response = await fetch(`${options.controllerUrl.replace(/\/$/, '')}/configs?force=true`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(options.controllerSecret ? { Authorization: `Bearer ${options.controllerSecret}` } : {}) },
    body: JSON.stringify({ path: options.controllerConfigPath }),
  })
  if (!response.ok) throw new Error(`内置 Mihomo 重载失败：HTTP ${response.status} ${await response.text()}`)
  return { reloaded: true, reloadRequired: false }
}

async function persist(source, state, options, shouldReload) {
  const definitions = await loadDefinitions(source)
  const config = buildConfig(state, definitions, options.controllerSecret)
  await atomicWrite(options.statePath, `${JSON.stringify(state, null, 2)}\n`)
  await atomicWrite(options.configPath, YAML.stringify(config))
  const reload = shouldReload ? await reloadCore(options) : { reloaded: false, reloadRequired: Boolean(options.controllerUrl) }
  return { definitions, config, ...reload }
}

export function isEmbeddedCoreEnabled() {
  return String(process.env.EMBEDDED_CORE_ENABLED || '').trim().toLowerCase() === 'true'
}

export async function ensureEmbeddedCore(source, rawOptions = {}) {
  const options = defaultOptions(rawOptions)
  const definitions = await loadDefinitions(source)
  const existing = await readState(options)
  const state = existing || await migrateState(source, definitions)
  const result = await persist(source, state, options, false)
  return { migrated: !existing, ports: Object.keys(state.ports).length, configPath: options.configPath, ...result }
}

export async function embeddedListeners(source, rawOptions = {}) {
  const options = defaultOptions(rawOptions), state = await readState(options) || { version: 1, ports: {} }
  const definitions = await loadDefinitions(source), byId = new Map(definitions.map(item => [item.id, item]))
  return Object.entries(state.ports).filter(([, item]) => item.enabled).map(([port, item]) => {
    const definition = byId.get(item.nodeId)
    return {
      id: `embedded-listener-${port}`,
      port: Number(port),
      protocol: String(item.protocol || 'Mixed').toUpperCase(),
      listen: '0.0.0.0',
      routeName: definition?.raw?.name || `缺失节点 ${item.nodeId}`,
      listenerName: `ppm-${port}`,
      nodeId: item.nodeId,
      enabled: true,
      managedBy: 'embedded-mihomo',
      lastChecked: definition ? '内置核心监听' : '节点已不存在',
    }
  })
}

export async function applyEmbeddedPort({ source, port, nodeId: selectedNodeId, protocol = 'Mixed', enabled = true, ...rawOptions }) {
  const numericPort = Number(port), normalizedProtocol = String(protocol)
  if (!Number.isInteger(numericPort) || numericPort < 1024 || numericPort > 65535) throw new Error('端口必须是 1024–65535 的整数')
  const options = defaultOptions(rawOptions)
  if (!portAllowed(numericPort, options.portRanges)) throw new Error(`端口 ${numericPort} 不在内置核心已发布范围内：${options.portRanges}`)
  if (!LISTENER_TYPES[normalizedProtocol]) throw new Error('仅支持 Mixed、HTTP、SOCKS5 协议')
  const definitions = await loadDefinitions(source)
  const definition = definitions.find(item => item.id === selectedNodeId)
  if (!definition) throw new Error('所选节点不存在或订阅已更新')
  const previousState = await readState(options) || { version: 1, ports: {} }
  const previousConfig = await exists(options.configPath) ? await readFile(options.configPath, 'utf8') : null
  const nextState = structuredClone(previousState)
  nextState.ports[String(numericPort)] = { nodeId: definition.id, protocol: normalizedProtocol, enabled: Boolean(enabled) }
  try {
    const result = await persist(source, nextState, options, true)
    const listener = result.config.listeners.find(item => item.port === numericPort)
    return { port: numericPort, nodeId: definition.id, proxy: definition.raw.name, protocol: normalizedProtocol, enabled: Boolean(enabled), listener, embeddedCore: true, reloaded: result.reloaded, reloadRequired: result.reloadRequired }
  } catch (error) {
    await atomicWrite(options.statePath, `${JSON.stringify(previousState, null, 2)}\n`).catch(() => {})
    if (previousConfig !== null) await atomicWrite(options.configPath, previousConfig).catch(() => {})
    throw error
  }
}

export async function deleteEmbeddedPort({ source, port, ...rawOptions }) {
  const numericPort = Number(port)
  if (!Number.isInteger(numericPort) || numericPort < 1024 || numericPort > 65535) throw new Error('端口必须是 1024–65535 的整数')
  const options = defaultOptions(rawOptions), previousState = await readState(options) || { version: 1, ports: {} }
  if (!Object.prototype.hasOwnProperty.call(previousState.ports, String(numericPort))) return { port: numericPort, removed: false, embeddedCore: true, reloaded: false, reloadRequired: false }
  const previousConfig = await exists(options.configPath) ? await readFile(options.configPath, 'utf8') : null
  const nextState = structuredClone(previousState); delete nextState.ports[String(numericPort)]
  try {
    const result = await persist(source, nextState, options, true)
    return { port: numericPort, removed: true, listenerRemoved: true, overrideRemoved: false, embeddedCore: true, reloaded: result.reloaded, reloadRequired: result.reloadRequired }
  } catch (error) {
    await atomicWrite(options.statePath, `${JSON.stringify(previousState, null, 2)}\n`).catch(() => {})
    if (previousConfig !== null) await atomicWrite(options.configPath, previousConfig).catch(() => {})
    throw error
  }
}

export async function embeddedCoreStatus(rawOptions = {}) {
  const options = defaultOptions(rawOptions)
  if (!options.controllerUrl) return { enabled: true, reachable: false, version: null }
  try {
    const response = await fetch(`${options.controllerUrl.replace(/\/$/, '')}/version`, { headers: options.controllerSecret ? { Authorization: `Bearer ${options.controllerSecret}` } : {} })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    return { enabled: true, reachable: true, version: body.version || null, meta: body.meta === true }
  } catch (error) { return { enabled: true, reachable: false, version: null, error: error.message } }
}
