import { randomUUID } from 'node:crypto'
import { OBSERVABILITY_LIMITS, observationState } from '../../shared/observability.js'
import { redactText } from '../security/redaction.mjs'
import { ObservationError } from './controller.mjs'

export class ObservationService {
  constructor({ store, controller, loadCatalog, verifyPool, probeHost, auditStore, mutationGate, enabled = true, clock = Date.now }) {
    Object.assign(this, { store, controller, loadCatalog, verifyPool, probeHost, auditStore, mutationGate, enabled, clock })
    this.active = null
    this.pending = null
    this.timer = null
    this.stopping = false
    this.nextRunAt = clock() + store.settings.intervalSeconds * 1000
    this.nextAllowedAt = store.meta('nextAllowedAt') || 0
    this.nodeOffset = 0
    this.portOffset = 0
    this.snapshotCache = null
  }
  status() {
    return { supported: this.enabled, settings: { ...this.store.settings }, limits: OBSERVABILITY_LIMITS,
      job: this.active || this.store.meta('job'), nextRunAt: this.store.settings.enabled && this.enabled ? this.nextRunAt : null,
      nextAllowedAt: this.nextAllowedAt, running: Boolean(this.active), schedulerRunning: Boolean(this.timer) }
  }
  settings(patch) {
    if (patch?.enabled && !this.enabled) throw new ObservationError('此部署不支持后台检测', 501)
    const settings = this.store.updateSettings(patch)
    this.nextRunAt = this.clock() + settings.intervalSeconds * 1000
    if (!settings.enabled && this.active?.source === 'scheduler') this.cancel()
    this.snapshotCache = null
    return this.status()
  }
  assertAvailable() {
    if (!this.enabled) throw new ObservationError('节点检测仅支持内置 Mihomo 模式', 501, 'OBSERVATION_UNSUPPORTED')
    if (this.stopping || this.active) throw new ObservationError('已有检测正在执行，请等待完成或取消', 409, 'OBSERVATION_BUSY')
    if (this.clock() < this.nextAllowedAt) throw new ObservationError('检测冷却中，请稍后重试', 429, 'OBSERVATION_COOLDOWN')
  }
  async snapshot() {
    if (this.snapshotCache && this.clock() - this.snapshotCache.at < 2000) return this.snapshotCache.promise
    const promise = this.readSnapshot()
    this.snapshotCache = { at: this.clock(), promise }
    try { return await promise } catch (error) { this.snapshotCache = null; throw error }
  }
  async readSnapshot() {
    const catalog = await this.loadCatalog()
    let proxies = {}, reachable = false, error = null
    if (this.enabled) {
      try { proxies = await this.controller.proxies(); reachable = true }
      catch (cause) { error = redactText(cause.message) }
    }
    const persisted = new Map(this.store.latest('node').map(row => [row.targetId, row]))
    const staleMs = Math.max(600000, this.store.settings.intervalSeconds * 2000)
    const nodes = catalog.nodes.map(node => {
      const detail = proxies[`ppm-node-${node.id}`]
      const history = Array.isArray(detail?.history) ? detail.history.at(-1) : null
      const coreAt = Date.parse(history?.time) || null, saved = persisted.get(node.id)
      const useSaved = saved && saved.checkedAt >= (coreAt || 0)
      const checkedAt = useSaved ? saved.checkedAt : coreAt
      const healthy = useSaved ? saved.successes === saved.attempts : coreAt ? detail.alive !== false && Number(history.delay) > 0 : null
      return { id: node.id, loaded: Boolean(detail), healthy, checkedAt,
        delay: useSaved ? saved.latencyMs : coreAt && healthy ? Number(history.delay) : null,
        state: (!reachable || !detail) && checkedAt ? 'stale' : observationState({ healthy, checkedAt }, this.clock(), staleMs) }
    })
    const names = new Map(catalog.nodes.map(node => [node.id, node.name]))
    const ports = (catalog.listeners || []).filter(port => !port.isGlobal).map(port => {
      const group = proxies[`PPM-${port.port}`], now = String(group?.now || '')
      const activeNodeId = now.startsWith('ppm-node-') ? now.slice(9) : null
      return { port: port.port, enabled: port.enabled, strategy: port.strategy, reachable: Boolean(group),
        activeNodeId, activeNodeName: names.get(activeNodeId) || null,
        ...this.store.summary('port', String(port.port), this.clock()) }
    })
    return { ...this.status(), reachable, error, checkedAt: this.clock(), nodes, ports,
      summary: this.store.summary('port', null, this.clock()) }
  }
  async startNodes(nodeIds) {
    this.assertAvailable()
    if (!Array.isArray(nodeIds) || !nodeIds.length || nodeIds.length > OBSERVABILITY_LIMITS.nodeBatch || nodeIds.some(id => typeof id !== 'string')) throw new ObservationError('请选择 1–100 个节点')
    const catalog = await this.loadCatalog(), available = new Set(catalog.nodes.map(node => node.id))
    if (nodeIds.some(id => !available.has(id))) throw new ObservationError('检测列表包含已删除或停用的节点')
    return this.launch('nodes', 'manual', [...new Set(nodeIds)], [], this.store.settings.attempts)
  }
  async verifyPort(port, attempts = 8) {
    this.assertAvailable()
    if (!Number.isInteger(attempts) || attempts < 2 || attempts > 20) throw new ObservationError('验证次数必须是 2–20 的整数')
    const catalog = await this.loadCatalog(), listener = (catalog.listeners || []).find(item => item.port === Number(port) && !item.isGlobal)
    if (!listener) throw new ObservationError('端口池不存在', 404, 'PORT_POOL_NOT_FOUND')
    if (listener.enabled === false) throw new ObservationError('停用的端口池不能验证')
    this.launch('ports', 'manual', [], [listener], attempts)
    const result = await this.pending
    if (result.error) throw new ObservationError(result.error, 502)
    return result.portResults[0]
  }
  launch(kind, source, nodeIds, ports, attempts) {
    this.assertAvailable()
    const settings = { ...this.store.settings }
    this.abort = new AbortController()
    const signal = this.abort.signal
    const job = { id: randomUUID(), kind, source, status: 'running', total: nodeIds.length + ports.length,
      completed: 0, failures: 0, startedAt: this.clock(), finishedAt: null }
    this.store.setMeta('job', job)
    this.nextAllowedAt = this.clock() + OBSERVABILITY_LIMITS.cooldownMs
    this.store.setMeta('nextAllowedAt', this.nextAllowedAt)
    this.active = job
    const progress = failed => {
      job.completed++; if (failed) job.failures++
      this.store.setMeta('job', job)
      this.snapshotCache = null
    }
    const work = async () => {
      let cursor = 0
      const workers = await Promise.allSettled(Array.from({ length: Math.min(settings.concurrency, nodeIds.length) }, async () => {
        while (cursor < nodeIds.length && !signal.aborted) {
          const id = nodeIds[cursor++]
          let delay = null, error = null
          try { delay = await this.controller.delay(id, { timeoutMs: settings.timeoutMs, signal }) }
          catch (cause) { error = redactText(cause.message).slice(0, 512) }
          if (signal.aborted) break
          this.store.record({ kind: 'node', targetId: id, successes: error ? 0 : 1, latencyMs: delay, error, source })
          progress(Boolean(error))
        }
      }))
      const failedWorker = workers.find(result => result.status === 'rejected')
      if (failedWorker) throw failedWorker.reason
      const portResults = []
      for (const port of ports) {
        signal.throwIfAborted()
        const result = await this.verifyPool({ host: this.probeHost, port: port.port, protocol: port.protocol, attempts, timeoutMs: settings.timeoutMs, signal })
        signal.throwIfAborted()
        const successful = result.samples.filter(sample => sample.ok)
        this.store.record({ kind: 'port', targetId: String(port.port), attempts: result.attempts, successes: result.successes,
          latencyMs: successful.length ? successful.reduce((sum, sample) => sum + sample.latencyMs, 0) / successful.length : null,
          distribution: result.distribution, uniqueExitCount: result.uniqueExitCount, source,
          configuration: { protocol: port.protocol, strategy: port.strategy, nodeIds: port.nodeIds },
          errors: result.samples.filter(sample => !sample.ok).map(sample => redactText(sample.error).slice(0, 512)) })
        portResults.push(result)
        progress(result.failures > 0)
      }
      signal.throwIfAborted()
      return { portResults }
    }
    // The lease outlives the HTTP 202 response, so recovery cannot race a batch.
    this.pending = this.mutationGate.runMutation(work).then(result => {
      job.status = 'completed'
      return result
    }, cause => {
      job.status = signal.aborted ? 'cancelled' : 'failed'
      job.error = signal.aborted ? '检测已取消，未完成样本不计入失败' : redactText(cause.message)
      return { error: job.error, portResults: [] }
    }).finally(() => {
      job.finishedAt = this.clock()
      this.store.setMeta('job', job)
      this.nextAllowedAt = this.clock() + OBSERVABILITY_LIMITS.cooldownMs
      this.store.setMeta('nextAllowedAt', this.nextAllowedAt)
      this.nextRunAt = this.clock() + this.store.settings.intervalSeconds * 1000
      this.active = null
      this.snapshotCache = null
      this.auditStore?.record({ actor: source === 'scheduler' ? 'scheduler' : 'local', action: 'observation.run',
        outcome: job.failures || job.status === 'failed' ? 'failure' : 'success', targetType: 'observation', targetId: job.id,
        message: `检测${job.status === 'completed' ? '完成' : '结束'}：${job.completed}/${job.total}，异常 ${job.failures}`, metadata: job })
    }).catch(error => {
      // Background jobs must never leave an unhandled rejection on a full disk.
      this.active = null
      console.error('检测结果持久化失败：', redactText(error.message))
      return { error: '检测结果持久化失败，请检查磁盘和数据库', portResults: [] }
    })
    return { ...job }
  }
  cancel() { if (this.active) this.abort.abort(); return this.status() }
  async tick() {
    this.store.prune(this.clock())
    if (!this.enabled || !this.store.settings.enabled || this.active || this.stopping || this.clock() < Math.max(this.nextRunAt, this.nextAllowedAt)) return
    this.nextRunAt = this.clock() + this.store.settings.intervalSeconds * 1000
    try {
      const catalog = await this.loadCatalog()
      if (!this.store.settings.enabled || this.stopping) return
      const rotate = (items, offset, count) => items.length ? Array.from({ length: Math.min(items.length, count) }, (_, i) => items[(offset + i) % items.length]) : []
      const nodes = rotate(catalog.nodes, this.nodeOffset, OBSERVABILITY_LIMITS.nodeBatch)
      const ports = rotate((catalog.listeners || []).filter(item => !item.isGlobal && item.enabled !== false), this.portOffset, OBSERVABILITY_LIMITS.scheduledPorts)
      this.nodeOffset += nodes.length; this.portOffset += ports.length
      if (nodes.length || ports.length) this.launch('scheduled', 'scheduler', nodes.map(node => node.id), ports, this.store.settings.attempts)
    } catch (error) {
      this.auditStore?.record({ actor: 'scheduler', action: 'observation.schedule', outcome: 'failure', message: `定时检测未启动：${redactText(error.message)}` })
    }
  }
  start() {
    if (this.timer) return
    this.stopping = false
    this.timer = setInterval(() => {
      if (!this.ticking) this.ticking = this.tick().catch(() => {}).finally(() => { this.ticking = null })
    }, 30000)
    this.timer.unref?.()
  }
  async stop() {
    this.stopping = true
    clearInterval(this.timer); this.timer = null
    this.cancel()
    await this.ticking
    await this.pending
  }
}
