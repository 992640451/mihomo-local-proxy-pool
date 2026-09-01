import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function defaultInstalledDataDir() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Proxy Port Manager')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Proxy Port Manager')
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'proxy-port-manager')
}

export function resolveRuntimePaths({ root = process.env.PPM_ROOT || sourceRoot, dataDir = process.env.PPM_DATA_DIR } = {}) {
  const installRoot = path.resolve(root)
  const packagedAppRoot = path.join(installRoot, 'app')
  const packaged = existsSync(path.join(packagedAppRoot, 'server', 'index.mjs'))
  const appRoot = packaged ? packagedAppRoot : installRoot
  const portable = process.env.PPM_PORTABLE === '1' || packaged
  const resolvedDataDir = path.resolve(dataDir || (portable ? path.join(installRoot, 'data') : defaultInstalledDataDir()))
  const coreDir = path.resolve(process.env.PPM_CORE_DIR || path.join(installRoot, 'core'))
  const coreName = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'
  const sourceEnv = path.join(installRoot, '.env')
  return {
    installRoot,
    appRoot,
    packaged,
    portable,
    dataDir: resolvedDataDir,
    logDir: path.join(resolvedDataDir, 'logs'),
    runtimeDir: path.join(resolvedDataDir, 'runtime'),
    configFile: process.env.PPM_CONFIG_FILE || (!packaged && existsSync(sourceEnv) ? sourceEnv : path.join(resolvedDataDir, 'config.env')),
    subscriptionDb: path.join(resolvedDataDir, 'subscriptions.sqlite'),
    sessionDb: path.join(resolvedDataDir, 'sessions.sqlite'),
    coreState: path.join(resolvedDataDir, 'embedded-core.json'),
    coreDir,
    coreConfig: path.join(coreDir, 'config.yaml'),
    coreExecutable: path.resolve(process.env.PPM_MIHOMO_BINARY || path.join(coreDir, coreName)),
    runtimeState: path.join(resolvedDataDir, 'runtime', 'service.json'),
    lockFile: path.join(resolvedDataDir, 'runtime', 'service.lock'),
    appLog: path.join(resolvedDataDir, 'logs', 'application.log'),
    coreLog: path.join(resolvedDataDir, 'logs', 'mihomo.log'),
  }
}

export async function ensureRuntimeDirectories(paths) {
  await Promise.all([
    mkdir(paths.dataDir, { recursive: true }),
    mkdir(paths.logDir, { recursive: true }),
    mkdir(paths.runtimeDir, { recursive: true }),
    mkdir(paths.coreDir, { recursive: true }),
  ])
}

export function parseEnv(content) {
  const values = {}
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    values[key] = trimmed.slice(separator + 1)
  }
  return values
}

export async function loadRuntimeEnv(filename, { override = false } = {}) {
  const values = parseEnv(await readFile(filename, 'utf8'))
  for (const [key, value] of Object.entries(values)) {
    if (override || process.env[key] === undefined) process.env[key] = value
  }
  return values
}

export async function writeRuntimeEnv(filename, content) {
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
}

export function configurePortableEnvironment(paths) {
  const controllerPort = Number(process.env.PPM_CONTROLLER_PORT || 19090)
  const managementPort = Number(process.env.PPM_MANAGEMENT_PORT || 4173)
  const controllerAddress = `127.0.0.1:${controllerPort}`
  Object.assign(process.env, {
    NODE_ENV: 'production',
    APP_HOST: '127.0.0.1',
    PORT: String(managementPort),
    PROBE_HOST: '127.0.0.1',
    SUBSCRIPTION_MODE: process.env.SUBSCRIPTION_MODE || 'native',
    SUBSCRIPTION_DB: paths.subscriptionDb,
    SUBSCRIPTION_MASTER_KEY: process.env.SUBSCRIPTION_MASTER_KEY || process.env.MIHOMO_CONTROLLER_SECRET || '',
    SUBSCRIPTION_LEGACY_SOURCE: paths.coreConfig,
    MIHOMO_CONFIG_PATH: paths.coreConfig,
    EMBEDDED_CORE_ENABLED: 'true',
    EMBEDDED_CORE_STATE_PATH: paths.coreState,
    EMBEDDED_CORE_CONFIG_PATH: paths.coreConfig,
    EMBEDDED_CORE_HOST_CONFIG_PATH: paths.coreConfig,
    EMBEDDED_CORE_CONTROLLER_URL: `http://${controllerAddress}`,
    EMBEDDED_CORE_CONTROLLER_ADDRESS: controllerAddress,
    EMBEDDED_CORE_LISTENER_HOST: '127.0.0.1',
    EMBEDDED_CORE_PORT_RANGES: process.env.PPM_PORT_RANGES || '',
    EMBEDDED_CORE_SECRET: process.env.MIHOMO_CONTROLLER_SECRET || '',
    AUTH_SESSION_DB: paths.sessionDb,
  })
  return { controllerPort, managementPort, controllerAddress }
}
