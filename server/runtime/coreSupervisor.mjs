import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

export class CoreSupervisor {
  constructor({ executable, dataDir, logFile, controllerUrl, secret = '', startupTimeoutMs = 15000, onExit = null } = {}) {
    this.executable = executable
    this.dataDir = dataDir
    this.logFile = logFile
    this.controllerUrl = controllerUrl?.replace(/\/$/, '')
    this.secret = secret
    this.startupTimeoutMs = startupTimeoutMs
    this.onExit = typeof onExit === 'function' ? onExit : null
    this.child = null
    this.logStream = null
    this.stopping = false
  }

  async status() {
    if (!this.controllerUrl) return { reachable: false, version: null }
    try {
      const response = await fetch(`${this.controllerUrl}/version`, {
        headers: this.secret ? { Authorization: `Bearer ${this.secret}` } : {},
        signal: AbortSignal.timeout(1500),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      return { reachable: true, version: body.version || null, meta: body.meta === true }
    } catch (error) {
      return { reachable: false, version: null, error: error.message }
    }
  }

  async start() {
    if (this.child) return this.status()
    await access(this.executable)
    this.logStream = createWriteStream(this.logFile, { flags: 'a' })
    this.logStream.write(`\n[${new Date().toISOString()}] starting ${this.executable}\n`)
    const child = spawn(this.executable, ['-d', this.dataDir], {
      cwd: path.dirname(this.executable),
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout.pipe(this.logStream, { end: false })
    child.stderr.pipe(this.logStream, { end: false })
    child.once('exit', (code, signal) => {
      this.logStream?.write(`[${new Date().toISOString()}] exited code=${code} signal=${signal}\n`)
      this.child = null
      if (!this.stopping) this.onExit?.({ code, signal })
    })
    const startedAt = Date.now()
    while (Date.now() - startedAt < this.startupTimeoutMs) {
      if (!this.child) throw new Error('Mihomo 在健康检查完成前退出，请查看 mihomo.log')
      const status = await this.status()
      if (status.reachable) return status
      await delay(250)
    }
    await this.stop()
    throw new Error(`Mihomo 在 ${this.startupTimeoutMs}ms 内未就绪，请查看 mihomo.log`)
  }

  async stop({ timeoutMs = 5000 } = {}) {
    if (!this.child) {
      this.logStream?.end()
      this.logStream = null
      return
    }
    this.stopping = true
    const child = this.child
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM')
    await Promise.race([exited, delay(timeoutMs)])
    if (this.child === child) {
      child.kill('SIGKILL')
      await Promise.race([exited, delay(1000)])
    }
    this.child = null
    this.logStream?.end()
    this.logStream = null
    this.stopping = false
  }
}
