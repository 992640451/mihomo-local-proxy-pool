import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises'
import { once } from 'node:events'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capture } from './build-metadata.mjs'
import { argument } from './release-utils.mjs'
import { tarCommand } from './archive-tools.mjs'
import { smokeWindowsLaunchers } from './smoke-windows-launchers.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function freePort() {
  const socket = net.createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const { port } = socket.address()
  await new Promise(resolve => socket.close(resolve))
  return port
}

// Retain OS runtime essentials only; never use the developer's PPM/auth/database settings.
export function smokeEnvironment(root, managementPort, controllerPort) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|pathext|temp|tmp|tmpdir|home|userprofile|localappdata|lang|lc_all)$/i.test(key)))
  return { ...env, PPM_ROOT: root, PPM_PORTABLE: '1', PPM_MANAGEMENT_PORT: String(managementPort), PPM_CONTROLLER_PORT: String(controllerPort) }
}

export async function smokePortable(archiveFile, { expectedVersion, expectedRevision, expectedMetadata, expectedSbom, requireMetadata = true } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'ppm-release-smoke-'))
  let child, exited, env, node, entry, root
  try {
    const tar = tarCommand()
    const entries = capture(tar, ['-tf', path.resolve(archiveFile)]).split(/\r?\n/)
    if (entries.some(name => /^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$)/.test(name))) throw new Error('不安全的归档路径')
    capture(tar, ['-xf', path.resolve(archiveFile), '-C', temporary])
    const folders = await readdir(temporary, { withFileTypes: true })
    assert.equal(folders.length, 1, '便携包应只包含一个顶层目录')
    root = path.join(temporary, folders[0].name)
    assert.equal(folders[0].isDirectory(), true)
    assert.equal((await readdir(root)).includes('data'), false, '发布包不得含有用户数据')
    if (process.platform === 'win32') {
      const renamed = path.join(temporary, '中文 & portable (test)!')
      await rename(root, renamed)
      root = renamed
    }
    node = path.join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
    entry = path.join(root, 'app', 'scripts', 'launcher.mjs')
    const manifest = JSON.parse(await readFile(path.join(root, 'app', 'package.json'), 'utf8'))
    assert.equal(manifest.version, expectedVersion)
    if (expectedMetadata) assert.deepEqual(JSON.parse(await readFile(path.join(root, 'app', 'build-info.json'), 'utf8')), expectedMetadata, '归档元数据必须与 sidecar 相同')
    if (expectedSbom) assert.deepEqual(JSON.parse(await readFile(path.join(root, 'sbom.cdx.json'), 'utf8')), expectedSbom, '归档 SBOM 必须与 sidecar 相同')
    let controllerPort = await freePort(), managementPort = await freePort()
    while (controllerPort === managementPort) managementPort = await freePort()
    env = smokeEnvironment(root, managementPort, controllerPort)
    let password
    for (let iteration = 0; iteration < 2; iteration += 1) {
      let output = ''
      // Internal no-browser entry also works with historical launcher versions.
      child = spawn(node, [entry, '_serve', '--no-open'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
      exited.catch(() => {})
      const collect = chunk => { output = (output + chunk.toString()).slice(-65536) }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      let state = null
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (child.exitCode !== null) throw new Error('便携服务在就绪前退出（输出可能含密码，不回显）')
        try { state = JSON.parse(await readFile(path.join(root, 'data', 'runtime', 'service.json'), 'utf8')) } catch {}
        if (state) break
        await delay(250)
      }
      assert.ok(state, '便携服务必须在 30 秒内就绪')
      password ||= /管理密码：([^\r\n]+)/.exec(output)?.[1].trim()
      assert.ok(password, '首次启动应生成管理密码')
      const base = `http://127.0.0.1:${managementPort}`
      const request = (url, options = {}) => fetch(`${base}${url}`, { ...options, signal: AbortSignal.timeout(5000) })
      assert.equal((await request('/healthz')).status, 200)
      const page = await request('/')
      assert.equal(page.status, 200)
      assert.match(await page.text(), /<div id="root">/)
      assert.equal((await request('/api/runtime')).status, 401)
      const config = await readFile(path.join(root, 'data', 'config.env'), 'utf8')
      const username = /^AUTH_USERNAME=(.+)$/m.exec(config)?.[1].trim()
      const login = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
      assert.equal(login.status, 200, '自动生成的凭据应可登录')
      const response = await request('/api/runtime', { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } })
      assert.equal(response.status, 200)
      const runtime = await response.json()
      assert.equal(runtime.core?.reachable, true, 'Mihomo 必须真实就绪')
      if (requireMetadata) {
        assert.equal(runtime.buildInfo?.version, expectedVersion)
        if (expectedRevision) assert.equal(runtime.buildInfo?.revision, expectedRevision)
        assert.ok(runtime.buildInfo?.builtAt)
      }
      // Use the shipped stop command rather than killing a healthy service.
      const stop = spawn(node, [entry, 'stop'], { cwd: root, env, stdio: 'ignore', windowsHide: true })
      const stopResult = await new Promise((resolve, reject) => { stop.once('error', reject); stop.once('exit', code => resolve(code)) })
      assert.equal(stopResult, 0, 'ppm stop 应正常退出')
      const result = await Promise.race([exited, delay(15000).then(() => null)])
      assert.equal(result?.code, 0, '便携服务应干净退出')
      assert.equal((await readdir(path.join(root, 'data', 'runtime'))).includes('service.lock'), false)
      child = null
    }
    const windowsLaunchers = process.platform === 'win32' ? await smokeWindowsLaunchers(root, env) : { tested: false }
    return { version: manifest.version, restarted: true, windowsLaunchers }
  } finally {
    if (child && child.exitCode === null) {
      // Best effort cooperative cleanup; only kill this test's own process tree.
      try { capture(node, [entry, 'stop'], { cwd: root, env, timeout: 15000 }) } catch {}
      if (child.exitCode === null) {
        if (process.platform === 'win32') { try { capture('taskkill.exe', ['/pid', String(child.pid), '/T', '/F']) } catch {} }
        else child.kill('SIGTERM')
        await Promise.race([exited.catch(() => {}), delay(5000)])
      }
    }
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smokePortable(argument(process.argv, '--archive'), { expectedVersion: argument(process.argv, '--version'), expectedRevision: argument(process.argv, '--revision') })
    .then(() => console.log('便携包首次启动、认证、核心健康、停止和重启测试通过'))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
