import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Agent, fetch } from 'undici'

const DEFAULT_DOH_URLS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']

async function responseDetail(response) {
  if (!response.body) return ''
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    while (size < 8192) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = 8192 - size
      chunks.push(Buffer.from(value).subarray(0, remaining))
      size += Math.min(value.byteLength, remaining)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  let detail = text
  try {
    const parsed = JSON.parse(text)
    detail = String(parsed.message || parsed.error || parsed.detail || '')
  } catch {}
  return detail
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/[a-f0-9]{24,}/gi, '[已隐藏]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[已隐藏]')
    .slice(0, 240)
}

function blockedIpv4(address) {
  const parts = address.split('.').map(Number)
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19))
    || (parts[0] >= 224)
}

function blockedIp(address) {
  if (isIP(address) === 4) return blockedIpv4(address)
  const value = address.toLowerCase()
  return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')
}

function fakeIp(address) {
  if (isIP(address) === 4) {
    const [first, second] = address.split('.').map(Number)
    return first === 198 && (second === 18 || second === 19)
  }
  return isIP(address) === 6 && address.toLowerCase().startsWith('fdfe:dcba:9876:')
}

function normalizeAddresses(records) {
  const seen = new Set(), addresses = []
  for (const record of records || []) {
    const address = typeof record === 'string' ? record : record?.address
    const family = isIP(address)
    if (!family || seen.has(address)) continue
    seen.add(address)
    addresses.push({ address, family })
  }
  return addresses
}

async function dohQuery(hostname, type, endpoint, fetchImpl, timeoutMs) {
  const url = new URL(endpoint)
  if (url.protocol !== 'https:') throw new Error('DoH 地址必须使用 HTTPS')
  url.searchParams.set('name', hostname)
  url.searchParams.set('type', type)
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/dns-json' },
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`DoH HTTP ${response.status}`)
  }
  const payload = await response.json()
  if (Number(payload.Status) !== 0 && Number(payload.Status) !== 3) throw new Error(`DoH DNS 状态 ${payload.Status}`)
  const family = type === 'AAAA' ? 6 : 4
  return normalizeAddresses((payload.Answer || []).filter(item => Number(item.type) === (family === 6 ? 28 : 1)).map(item => item.data))
}

async function secureLookup(hostname, options) {
  if (options.dohLookup) return normalizeAddresses(await options.dohLookup(hostname))
  const endpoints = options.dohUrls?.length ? options.dohUrls : DEFAULT_DOH_URLS
  const timeoutMs = Number(options.dohTimeoutMs || 5000)
  const fetchImpl = options.dohFetch || fetch
  for (const endpoint of endpoints) {
    const results = await Promise.allSettled([
      dohQuery(hostname, 'A', endpoint, fetchImpl, timeoutMs),
      dohQuery(hostname, 'AAAA', endpoint, fetchImpl, timeoutMs),
    ])
    const addresses = normalizeAddresses(results.flatMap(result => result.status === 'fulfilled' ? result.value : []))
    if (addresses.length) return addresses
  }
  throw new Error('订阅地址安全 DNS 解析失败')
}

function pinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    const family = typeof options === 'number' ? options : Number(options?.family || 0)
    const candidates = family ? addresses.filter(item => item.family === family) : addresses
    if (!candidates.length) {
      const error = new Error('没有匹配地址族的已校验订阅地址')
      error.code = 'ENOTFOUND'
      return callback(error)
    }
    if (typeof options === 'object' && options?.all) return callback(null, candidates)
    callback(null, candidates[0].address, candidates[0].family)
  }
}

function pinnedDispatcher(addresses, timeoutMs) {
  return new Agent({
    autoSelectFamily: addresses.some(item => item.family === 4) && addresses.some(item => item.family === 6),
    connect: { lookup: pinnedLookup(addresses), timeout: timeoutMs },
  })
}

async function assertPublicUrl(url, options) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('订阅地址仅支持 HTTP/HTTPS')
  if (url.username || url.password) throw new Error('订阅地址不能包含 URL 用户名或密码')
  if (options.allowPrivateNetworks === true) return null
  const lookupFn = options.lookup || lookup
  let addresses = isIP(url.hostname) ? [{ address: url.hostname, family: isIP(url.hostname) }] : normalizeAddresses(await lookupFn(url.hostname, { all: true, verbatim: true }))
  if (addresses.length && addresses.every(item => fakeIp(item.address))) addresses = await secureLookup(url.hostname, options)
  if (!addresses.length || addresses.some(item => blockedIp(item.address))) throw new Error('订阅地址解析到内网、环回或保留地址')
  return addresses
}

export async function fetchSubscription(rawUrl, options = {}) {
  const maxBytes = Number(options.maxBytes || 5 * 1024 * 1024)
  const timeoutMs = Number(options.timeoutMs || 20000)
  let url
  try { url = new URL(String(rawUrl || '')) } catch { throw new Error('订阅地址无效') }
  for (let redirect = 0; redirect <= Number(options.maxRedirects ?? 3); redirect += 1) {
    const addresses = await assertPublicUrl(url, options)
    const dispatcher = addresses && !isIP(url.hostname)
      ? (options.dispatcherFactory || pinnedDispatcher)(addresses, timeoutMs)
      : null
    try {
      const response = await (options.request || fetch)(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        ...(dispatcher ? { dispatcher } : {}),
        headers: {
          Accept: 'application/yaml,text/yaml,text/plain,*/*',
          'User-Agent': options.userAgent || 'mihomo/1.19.28',
          ...(options.etag ? { 'If-None-Match': options.etag } : {}),
          ...(options.lastModified ? { 'If-Modified-Since': options.lastModified } : {}),
        },
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => {})
        if (!location || redirect === Number(options.maxRedirects ?? 3)) throw new Error('订阅重定向次数过多')
        url = new URL(location, url)
        continue
      }
      if (response.status === 304) {
        await response.body?.cancel().catch(() => {})
        return { notModified: true, etag: options.etag || null, lastModified: options.lastModified || null }
      }
      if (!response.ok) {
        const detail = await responseDetail(response)
        throw new Error(`订阅下载失败：HTTP ${response.status}${detail ? `（${detail}）` : ''}`)
      }
      const announced = Number(response.headers.get('content-length') || 0)
      if (announced > maxBytes) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`订阅内容超过 ${maxBytes} 字节上限`)
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > maxBytes) throw new Error(`订阅内容超过 ${maxBytes} 字节上限`)
      return {
        notModified: false,
        content: bytes.toString('utf8'),
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
      }
    } finally {
      await dispatcher?.close().catch(() => {})
    }
  }
  throw new Error('订阅下载失败')
}
