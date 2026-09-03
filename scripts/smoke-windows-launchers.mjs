import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { WINDOWS_LAUNCHERS } from './portable-launchers.mjs'

// Exercise cmd.exe itself (including quoting, UTF-8 output and pause), from outside
// the install directory. Never echo captured output: first start contains a password.
export function runWindowsLauncher(filename, args = [], { env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${filename}" ${args.join(' ')}"`], {
      env, cwd, windowsHide: true, windowsVerbatimArguments: true,
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 45000,
    })
    let output = ''
    const collect = chunk => { output = (output + chunk).slice(-65536) }
    child.stdout.setEncoding('utf8').on('data', collect)
    child.stderr.setEncoding('utf8').on('data', collect)
    child.stdin.on('error', () => {})
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, output }))
    child.stdin.end('\r\n') // Acknowledge pause just as a user would after reading.
  })
}

export async function smokeWindowsLaunchers(root, baseEnv) {
  const files = await readdir(root)
  // Keep release tooling usable with historical bundles without these launchers.
  if (!WINDOWS_LAUNCHERS.some(file => files.includes(file))) return { tested: false }
  for (const file of [...WINDOWS_LAUNCHERS, '开始使用.txt', 'START_HERE.txt']) {
    assert.ok(files.includes(file), `便携包缺少 ${file}`)
  }
  await readFile(path.join(root, 'bin', 'ppm.cmd'))
  assert.ok(!files.includes('ppm.cmd') && !files.includes('ppm'), 'Windows 包根目录只保留中文操作入口')
  const dataDir = path.join(root, '双击测试 data')
  const env = { ...baseEnv, PPM_DATA_DIR: dataDir }
  const run = (index, args = []) => runWindowsLauncher(path.join(root, WINDOWS_LAUNCHERS[index]), args, { env, cwd: path.dirname(root) })
  const stateFile = path.join(dataDir, 'runtime', 'service.json')
  const configFile = path.join(dataDir, 'config.env')
  const readState = async () => JSON.parse(await readFile(stateFile, 'utf8'))
  try {
    const unopened = await run(1, ['--no-open'])
    assert.equal(unopened.code, 1, '未运行时打开页面应提示失败')
    await assert.rejects(readFile(configFile), { code: 'ENOENT' }, '打开未运行实例不得生成密码')
    const started = await run(0, ['--no-open'])
    assert.equal(started.code, 0, '双击启动应在父窗口退出后保持后台运行')
    const password = /管理密码：([^\r\n]+)/.exec(started.output)?.[1].trim()
    assert.ok(password, '首次双击启动必须在当前窗口显示密码')
    const original = await readState()
    await assert.rejects(readFile(path.join(root, 'bin', 'data', 'config.env')), { code: 'ENOENT' }, '移动入口不得改变数据根目录')
    const config = await readFile(configFile, 'utf8')
    const username = /^AUTH_USERNAME=(.+)$/m.exec(config)?.[1].trim()
    const login = await fetch(`${original.managementUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(5000),
    })
    assert.equal(login.status, 200, '启动窗口中的凭据必须能登录')
    await login.arrayBuffer()
    assert.ok(!(await readFile(path.join(dataDir, 'logs', 'application.log'), 'utf8')).includes(password), '后台日志不得泄露首次密码')
    assert.ok(!config.includes(password), '配置不得保存明文密码')
    const repeated = await run(0, ['--no-open'])
    assert.equal(repeated.code, 0, '重复双击启动应成功')
    assert.equal((await readState()).pid, original.pid, '重复双击不得产生新服务')
    assert.ok(!repeated.output.includes(password), '重复启动不应再次显示密码')
    assert.equal((await run(1, ['--no-open'])).code, 0, '运行中可打开页面入口')
    assert.equal((await run(2)).code, 0, '双击停止应成功')
    await assert.rejects(readFile(stateFile), { code: 'ENOENT' })
    assert.equal(await readFile(configFile, 'utf8'), config, '停止服务必须保留配置和密钥')
    assert.equal((await run(2)).code, 0, '重复停止应成功')
    assert.equal((await run(0, ['--no-open'])).code, 0, '双击入口支持再次启动')
    assert.equal(await readFile(configFile, 'utf8'), config, '重启不得重新初始化')
    return { tested: true, restarted: true }
  } finally {
    // Cooperative cleanup of this test's isolated instance, never a user's service.
    const stopped = await run(2)
    assert.equal(stopped.code, 0, '清理双击测试实例必须正常停止')
  }
}
