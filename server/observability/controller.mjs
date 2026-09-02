export class ObservationError extends Error {
  constructor(message, status = 400, code = 'OBSERVATION_FAILED') { super(message); this.status = status; this.code = code }
}

export class ObservationController {
  constructor({ url = process.env.EMBEDDED_CORE_CONTROLLER_URL || '', secret = process.env.EMBEDDED_CORE_SECRET || '', fetchImpl = fetch,
    testUrl = process.env.OBSERVABILITY_TEST_URL || 'https://www.gstatic.com/generate_204' } = {}) {
    Object.assign(this, { url, secret, fetchImpl, testUrl })
  }
  async request(pathname, { timeoutMs = 5000, signal } = {}) {
    if (!this.url) throw new ObservationError('此部署未配置内置 Mihomo Controller', 501, 'OBSERVATION_UNSUPPORTED')
    const response = await this.fetchImpl(`${this.url.replace(/\/$/, '')}${pathname}`, {
      headers: this.secret ? { Authorization: `Bearer ${this.secret}` } : {}, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) { await response.body?.cancel(); throw new ObservationError(`Mihomo 检测返回 HTTP ${response.status}`, 502) }
    let size = 0
    const chunks = []
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 8 * 1024 * 1024) throw new Error('Mihomo 响应超过容量上限')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  async proxies(options) { return (await this.request('/proxies', options)).proxies || {} }
  async delay(id, { timeoutMs, signal }) {
    const query = new URLSearchParams({ url: this.testUrl, timeout: String(timeoutMs) })
    const result = await this.request(`/proxies/${encodeURIComponent(`ppm-node-${id}`)}/delay?${query}`, { timeoutMs: timeoutMs + 1000, signal })
    if (!Number.isFinite(result.delay) || result.delay <= 0) throw new Error('节点未返回有效延迟')
    return result.delay
  }
}
