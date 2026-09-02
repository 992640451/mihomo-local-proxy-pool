import { createHash } from 'node:crypto'
import { decryptRecoveryPayload, encryptRecoveryPayload } from './crypto.mjs'
import { configurationChanges, configurationDigest, ConfigurationPlanSigner } from './plan.mjs'

const MAX_SUBSCRIPTIONS = 1000
const MAX_NODES = 100_000

function requiredText(value, label, maximum = 512) {
  const text = String(value || '').trim()
  if (!text || text.length > maximum) throw new Error(`恢复数据中的${label}无效`)
  return text
}

function requiredContent(value, label, maximum) {
  const content = typeof value === 'string' ? value : ''
  if (!content.trim() || Buffer.byteLength(content, 'utf8') > maximum) throw new Error(`恢复数据中的${label}无效`)
  return content
}

function validateUrl(value) {
  if (!value) return null
  let url
  try { url = new URL(String(value)) } catch { throw new Error('恢复数据包含无效订阅 URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('恢复数据包含不安全的订阅 URL')
  return url.toString()
}

function validateSubscriptions(value) {
  if (!Array.isArray(value) || value.length > MAX_SUBSCRIPTIONS) throw new Error('恢复数据中的订阅列表无效')
  const ids = new Set(), nodeIds = new Set(), snapshotIds = new Set()
  let nodeCount = 0
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('恢复数据包含无效订阅')
    const id = requiredText(item.id, '订阅 ID', 128)
    if (ids.has(id)) throw new Error(`恢复数据包含重复订阅 ID：${id}`)
    ids.add(id)
    const sourceType = requiredText(item.sourceType, '订阅类型', 32)
    if (!['url', 'inline', 'legacy'].includes(sourceType)) throw new Error(`恢复数据包含未知订阅类型：${sourceType}`)
    const refreshIntervalSeconds = Number(item.refreshIntervalSeconds)
    if (!Number.isInteger(refreshIntervalSeconds) || refreshIntervalSeconds < 60 || refreshIntervalSeconds > 604800) throw new Error(`订阅“${item.name || id}”的刷新周期无效`)
    const priority = Number(item.priority || 0)
    if (!Number.isInteger(priority) || priority < -10000 || priority > 10000) throw new Error(`订阅“${item.name || id}”的优先级无效`)
    const stableKeys = new Set()
    const nodes = Array.isArray(item.nodes) ? item.nodes.map(node => {
      const nodeId = requiredText(node?.id, '节点 ID', 128)
      if (nodeIds.has(nodeId)) throw new Error(`恢复数据包含重复节点 ID：${nodeId}`)
      nodeIds.add(nodeId)
      if (!node.raw || typeof node.raw !== 'object' || Array.isArray(node.raw)) throw new Error(`节点“${node.name || nodeId}”配置无效`)
      requiredText(node.raw.name || node.name, '节点名称')
      requiredText(node.raw.type, '节点类型', 64)
      requiredText(node.raw.server, '节点服务器', 512)
      const port = Number(node.raw.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`节点“${node.name || nodeId}”端口无效`)
      const stableKey = requiredText(node.stableKey, '节点稳定键', 2048)
      if (stableKeys.has(stableKey)) throw new Error(`订阅“${item.name || id}”包含重复节点稳定键`)
      stableKeys.add(stableKey)
      return {
        ...node,
        id: nodeId,
        stableKey,
        name: requiredText(node.name, '节点名称'),
        active: node.active !== false,
      }
    }) : []
    nodeCount += nodes.length
    if (nodeCount > MAX_NODES) throw new Error('恢复数据中的节点数量超过上限')
    const snapshot = item.snapshot ? {
      ...item.snapshot,
      id: requiredText(item.snapshot.id, '订阅快照 ID', 128),
      content: requiredContent(item.snapshot.content, '订阅快照内容', 8 * 1024 * 1024),
      contentHash: requiredText(item.snapshot.contentHash, '订阅快照哈希', 128),
      format: requiredText(item.snapshot.format, '订阅格式', 64),
      nodeCount: Number(item.snapshot.nodeCount),
    } : null
    if (snapshot && snapshotIds.has(snapshot.id)) throw new Error('恢复数据包含重复快照 ID')
    if (snapshot) snapshotIds.add(snapshot.id)
    if (snapshot && (!Number.isInteger(snapshot.nodeCount) || snapshot.nodeCount < 0 || snapshot.nodeCount > MAX_NODES)) throw new Error(`订阅“${item.name || id}”的快照节点数无效`)
    if (snapshot && createHash('sha256').update(snapshot.content).digest('hex') !== snapshot.contentHash) throw new Error(`订阅“${item.name || id}”的快照校验失败`)
    if (snapshot && nodes.filter(node => node.active).length !== snapshot.nodeCount) throw new Error(`订阅“${item.name || id}”的节点数量与快照不一致`)
    return {
      ...item,
      id,
      name: requiredText(item.name, '订阅名称'),
      sourceType,
      url: validateUrl(item.url),
      enabled: item.enabled !== false,
      priority,
      refreshIntervalSeconds,
      snapshot,
      nodes,
    }
  })
}

