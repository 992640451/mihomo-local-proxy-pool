import { recordAudit } from '../audit/record.mjs'
import { apiError } from '../http/responses.mjs'
import { buildOpenApi } from '../automation/contract.mjs'

export function registerAutomationRoutes(app, { recoveryService, loadLiveCatalog, auditStore, mutationGate }) {
  app.get('/api/openapi.json', (_req, res) => res.set('Cache-Control', 'no-store').json(buildOpenApi()))
  app.get('/api/ports', async (_req, res) => res.set('Cache-Control', 'no-store').json({ ports: (await loadLiveCatalog()).listeners || [] }))
  // Exclusive gate also makes backup / dry-run snapshots consistent with manual
  // mutations; RecoveryService suspends the subscription scheduler while reading.
  for (const action of ['export', 'plan', 'apply']) {
    app.post(`/api/config/${action}`, mutationGate.restore(async (req, res) => {
      const started = Date.now()
      try {
        const { password, recoveryPackage, planToken } = req.body || {}
        let result
        if (action === 'export') result = await recoveryService.create(password)
        if (action === 'plan') result = await recoveryService.plan(recoveryPackage, password)
        if (action === 'apply') result = await recoveryService.restore(recoveryPackage, password, { requirePlan: true, planToken })
        recordAudit(auditStore, req, { action: `configuration.${action}`, targetType: 'configuration', message: `配置${{ export: '导出', plan: '预检', apply: '恢复' }[action]}完成`, durationMs: Date.now() - started })
        res.set('Cache-Control', 'no-store').json(action === 'export' ? { ...result.recoveryPackage, summary: result.summary } : result)
      } catch (error) {
        recordAudit(auditStore, req, { action: `configuration.${action}`, outcome: 'failure', targetType: 'configuration', message: '配置自动化操作失败', durationMs: Date.now() - started })
        apiError(req, res, { status: error.status || 400, code: error.code || 'CONFIGURATION_FAILED', message: '配置操作失败', error })
      }
    }))
  }
}
