import { readFileSync } from 'node:fs'
import path from 'node:path'

export function readBuildInfo(root) {
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const fallback = { version, revision: null, builtAt: null, target: 'source', nodeVersion: process.version }
  try {
    const info = JSON.parse(readFileSync(path.join(root, 'build-info.json'), 'utf8'))
    if (info.schemaVersion !== 1 || info.version !== version) return fallback
    return {
      ...fallback,
      revision: /^[a-f0-9]{40,64}$/.test(info.revision || '') ? info.revision : null,
      builtAt: Number.isFinite(Date.parse(info.builtAt)) ? new Date(info.builtAt).toISOString() : null,
      target: /^[a-z0-9/-]{1,50}$/.test(info.target || '') ? info.target : 'unknown',
    }
  } catch { return fallback }
}
