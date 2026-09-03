import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { run } from '../server/updates/process.mjs'
import { readJson, writeJson } from '../server/updates/files.mjs'

const projectRoot = process.cwd()
// Docker Desktop reports drive paths to the Windows client; the Linux worker
// needs the corresponding daemon path for subsequent Compose operations.
function daemonPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value || '') ? `/run/desktop/mnt/host/${value[0].toLowerCase()}/${value.slice(3).replaceAll('\\', '/')}` : value
}
const baseArgs = ['compose']
let updaterImage = 'proxy-port-manager-updater:1', buildUpdater = true
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--updater-image' && process.argv[index + 1]) {
    updaterImage = process.argv[++index]
    if (!/^[a-z0-9][a-z0-9._/:@-]*$/.test(updaterImage)) throw new Error('更新器镜像名称无效')
    buildUpdater = false
    continue
  }
  if (process.argv[index] !== '--compose-file' || !process.argv[index + 1]) throw new Error('用法：npm run updates:setup-docker -- [--compose-file compose.yaml] [--updater-image 本地镜像]')
  baseArgs.push('-f', path.resolve(process.argv[++index]))
}
const config = JSON.parse(await run('docker', [...baseArgs, 'config', '--format', 'json']))
const project = config.name
if (!/^[a-z0-9][a-z0-9_-]*$/.test(project || '') || !config.services?.['proxy-port-manager'] || !config.services?.['mihomo-core']) throw new Error('未识别到完整 Compose 部署')
const stateRoot = path.join(projectRoot, '.local', 'updater')
const shared = path.join(stateRoot, 'state'), control = path.join(stateRoot, 'control')
if (await readJson(path.join(control, 'deployment.json'))) {
  const configFile = path.join(control, 'deployment.compose.json')
  if (!await readJson(configFile)) throw new Error('更新器登记缺少部署配置，请先检查 .local/updater/control')
  await run('docker', ['compose', '-p', project, '-f', configFile, 'up', '-d', '--no-build', '--no-deps', '--wait', '--wait-timeout', '90', 'proxy-port-manager', 'updater'])
  console.log('已恢复现有网页更新器接入；使用 .local/updater/control/deployment.compose.json 管理部署。')
  process.exit(0)
}
await mkdir(shared, { recursive: true, mode: 0o700 })
await mkdir(control, { recursive: true, mode: 0o700 })
const mounts = [], restart = {}
for (const service of ['proxy-port-manager', 'mihomo-core']) {
  const id = await run('docker', [...baseArgs, 'ps', '-q', service])
  if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('接入前请先正常启动两个服务')
  const [container] = JSON.parse(await run('docker', ['inspect', id]))
  if (container.Config.Labels?.['com.docker.compose.project'] !== project) throw new Error('Compose 项目身份不一致')
  restart[service] = config.services[service].restart || 'unless-stopped'
  config.services[service].image = container.Image
  delete config.services[service].build
  delete config.services[service].develop
  for (const mount of container.Mounts) {
    if (!mount.RW || mount.Destination === '/updates') continue
    if (!['volume', 'bind'].includes(mount.Type)) throw new Error('不支持的数据挂载类型')
    if (!mounts.some(item => item.Type === mount.Type && item.Source === mount.Source)) mounts.push(mount)
  }
}
if (!mounts.length) throw new Error('未识别到持久化数据卷')
const app = config.services['proxy-port-manager']
const expectedPaths = ['SUBSCRIPTION_DB', 'AUTH_SESSION_DB', 'AUDIT_DB', 'OBSERVABILITY_DB', 'API_TOKEN_DB', 'EMBEDDED_CORE_STATE_PATH', 'EMBEDDED_CORE_CONFIG_PATH']
for (const key of expectedPaths) {
  const value = app.environment?.[key]
  if (value && !mounts.some(mount => value === mount.Destination || value.startsWith(`${mount.Destination}/`))) throw new Error(`${key} 位于未登记的存储中，不能启用自动更新`)
}
if (buildUpdater) await run('docker', ['build', '-f', 'Dockerfile.updater', '-t', updaterImage, '.'], { cwd: projectRoot, timeout: 15 * 60 * 1000 })
await run('docker', ['image', 'inspect', updaterImage])
const socketGroup = (await run('docker', ['run', '--rm', '--entrypoint', 'node', '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock', updaterImage, '-e', "console.log(require('node:fs').statSync('/var/run/docker.sock').gid)"])).trim()
if (!/^\d+$/.test(socketGroup)) throw new Error('无法确定 Docker socket 访问组')
const probe = await run('docker', ['create', '--mount', `type=bind,source=${stateRoot},target=/owned`, updaterImage])
let daemonRoot
try {
  const [container] = JSON.parse(await run('docker', ['inspect', probe]))
  daemonRoot = daemonPath(container.Mounts.find(mount => mount.Destination === '/owned')?.Source)
} finally { await run('docker', ['rm', probe]) }
if (!daemonRoot?.startsWith('/')) throw new Error('Docker 未返回可供更新器使用的宿主绝对路径')
await run('docker', ['run', '--rm', '--entrypoint', 'node', '--mount', `type=bind,source=${daemonRoot},target=/owned,readonly`, updaterImage, '-e', "const fs=require('node:fs');for(const p of ['/owned/state','/owned/control'])if(!fs.statSync(p).isDirectory())process.exit(1)"])
// Render all bind sources using paths understood by the Linux Docker daemon.
for (const service of ['proxy-port-manager', 'mihomo-core']) {
  const id = await run('docker', [...baseArgs, 'ps', '-q', service])
  const [container] = JSON.parse(await run('docker', ['inspect', id]))
  for (const volume of config.services[service].volumes || []) {
    if (volume.type === 'bind') volume.source = daemonPath(container.Mounts.find(mount => mount.Destination === volume.target)?.Source || volume.source)
  }
}
const registration = { id: randomUUID(), mode: 'docker', project, roots: mounts.map((_, i) => `/managed/${i}`), restart }
await writeJson(path.join(shared, 'deployment.json'), { id: registration.id, mode: 'docker' })
try { await writeFile(path.join(shared, 'control.key'), randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' }) }
catch (error) { if (error.code !== 'EEXIST') throw error }
app.environment ||= {}
app.environment.PPM_UPDATE_DIR = '/updates'
app.volumes ||= []
app.volumes.push({ type: 'bind', source: `${daemonRoot}/state`, target: '/updates' })
config.volumes ||= {}
const managed = mounts.map((mount, index) => {
  if (mount.Type === 'volume') {
    const name = `updater-managed-${index}`
    config.volumes[name] = { name: mount.Name, external: true }
    return { type: 'volume', source: name, target: `/managed/${index}` }
  }
  return { type: 'bind', source: daemonPath(mount.Source), target: `/managed/${index}` }
})
config.services.updater = {
  image: updaterImage, container_name: `${project}-updater`, user: '1000:1000', group_add: [socketGroup],
  environment: { PPM_UPDATE_DIR: '/updates', PPM_UPDATE_DEPLOYMENT_FILE: '/registration/deployment.json' },
  volumes: [{ type: 'bind', source: `${daemonRoot}/state`, target: '/updates' }, { type: 'bind', source: `${daemonRoot}/control`, target: '/registration' }, { type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }, ...managed],
  networks: app.networks || { default: null }, restart: 'unless-stopped', init: true, read_only: true, tmpfs: ['/tmp'],
  cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
}
const configFile = path.join(control, 'deployment.compose.json')
await writeJson(configFile, config)
await run('docker', ['compose', '-p', project, '-f', configFile, 'config', '--quiet'])
await writeJson(path.join(control, 'deployment.json'), registration)
// Only the newly created updater directories are chowned; application data is untouched.
await run('docker', ['run', '--rm', '--user', '0', '--entrypoint', 'node', '--mount', `type=bind,source=${stateRoot},target=/owned`, updaterImage, '-e', "const fs=require('node:fs');function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=p+'/'+e.name;if(e.isDirectory())walk(f);fs.chownSync(f,1000,1000)}fs.chownSync(p,1000,1000)}walk('/owned')"])
await run('docker', ['compose', '-p', project, '-f', configFile, 'up', '-d', '--no-build', '--no-deps', '--wait', '--wait-timeout', '90', 'proxy-port-manager', 'updater'])
console.log('网页更新器已接入，原数据卷及 Mihomo 容器已保留。')
console.log(`后续管理部署请使用：docker compose -p ${project} -f .local/updater/control/deployment.compose.json ...`)
