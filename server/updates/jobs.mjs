import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { readJson, writeJson } from './files.mjs'
export const TERMINAL_STATES = new Set(['succeeded', 'failed', 'rolled_back', 'recovery_required', 'cancelled'])
export const CANCELLABLE_STATES = new Set(['queued', 'preparing', 'downloading', 'countdown'])
export function validJobId(id) { if (!/^[a-f0-9-]{36}$/.test(id || '')) throw Object.assign(new Error('更新任务不存在'), { status: 404 }); return id }
export function publicJob(job) {
  if (!job) return null
  const { id, state, targetVersion, previousVersion, createdAt, updatedAt, message, progress, restartAt, error, actualVersion, actualRevision } = job
  return { id, state, targetVersion, previousVersion, createdAt, updatedAt, message, progress, restartAt, error, actualVersion, actualRevision, terminal: TERMINAL_STATES.has(state), canCancel: CANCELLABLE_STATES.has(state) }
}
export class UpdateJobs {
  constructor(directory, privateDirectory = directory) { this.directory = directory; this.privateDirectory = privateDirectory }
  file(id) { return path.join(this.directory, 'jobs', `${validJobId(id)}.json`) }
  async get(id) {
    if (this.privateDirectory === this.directory) return readJson(this.file(id))
    const trusted = await readJson(path.join(this.privateDirectory, 'jobs', `${validJobId(id)}.json`))
    if (trusted) return trusted
    const request = await readJson(this.file(id))
    if (!request) return null
    const { targetVersion, previousVersion, digest, envelope, idempotencyKey, createdAt } = request
    return { id, state: 'queued', targetVersion, previousVersion, digest, envelope, idempotencyKey, createdAt }
  }
  async latest() { const pointer = await readJson(path.join(this.directory, 'latest.json')); return pointer ? this.get(pointer.id) : null }
  async save(job, patch) {
    Object.assign(job, patch, { updatedAt: Date.now() })
    if (this.privateDirectory !== this.directory) {
      await writeJson(path.join(this.privateDirectory, 'jobs', `${validJobId(job.id)}.json`), job)
      await writeJson(this.file(job.id), { ...publicJob(job), idempotencyKey: job.idempotencyKey })
    } else await writeJson(this.file(job.id), job)
    return job
  }
  async submit({ version, digest, envelope, currentVersion, idempotencyKey }) {
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(idempotencyKey || '')) throw Object.assign(new Error('缺少有效的更新请求标识'), { status: 400 })
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const requestFile = path.join(this.directory, 'pending.json')
    const old = await this.latest()
    if (old?.idempotencyKey === idempotencyKey) return old
    const id = randomUUID(), job = { id, state: 'queued', targetVersion: version, previousVersion: currentVersion, digest, envelope, idempotencyKey, createdAt: Date.now(), updatedAt: Date.now(), message: '更新任务已接收' }
    await this.save(job, {})
    try {
      const handle = await open(requestFile, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ id })); await handle.sync() } finally { await handle.close() }
    } catch (error) {
      await rm(this.file(id), { force: true })
      if (error.code !== 'EEXIST') throw error
      const pending = await readJson(requestFile), active = pending && await this.get(pending.id)
      if (active?.targetVersion === version) return active
      throw Object.assign(new Error('另一个更新任务正在执行，请稍后重试'), { status: 409 })
    }
    await writeJson(path.join(this.directory, 'latest.json'), { id })
    return job
  }
  async cancel(id) {
    const job = await this.get(id)
    if (!job || !CANCELLABLE_STATES.has(job.state)) throw Object.assign(new Error('该阶段不能取消更新'), { status: 409 })
    await writeJson(path.join(this.directory, 'cancel.json'), { id })
    return job
  }
}
