import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

export function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 32 * 1024 * 1024, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

export async function buildMetadata(root, { revision = process.env.PPM_BUILD_REVISION, builtAt = process.env.PPM_BUILD_TIME, target = `${process.platform}-${process.arch}` } = {}) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  if (!revision) {
    try { revision = capture('git', ['-C', root, 'rev-parse', 'HEAD']) } catch { revision = null }
  }
  if (revision && !/^[a-f0-9]{40,64}$/.test(revision)) throw new Error('构建提交号必须是完整 Git SHA')
  builtAt ||= new Date().toISOString()
  if (!Number.isFinite(Date.parse(builtAt))) throw new Error('构建时间无效')
  return { schemaVersion: 1, version: pkg.version, revision, builtAt: new Date(builtAt).toISOString(), target, nodeVersion: process.version }
}

export async function writeJson(filename, value) {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function executableComponent(name, version, filename, sourceUrl) {
  return {
    type: 'application', name, version, 'bom-ref': `ppm:native:${name}@${version}`,
    hashes: [{ alg: 'SHA-256', content: createHash('sha256').update(await readFile(filename)).digest('hex') }],
    externalReferences: [{ type: 'vcs', url: sourceUrl }],
  }
}

export function extendSbom(sbom, metadata, nativeComponents) {
  if (sbom.bomFormat !== 'CycloneDX' || !sbom.metadata?.component?.['bom-ref']) throw new Error('npm 未生成有效的 CycloneDX SBOM')
  const copy = structuredClone(sbom)
  copy.metadata.timestamp = metadata.builtAt
  copy.metadata.properties = [
    { name: 'ppm:target', value: metadata.target },
    { name: 'ppm:revision', value: metadata.revision || 'unknown' },
    { name: 'ppm:inventory-scope', value: 'npm build dependency graph (including frontend and build tools), plus bundled Node.js and Mihomo binaries; not a complete native transitive inventory' },
  ]
  copy.components = [...(copy.components || []), ...nativeComponents]
  copy.dependencies ||= []
  let root = copy.dependencies.find(item => item.ref === copy.metadata.component['bom-ref'])
  if (!root) { root = { ref: copy.metadata.component['bom-ref'], dependsOn: [] }; copy.dependencies.push(root) }
  root.dependsOn = [...(root.dependsOn || []), ...nativeComponents.map(item => item['bom-ref'])]
  for (const item of nativeComponents) copy.dependencies.push({ ref: item['bom-ref'], dependsOn: [] })
  return copy
}
