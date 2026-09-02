import { apiError } from '../http/responses.mjs'
import { recordAudit } from '../audit/record.mjs'

export function registerTokenRoutes(app, { tokenStore, configured, auditStore }) {
  app.use('/api/tokens', (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    if (!configured || req.auth?.type !== 'session') return apiError(req, res, { status: 403, code: 'SESSION_REQUIRED', message: '请先配置管理认证并通过浏览器登录后管理令牌' })
    next()
  })
  app.get('/api/tokens', (_req, res) => res.json({ tokens: tokenStore.list() }))
  app.post('/api/tokens', (req, res) => {
    try {
      const result = tokenStore.create(req.body)
      recordAudit(auditStore, req, { action: 'apiToken.create', targetType: 'apiToken', targetId: result.id, message: '已创建 API 令牌', metadata: { scopes: result.scopes, expiresAt: result.expiresAt } })
      res.status(201).json(result)
    } catch (error) { apiError(req, res, { status: 400, code: 'TOKEN_CREATE_FAILED', message: '令牌创建失败', error }) }
  })
  app.delete('/api/tokens/:id', (req, res) => {
    if (!tokenStore.revoke(req.params.id)) return apiError(req, res, { status: 404, code: 'TOKEN_NOT_FOUND', message: '令牌不存在' })
    recordAudit(auditStore, req, { action: 'apiToken.revoke', targetType: 'apiToken', targetId: req.params.id, message: '已撤销 API 令牌' })
    res.status(204).end()
  })
}
