import path from 'node:path'
import { rm } from 'node:fs/promises'
import { readJson, snapshot, restoreSnapshot, writeJson } from './files.mjs'
import { CANCELLABLE_STATES, TERMINAL_STATES } from './jobs.mjs'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function executeUpdate({ job, jobs, adapter, manifest, directory, countdownMs = 5000, delay = sleep }) {
  const recoveryRoot = path.join(adapter.privateDirectory || directory, 'recovery', job.id)
  const maintenance = path.join(directory, 'maintenance.json')
  const cancelled = async () => (await readJson(path.join(directory, 'cancel.json')))?.id === job.id
  const save = patch => jobs.save(job, patch)
  const finish = async (state, message, extra = {}) => {
    await save({ state, message, ...extra })
    await rm(path.join(directory, 'pending.json'), { force: true })
  }
  async function recover(reason) {
    try {
      await writeJson(maintenance, { jobId: job.id })
      await adapter.stop()
      if (job.changed) {
        await save({ state: 'rolling_back', message: '正在恢复升级前的完整状态' })
        await restoreSnapshot(adapter.roots, recoveryRoot, path.join(adapter.privateDirectory || directory, 'failed', job.id))
        await adapter.restore(job)
      }
      await adapter.start(job, true)
      const actual = await adapter.verify(job.previousVersion, job.previousRevision)
      await adapter.commit(job, true)
      await rm(maintenance, { force: true })
      await finish(job.changed ? 'rolled_back' : 'failed', job.changed ? '更新失败，已恢复旧版本并重新启动' : '更新未安装，原服务已恢复运行', { error: reason, actualVersion: actual.version, actualRevision: actual.revision })
    } catch (error) {
      // Keep maintenance marker and pending request so recovery can be retried explicitly.
      await save({ state: 'recovery_required', message: '自动恢复未完成，请使用本机恢复入口', error: `${reason}；恢复失败：${error.message}` })
    }
  }
  if (job.state === 'recovery_required') return
  if (job.state === 'committed') {
    await rm(maintenance, { force: true })
    await finish('succeeded', `已更新至 v${job.actualVersion}，服务已自动重启`)
    return
  }
  if (TERMINAL_STATES.has(job.state)) { await rm(path.join(directory, 'pending.json'), { force: true }); return }
  if (!CANCELLABLE_STATES.has(job.state)) { await recover('更新过程意外中断'); return }
  try {
    await save({ state: 'preparing', message: '正在检查更新环境', progress: null })
    await adapter.preflight(job, manifest)
    if (!job.previousRevision) job.previousRevision = (await adapter.verify(job.previousVersion, null)).revision
    await adapter.prepare(job, manifest, async patch => {
      if (await cancelled()) throw Object.assign(new Error('更新已取消'), { cancelled: true })
      await save(patch)
    })
    await save({ state: 'countdown', message: '新版本已准备就绪，即将备份并重启服务', progress: null, restartAt: Date.now() + countdownMs })
    while (Date.now() < job.restartAt) {
      if (await cancelled()) throw Object.assign(new Error('更新已取消'), { cancelled: true })
      await delay(Math.min(250, Math.max(1, job.restartAt - Date.now())))
    }
    if (await cancelled()) throw Object.assign(new Error('更新已取消'), { cancelled: true })
    // Persist stopping before any lifecycle action: a crash now must restart the original service.
    await save({ state: 'stopping', message: '正在停止服务以创建一致备份' })
    await writeJson(maintenance, { jobId: job.id })
    await adapter.stop()
    await save({ state: 'backing_up', message: '正在备份订阅、密钥和完整运行数据' })
    await snapshot(adapter.roots, recoveryRoot)
    await adapter.capture(job)
    await save({ state: 'installing', changed: true, message: '正在安装新版本' })
    await adapter.install(job, manifest)
    await save({ state: 'restarting', message: '正在自动启动新版本，页面恢复后将自动连接' })
    await adapter.start(job, false)
    await save({ state: 'verifying', message: '正在核验版本、数据和代理端口' })
    const actual = await adapter.verify(job.targetVersion, manifest.revision)
    await adapter.commit(job, false)
    await save({ state: 'committed', actualVersion: actual.version, actualRevision: actual.revision })
    await rm(maintenance, { force: true })
    await finish('succeeded', `已更新至 v${actual.version}，服务已自动重启`, { actualVersion: actual.version, actualRevision: actual.revision })
  } catch (error) {
    if (job.state === 'committed' || job.state === 'succeeded') return
    if (CANCELLABLE_STATES.has(job.state)) await finish(error.cancelled ? 'cancelled' : 'failed', error.cancelled ? '更新已取消，原服务继续运行' : '更新尚未安装，原服务继续运行', { error: error.cancelled ? null : error.message })
    else await recover(error.message)
  }
}
