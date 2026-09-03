import { createHash, verify } from 'node:crypto'
export const UPDATE_REPOSITORY = '992640451/mihomo-local-proxy-pool'
export const UPDATE_PROTOCOL = 1
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export function compareVersions(a, b) {
  if (!VERSION.test(a || '') || !VERSION.test(b || '')) throw new Error('仅支持正式语义化版本')
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1
  return 0
}
export function releaseUrl(url, version) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.host !== 'github.com' || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.startsWith(`/${UPDATE_REPOSITORY}/releases/download/v${version}/`)) throw new Error('更新下载地址不属于已验证的项目版本')
  return parsed.href
}
export function verifyManifest(envelope, keys, currentVersion) {
  if (envelope?.algorithm !== 'ed25519' || typeof envelope.payload !== 'string' || envelope.payload.length > 256 * 1024 || !keys?.[envelope.keyId]) throw new Error('更新清单缺少受信任签名')
  const bytes = Buffer.from(envelope.payload, 'base64')
  if (!verify(null, bytes, keys[envelope.keyId], Buffer.from(envelope.signature || '', 'base64'))) throw new Error('更新清单签名校验失败')
  const manifest = JSON.parse(bytes.toString('utf8'))
  if (manifest.schemaVersion !== 1 || manifest.updaterProtocol !== UPDATE_PROTOCOL || manifest.repository !== UPDATE_REPOSITORY || !/^[a-f0-9]{40,64}$/.test(manifest.revision || '')) throw new Error('更新协议或构建信息不受支持')
  if (compareVersions(manifest.version, currentVersion) <= 0) throw new Error('目标不是更高的正式版本')
  if (compareVersions(currentVersion, manifest.minVersion) < 0 || compareVersions(currentVersion, manifest.maxVersion) > 0) throw new Error('当前版本需要先升级到支持的中间版本')
  for (const [target, asset] of Object.entries(manifest.portable || {})) {
    if (!/^(windows|linux|macos)-(x64|arm64)$/.test(target) || !/^[a-f0-9]{64}$/.test(asset.sha256 || '') || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > MAX_ARCHIVE_BYTES) throw new Error('更新包清单无效')
    releaseUrl(asset.url, manifest.version)
  }
  if (manifest.docker && (!new RegExp(`^ghcr\\.io/${UPDATE_REPOSITORY}@sha256:[a-f0-9]{64}$`).test(manifest.docker.image) || !/^docker\.io\/metacubex\/mihomo@sha256:[a-f0-9]{64}$/.test(manifest.docker.coreImage))) throw new Error('更新镜像必须固定到受信任仓库摘要')
  return { manifest, digest: createHash('sha256').update(bytes).digest('hex') }
}
export function platformTarget() { return `${{ win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform] || process.platform}-${process.arch}` }