function validatePayload(payload) {
  if (!payload || payload.format !== 'ppm-recovery-data' || payload.version !== 1) throw new Error('恢复包中的数据版本不受支持')
  if (!payload.data || typeof payload.data !== 'object') throw new Error('恢复包缺少数据')
  const subscriptions = validateSubscriptions(payload.data.subscriptions)
  const ports = payload.data.ports
  if (!ports || typeof ports !== 'object' || Array.isArray(ports) || !ports.ports || typeof ports.ports !== 'object' || Array.isArray(ports.ports)) throw new Error('恢复数据中的端口配置无效')
  return { subscriptions, ports }
}

export class RecoveryService {
  constructor({ subscriptionStore, exportPorts, restorePorts, validatePorts, suspend, resume, appVersion = 'unknown' } = {}) {
    this.subscriptionStore = subscriptionStore
    this.exportPorts = exportPorts
    this.restorePorts = restorePorts
    this.suspend = suspend
    this.resume = resume
    this.appVersion = appVersion
    this.validatePorts = validatePorts
    this.planSigner = new ConfigurationPlanSigner()
  }

  available() {
    return Boolean(this.subscriptionStore && this.exportPorts && this.restorePorts)
  }

  async create(password) {
    if (!this.available()) throw new Error('当前运行模式不支持完整备份')
    let data, suspended = false, suspendToken
    try {
      if (this.suspend) { suspendToken = await this.suspend(); suspended = true }
      data = await this.currentConfiguration()
    } finally { if (suspended) await this.resume?.(suspendToken) }
    const payload = {
      format: 'ppm-recovery-data',
      version: 1,
      appVersion: this.appVersion,
      createdAt: Date.now(),
      data,
    }
    const recoveryPackage = await encryptRecoveryPayload(payload, password)
    return {
      recoveryPackage,
      summary: {
        subscriptions: payload.data.subscriptions.length,
        nodes: payload.data.subscriptions.reduce((sum, item) => sum + item.nodes.length, 0),
        ports: Object.keys(payload.data.ports.ports || {}).length,
      },
    }
  }

  async inspect(recoveryPackage, password) {
    const payload = await decryptRecoveryPayload(recoveryPackage, password)
    const validated = validatePayload(payload)
    return {
      payload,
      validated,
      summary: {
        appVersion: payload.appVersion || 'unknown',
        createdAt: payload.createdAt || null,
        subscriptions: validated.subscriptions.length,
        nodes: validated.subscriptions.reduce((sum, item) => sum + item.nodes.length, 0),
        ports: Object.keys(validated.ports.ports || {}).length,
      },
    }
  }

  async currentConfiguration() {
    return { subscriptions: this.subscriptionStore.exportRecovery(), ports: await this.exportPorts() }
  }

  async plan(recoveryPackage, password) {
    if (!this.available()) throw new Error('当前运行模式不支持完整恢复')
    const { validated, summary } = await this.inspect(recoveryPackage, password)
    let suspended = false, suspendToken
    try {
      if (this.suspend) { suspendToken = await this.suspend(); suspended = true }
      const previous = await this.currentConfiguration(), revision = configurationDigest(previous)
      const changes = configurationChanges(previous, validated), errors = []
      try { await this.validatePorts?.(validated.ports, validated.subscriptions) } catch (error) { errors.push(error.message) }
      const canApply = !errors.length && !changes.missingNodes.length
      return { ...summary, ...changes, errors, revision, canApply, ...(canApply ? this.planSigner.sign(revision, recoveryPackage) : { planToken: null, expiresAt: null }) }
    } finally { if (suspended) await this.resume?.(suspendToken) }
  }

  async restore(recoveryPackage, password, options = {}) {
    if (!this.available()) throw new Error('当前运行模式不支持完整恢复')
    const { validated, summary } = await this.inspect(recoveryPackage, password)
    let suspended = false, suspendToken
    try {
      if (this.suspend) { suspendToken = await this.suspend(); suspended = true }
      const previous = {
        subscriptions: this.subscriptionStore.exportRecovery(),
        ports: await this.exportPorts(),
      }
      if (options.requirePlan) {
        this.planSigner.verify(options.planToken, configurationDigest(previous), recoveryPackage)
        await this.validatePorts?.(validated.ports, validated.subscriptions)
        if (configurationChanges(previous, validated).missingNodes.length) throw new Error('恢复配置引用了缺失节点')
      }
      try {
        this.subscriptionStore.replaceRecovery(validated.subscriptions)
        const portResult = await this.restorePorts(validated.ports)
        return { ...summary, ...portResult }
      } catch (error) {
        const rollbackErrors = []
        try { this.subscriptionStore.replaceRecovery(previous.subscriptions) } catch (rollbackError) { rollbackErrors.push(`订阅回滚失败：${rollbackError.message}`) }
        try { await this.restorePorts(previous.ports) } catch (rollbackError) { rollbackErrors.push(`端口回滚失败：${rollbackError.message}`) }
        const suffix = rollbackErrors.length ? `；${rollbackErrors.join('；')}` : '；原配置已恢复'
        throw new Error(`恢复失败：${error.message}${suffix}`, { cause: error })
      }
    } finally {
      if (suspended) await this.resume?.(suspendToken)
    }
  }
}
