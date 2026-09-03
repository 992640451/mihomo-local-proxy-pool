import { open, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, writeJson } from './files.mjs'
import { verifyManifest } from './manifest.mjs'
import { UpdateJobs } from './jobs.mjs'
import { executeUpdate } from './engine.mjs'
import { PortableAdapter } from './portable.mjs'
import { DockerAdapter } from './docker.mjs'

export async function runWorker({ directory, once = false, recover = false }) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const deploymentFile = process.env.PPM_UPDATE_DEPLOYMENT_FILE || path.join(directory, 'deployment.json')
  const deployment = await readJson(deploymentFile)
  const privateDirectory = path.dirname(deploymentFile)
  if (!deployment || !['portable', 'docker'].includes(deployment.mode)) throw new Error('更新器未登记')
  const lockFile = path.join(directory, 'worker.lock'), old = await readJson(lockFile)
  if (old && deployment.mode === 'portable') { try { process.kill(old.pid, 0); return } catch {} }
  // Docker has one updater container per registered Compose project. The file survives container restart.
  if (old) await rm(lockFile, { force: true })
  const lock = await open(lockFile, 'wx', 0o600)
  await lock.writeFile(JSON.stringify({ pid: process.pid }))
  await lock.close()
  const jobs = new UpdateJobs(directory, privateDirectory)
  const keys = JSON.parse(await readFile(new URL('../../release/update-public-keys.json', import.meta.url), 'utf8'))
  const heartbeat = () => writeJson(path.join(directory, 'heartbeat.json'), { at: Date.now(), protocol: 1 })
  const timer = setInterval(() => heartbeat().catch(() => {}), 5000)
  const adapter = deployment.mode === 'portable' ? new PortableAdapter(deployment, directory) : new DockerAdapter(deployment, directory, privateDirectory)
  try {
    do {
      await heartbeat()
      const pending = await readJson(path.join(directory, 'pending.json'))
      if (pending) {
        const job = await jobs.get(pending.id)
        if (!job) throw new Error('更新任务记录缺失')
        if (recover && job.state === 'recovery_required') await jobs.save(job, { state: 'rolling_back' })
        try {
          const { manifest, digest } = verifyManifest(job.envelope, keys, job.previousVersion)
          if (manifest.version !== job.targetVersion || digest !== job.digest) throw new Error('任务与签名目标不一致')
          await executeUpdate({ job, jobs, adapter, manifest, directory })
        } catch (error) {
          await jobs.save(job, { state: 'recovery_required', error: error.message, message: '更新器拒绝执行，请检查更新日志' })
        }
      }
      if (!once) await new Promise(resolve => setTimeout(resolve, 2000))
    } while (!once)
  } finally { clearInterval(timer); await rm(lockFile, { force: true }) }
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const index = process.argv.indexOf('--directory'), directory = index >= 0 ? path.resolve(process.argv[index + 1]) : process.env.PPM_UPDATE_DIR
  if (!directory) throw new Error('缺少更新目录')
  runWorker({ directory, once: process.argv.includes('--once'), recover: process.argv.includes('--recover') }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
