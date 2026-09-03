import { spawn } from 'node:child_process'
export function run(command, args, { cwd, env = process.env, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errorOutput = '', exceeded = false
    const timer = setTimeout(() => { exceeded = true; child.kill('SIGKILL') }, timeout)
    child.stdout.on('data', value => { output += value; if (output.length > 16 * 1024 * 1024) { exceeded = true; child.kill() } })
    child.stderr.on('data', value => { errorOutput = (errorOutput + value).slice(-4000) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (exceeded) reject(new Error('更新子进程超时或输出过大'))
      else if (code !== 0) reject(new Error(`更新子进程退出（${code}）：${errorOutput.replace(/(?:https?:\/\/)[^\s]+/g, '[URL]')}`))
      else resolve(output.trim())
    })
  })
}
export async function verifyRunning(url, token, version, revision, { timeout = 90000 } = {}) {
  const deadline = Date.now() + timeout
  let message = '服务尚未就绪'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/internal/update-ready`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) })
      if (!response.ok) throw new Error(`服务核验返回 HTTP ${response.status}`)
      const result = await response.json()
      if (result.version !== version || (revision && result.revision !== revision) || result.ready !== true) throw new Error('目标版本、数据库或代理核心尚未就绪')
      return result
    } catch (error) { message = error.message }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(message)
}
