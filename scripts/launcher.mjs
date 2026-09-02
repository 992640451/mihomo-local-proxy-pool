import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { access, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { generateConfiguration } from './init.mjs'
import {
  configurePortableEnvironment,
  ensureRuntimeDirectories,
  loadRuntimeEnv,
  resolveRuntimePaths,
  writeRuntimeEnv,
} from '../server/runtime/paths.mjs'
import { CoreSupervisor } from '../server/runtime/coreSupervisor.mjs'
import { AUTOMATION_COMMANDS, AUTOMATION_USAGE, runAutomation } from './automation-cli.mjs'

const entryFile = fileURLToPath(import.meta.url)
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function readJson(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')) }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}

async function prepareRuntime({ announceCredentials = false, initialize = true } = {}) {
  const paths = resolveRuntimePaths()
  if (initialize) await ensureRuntimeDirectories(paths)
  try {
    await access(paths.configFile)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    if (!initialize) return { paths, runtime: null, configured: false }
    const generated = generateConfiguration()
    await writeRuntimeEnv(paths.configFile, generated.content)
    if (announceCredentials) {
      console.log(`已生成便携配置：${paths.configFile}`)
      console.log(`管理账号：${generated.username}`)
      console.log(`管理密码：${generated.password}`)
      console.log('请立即保存密码；配置文件只保存不可逆的 Scrypt 哈希。')
    }
  }
  await loadRuntimeEnv(paths.configFile)
  const runtime = configurePortableEnvironment(paths)
  if (!process.env.MIHOMO_CONTROLLER_SECRET || process.env.MIHOMO_CONTROLLER_SECRET.length < 32) {
    throw new Error('MIHOMO_CONTROLLER_SECRET 至少需要 32 个字符')
  }
  return { paths, runtime, configured: true }
}

async function acquireLock(filename) {
  try {
    const handle = await open(filename, 'wx', 0o600)
    await handle.writeFile(`${process.pid}\n`)
    return handle
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const pid = Number(String(await readFile(filename, 'utf8')).trim())
    if (processAlive(pid)) throw new Error(`服务已在运行，PID ${pid}`)
    await rm(filename, { force: true })
    const handle = await open(filename, 'wx', 0o600)
    await handle.writeFile(`${process.pid}\n`)
    return handle
  }
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

function createControlServer(token, onShutdown) {
  return http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' })); return
    }
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200).end(JSON.stringify({ status: 'ok', pid: process.pid })); return
    }
    if (req.method === 'POST' && req.url === '/shutdown') {
      res.writeHead(202).end(JSON.stringify({ status: 'stopping' }))
      setImmediate(onShutdown)
      return
    }
    res.writeHead(404).end(JSON.stringify({ error: 'not_found' }))
  })
}

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function serve({ shouldOpen = true } = {}) {
  const { paths, runtime } = await prepareRuntime({ announceCredentials: true })
  const lock = await acquireLock(paths.lockFile)
  let controlServer = null
  let application = null
  let supervisor = null
  let shuttingDown = false

  const shutdown = async exitCode => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      if (controlServer) await new Promise(resolve => controlServer.close(resolve))
      await supervisor?.stop()
      await application?.stopApplication()
    } finally {
      await rm(paths.runtimeState, { force: true }).catch(() => {})
      await lock.close().catch(() => {})
      await rm(paths.lockFile, { force: true }).catch(() => {})
      if (exitCode !== undefined) process.exit(exitCode)
    }
  }

  try {
    const applicationUrl = pathToFileURL(path.join(paths.appRoot, 'server', 'index.mjs')).href
    application = await import(applicationUrl)
    const started = await application.startApplication({ port: runtime.managementPort, host: '127.0.0.1' })
    const managementUrl = `http://127.0.0.1:${started.port}`
    supervisor = new CoreSupervisor({
      executable: paths.coreExecutable,
      dataDir: paths.coreDir,
      logFile: paths.coreLog,
      controllerUrl: process.env.EMBEDDED_CORE_CONTROLLER_URL,
      secret: process.env.MIHOMO_CONTROLLER_SECRET,
      onExit: ({ code }) => { console.error(`Mihomo 意外退出，code=${code}`); shutdown(1) },
    })
    const core = await supervisor.start()
    const token = randomBytes(32).toString('base64url')
    controlServer = createControlServer(token, () => shutdown(0))
    const controlPort = await listen(controlServer)
    const state = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      managementUrl,
      controlUrl: `http://127.0.0.1:${controlPort}`,
      controlToken: token,
      coreVersion: core.version,
    }
    await writeFile(paths.runtimeState, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    console.log(`Proxy Port Manager 已启动：${managementUrl}`)
    console.log(`Mihomo ${core.version || ''} 已就绪，PID ${supervisor.child?.pid}`)
    if (shouldOpen) openBrowser(managementUrl)
    process.once('SIGINT', () => shutdown(0))
    process.once('SIGTERM', () => shutdown(0))
  } catch (error) {
    console.error(`启动失败：${error.message}`)
    await shutdown(undefined)
    throw error
  }
}

