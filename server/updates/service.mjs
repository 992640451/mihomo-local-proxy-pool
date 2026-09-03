import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson } from './files.mjs'
import { UpdateDiscovery } from './discovery.mjs'
import { UpdateJobs, publicJob } from './jobs.mjs'
import { platformTarget, verifyManifest } from './manifest.mjs'

const codeRoot = fileURLToPath(new URL('../../', import.meta.url))
export class UpdateService {
  constructor({ directory, version, keys, launch = null }) {
    Object.assign(this, { directory, version, keys, launch })
    this.jobs = new UpdateJobs(directory)
    this.discovery = new UpdateDiscovery({ directory, version, keys })
  }
  async status({ force = false } = {}) {
    const preferences = await readJson(path.join(this.directory, 'preferences.json'), { automatic: true })
    const info = await this.discovery.check({ force, online: force || preferences.automatic })
    const deployment = await readJson(path.join(this.directory, 'deployment.json'))
    const latest = publicJob(await this.jobs.latest())
    let reason = info.warning || info.unsupportedReason || deployment?.unsupportedReason
    if (!reason && !deployment) reason = '此安装尚未接入网页更新器，请先按升级文档完成一次性接入'
    if (!reason && deployment?.mode === 'docker') {
      const heartbeat = await readJson(path.join(this.directory, 'heartbeat.json'))
      if (!heartbeat || Date.now() - heartbeat.at > 30000) reason = 'Docker 更新器尚未运行，请检查 updater 服务'
    }
    if (!reason && info.manifest && !(deployment?.mode === 'docker' ? info.manifest.docker : info.manifest.portable?.[platformTarget()])) reason = '该发布不支持当前部署平台'
    return { currentVersion: this.version, latestVersion: info.latestVersion, hasUpdate: info.hasUpdate, checkedAt: info.checkedAt, publishedAt: info.publishedAt, notes: info.notes, releaseUrl: info.releaseUrl, digest: info.digest, warning: info.warning, automatic: preferences.automatic, canUpdate: Boolean(info.hasUpdate && info.manifest && !reason), canAutoRestart: Boolean(deployment), unsupportedReason: reason || null, deploymentMode: deployment?.mode || 'unmanaged', installationId: deployment?.id || 'unmanaged', latestJob: latest }
  }
  async submit(body, idempotencyKey) {
    if (body?.autoRestart !== true) throw Object.assign(new Error('请确认更新并自动重启'), { status: 400 })
    const status = await this.status()
    if (!status.canUpdate) throw Object.assign(new Error(status.unsupportedReason || '没有可用的更新'), { status: 409 })
    const cached = await readJson(path.join(this.directory, 'discovery.json'))
    const { manifest, digest } = verifyManifest(cached.envelope, this.keys, this.version)
    if (manifest.version !== body.version || digest !== body.digest) throw Object.assign(new Error('版本信息已变化，请重新查看更新说明'), { status: 409 })
    const job = await this.jobs.submit({ version: manifest.version, digest, envelope: cached.envelope, currentVersion: this.version, idempotencyKey })
    const deployment = await readJson(path.join(this.directory, 'deployment.json'))
    if (deployment.mode === 'portable' && this.launch) {
      try { await this.launch() } catch (error) {
        await this.jobs.save(job, { state: 'failed', error: '独立更新器启动失败，请重新启动管理器后重试', message: '更新尚未开始' })
        await rm(path.join(this.directory, 'pending.json'), { force: true })
        throw error
      }
    }
    return publicJob(job)
  }
}

const launches = new Map()
export async function launchPortableWorker(directory) {
  if (launches.has(directory)) return launches.get(directory)
  const pending = startPortableWorker(directory).finally(() => launches.delete(directory))
  launches.set(directory, pending)
  return pending
}
async function startPortableWorker(directory) {
  // Copy an independent runtime: Windows cannot overwrite a running node.exe.
  const runner = path.join(directory, 'runner')
  await mkdir(runner, { recursive: true, mode: 0o700 })
  const executable = path.join(runner, process.platform === 'win32' ? 'node.exe' : 'node')
  // Reuse while a previous worker owns the runtime; concurrent submissions are serialized by pending.json.
  const lock = await readJson(path.join(directory, 'worker.lock'))
  if (lock?.pid) { try { process.kill(lock.pid, 0); return } catch {} }
  await cp(process.execPath, executable)
  await cp(path.join(codeRoot, 'server', 'updates'), path.join(runner, 'server', 'updates'), { recursive: true })
  await mkdir(path.join(runner, 'release'), { recursive: true })
  await cp(path.join(codeRoot, 'release', 'update-public-keys.json'), path.join(runner, 'release', 'update-public-keys.json'))
  const fd = openSync(path.join(directory, 'worker.log'), 'a', 0o600)
  try {
    const child = spawn(executable, [path.join(runner, 'server', 'updates', 'worker.mjs'), '--directory', directory, '--once'], { detached: true, windowsHide: true, shell: false, stdio: ['ignore', fd, fd], env: { ...process.env } })
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    child.unref()
    for (let i = 0; i < 100; i++) {
      if (await readJson(path.join(directory, 'worker.lock'))) return
      if (child.exitCode !== null) throw new Error('独立更新器启动失败')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('独立更新器启动超时')
  } finally { closeSync(fd) }
}
