import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { buildProxyGroup, LISTENER_TYPES, normalizePortConfig, PORT_STRATEGIES, validatePortConfig } from '../shared/portConfig.js'

let mutationQueue = Promise.resolve()

function emptyState() { return { version: 2, ports: {} } }

function normalizeState(value = {}) {
  const state = emptyState()
  for (const [port, item] of Object.entries(value?.ports && typeof value.ports === 'object' ? value.ports : {})) {
    state.ports[String(port)] = normalizePortConfig({ ...item, port: Number(port) })
  }
  return state
}

function serializeMutation(operation) {
  const result = mutationQueue.then(operation, operation)
  mutationQueue = result.catch(() => {})
  return result
}

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
    listenerHost: options.listenerHost || process.env.EMBEDDED_CORE_LISTENER_HOST || '0.0.0.0',
    controllerAddress: options.controllerAddress || process.env.EMBEDDED_CORE_CONTROLLER_ADDRESS || '0.0.0.0:9090',
    definitionProvider: typeof options.definitionProvider === 'function' ? options.definitionProvider : null,
  }
}

async function resolveDefinitions(source, options) {
  return options.definitionProvider ? await options.definitionProvider() : loadDefinitions(source)
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
    return normalizeState(parsed)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return null
  }
}

async function backupLegacyState(options) {
  try {
    const raw = await readFile(options.statePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (Number(parsed?.version || 1) >= 2) return null
    const backupPath = `${options.statePath}.v1.bak`
    if (!await exists(backupPath)) await atomicWrite(backupPath, raw)
    return backupPath
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function migrateState(source, definitions) {
  const state = emptyState()
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
      nodeIds: [chosen.id],
      strategy: 'select',
      protocol: ({ mixed: 'Mixed', http: 'HTTP', socks: 'SOCKS5' })[String(listener.type || '').toLowerCase()] || 'Mixed',
      enabled: true,
    }
  }
  return state
}

function buildConfig(state, definitions, options) {
  const byId = new Map(definitions.map(item => [item.id, item]))
  const proxies = new Map(), proxyGroups = [], listeners = []
  for (const [portText, rawItem] of Object.entries(state.ports).sort(([a], [b]) => Number(a) - Number(b))) {
    const item = normalizePortConfig({ ...rawItem, port: Number(portText) })
    if (!item.enabled) continue
    const internalNames = item.nodeIds.map(id => {
      const definition = byId.get(id)
      if (!definition) throw new Error(`端口 ${portText} 的订阅节点已不存在：${id}`)
      const internalName = `ppm-node-${definition.id}`
      if (!proxies.has(internalName)) proxies.set(internalName, { ...definition.raw, name: internalName })
      return internalName
    })
    const proxyGroup = buildProxyGroup(item, internalNames)
    proxyGroups.push(proxyGroup)
    listeners.push({
      name: `ppm-${portText}`,
      type: LISTENER_TYPES[item.protocol] || 'mixed',
      listen: options.listenerHost,
      port: Number(portText),
      proxy: proxyGroup.name,
      udp: true,
    })
  }
  return {
    'allow-lan': options.listenerHost !== '127.0.0.1' && options.listenerHost !== '::1',
    'bind-address': options.listenerHost === '0.0.0.0' ? '*' : options.listenerHost,
    mode: 'rule',
    'log-level': 'info',
    ipv6: true,
    'external-controller': options.controllerAddress,
    secret: options.controllerSecret,
    proxies: [...proxies.values()],
    'proxy-groups': proxyGroups,
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
  if (!response.ok) throw new Error(`Mihomo 核心重载失败：HTTP ${response.status} ${await response.text()}`)
  return { reloaded: true, reloadRequired: false }
}

async function persist(source, state, options, shouldReload) {
  const definitions = await resolveDefinitions(source, options)
  const config = buildConfig(state, definitions, options)
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
  const definitions = await resolveDefinitions(source, options)
  const legacyBackupPath = await backupLegacyState(options)
  const existing = await readState(options)
  const state = existing || (options.definitionProvider ? emptyState() : await migrateState(source, definitions))
  const result = await persist(source, state, options, false)
  return { migrated: !existing || Boolean(legacyBackupPath), legacyBackupPath, ports: Object.keys(state.ports).length, configPath: options.configPath, ...result }
}

export function syncEmbeddedCore(source, rawOptions = {}) {
  return serializeMutation(async () => {
    const options = defaultOptions(rawOptions), state = await readState(options) || emptyState()
    return persist(source, state, options, true)
  })
}

export async function embeddedListeners(source, rawOptions = {}) {
  const options = defaultOptions(rawOptions), state = await readState(options) || emptyState()
  const definitions = await resolveDefinitions(source, options), byId = new Map(definitions.map(item => [item.id, item]))
  return Object.entries(state.ports).map(([port, rawItem]) => {
    const item = normalizePortConfig({ ...rawItem, port: Number(port) })
    const selected = item.nodeIds.map(id => byId.get(id)).filter(Boolean)
    const missing = item.nodeIds.find(id => !byId.has(id))
    return {
      id: `embedded-listener-${port}`,
      port: Number(port),
      protocol: ({ mixed: 'Mixed', http: 'HTTP', socks: 'SOCKS5' })[String(LISTENER_TYPES[item.protocol] || '').toLowerCase()] || 'Mixed',
      listen: options.listenerHost,
      routeName: `${PORT_STRATEGIES[item.strategy].label} · ${item.nodeIds.length} 节点`,
      listenerName: `ppm-${port}`,
      nodeId: item.nodeId,
      nodeIds: item.nodeIds,
      strategy: item.strategy,
      strategyOptions: item.strategyOptions,
      enabled: item.enabled !== false,
      managedBy: 'embedded-mihomo',
      lastChecked: item.enabled === false ? '配置已停用' : missing ? `节点已不存在：${missing}` : `受管监听 · 首选 ${selected[0]?.raw?.name || '未知'}`,
    }
  })
}

async function applyEmbeddedPortMutation({ source, port, nodeId, nodeIds, strategy, strategyOptions, protocol = 'Mixed', enabled = true, ...rawOptions }) {
  const numericPort = Number(port), normalizedProtocol = String(protocol)
  const options = defaultOptions(rawOptions)
  const definitions = await resolveDefinitions(source, options)
  const availableNodeIds = new Set(definitions.map(item => item.id))
  const normalized = validatePortConfig({ port: numericPort, nodeId, nodeIds, strategy, strategyOptions, protocol: normalizedProtocol, enabled }, {
    availableNodeIds,
    portAllowed: value => portAllowed(value, options.portRanges),
  })
  const primary = definitions.find(item => item.id === normalized.nodeId)
  const previousState = await readState(options) || emptyState()
  const previousConfig = await exists(options.configPath) ? await readFile(options.configPath, 'utf8') : null
  const nextState = structuredClone(previousState)
  nextState.version = 2
  nextState.ports[String(numericPort)] = normalized
  try {
    const result = await persist(source, nextState, options, true)
    const listener = result.config.listeners.find(item => item.port === numericPort)
    const proxyGroup = (result.config['proxy-groups'] || []).find(item => item.name === listener?.proxy)
    return { ...normalized, proxy: primary.raw.name, routeName: `${PORT_STRATEGIES[normalized.strategy].label} · ${normalized.nodeIds.length} 节点`, listener, proxyGroup, embeddedCore: true, reloaded: result.reloaded, reloadRequired: result.reloadRequired }
  } catch (error) {
    await atomicWrite(options.statePath, `${JSON.stringify(previousState, null, 2)}\n`).catch(() => {})
    if (previousConfig !== null) await atomicWrite(options.configPath, previousConfig).catch(() => {})
    if (previousConfig !== null) await reloadCore(options).catch(() => {})
    throw error
  }
}

export function applyEmbeddedPort(options) {
  return serializeMutation(() => applyEmbeddedPortMutation(options))
}

async function deleteEmbeddedPortMutation({ source, port, ...rawOptions }) {
  const numericPort = Number(port)
  if (!Number.isInteger(numericPort) || numericPort < 1024 || numericPort > 65535) throw new Error('端口必须是 1024–65535 的整数')
  const options = defaultOptions(rawOptions), previousState = await readState(options) || emptyState()
  if (!Object.prototype.hasOwnProperty.call(previousState.ports, String(numericPort))) return { port: numericPort, removed: false, embeddedCore: true, reloaded: false, reloadRequired: false }
  const previousConfig = await exists(options.configPath) ? await readFile(options.configPath, 'utf8') : null
  const nextState = structuredClone(previousState); delete nextState.ports[String(numericPort)]
  try {
    const result = await persist(source, nextState, options, true)
    return { port: numericPort, removed: true, listenerRemoved: true, overrideRemoved: false, embeddedCore: true, reloaded: result.reloaded, reloadRequired: result.reloadRequired }
  } catch (error) {
    await atomicWrite(options.statePath, `${JSON.stringify(previousState, null, 2)}\n`).catch(() => {})
    if (previousConfig !== null) await atomicWrite(options.configPath, previousConfig).catch(() => {})
    if (previousConfig !== null) await reloadCore(options).catch(() => {})
    throw error
  }
}

export function deleteEmbeddedPort(options) {
  return serializeMutation(() => deleteEmbeddedPortMutation(options))
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

async function controllerJson(options, pathname) {
  const response = await fetch(`${options.controllerUrl.replace(/\/$/, '')}${pathname}`, {
    headers: options.controllerSecret ? { Authorization: `Bearer ${options.controllerSecret}` } : {},
  })
  if (!response.ok) throw new Error(`Mihomo Controller 返回 HTTP ${response.status}`)
  return response.json()
}

export async function embeddedPortStatus(source, port, rawOptions = {}) {
  const numericPort = Number(port), options = defaultOptions(rawOptions)
  if (!Number.isInteger(numericPort)) throw new Error('端口无效')
  const state = await readState(options) || emptyState()
  const item = state.ports[String(numericPort)]
  if (!item) throw new Error('端口配置不存在')
  const definitions = await resolveDefinitions(source, options), byId = new Map(definitions.map(value => [value.id, value]))
  const normalized = normalizePortConfig({ ...item, port: numericPort })
  if (!options.controllerUrl) return { port: numericPort, strategy: normalized.strategy, activeNodeId: null, activeNodeName: null, reachable: false, nodes: [] }
  const groupName = `PPM-${numericPort}`
  const group = await controllerJson(options, `/proxies/${encodeURIComponent(groupName)}`)
  const statuses = await Promise.all(normalized.nodeIds.map(async id => {
    const definition = byId.get(id), internalName = `ppm-node-${id}`
    let detail = null
    try { detail = await controllerJson(options, `/proxies/${encodeURIComponent(internalName)}`) } catch {}
    return { nodeId: id, nodeName: definition?.raw?.name || `缺失节点 ${id}`, healthy: detail ? detail.alive !== false : null, history: Array.isArray(detail?.history) ? detail.history.slice(-1) : [] }
  }))
  const activeInternalName = String(group.now || '')
  const activeNodeId = activeInternalName.startsWith('ppm-node-') ? activeInternalName.slice('ppm-node-'.length) : null
  return {
    port: numericPort,
    strategy: normalized.strategy,
    activeNodeId,
    activeNodeName: activeNodeId ? byId.get(activeNodeId)?.raw?.name || null : null,
    reachable: true,
    nodes: statuses,
  }
}
