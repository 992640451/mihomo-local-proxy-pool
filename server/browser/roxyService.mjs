import { randomUUID } from 'node:crypto'
import { RoxyClient } from './roxyClient.mjs'

function roxyError(message, code = 'ROXY_INTEGRATION_FAILED', status = 400) {
  return Object.assign(new Error(message), { code, status })
}
function delay(ms, signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

export class RoxyIntegrationService {
  constructor({ store, host, fetchImpl, loadCatalog, proxySessionStore, startSession, endSession, getSession, monitorIntervalMs = 1000 } = {}) {
    this.store = store
    this.host = host
    this.fetchImpl = fetchImpl
    this.loadCatalog = loadCatalog
    this.proxySessionStore = proxySessionStore
    this.startSession = startSession
    this.endSession = endSession
    this.getSession = getSession
    this.monitorIntervalMs = monitorIntervalMs
    this.monitors = new Map()
    this.stopping = false
  }

  publicConfig() {
    const config = this.store.config()
    return { ...config, hostMode: this.host === '127.0.0.1' ? 'local' : 'docker-host', bindingCount: this.store.bindings().length }
  }

  client(override = {}) {
    const config = this.store.config({ secrets: true })
    const apiPort = override.apiPort ?? config.apiPort
    const apiKey = override.apiKey === undefined ? config.apiKey : override.apiKey
    if (!apiKey) throw roxyError('请先在系统设置中配置 Roxy API Key', 'ROXY_NOT_CONFIGURED')
    return new RoxyClient({ host: this.host, port: apiPort, token: apiKey, fetchImpl: this.fetchImpl })
  }

  async connect({ apiPort, apiKey } = {}) {
    const numericPort = Number(apiPort ?? this.store.config().apiPort)
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) throw roxyError('Roxy API 端口必须是 1–65535 的整数', 'INVALID_ROXY_PORT')
    const current = this.store.config({ secrets: true })
    const key = apiKey === undefined || apiKey === '' ? current.apiKey : String(apiKey).trim()
    if (!key) throw roxyError('请填写 Roxy API Key', 'ROXY_API_KEY_REQUIRED')
    const workspaces = await this.client({ apiPort: numericPort, apiKey: key }).listWorkspaces()
    const config = this.store.saveConfig({ apiPort: numericPort, apiKey: key })
    return { config: this.publicConfig(), workspaces }
  }

  async workspaces() { return { items: await this.client().listWorkspaces() } }

  async windows({ workspaceId, projectId = '' }) {
    if (!workspaceId) throw roxyError('请选择 Roxy 团队', 'ROXY_WORKSPACE_REQUIRED')
    return { items: await this.client().listWindows({ workspaceId, projectId }) }
  }

  binding(port) {
    const binding = this.store.binding(port)
    const run = this.monitors.get(Number(port))?.publicState || null
    return { configured: this.store.config().configured, binding, run }
  }

  async saveBinding(port, input) {
    const listener = await this.#sessionListener(port)
    if (this.proxySessionStore?.current(Number(port))) throw roxyError('端口正在使用中，请先关闭浏览器并结束会话', 'PROXY_SESSION_CONFLICT', 409)
    const candidate = {
      workspaceId: input?.workspaceId, projectId: input?.projectId, dirId: input?.dirId,
      windowName: input?.windowName, windowSortNum: input?.windowSortNum, syncProxy: input?.syncProxy,
    }
    if (input?.manual === true) return this.store.saveBinding(listener.port, candidate)
    const windows = await this.client().listWindows(candidate)
    const selected = windows.find(item => item.dirId === String(candidate.dirId || ''))
    if (!selected) throw roxyError('所选 Roxy 窗口已不存在，请重新读取窗口列表', 'ROXY_WINDOW_NOT_FOUND', 404)
    return this.store.saveBinding(listener.port, { ...candidate, ...selected, projectId: candidate.projectId || selected.projectId })
  }

  async deleteBinding(port) {
    if (this.proxySessionStore?.current(Number(port))) throw roxyError('端口正在使用中，不能解除浏览器绑定', 'PROXY_SESSION_CONFLICT', 409)
    return { port: Number(port), removed: this.store.deleteBinding(port) }
  }

  async start(port) {
    const numericPort = Number(port), listener = await this.#sessionListener(numericPort), binding = this.store.binding(numericPort)
    if (!binding) throw roxyError('此端口尚未绑定 Roxy 窗口', 'ROXY_BINDING_NOT_FOUND', 404)
    const client = this.client(), profileId = `roxy:${binding.workspaceId}:${binding.dirId}`
    const current = await this.getSession(numericPort)
    if (current.session) {
      if (current.state === 'active' && current.session.profileId === profileId && await client.running(binding.dirId)) {
        this.#monitor(binding, current.session.sessionId, true)
        return { ...current, browser: { state: 'running', binding } }
      }
      throw roxyError('此端口有未结束的会话，请确认旧浏览器已经关闭', 'PROXY_SESSION_CONFLICT', 409)
    }
    if (await client.running(binding.dirId)) throw roxyError('所选 Roxy 窗口已经打开，请先关闭后从管理页面启动', 'ROXY_WINDOW_RUNNING', 409)

    const session = await this.startSession(numericPort, { launchId: randomUUID(), profileId })
    let opened = false
    try {
      if (binding.syncProxy) await client.setProxy(binding, { port: numericPort, protocol: listener.protocol })
      await client.open(binding)
      opened = true
      this.#monitor(binding, session.session.sessionId, true)
      return { ...session, browser: { state: 'running', binding } }
    } catch (error) {
      if (!opened) {
        let running = false, known = false
        try { running = await client.running(binding.dirId); known = true } catch {}
        if (known && !running) await this.endSession(numericPort, session.session.sessionId).catch(() => {})
        if (running) this.#monitor(binding, session.session.sessionId, true)
      }
      throw error
    }
  }

  async resume() {
    this.stopping = false
    if (!this.store.config().configured) return
    for (const session of this.proxySessionStore?.openSessions?.() || []) {
      const binding = this.store.binding(session.port)
      if (binding && session.profileId === `roxy:${binding.workspaceId}:${binding.dirId}` && ['active', 'recovery-required'].includes(session.state)) {
        this.#monitor(binding, session.sessionId, false)
      }
    }
  }

  async stop() {
    this.stopping = true
    const tasks = []
    for (const monitor of this.monitors.values()) { monitor.controller.abort(); tasks.push(monitor.task) }
    await Promise.allSettled(tasks)
    this.monitors.clear()
  }

  #monitor(binding, sessionId, observed) {
    const port = Number(binding.port), existing = this.monitors.get(port)
    if (existing?.sessionId === sessionId) return
    existing?.controller.abort()
    const controller = new AbortController()
    const monitor = { sessionId, controller, publicState: { state: observed ? 'running' : 'checking', sessionId, lastCheckedAt: Date.now(), error: null }, task: null }
    this.monitors.set(port, monitor)
    monitor.task = (async () => {
      let hasObserved = observed, absent = 0
      while (!controller.signal.aborted && !this.stopping) {
        await delay(this.monitorIntervalMs, controller.signal)
        if (controller.signal.aborted || this.stopping) break
        try {
          const running = await this.client().running(binding.dirId)
          monitor.publicState = { state: running ? 'running' : 'checking', sessionId, lastCheckedAt: Date.now(), error: null }
          if (running) { hasObserved = true; absent = 0; continue }
          absent++
          if ((hasObserved && absent >= 2) || (!hasObserved && absent >= 3)) {
            await this.endSession(port, sessionId)
            monitor.publicState = { state: 'ended', sessionId, lastCheckedAt: Date.now(), error: null }
            break
          }
        } catch (error) {
          absent = 0
          monitor.publicState = { state: 'attention', sessionId, lastCheckedAt: Date.now(), error: error.message }
          await delay(4000, controller.signal)
        }
      }
    })().finally(() => {
      const active = this.monitors.get(port)
      if (active === monitor && monitor.publicState.state === 'ended') this.monitors.delete(port)
    })
  }

  async #sessionListener(port) {
    const numericPort = Number(port)
    if (!Number.isInteger(numericPort) || numericPort < 1024 || numericPort > 65535) throw roxyError('代理端口无效', 'INVALID_PORT')
    const catalog = await this.loadCatalog()
    const listener = (catalog.listeners || []).find(item => Number(item.port) === numericPort)
    if (!listener || listener.isGlobal) throw roxyError('代理端口不存在', 'PORT_POOL_NOT_FOUND', 404)
    if (listener.strategy !== 'session-round-robin' || listener.enabled === false) throw roxyError('只有已启用的“会话轮换”端口可以绑定浏览器', 'ROXY_BINDING_UNSUPPORTED', 409)
    return listener
  }
}
