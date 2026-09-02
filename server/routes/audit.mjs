import { recordAudit } from '../audit/record.mjs'
import { apiError } from '../http/responses.mjs'

export function registerAuditRoutes(app, { auditStore, mutationGate } = {}) {
  app.get('/api/audit', (req, res) => {
    try {
      res.set('Cache-Control', 'no-store').json(auditStore.list({
        before: req.query.before,
        limit: req.query.limit,
        outcome: req.query.outcome,
        action: req.query.action,
      }))
    } catch (error) { apiError(req, res, { status: 400, code: 'AUDIT_READ_FAILED', message: '操作记录读取失败', error }) }
  })

  app.delete('/api/audit', mutationGate.mutation((req, res) => {
    try {
      const deleted = auditStore.clear()
      recordAudit(auditStore, req, { action: 'audit.clear', targetType: 'audit', message: `已清理 ${deleted} 条操作记录`, metadata: { deleted } })
      res.set('Cache-Control', 'no-store').json({ deleted })
    } catch (error) { apiError(req, res, { status: 500, code: 'AUDIT_CLEAR_FAILED', message: '操作记录清理失败', error }) }
  }))
}
