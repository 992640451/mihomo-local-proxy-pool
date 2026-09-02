import { recordAudit } from '../audit/record.mjs'
import { apiError } from '../http/responses.mjs'

function timestampName(prefix, suffix = 'json') {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.${suffix}`
}

export function registerReliabilityRoutes(app, { recoveryService, diagnosticService, auditStore, mutationGate } = {}) {
  app.get('/api/diagnostics', async (req, res) => {
    try { res.set('Cache-Control', 'no-store').json(await diagnosticService.run()) }
    catch (error) { apiError(req, res, { status: 500, code: 'DIAGNOSTICS_FAILED', message: '系统诊断失败', error }) }
  })

  app.get('/api/diagnostics/export', async (req, res) => {
    const started = Date.now()
    try {
      const result = await diagnosticService.export()
      recordAudit(auditStore, req, { action: 'diagnostics.export', targetType: 'diagnostics', message: '已导出脱敏诊断数据', durationMs: Date.now() - started })
      res.set({ 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${timestampName('ppm-diagnostics')}"` }).json(result)
    } catch (error) {
      recordAudit(auditStore, req, { action: 'diagnostics.export', outcome: 'failure', targetType: 'diagnostics', message: `诊断数据导出失败：${error.message}`, durationMs: Date.now() - started })
      apiError(req, res, { status: 500, code: 'DIAGNOSTICS_EXPORT_FAILED', message: '诊断数据导出失败', error })
    }
  })

  app.post('/api/recovery/export', mutationGate.mutation(async (req, res) => {
    const started = Date.now()
    try {
      const result = await recoveryService.create(req.body?.password)
      recordAudit(auditStore, req, { action: 'recovery.export', targetType: 'recovery', message: '已创建加密恢复包', durationMs: Date.now() - started, metadata: result.summary })
      res.set({ 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${timestampName('ppm-recovery')}"` }).json({ ...result.recoveryPackage, summary: result.summary })
    } catch (error) {
      recordAudit(auditStore, req, { action: 'recovery.export', outcome: 'failure', targetType: 'recovery', message: `恢复包创建失败：${error.message}`, durationMs: Date.now() - started })
      apiError(req, res, { status: 400, code: 'RECOVERY_EXPORT_FAILED', message: '恢复包创建失败', error })
    }
  }))

  app.post('/api/recovery/inspect', async (req, res) => {
    try {
      const result = await recoveryService.inspect(req.body?.recoveryPackage, req.body?.password)
      res.set('Cache-Control', 'no-store').json(result.summary)
    } catch (error) { apiError(req, res, { status: 400, code: 'RECOVERY_INSPECT_FAILED', message: '恢复包校验失败', error }) }
  })

  app.post('/api/recovery/restore', mutationGate.restore(async (req, res) => {
    const started = Date.now()
    try {
      const result = await recoveryService.restore(req.body?.recoveryPackage, req.body?.password)
      recordAudit(auditStore, req, { action: 'recovery.restore', targetType: 'recovery', message: '已恢复订阅和端口配置', durationMs: Date.now() - started, metadata: result })
      res.set('Cache-Control', 'no-store').json(result)
    } catch (error) {
      recordAudit(auditStore, req, { action: 'recovery.restore', outcome: 'failure', targetType: 'recovery', message: `恢复失败：${error.message}`, durationMs: Date.now() - started })
      apiError(req, res, { status: 400, code: 'RECOVERY_RESTORE_FAILED', message: '恢复失败', error })
    }
  }))
}
