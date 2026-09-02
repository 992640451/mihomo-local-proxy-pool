import { open, readFile, stat } from 'node:fs/promises'
import { RECOVERY_MAX_FILE_BYTES } from '../shared/recoveryLimits.js'
import { redactText } from '../server/security/redaction.mjs'

export const AUTOMATION_COMMANDS = new Set(['doctor', 'backup', 'restore', 'ports', 'subscriptions'])
export const AUTOMATION_USAGE = `自动化（需要设置 PPM_API_TOKEN 或 PPM_API_TOKEN_FILE）：
  ppm doctor [--url http://127.0.0.1:4173]
  ppm ports list
  ppm subscriptions refresh <id|--all>
  ppm backup <file.json>
  ppm restore <file.json> [--dry-run] [--plan plan.json]
  ppm restore <file.json> --apply --plan plan.json

--url 也可通过 PPM_API_URL 设置。备份口令由 PPM_BACKUP_PASSWORD_FILE
或 PPM_BACKUP_PASSWORD 提供。输出 JSON；失败退出码 1，预检阻塞/诊断异常/
部分刷新失败退出码 2。文件不会被覆盖；恢复默认只预检，应用必须使用已保存的计划。
远程只支持 HTTPS，HTTP 仅允许 localhost / 127.0.0.1 / [::1]。不自动重试写操作。`

export function automationBaseUrl(value = 'http://127.0.0.1:4173') {
  let url
  try { url = new URL(value) } catch { throw new Error('PPM_API_URL / --url 不是有效地址') }
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含凭据、查询参数或片段')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('远程 API 必须使用 HTTPS；HTTP 只允许回环地址')
  return url.toString().replace(/\/$/, '')
}

async function smallSecret(env, name) {
  const filename = env[`${name}_FILE`]
  if (filename) {
    if ((await stat(filename)).size > 4096) throw new Error(`${name}_FILE 文件过大`)
    return (await readFile(filename, 'utf8')).replace(/\r?\n$/, '')
  }
  return env[name] || ''
}

async function readJsonFile(filename, maximum = RECOVERY_MAX_FILE_BYTES) {
  if (!filename) throw new Error('缺少文件路径')
  if ((await stat(filename)).size > maximum) throw new Error('文件超过允许的大小')
  try { return JSON.parse(await readFile(filename, 'utf8')) } catch { throw new Error('文件不是有效的 JSON') }
}

async function writeNewJson(filename, data) {
  // Exclusive creation prevents accidental overwrites; POSIX permissions are owner-only.
  const handle = await open(filename, 'wx', 0o600)
  try { await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`); await handle.sync() }
  finally { await handle.close() }
}

function parseArguments(args) {
  const options = {}, positional = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (['--url', '--plan'].includes(arg)) {
      if (options[arg] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`参数 ${arg} 缺少值或重复`)
      options[arg] = args[++index]
    } else if (['--all', '--apply', '--dry-run'].includes(arg)) {
      if (options[arg]) throw new Error(`重复参数：${arg}`)
      options[arg] = true
    } else if (arg.startsWith('-')) throw new Error('不支持的参数；使用 --help 查看用法（密钥和口令不可作为命令行参数）')
    else positional.push(arg)
  }
  return { options, positional }
}

export async function runAutomation(command, args, { env = process.env, fetchImpl = fetch, stdout = text => console.log(text) } = {}) {
  if (args.includes('--help') || args.includes('-h')) { stdout(AUTOMATION_USAGE); return 0 }
  const { options, positional } = parseArguments(args)
  const allowedOptions = { doctor: ['--url'], ports: ['--url'], subscriptions: ['--url', '--all'], backup: ['--url'], restore: ['--url', '--plan', '--apply', '--dry-run'] }[command]
  if (!allowedOptions || Object.keys(options).some(option => !allowedOptions.includes(option))) throw new Error('命令包含不支持的选项；使用 --help 查看用法')
  if (command === 'doctor' && positional.length) throw new Error('doctor 不接受位置参数')
  if (command === 'ports' && (positional.length !== 1 || positional[0] !== 'list')) throw new Error('用法：ppm ports list')
  if (command === 'subscriptions' && (positional[0] !== 'refresh' || (options['--all'] ? positional.length !== 1 : positional.length !== 2))) throw new Error('用法：ppm subscriptions refresh <id|--all>')
  if (['backup', 'restore'].includes(command) && positional.length !== 1) throw new Error(`用法：ppm ${command} <file.json>`)
  if (options['--apply'] && (options['--dry-run'] || !options['--plan'])) throw new Error('--apply 必须提供 --plan，且不能与 --dry-run 同时使用')
  const baseUrl = automationBaseUrl(options['--url'] || env.PPM_API_URL)
  const secret = await smallSecret(env, 'PPM_API_TOKEN')
  if (!/^ppm_[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('请通过 PPM_API_TOKEN 或 PPM_API_TOKEN_FILE 提供有效 API 令牌')
  const request = async (path, body) => {
    let response
    try {
      response = await fetchImpl(`${baseUrl}/api/v1${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${secret}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000),
      })
    } catch { throw new Error('API 连接失败、超时或发生重定向；请检查地址和服务状态（写操作请先查询状态，勿盲目重试）') }
    let size = 0, chunks = []
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > RECOVERY_MAX_FILE_BYTES) throw new Error('API 响应超过允许的大小')
      chunks.push(chunk)
    }
    let data
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error(`API 返回非 JSON 响应（HTTP ${response.status}）`) }
    if (!response.ok) throw new Error(redactText(`HTTP ${response.status} ${data.error?.code || 'API_ERROR'}：${data.error?.message || '操作失败'}${data.error?.requestId ? ` (requestId: ${data.error.requestId})` : ''}`))
    return data
  }
  const print = data => stdout(JSON.stringify(data, null, 2))
  if (command === 'doctor') { const result = await request('/diagnostics'); print(result); return result.status === 'ok' ? 0 : 2 }
  if (command === 'ports') { print(await request('/ports')); return 0 }
  if (command === 'subscriptions') {
    const result = await request(options['--all'] ? '/subscriptions/refresh-all' : `/subscriptions/${encodeURIComponent(positional[1])}/refresh`, {})
    print(result); return result.results?.some(item => !item.ok) ? 2 : 0
  }
  const password = await smallSecret(env, 'PPM_BACKUP_PASSWORD')
  if (password.length < 8 || password.length > 256) throw new Error('请通过 PPM_BACKUP_PASSWORD_FILE 或 PPM_BACKUP_PASSWORD 提供 8–256 字符的备份口令')
  if (command === 'backup') {
    const result = await request('/config/export', { password })
    await writeNewJson(positional[0], result)
    print({ saved: positional[0], summary: result.summary }); return 0
  }
  const recoveryPackage = await readJsonFile(positional[0])
  if (options['--apply']) {
    const plan = await readJsonFile(options['--plan'], 8 * 1024 * 1024)
    if (!plan.canApply || !plan.planToken || plan.baseUrl !== baseUrl) throw new Error('计划不可应用或目标地址不匹配，请重新预检')
    print(await request('/config/apply', { recoveryPackage, password, planToken: plan.planToken })); return 0
  }
  const result = { ...await request('/config/plan', { recoveryPackage, password }), baseUrl }
  if (options['--plan']) await writeNewJson(options['--plan'], result)
  print(result); return result.canApply ? 0 : 2
}
