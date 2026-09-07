import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { automationBaseUrl, smallSecret } from './automation-cli.mjs'

// Browser adapters only own lifecycle. Node selection remains in the manager.
export async function createBrowserAdapter(browser, { env = process.env, fetchImpl = fetch, spawnImpl = spawn, wait = sleep } = {}) {
  if (browser?.type === 'roxy') {
    if (typeof browser.workspaceId !== 'string' || !browser.workspaceId || typeof browser.dirId !== 'string' || !browser.dirId) throw new Error('Roxy 配置需要字符串 workspaceId 和 dirId')
    const apiUrl = automationBaseUrl(browser.apiUrl || 'http://127.0.0.1:50000')
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(apiUrl).hostname)) throw new Error('Roxy 适配器只连接本机 API')
    const secret = await smallSecret(env, 'ROXY_API_KEY')
    if (!secret) throw new Error('请通过 ROXY_API_KEY_FILE 或 ROXY_API_KEY 设置 Roxy API Key')
    const call = async (path, body) => {
      let response
      try { response = await fetchImpl(`${apiUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { token: secret, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) }) }
      catch { throw new Error('Roxy API 连接失败；保留会话绑定，请核对浏览器状态') }
      if (!response.ok) throw new Error(`Roxy API 返回 HTTP ${response.status}`)
      const value = await response.json()
      if (value.code !== 0) throw new Error('Roxy 操作未成功；请在浏览器中核对状态')
      return value.data
    }
    const running = async () => {
      const items = await call(`/browser/connection_info?${new URLSearchParams({ dirIds: browser.dirId })}`)
      if (!Array.isArray(items) || items.some(item => typeof item.dirId !== 'string')) throw new Error('无法识别 Roxy 窗口状态，请保留会话并检查客户端版本')
      return items.some(item => item.dirId === browser.dirId)
    }
    return {
      running,
      async open() { await call('/browser/open', { workspaceId: browser.workspaceId, dirId: browser.dirId, forceOpen: false }) },
      async waitForExit() {
        // Wait for the opened profile to become visible before treating absence as exit.
        let observed = false
        for (let attempt = 0; attempt < 30; attempt++) { if (await running()) { observed = true; break }; await wait(1000) }
        if (!observed) throw new Error('未确认 Roxy 窗口启动，已保留会话；请核对后手动结束')
        while (await running()) await wait(1000)
      },
    }
  }
  if (browser?.type === 'command') {
    if (typeof browser.executable !== 'string' || !browser.executable || !Array.isArray(browser.args) || browser.args.some(arg => typeof arg !== 'string') || browser.lifecycle !== 'process') {
      throw new Error('命令适配需要 executable、args 和 lifecycle: process；必须启动独立且不转交到已有进程的程序')
    }
    let child, completion
    return {
      running: async () => false,
      async open() {
        // Do not pass manager/browser API credentials to the launched application.
        const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(PPM_API_TOKEN|ROXY_API_KEY)(_|$)/i.test(key)))
        child = spawnImpl(browser.executable, browser.args, { shell: false, windowsHide: true, stdio: 'ignore', env: childEnv })
        completion = new Promise((resolve, reject) => { child.once('error', () => reject(new Error('浏览器启动失败，请检查可执行文件和参数'))); child.once('exit', (code, signal) => resolve({ code, signal })) })
        completion.catch(() => {})
        try { await once(child, 'spawn') }
        catch { throw Object.assign(new Error('浏览器未能启动，请检查可执行文件路径'), { definitelyNotStarted: true }) }
      },
      async waitForExit() { await completion },
    }
  }
  throw new Error('browser.type 仅支持 roxy 或 command')
}

export async function launchBrowserSession(config, { request, env, fetchImpl, print = console.log, adapter: suppliedAdapter } = {}) {
  if (!Number.isInteger(config?.port) || config.port < 1024 || config.port > 65535 || typeof config.profileId !== 'string' || !config.profileId || config.profileId.length > 256) throw new Error('启动配置需要有效 port 和唯一 profileId')
  const adapter = suppliedAdapter || await createBrowserAdapter(config.browser, { env, fetchImpl })
  const base = `/ports/${config.port}`, current = await request(`${base}/session`)
  const running = await adapter.running()
  if (current.session) {
    if (current.state === 'active' && current.session.profileId === config.profileId && running) {
      print({ state: 'already-running', port: config.port, nodeName: current.session.nodeName }); return 0
    }
    throw new Error('此端口有未结束的会话；请等启动器确认退出，或核对浏览器已关闭后在管理页面结束使用')
  }
  if (running) throw new Error('浏览器配置文件已经打开，请关闭后通过此入口启动')
  const launchId = randomUUID()
  let result
  try { result = await request(`${base}/sessions`, { launchId, profileId: config.profileId }) }
  catch {
    const recovered = await request(`${base}/session`)
    if (recovered.state !== 'active' || recovered.session?.launchId !== launchId) throw new Error('会话尚未确认，请查询端口状态；浏览器未启动')
    result = recovered
  }
  if (result.state !== 'active' || !result.session?.sessionId) throw new Error('会话尚未激活，浏览器未启动')
  print({ state: 'active', port: config.port, nodeName: result.session.nodeName, sessionId: result.session.sessionId })
  // On a lost launch response or lifecycle error keep the node fixed. Never infer exit.
  try { await adapter.open() }
  catch (error) {
    if (error.definitelyNotStarted) await request(`${base}/sessions/${encodeURIComponent(result.session.sessionId)}/end`, {})
    throw error
  }
  await adapter.waitForExit()
  await request(`${base}/sessions/${encodeURIComponent(result.session.sessionId)}/end`, {})
  print({ state: 'ended', port: config.port })
  return 0
}
