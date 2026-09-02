import net from 'node:net'
import { recordAudit } from '../audit/record.mjs'
import { apiError } from '../http/responses.mjs'

export function registerPortRoutes(app, {
  probeHost,
  embeddedCore,
  coreOptions,
  defaultConfigDir,
  loadLiveCatalog,
  applyEmbeddedPort,
  applyMihomoPort,
  deleteEmbeddedPort,
  deleteMihomoPort,
  embeddedPortStatus,
  probeProxyEgress,
  verifyProxyPool,
  auditStore,
  mutationGate,
} = {}) {
  app.put('/api/ports/:port', mutationGate.mutation(async (req, res) => {
    try {
      const applyPort = embeddedCore ? applyEmbeddedPort : applyMihomoPort
      const result = await applyPort({
        source: defaultConfigDir(),
        port: req.params.port,
        nodeId: String(req.body?.nodeId || ''),
        nodeIds: Array.isArray(req.body?.nodeIds) ? req.body.nodeIds.map(value => String(value || '')) : undefined,
        strategy: req.body?.strategy === undefined ? undefined : String(req.body.strategy),
        strategyOptions: req.body?.strategyOptions,
        protocol: String(req.body?.protocol || 'Mixed'),
        enabled: req.body?.enabled !== false,
        ...coreOptions,
      })
      recordAudit(auditStore, req, { action: 'port.apply', targetType: 'port', targetId: req.params.port, message: `已应用端口 ${req.params.port} 配置`, metadata: { strategy: result.strategy, protocol: result.protocol, nodeCount: result.nodeIds?.length || 0, enabled: result.enabled } })
      res.set('Cache-Control', 'no-store').json(result)
    } catch (error) {
      recordAudit(auditStore, req, { action: 'port.apply', outcome: 'failure', targetType: 'port', targetId: req.params.port, message: `端口配置应用失败：${error.message}` })
      apiError(req, res, { status: 400, code: 'PORT_APPLY_FAILED', message: '端口配置应用失败', error })
    }
  }))

  app.delete('/api/ports/:port', mutationGate.mutation(async (req, res) => {
    try {
      const deletePort = embeddedCore ? deleteEmbeddedPort : deleteMihomoPort
      const result = await deletePort({ source: defaultConfigDir(), port: req.params.port, ...coreOptions })
      recordAudit(auditStore, req, { action: 'port.delete', targetType: 'port', targetId: req.params.port, message: result.removed ? `已删除端口 ${req.params.port}` : `端口 ${req.params.port} 不存在`, metadata: { removed: result.removed } })
      res.set('Cache-Control', 'no-store').json(result)
    } catch (error) {
      recordAudit(auditStore, req, { action: 'port.delete', outcome: 'failure', targetType: 'port', targetId: req.params.port, message: `端口配置删除失败：${error.message}` })
      apiError(req, res, { status: 400, code: 'PORT_DELETE_FAILED', message: '端口配置删除失败', error })
    }
  }))

  app.get('/api/ports/:port/status', async (req, res) => {
    if (!embeddedCore) return apiError(req, res, { status: 501, code: 'PORT_STATUS_UNSUPPORTED', message: '当前 Mihomo 运行模式不支持策略组状态查询' })
    try { res.set('Cache-Control', 'no-store').json(await embeddedPortStatus(defaultConfigDir(), req.params.port, coreOptions)) }
    catch (error) { apiError(req, res, { status: 502, code: 'PORT_STATUS_FAILED', message: '策略组状态读取失败', error }) }
  })

  app.get('/api/ports/:port/test', async (req, res) => {
    const port = Number(req.params.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return apiError(req, res, { status: 400, code: 'INVALID_PORT', message: '端口无效' })
    let listener = null
    try {
      const catalog = await loadLiveCatalog()
      listener = (catalog.listeners || []).find(item => Number(item.port) === port) || null
    } catch {}
    const started = Date.now(), socket = net.createConnection({ host: probeHost, port })
    let finished = false
    const done = open => { if (finished) return; finished = true; socket.destroy(); res.json({ host: probeHost, port, open, latencyMs: Date.now() - started, proxy: listener?.routeName || null, listenerName: listener?.listenerName || null }) }
    socket.setTimeout(1500)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })

  app.get('/api/ports/:port/egress', async (req, res) => {
    const port = Number(req.params.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return apiError(req, res, { status: 400, code: 'INVALID_PORT', message: '端口无效' })
    try {
      const catalog = await loadLiveCatalog()
      const listener = (catalog.listeners || []).find(item => Number(item.port) === port)
      if (!listener?.isGlobal) return apiError(req, res, { status: 400, code: 'EGRESS_UNSUPPORTED', message: '仅全局动态路由支持出口国家检测' })
      res.set('Cache-Control', 'no-store').json({ port, ...(await probeProxyEgress({ host: probeHost, port })) })
    } catch (error) { apiError(req, res, { status: 502, code: 'EGRESS_PROBE_FAILED', message: '出口国家检测失败', error }) }
  })

  app.post('/api/ports/:port/verify', mutationGate.mutation(async (req, res) => {
    const port = Number(req.params.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return apiError(req, res, { status: 400, code: 'INVALID_PORT', message: '端口无效' })
    try {
      const catalog = await loadLiveCatalog()
      const listener = (catalog.listeners || []).find(item => Number(item.port) === port)
      if (!listener || listener.isGlobal) return apiError(req, res, { status: 404, code: 'PORT_POOL_NOT_FOUND', message: '端口池不存在' })
      const result = await verifyProxyPool({ host: probeHost, port, attempts: req.body?.attempts ?? 8 })
      recordAudit(auditStore, req, { action: 'port.verify', targetType: 'port', targetId: req.params.port, message: `端口 ${port} 验证完成：${result.successes}/${result.attempts} 成功`, metadata: { attempts: result.attempts, successes: result.successes, failures: result.failures, uniqueExitCount: result.uniqueExitCount } })
      res.set('Cache-Control', 'no-store').json(result)
    } catch (error) {
      recordAudit(auditStore, req, { action: 'port.verify', outcome: 'failure', targetType: 'port', targetId: req.params.port, message: `代理池验证失败：${error.message}` })
      apiError(req, res, { status: 400, code: 'PORT_VERIFY_FAILED', message: '代理池验证失败', error })
    }
  }))
}
