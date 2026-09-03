import path from 'node:path'
import { readJson, writeJson } from './files.mjs'
import { compareVersions, UPDATE_REPOSITORY, verifyManifest } from './manifest.mjs'
const CACHE_MS = 6 * 60 * 60 * 1000

export async function fetchJson(url, fetcher = fetch) {
  const response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Proxy-Port-Manager-Updates' }, signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error(`版本源暂时不可用（HTTP ${response.status}）`)
  if (Number(response.headers.get('content-length')) > 1024 * 1024) throw new Error('版本响应过大')
  const chunks = []; let size = 0
  for await (const chunk of response.body) { size += chunk.length; if (size > 1024 * 1024) throw new Error('版本响应过大'); chunks.push(chunk) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export class UpdateDiscovery {
  constructor({ directory, version, keys, fetcher = fetch, now = Date.now }) { Object.assign(this, { directory, version, keys, fetcher, now }); this.pending = null; this.lastAttempt = 0 }
  async check({ force = false, online = true } = {}) {
    const cached = await readJson(path.join(this.directory, 'discovery.json'))
    if (cached) {
      cached.currentVersion = this.version
      try { cached.hasUpdate = Boolean(cached.latestVersion && compareVersions(cached.latestVersion, this.version) > 0) } catch { cached.hasUpdate = false }
    }
    if (!online) return cached || { currentVersion: this.version, checkedAt: null, hasUpdate: false }
    if (!force && cached && this.now() - cached.checkedAt < CACHE_MS) return cached
    if (this.pending) return this.pending
    if (this.now() - this.lastAttempt < 30000) return cached || { currentVersion: this.version, hasUpdate: false, warning: '请稍后再检查' }
    this.lastAttempt = this.now()
    this.pending = this.load().finally(() => { this.pending = null })
    return this.pending
  }
  async load() {
    const result = { currentVersion: this.version, checkedAt: this.now(), hasUpdate: false, latestVersion: null }
    try {
      const release = await fetchJson(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`, this.fetcher)
      const version = String(release.tag_name || '').replace(/^v/, '')
      if (release.draft || release.prerelease) throw new Error('版本源没有可用的正式发布')
      result.latestVersion = version
      result.hasUpdate = compareVersions(version, this.version) > 0
      result.releaseUrl = `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${version}`
      result.notes = String(release.body || '').slice(0, 20000)
      result.publishedAt = release.published_at
      if (result.hasUpdate) {
        const asset = release.assets?.find(item => item.name === 'update-manifest.json')
        if (!asset) result.unsupportedReason = '此版本尚未提供网页更新清单，请按发布说明更新'
        else {
          const envelope = await fetchJson(`https://github.com/${UPDATE_REPOSITORY}/releases/download/v${version}/update-manifest.json`, this.fetcher)
          const verified = verifyManifest(envelope, this.keys, this.version)
          if (verified.manifest.version !== version) throw new Error('发布版本与更新清单不一致')
          Object.assign(result, verified, { envelope })
        }
      }
    } catch (error) { result.warning = error.message; result.hasUpdate = Boolean(result.latestVersion && result.hasUpdate) }
    await writeJson(path.join(this.directory, 'discovery.json'), result)
    return result
  }
}
