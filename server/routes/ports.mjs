import net from 'node:net'
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
} = {}) {
  app.put('/api/ports/:port', async (req, res) => {
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
      res.set('Cache-Control', 'no-store').json(result)
    } catch (error) { apiError(req, res, { status: 400, code: 'PORT_APPLY_FAILED', message: '端口配置应用失败', error }) }
  })

  app.delete('/api/ports/:port', async (req, res) => {
    try {
      const deletePort = embeddedCore ? deleteEmbeddedPort : deleteMihomoPort
      const result = await deletePort({ source: defaultConfigDir(), port: req.params.port, ...coreOptions })
      res.set('Cache-Control', 'no-store').json(result)
    } catch (error) { apiError(req, res, { status: 400, code: 'PORT_DELETE_FAILED', message: '端口配置删除失败', error }) }
  })

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

  app.post('/api/ports/:port/verify', async (req, res) => {
    const port = Number(req.params.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return apiError(req, res, { status: 400, code: 'INVALID_PORT', message: '端口无效' })
    try {
      const catalog = await loadLiveCatalog()
      const listener = (catalog.listeners || []).find(item => Number(item.port) === port)
      if (!listener || listener.isGlobal) return apiError(req, res, { status: 404, code: 'PORT_POOL_NOT_FOUND', message: '端口池不存在' })
      const result = await verifyProxyPool({ host: probeHost, port, attempts: req.body?.attempts ?? 8 })
      res.set('Cache-Control', 'no-store').json(result)
    } catch (error) { apiError(req, res, { status: 400, code: 'PORT_VERIFY_FAILED', message: '代理池验证失败', error }) }
  })
}
