import os from 'node:os'
import { apiError } from '../http/responses.mjs'

export function registerHealthRoute(app) {
  app.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()) })
  })
}

export function registerRuntimeRoute(app, { startedAt, appVersion = 'unknown', buildInfo = null, embeddedCore, embeddedCoreStatus, loadLiveCatalog } = {}) {
  app.get('/api/runtime', async (req, res) => {
    try {
      const catalog = await loadLiveCatalog(), core = embeddedCore ? await embeddedCoreStatus() : { enabled: false }
      res.set('Cache-Control', 'no-store').json({ appVersion, buildInfo, startedAt, processUptimeSeconds: Math.floor(process.uptime()), systemUptimeSeconds: Math.floor(os.uptime()), totalNodes: catalog.nodes.length, providerCount: catalog.providers.length, countryCount: catalog.countries.length, hostname: os.hostname(), platform: `${os.platform()} ${os.release()}`, core })
    } catch (error) { apiError(req, res, { status: 500, code: 'RUNTIME_READ_FAILED', message: '运行状态读取失败', error }) }
  })
}
