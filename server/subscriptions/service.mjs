import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { fetchSubscription } from './fetcher.mjs'
import { parseSubscription } from './parser.mjs'
import { redactText } from '../security/redaction.mjs'

function hash(content) { return createHash('sha256').update(content).digest('hex') }
function legacyNodeId(providerId, name) { return createHash('sha1').update(`${providerId}:${name}`).digest('hex').slice(0, 16) }

export class SubscriptionService {
  constructor({ store, mode = 'native', legacySource, fetchOptions = {} }) {
    this.store = store
    this.mode = mode
    this.legacySource = legacySource
    this.fetchOptions = fetchOptions
    this.refreshing = new Set()
    this.timer = null
    this.paused = false
    this.changeQueue = Promise.resolve()
    this.applyChange = change => change()
  }

  async initialize() {
    if (this.mode === 'hybrid' && !this.store.list().length && this.legacySource) await this.migrateLegacy(this.legacySource)
  }

  list() { return this.store.list() }
  getDefinitions(options) { return this.store.definitions(options) }
  nodeIds(id) { return this.store.nodeIds(id) }

  #change(operation, onFailure) {
    const run = async () => {
      try {
        return await this.applyChange(synchronize => this.store.transaction(async () => {
          const result = await operation()
          await synchronize?.()
          return result
        }))
      } catch (error) {
        // Failure bookkeeping is outside the rolled-back transaction.
        onFailure?.(error)
        throw error
      }
    }
    const result = this.changeQueue.then(run, run)
    this.changeQueue = result.catch(() => {})
    return result
  }

  async preview({ url, content }) {
    const payload = content || (await fetchSubscription(url, this.fetchOptions)).content
    const parsed = parseSubscription(payload, { subscriptionId: 'preview' })
    return { format: parsed.format, nodeCount: parsed.nodeCount, sample: parsed.nodes.slice(0, 8).map(node => ({ name: node.name, type: node.raw.type, server: node.raw.server })) }
  }

  async create({ name, url, content, enabled = true, priority = 0, refreshIntervalSeconds = 3600 }) {
    const cleanName = String(name || '').trim()
    if (!cleanName) throw new Error('订阅名称不能为空')
    if (!url && !content) throw new Error('需要提供订阅 URL 或 YAML 内容')
    const normalizedUrl = url ? String(url).trim() : null
    const record = { name: cleanName, sourceType: url ? 'url' : 'inline', url: normalizedUrl, enabled, priority: normalizePriority(priority), refreshIntervalSeconds: normalizeInterval(refreshIntervalSeconds) }
    let id
    return this.#change(async () => {
      const duplicate = normalizedUrl ? this.store.list({ secrets: true }).find(item => item.url === normalizedUrl) : null
      if (duplicate?.nodeCount) throw new Error(`该订阅地址已由“${duplicate.name}”导入`)
      id = duplicate?.id || this.store.insertSubscription(record)
      if (duplicate) this.store.update(id, record)
      if (content) this.#activate(id, content)
      else await this.#refresh(id)
      return this.store.get(id)
    }, error => {
      if (!id) return
      // Keep a retryable failed import, but never its rejected snapshot/nodes.
      if (!this.store.get(id)) this.store.insertSubscription({ ...record, id })
      this.store.recordFailure(id, error.message)
    })
  }

  async update(id, patch) {
    patch = { ...patch }
    if (patch.refreshIntervalSeconds !== undefined) patch.refreshIntervalSeconds = normalizeInterval(patch.refreshIntervalSeconds)
    if (patch.priority !== undefined) patch.priority = normalizePriority(patch.priority)
    if (patch.name !== undefined && !String(patch.name).trim()) throw new Error('订阅名称不能为空')
    return this.#change(async () => {
      if (!this.store.get(id)) throw new Error('订阅不存在')
      this.store.update(id, patch)
      if (patch.content) this.#activate(id, String(patch.content))
      else if (patch.url) await this.#refresh(id)
      return this.store.get(id)
    }, error => this.store.recordFailure(id, error.message))
  }

  async refresh(id) {
    if (this.refreshing.has(id)) throw new Error('该订阅正在刷新')
    this.refreshing.add(id)
    try {
      return await this.#change(() => this.#refresh(id), error => this.store.recordFailure(id, error.message))
    } finally { this.refreshing.delete(id) }
  }

  async #refresh(id) {
    const subscription = this.store.get(id, { secrets: true })
    if (!subscription) throw new Error('订阅不存在')
    if (!subscription.url) throw new Error('粘贴导入的订阅没有远程地址')
    const result = await fetchSubscription(subscription.url, { ...this.fetchOptions, etag: subscription.etag, lastModified: subscription.lastModified })
    if (result.notModified) this.store.recordNotModified(id, result)
    else this.#activate(id, result.content, result)
    return this.store.get(id)
  }

  async refreshAll() {
    const candidates = this.store.list().filter(item => item.enabled && item.sourceType === 'url')
    const results = await Promise.allSettled(candidates.map(item => this.refresh(item.id)))
    return results.map((result, index) => result.status === 'fulfilled'
      ? { id: candidates[index].id, ok: true, subscription: result.value }
      : { id: candidates[index].id, ok: false, error: redactText(result.reason.message) })
  }

  async remove(id, validate = async () => {}) {
    return this.#change(async () => {
      if (!this.store.get(id)) throw new Error('订阅不存在')
      await validate()
      this.store.delete(id)
    }, error => this.store.recordFailure(id, error.message))
  }

  #activate(id, content, metadata = {}) {
    const parsed = parseSubscription(content, { subscriptionId: id })
    return this.store.activate({ subscriptionId: id, content, contentHash: hash(content), format: parsed.format, nodes: parsed.nodes, etag: metadata.etag, lastModified: metadata.lastModified })
  }

  async migrateLegacy(source) {
    let info
    try { info = await stat(source) } catch { return { migrated: 0 } }
    if (info.isFile()) return { migrated: 0 }
    const profiles = YAML.parse(await readFile(path.join(source, 'profiles.yaml'), 'utf8')) || {}
    let migrated = 0
    const remotes = (profiles.items || []).filter(item => item.type === 'remote' && item.file)
    for (const [index, profile] of remotes.entries()) {
      try {
        const content = await readFile(path.join(source, 'profiles', profile.file), 'utf8')
        const id = String(profile.uid), url = profile.url ? String(profile.url) : null
        this.store.insertSubscription({ id, name: String(profile.name || profile.uid), sourceType: url ? 'url' : 'legacy', url, priority: (remotes.length - index) * 10, refreshIntervalSeconds: 3600 })
        const parsed = parseSubscription(content, { subscriptionId: id })
        this.store.activate({
          subscriptionId: id, content, contentHash: hash(content), format: parsed.format, nodes: parsed.nodes,
          preferredId: node => legacyNodeId(id, node.name),
        })
        migrated += 1
      } catch (error) {
        const existing = this.store.get(String(profile.uid))
        if (existing) this.store.recordFailure(existing.id, `旧订阅迁移失败：${error.message}`)
      }
    }
    return { migrated }
  }

  startScheduler(intervalMs = 30000) {
    if (this.timer) return
    this.paused = false
    const tick = () => {
      const timestamp = Date.now()
      for (const item of this.store.list()) {
        if (!item.enabled || item.sourceType !== 'url' || this.refreshing.has(item.id)) continue
        const base = item.lastAttemptAt || item.lastSuccessAt || item.createdAt
        if (timestamp - base >= item.refreshIntervalSeconds * 1000) {
          const operation = async () => {
            try {
              const subscription = await this.refresh(item.id)
              await this.onScheduledRefresh?.({ ok: true, subscription })
            } catch (error) { await this.onScheduledRefresh?.({ ok: false, subscription: item, error }) }
          }
          // Include the core reload in the lease, not just the download.
          Promise.resolve(this.runScheduledRefresh ? this.runScheduledRefresh(operation) : operation()).catch(error => {
            if (error.code !== 'RECOVERY_IN_PROGRESS') console.error('subscription scheduler operation failed')
          })
        }
      }
    }
    this.timer = setInterval(tick, intervalMs)
    this.timer.unref?.()
  }

  stopScheduler({ paused = false } = {}) { if (this.timer) clearInterval(this.timer); this.timer = null; this.paused = paused }

  schedulerStatus() {
    return {
      running: Boolean(this.timer),
      paused: this.paused,
      refreshing: this.refreshing.size,
      refreshingIds: [...this.refreshing],
      scheduledSubscriptions: this.store.list().filter(item => item.enabled && item.sourceType === 'url').length,
    }
  }
}

function normalizeInterval(value) {
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric < 60 || numeric > 604800) throw new Error('刷新周期必须是 60–604800 秒')
  return numeric
}

function normalizePriority(value) {
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric < -10000 || numeric > 10000) throw new Error('优先级必须是 -10000–10000 的整数')
  return numeric
}
