import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, readdir, cp, access, rename } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Transform, Readable } from 'node:stream'
import path from 'node:path'
import { inside, readJson, writeJson, hashFile, checkSpace, inventory } from './files.mjs'
import { platformTarget, releaseUrl } from './manifest.mjs'
import { run, verifyRunning } from './process.mjs'

export function checkArchiveNames(names, verbose) {
  if (names.length > 100000) throw new Error('更新包文件过多')
  for (const name of names) {
    const normal = name.replaceAll('\\', '/')
    if (!normal || normal.startsWith('/') || normal.includes(':') || normal.split('/').includes('..') || /[\x00-\x1f]/.test(normal)) throw new Error('更新包包含越界路径')
  }
  if (verbose.some(line => !/^[-d]/.test(line))) throw new Error('更新包包含链接或特殊文件')
}
export class PortableAdapter {
  constructor(deployment, directory) {
    Object.assign(this, { deployment, directory })
    this.roots = [deployment.dataDir, deployment.coreDir]
  }
  async preflight() {
    if (this.deployment.unsupportedReason) throw new Error(this.deployment.unsupportedReason)
    const { installRoot, dataDir, coreDir } = this.deployment
    if (!path.isAbsolute(installRoot) || !path.isAbsolute(dataDir) || !path.isAbsolute(coreDir)) throw new Error('便携安装路径无效')
    for (const root of this.roots) {
      if (path.resolve(root) === path.parse(root).root || path.resolve(root) === path.resolve(installRoot)) throw new Error('不支持该数据目录布局')
      inside(root, path.join(root, 'probe'))
      await access(root)
      if (!path.relative(root, this.directory).startsWith('..') && !path.isAbsolute(path.relative(root, this.directory))) throw new Error('更新控制目录不能位于备份数据内')
    }
    if (dataDir === coreDir || (!path.relative(dataDir, coreDir).startsWith('..') && !path.isAbsolute(path.relative(dataDir, coreDir))) || (!path.relative(coreDir, dataDir).startsWith('..') && !path.isAbsolute(path.relative(coreDir, dataDir)))) throw new Error('重叠的数据目录需要手工更新')
    await checkSpace(this.directory, 1024 * 1024 * 1024)
  }
  async prepare(job, manifest, report) {
    const asset = manifest.portable?.[platformTarget()]
    if (!asset) throw new Error('发布不支持当前平台')
    const stage = inside(this.directory, path.join(this.directory, 'staging', job.id))
    await mkdir(stage, { recursive: true })
    const archive = path.join(stage, asset.url.endsWith('.zip') ? 'package.zip' : 'package.tar.gz')
    await report({ state: 'downloading', message: '正在下载并校验新版本', progress: 0 })
    const response = await fetch(releaseUrl(asset.url, manifest.version), { signal: AbortSignal.timeout(15 * 60 * 1000), headers: { 'User-Agent': 'Proxy-Port-Manager-Updates' } })
    if (!response.ok) throw new Error(`更新包下载失败（HTTP ${response.status}）`)
    let received = 0, lastReport = 0
    const meter = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length
      if (received > asset.bytes) return callback(new Error('更新包大小超出签名清单'))
      const update = Date.now() - lastReport > 500 ? report({ progress: Math.floor(received * 100 / asset.bytes) }) : Promise.resolve()
      if (Date.now() - lastReport > 500) lastReport = Date.now()
      update.then(() => callback(null, chunk), callback)
    } })
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(archive, { mode: 0o600 }))
    if (received !== asset.bytes || await hashFile(archive) !== asset.sha256) throw new Error('更新包校验失败')
    await report({ progress: 100, message: '下载完成，正在检查并解压更新包' })
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
    const names = (await run(tar, ['-tf', archive])).split(/\r?\n/).filter(Boolean)
    const verbose = (await run(tar, ['-tvf', archive])).split(/\r?\n/).filter(Boolean)
    checkArchiveNames(names, verbose)
    const unpack = path.join(stage, 'unpacked')
    await mkdir(unpack, { recursive: true })
    await run(tar, ['-xf', archive, '-C', unpack], { timeout: 15 * 60 * 1000 })
    const entries = await readdir(unpack)
    if (entries.length !== 1) throw new Error('更新包目录结构无效')
    const extracted = inside(unpack, path.join(unpack, entries[0]))
    await inventory(extracted)
    const info = await readJson(path.join(extracted, 'app', 'build-info.json'))
    if (info?.version !== manifest.version || info.revision !== manifest.revision) throw new Error('包内构建信息与签名清单不一致')
    job.prepared = extracted
    await report({ progress: 100 })
  }
  async stop() {
    const state = await readJson(path.join(this.deployment.dataDir, 'runtime', 'service.json'))
    if (!state) return
    try { process.kill(state.pid, 0) } catch { return }
    const response = await fetch(`${state.controlUrl}/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${state.controlToken}` }, signal: AbortSignal.timeout(4000) })
    if (!response.ok) throw new Error('无法正常停止当前便携服务')
    for (let i = 0; i < 120; i++) {
      try { process.kill(state.pid, 0) } catch { return }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('服务未正常退出，已停止安装')
  }
  async capture(job) { job.previousPointer = await readJson(path.join(this.directory, 'active-release.json')) }
  async install(job) {
    const target = inside(this.deployment.installRoot, path.join(this.deployment.installRoot, 'releases', job.targetVersion))
    await mkdir(path.dirname(target), { recursive: true })
    await rm(target, { recursive: true, force: true })
    try { await rename(job.prepared, target) }
    catch (error) { if (error.code !== 'EXDEV') throw error; await cp(job.prepared, target, { recursive: true }) }
    await writeJson(path.join(this.directory, 'active-release.json'), { root: target, version: job.targetVersion })
  }
  async restore(job) {
    if (job.previousPointer) await writeJson(path.join(this.directory, 'active-release.json'), job.previousPointer)
    else await rm(path.join(this.directory, 'active-release.json'), { force: true })
  }
  async start() {
    const pointer = await readJson(path.join(this.directory, 'active-release.json'))
    const root = pointer?.root || this.deployment.installRoot
    await rm(path.join(this.deployment.dataDir, 'runtime', 'service.json'), { force: true })
    await rm(path.join(this.deployment.dataDir, 'runtime', 'service.lock'), { force: true })
    const node = path.join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
    await run(node, [path.join(root, 'app', 'scripts', 'launcher.mjs'), 'start', '--background', '--no-open'], {
      env: { ...process.env, PPM_ROOT: root, PPM_INSTALL_ROOT: this.deployment.installRoot, PPM_DATA_DIR: this.deployment.dataDir, PPM_CORE_DIR: this.deployment.coreDir, PPM_CONFIG_FILE: this.deployment.configFile, PPM_MIHOMO_BINARY: path.join(root, 'core', process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'), PPM_UPDATE_DIR: this.directory, PPM_UPDATE_START: '1', PPM_PORTABLE: '1' },
      timeout: 60000,
    })
  }
  async verify(version, revision) { return verifyRunning(this.deployment.managementUrl, (await readFile(path.join(this.directory, 'control.key'), 'utf8')).trim(), version, revision) }
  async commit() {}
}
