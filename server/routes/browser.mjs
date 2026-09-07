import { recordAudit } from '../audit/record.mjs'
import { apiError } from '../http/responses.mjs'

function handle(operation, { auditStore, action, target = () => 'roxy' } = {}) {
  return async (req, res) => {
    try {
      const result = await operation(req)
      if (action) recordAudit(auditStore, req, { action, targetType: 'browser', targetId: String(target(req)), message: `Roxy 浏览器操作完成：${action}` })
      res.set('Cache-Control', 'no-store').json(result)
    } catch (error) {
      if (action) recordAudit(auditStore, req, { action, outcome: 'failure', targetType: 'browser', targetId: String(target(req)), message: error.message })
      apiError(req, res, { status: error.status || 502, code: error.code || 'ROXY_INTEGRATION_FAILED', message: error.message, error })
    }
  }
}

export function registerBrowserRoutes(app, { service, auditStore, mutationGate } = {}) {
  const unavailable = (req, res) => apiError(req, res, { status: 501, code: 'BROWSER_INTEGRATION_UNAVAILABLE', message: '浏览器接入缺少可用的加密密钥' })
  if (!service) {
    app.use('/api/browser/roxy', unavailable)
    return
  }
  app.get('/api/browser/roxy/config', handle(() => service.publicConfig()))
  app.put('/api/browser/roxy/config', mutationGate.mutation(handle(req => service.connect(req.body), { auditStore, action: 'browser.roxy.configure' })))
  app.get('/api/browser/roxy/workspaces', handle(() => service.workspaces()))
  app.get('/api/browser/roxy/windows', handle(req => service.windows(req.query)))
  app.get('/api/browser/roxy/bindings/:port', handle(req => service.binding(req.params.port)))
  app.put('/api/browser/roxy/bindings/:port', mutationGate.mutation(handle(req => service.saveBinding(req.params.port, req.body), { auditStore, action: 'browser.roxy.bind', target: req => req.params.port })))
  app.delete('/api/browser/roxy/bindings/:port', mutationGate.mutation(handle(req => service.deleteBinding(req.params.port), { auditStore, action: 'browser.roxy.unbind', target: req => req.params.port })))
  app.post('/api/browser/roxy/bindings/:port/start', mutationGate.mutation(handle(req => service.start(req.params.port), { auditStore, action: 'browser.roxy.start', target: req => req.params.port })))
}
