import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { fetch } from 'undici'

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
    || (parts[0] >= 224) || address === '100.100.100.200'
}

function blockedIp(address) {
  if (isIP(address) === 4) return blockedIpv4(address)
  const value = address.toLowerCase()
  return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')
}

async function assertPublicUrl(url, allowPrivateNetworks) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('订阅地址仅支持 HTTP/HTTPS')
  if (url.username || url.password) throw new Error('订阅地址不能包含 URL 用户名或密码')
  if (allowPrivateNetworks) return
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(item => blockedIp(item.address))) throw new Error('订阅地址解析到内网、环回或保留地址')
}

export async function fetchSubscription(rawUrl, options = {}) {
  const maxBytes = Number(options.maxBytes || 5 * 1024 * 1024)
  let url
  try { url = new URL(String(rawUrl || '')) } catch { throw new Error('订阅地址无效') }
  for (let redirect = 0; redirect <= Number(options.maxRedirects ?? 3); redirect += 1) {
    await assertPublicUrl(url, options.allowPrivateNetworks === true)
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(Number(options.timeoutMs || 20000)),
      headers: {
        Accept: 'application/yaml,text/yaml,text/plain,*/*',
        'User-Agent': options.userAgent || 'mihomo/1.19.28',
        ...(options.etag ? { 'If-None-Match': options.etag } : {}),
        ...(options.lastModified ? { 'If-Modified-Since': options.lastModified } : {}),
      },
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location || redirect === Number(options.maxRedirects ?? 3)) throw new Error('订阅重定向次数过多')
      await response.body?.cancel()
      url = new URL(location, url)
      continue
    }
    if (response.status === 304) return { notModified: true, etag: options.etag || null, lastModified: options.lastModified || null }
    if (!response.ok) {
      const detail = await responseDetail(response)
      throw new Error(`订阅下载失败：HTTP ${response.status}${detail ? `（${detail}）` : ''}`)
    }
    const announced = Number(response.headers.get('content-length') || 0)
    if (announced > maxBytes) throw new Error(`订阅内容超过 ${maxBytes} 字节上限`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maxBytes) throw new Error(`订阅内容超过 ${maxBytes} 字节上限`)
    return {
      notModified: false,
      content: bytes.toString('utf8'),
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    }
  }
  throw new Error('订阅下载失败')
}
