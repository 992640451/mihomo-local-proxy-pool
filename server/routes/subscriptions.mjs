import { apiError } from '../http/responses.mjs'

export function registerSubscriptionRoutes(app, {
  subscriptionService,
  subscriptionMode,
  loadLiveCatalog,
  syncCoreAfterSubscriptionChange,
} = {}) {
  function unavailable(req, res) {
    return apiError(req, res, { status: 501, code: 'SUBSCRIPTIONS_DISABLED', message: '订阅管理功能未启用' })
  }

  app.get('/api/subscriptions/catalog', async (req, res) => {
    try { res.set('Cache-Control', 'no-store').json(await loadLiveCatalog()) }
    catch (error) { apiError(req, res, { status: 500, code: 'CATALOG_READ_FAILED', message: '订阅配置读取失败', error }) }
  })
  app.get('/api/subscriptions', (req, res) => {
    if (!subscriptionService) return unavailable(req, res)
    res.set('Cache-Control', 'no-store').json({ mode: subscriptionMode, subscriptions: subscriptionService.list() })
  })
  app.post('/api/subscriptions/preview', async (req, res) => {
    if (!subscriptionService) return unavailable(req, res)
    try { res.set('Cache-Control', 'no-store').json(await subscriptionService.preview({ url: req.body?.url, content: req.body?.content })) }
    catch (error) { apiError(req, res, { status: 400, code: 'SUBSCRIPTION_PREVIEW_FAILED', message: '订阅预览失败', error }) }
  })
  app.post('/api/subscriptions', async (req, res) => {
    if (!subscriptionService) return unavailable(req, res)
    try {
      const result = await subscriptionService.create(req.body || {})
      await syncCoreAfterSubscriptionChange()
      res.status(201).set('Cache-Control', 'no-store').json(result)
    } catch (error) { apiError(req, res, { status: 400, code: 'SUBSCRIPTION_IMPORT_FAILED', message: '订阅导入失败', error }) }
  })
  app.patch('/api/subscriptions/:id', async (req, res) => {
    if (!subscriptionService) return unavailable(req, res)
    try {
      const result = await subscriptionService.update(req.params.id, req.body || {})
      await syncCoreAfterSubscriptionChange()
      res.set('Cache-Control', 'no-store').json(result)
    } catch (error) { apiError(req, res, { status: 400, code: 'SUBSCRIPTION_UPDATE_FAILED', message: '订阅更新失败', error }) }
  })
  app.post('/api/subscriptions/:id/refresh', async (req, res) => {
    if (!subscriptionService) return unavailable(req, res)
    try {
      const result = await subscriptionService.refresh(req.params.id)
      await syncCoreAfterSubscriptionChange()
      res.set('Cache-Control', 'no-store').json(result)
    } catch (error) { apiError(req, res, { status: 400, code: 'SUBSCRIPTION_REFRESH_FAILED', message: '订阅刷新失败', error }) }
  })
  app.post('/api/subscriptions/refresh-all', async (req, res) => {
    if (!subscriptionService) return unavailable(req, res)
    try {
      const results = await subscriptionService.refreshAll()
      await syncCoreAfterSubscriptionChange()
      res.set('Cache-Control', 'no-store').json({ results })
    } catch (error) { apiError(req, res, { status: 400, code: 'SUBSCRIPTIONS_REFRESH_FAILED', message: '订阅批量刷新失败', error }) }
  })
  app.delete('/api/subscriptions/:id', async (req, res) => {
    if (!subscriptionService) return unavailable(req, res)
    try {
      const nodeIds = new Set(subscriptionService.nodeIds(req.params.id))
      const catalog = await loadLiveCatalog()
      const referenced = (catalog.listeners || []).filter(listener => (listener.nodeIds || []).some(id => nodeIds.has(id)))
      if (referenced.length) return apiError(req, res, { status: 409, code: 'SUBSCRIPTION_IN_USE', message: '订阅仍被端口引用', meta: { ports: referenced.map(item => item.port) } })
      subscriptionService.remove(req.params.id)
      await syncCoreAfterSubscriptionChange()
      res.status(204).end()
    } catch (error) { apiError(req, res, { status: 400, code: 'SUBSCRIPTION_DELETE_FAILED', message: '订阅删除失败', error }) }
  })
}