async function waitForBackground(paths, timeoutMs = 20000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const state = await readJson(paths.runtimeState)
    if (state && processAlive(Number(state.pid))) {
      try {
        const response = await fetch(`${state.managementUrl}/healthz`, { signal: AbortSignal.timeout(1000) })
        if (response.ok) return state
      } catch {}
    }
    await delay(250)
  }
  throw new Error('后台服务未能在预期时间内启动，请查看 application.log 和 mihomo.log')
}

async function startBackground({ shouldOpen = true } = {}) {
  const { paths } = await prepareRuntime({ announceCredentials: true })
  const current = await readJson(paths.runtimeState)
  if (current && processAlive(Number(current.pid))) throw new Error(`服务已在运行：${current.managementUrl}`)
  const logFd = openSync(paths.appLog, 'a')
  try {
    const child = spawn(process.execPath, [entryFile, '_serve', '--no-open'], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    })
    child.unref()
  } finally { closeSync(logFd) }
  const state = await waitForBackground(paths)
  console.log(`Proxy Port Manager 已在后台启动：${state.managementUrl}`)
  if (shouldOpen) openBrowser(state.managementUrl)
}

async function stopBackground() {
  const { paths } = await prepareRuntime({ initialize: false })
  const state = await readJson(paths.runtimeState)
  if (!state || !processAlive(Number(state.pid))) {
    await rm(paths.runtimeState, { force: true })
    await rm(paths.lockFile, { force: true })
    console.log('服务未运行')
    return
  }
  const response = await fetch(`${state.controlUrl}/shutdown`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${state.controlToken}` },
    signal: AbortSignal.timeout(3000),
  })
  if (!response.ok) throw new Error(`停止请求失败：HTTP ${response.status}`)
  for (let index = 0; index < 40 && processAlive(Number(state.pid)); index += 1) await delay(250)
  if (processAlive(Number(state.pid))) throw new Error(`服务未能正常停止，PID ${state.pid}`)
  console.log('Proxy Port Manager 已停止')
}

async function showStatus({ open = false } = {}) {
  const { paths } = await prepareRuntime({ initialize: false })
  const state = await readJson(paths.runtimeState)
  if (!state || !processAlive(Number(state.pid))) {
    console.log('状态：未运行')
    process.exitCode = 1
    return
  }
  try {
    const response = await fetch(`${state.managementUrl}/healthz`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    console.log(`状态：运行中，PID ${state.pid}`)
    console.log(`管理页面：${state.managementUrl}`)
    console.log(`Mihomo：${state.coreVersion || '未知版本'}`)
    if (open) openBrowser(state.managementUrl)
  } catch (error) {
    console.log(`状态：进程存在但健康检查失败（${error.message}）`)
    process.exitCode = 1
  }
}

function usage() {
  console.log(`Proxy Port Manager 便携服务\n\n用法：\n  ppm start [--background] [--no-open]\n  ppm stop\n  ppm restart [--background] [--no-open]\n  ppm status\n  ppm open\n\n不带 --background 时在前台运行，按 Ctrl+C 停止。`)
  console.log(`\n${AUTOMATION_USAGE}`)
}

async function main() {
  const [command = 'start', ...args] = process.argv.slice(2)
  if (AUTOMATION_COMMANDS.has(command)) { process.exitCode = await runAutomation(command, args); return }
  if (command === '_serve') return serve({ shouldOpen: !args.includes('--no-open') })
  const options = { shouldOpen: !args.includes('--no-open') }
  if (command === 'start') return args.includes('--background') ? startBackground(options) : serve(options)
  if (command === 'stop') return stopBackground()
  if (command === 'restart') { await stopBackground(); return args.includes('--background') ? startBackground(options) : serve(options) }
  if (command === 'status') return showStatus()
  if (command === 'open') return showStatus({ open: true })
  if (command === '--help' || command === '-h' || command === 'help') return usage()
  throw new Error(`未知命令：${command}`)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
