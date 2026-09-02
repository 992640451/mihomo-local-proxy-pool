import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function isMissingManifest(message) {
  return /manifest unknown|name unknown|(?:^|\n)ERROR: ghcr\.io\/[^\s]+: not found\s*$/i.test(message)
}

// After registry login, only an explicit missing-manifest response permits a push.
// Auth/network failures must not be interpreted as an unused version.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) for (const image of process.argv.slice(2)) {
  if (!/^ghcr\.io\/[a-z0-9._/-]+:[a-zA-Z0-9._-]+$/.test(image)) throw new Error('无效的 GHCR 镜像引用')
  const result = spawnSync('docker', ['buildx', 'imagetools', 'inspect', image], { encoding: 'utf8', timeout: 60000, windowsHide: true })
  if (result.error) throw result.error
  if (result.status === 0) throw new Error(`镜像已存在，拒绝覆盖：${image}；请发布新版本或人工核验中断的发布`)
  if (!isMissingManifest(result.stderr || '')) throw new Error(`无法确认镜像是否存在：${result.stderr}`)
  console.log(`镜像标签尚不存在：${image}`)
}
