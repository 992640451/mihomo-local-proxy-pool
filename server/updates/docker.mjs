import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { readJson, writeJson, checkSpace } from './files.mjs'
import { run, verifyRunning } from './process.mjs'

export class DockerAdapter {
  constructor(deployment, directory, privateDirectory = directory) { Object.assign(this, { deployment, directory, privateDirectory }); this.roots = deployment.roots; this.composeFile = path.join(privateDirectory, 'deployment.compose.json') }
  compose(args) { return run('docker', ['compose', '-p', this.deployment.project, '-f', this.composeFile, ...args], { timeout: 15 * 60 * 1000 }) }
  async containers({ allowMissing = false } = {}) {
    const result = []
    for (const service of ['proxy-port-manager', 'mihomo-core']) {
      const id = await this.compose(['ps', '-a', '-q', service])
      if (!id && allowMissing) continue
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('无法识别原部署容器')
      const [info] = JSON.parse(await run('docker', ['inspect', id]))
      if (info.Config.Labels?.['com.docker.compose.project'] !== this.deployment.project || info.Config.Labels?.['com.docker.compose.service'] !== service) throw new Error('容器归属校验失败')
      result.push({ service, id, info })
    }
    return result
  }
  async preflight(_job, manifest) {
    if (!manifest.docker || !/^[a-z0-9][a-z0-9_-]*$/.test(this.deployment.project || '')) throw new Error('Docker 更新配置无效')
    if (!this.roots?.length || this.roots.some((root, i) => root !== `/managed/${i}`)) throw new Error('Docker 数据映射未登记')
    await this.containers()
    await checkSpace(this.directory, 1024 * 1024 * 1024)
  }
  async prepare(job, manifest, report) {
    await report({ state: 'downloading', message: '正在拉取固定摘要的应用和核心镜像', progress: null })
    for (const image of [manifest.docker.image, manifest.docker.coreImage]) await run('docker', ['pull', image], { timeout: 15 * 60 * 1000 })
    const [info] = JSON.parse(await run('docker', ['image', 'inspect', manifest.docker.image]))
    if (info.Config.Labels?.['org.opencontainers.image.version'] !== manifest.version || info.Config.Labels?.['org.opencontainers.image.revision'] !== manifest.revision) throw new Error('镜像构建身份与清单不一致')
    job.oldImages = Object.fromEntries((await this.containers()).map(({ service, info }) => [service, info.Image]))
    await report({ progress: null })
  }
  async stop() {
    for (const { id } of await this.containers({ allowMissing: true })) await run('docker', ['update', '--restart=no', id])
    await this.compose(['stop', '--timeout', '45', 'proxy-port-manager', 'mihomo-core'])
    for (const { info } of await this.containers({ allowMissing: true })) if (info.State.Running) throw new Error('容器尚未停止，无法建立一致快照')
  }
  async capture(job) { job.previousCompose = await readJson(this.composeFile) }
  async install(_job, manifest) {
    const config = await readJson(this.composeFile)
    config.services['proxy-port-manager'].image = manifest.docker.image
    config.services['mihomo-core'].image = manifest.docker.coreImage
    for (const service of ['proxy-port-manager', 'mihomo-core']) config.services[service].restart = 'no'
    await writeJson(this.composeFile, config)
  }
  async restore(job) {
    if (!job.previousCompose || !job.oldImages) throw new Error('原部署配置恢复点缺失')
    const original = structuredClone(job.previousCompose)
    for (const service of ['proxy-port-manager', 'mihomo-core']) { original.services[service].image = job.oldImages[service]; original.services[service].restart = 'no' }
    await writeJson(this.composeFile, original)
  }
  async start() {
    await this.compose(['up', '-d', '--no-build', '--pull', 'never', '--no-deps', '--wait', '--wait-timeout', '90', 'proxy-port-manager'])
    await this.compose(['up', '-d', '--no-build', '--pull', 'never', '--no-deps', 'mihomo-core'])
  }
  async verify(version, revision) { return verifyRunning('http://proxy-port-manager:4180', (await readFile(path.join(this.directory, 'control.key'), 'utf8')).trim(), version, revision) }
  async commit(job) {
    const config = await readJson(this.composeFile)
    for (const { service, id } of await this.containers()) {
      const policy = job.previousCompose?.services[service]?.restart || this.deployment.restart?.[service] || 'unless-stopped'
      await run('docker', ['update', `--restart=${policy}`, id])
      config.services[service].restart = policy
    }
    await writeJson(this.composeFile, config)
  }
}
