import path from 'node:path'
import { publicJob } from '../updates/jobs.mjs'
import { writeJson } from '../updates/files.mjs'
import { apiError } from '../http/responses.mjs'
import { recordAudit } from '../audit/record.mjs'

export function registerUpdateRoutes(app, { service, auditStore }) {
  const wrap = handler => async (req, res) => {
    res.set('Cache-Control', 'no-store')
    if (req.auth?.type !== 'session') return apiError(req, res, { status: 403, code: 'ADMIN_SESSION_REQUIRED', message: '版本更新需要管理账号登录' })
    try { await handler(req, res) } catch (error) { apiError(req, res, { status: error.status || 500, code: 'UPDATE_FAILED', message: error.message }) }
  }
  app.get('/api/system/updates', wrap(async (_req, res) => res.json(await service.status())))
  app.post('/api/system/updates/check', wrap(async (_req, res) => res.json(await service.status({ force: true }))))
  app.patch('/api/system/updates/preferences', wrap(async (req, res) => {
    if (typeof req.body?.automatic !== 'boolean') throw Object.assign(new Error('自动检查设置无效'), { status: 400 })
    await writeJson(path.join(service.directory, 'preferences.json'), { automatic: req.body.automatic })
    res.json({ automatic: req.body.automatic })
  }))
  app.post('/api/system/updates/jobs', wrap(async (req, res) => {
    const job = await service.submit(req.body, req.get('Idempotency-Key'))
    recordAudit(auditStore, req, { action: 'system.update', targetType: 'version', targetId: job.targetVersion, message: '已确认更新并自动重启', metadata: { jobId: job.id } })
    res.status(202).json(job)
  }))
  app.get('/api/system/updates/jobs/:id', wrap(async (req, res) => {
    const job = publicJob(await service.jobs.get(req.params.id))
    if (!job) throw Object.assign(new Error('更新任务不存在'), { status: 404 })
    res.json(job)
  }))
  app.post('/api/system/updates/jobs/:id/cancel', wrap(async (req, res) => {
    await service.jobs.cancel(req.params.id)
    recordAudit(auditStore, req, { action: 'system.update.cancel', targetType: 'update', targetId: req.params.id, message: '请求取消尚未安装的更新' })
    res.status(202).json({ message: '已请求取消，等待更新器确认' })
  }))
}
