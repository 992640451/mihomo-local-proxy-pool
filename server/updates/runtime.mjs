import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { readJson, writeJson } from './files.mjs'

export async function registerPortableUpdates(paths, runtime) {
  if (!paths.packaged) return
  const installRoot = path.resolve(process.env.PPM_INSTALL_ROOT || paths.installRoot)
  const directory = path.resolve(process.env.PPM_UPDATE_DIR || path.join(installRoot, '.ppm-updates'))
  process.env.PPM_UPDATE_DIR = directory
  process.env.PPM_INSTALL_ROOT = installRoot
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const previous = await readJson(path.join(directory, 'deployment.json'))
  const config = {
    id: previous?.id || randomUUID(), mode: 'portable', installRoot, dataDir: paths.dataDir,
    coreDir: paths.coreDir, configFile: paths.configFile, managementUrl: `http://127.0.0.1:${runtime.managementPort}`,
  }
  const custom = ['AUDIT_DB', 'OBSERVABILITY_DB', 'API_TOKEN_DB'].some(key => process.env[key] && path.dirname(path.resolve(process.env[key])) !== paths.dataDir)
  if (custom || path.dirname(path.resolve(paths.configFile)) !== paths.dataDir) config.unsupportedReason = '自定义数据库或密钥位于登记目录之外，请按升级文档整理路径后更新'
  await writeJson(path.join(directory, 'deployment.json'), config)
  try { await writeFile(path.join(directory, 'control.key'), randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST') throw error }
}
export function isUpdateMaintenance(directory) { return existsSync(path.join(directory, 'maintenance.json')) }
export function updateControlAuthorized(req, directory) {
  try {
    const expected = Buffer.from(`Bearer ${readFileSync(path.join(directory, 'control.key'), 'utf8').trim()}`)
    const actual = Buffer.from(req.headers.authorization || '')
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch { return false }
}
export async function checkListeners(listeners, host) {
  await Promise.all(listeners.filter(listener => listener.enabled !== false).map(listener => new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(listener.port) })
    socket.setTimeout(2000)
    socket.once('connect', () => { socket.destroy(); resolve() })
    socket.once('timeout', () => { socket.destroy(); reject(new Error('代理监听端口未就绪')) })
    socket.once('error', reject)
  })))
}
