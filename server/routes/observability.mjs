import { apiError } from '../http/responses.mjs'
import { recordAudit } from '../audit/record.mjs'

export function registerObservationRoutes(app, { service, store, auditStore, mutationGate }) {
  const handle = operation => async (req, res) => {
    try { await operation(req, res) }
    catch (error) {
      if (error.status === 429) res.set('Retry-After', String(Math.max(1, Math.ceil((service.nextAllowedAt - Date.now()) / 1000))))
      apiError(req, res, { status: error.status || 400, code: error.code || 'OBSERVATION_FAILED', message: '可观测性操作失败', error })
    }
  }
  app.get('/api/observability', handle(async (_req, res) => res.set('Cache-Control', 'no-store').json(await service.snapshot())))
  app.get('/api/observability/status', handle(async (_req, res) => res.set('Cache-Control', 'no-store').json(service.status())))
  app.patch('/api/observability/settings', mutationGate.mutation(handle(async (req, res) => {
    const result = service.settings(req.body)
    recordAudit(auditStore, req, { action: 'observation.settings', message: '已更新后台检测设置', metadata: result.settings })
    res.set('Cache-Control', 'no-store').json(result)
  })))
  app.post('/api/observability/nodes/test', handle(async (req, res) => {
    res.status(202).set('Cache-Control', 'no-store').json(await service.startNodes(req.body?.nodeIds))
  }))
  app.post('/api/observability/cancel', handle(async (_req, res) => res.json(service.cancel())))
  app.get('/api/observability/history', handle(async (req, res) => {
    const kind = req.query.kind || 'port', targetId = req.query.targetId
    if (targetId !== undefined && (typeof targetId !== 'string' || targetId.length > 128)) throw new Error('检测目标无效')
    res.set('Cache-Control', 'no-store').json({ ...store.history({ kind, targetId, before: req.query.before, limit: req.query.limit }), summary: store.summary(kind, targetId) })
  }))
}
