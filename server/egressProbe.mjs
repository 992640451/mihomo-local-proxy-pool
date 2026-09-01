import { ProxyAgent, fetch as undiciFetch } from 'undici'

const regionNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' })

export function normalizeEgressPayload(payload = {}) {
  if (payload.success === false) throw new Error(payload.message || '出口地理信息查询失败')
  const countryCode = String(payload.country_code || '').toUpperCase()
  const ip = String(payload.ip || '')
  if (!ip || !/^[A-Z]{2}$/.test(countryCode)) throw new Error('出口地理信息响应不完整')
  return {
    ip,
    countryCode,
    country: regionNames.of(countryCode) || String(payload.country || countryCode),
    region: String(payload.region || ''),
    city: String(payload.city || ''),
    flag: String(payload.flag?.emoji || ''),
  }
}

export async function probeProxyEgress({ host, port, lookupUrl = process.env.EGRESS_LOOKUP_URL || 'https://ipwho.is/', timeoutMs = 10000 }) {
  const numericPort = Number(port)
  if (!host || !Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) throw new Error('出口检测代理地址无效')
  const dispatcher = new ProxyAgent(`http://${host}:${numericPort}`)
  const started = Date.now()
  try {
    const response = await undiciFetch(lookupUrl, { dispatcher, signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`出口地理信息查询失败：HTTP ${response.status}`)
    return { ...normalizeEgressPayload(await response.json()), latencyMs: Date.now() - started, checkedAt: new Date().toISOString() }
  } finally {
    await dispatcher.close()
  }
}
