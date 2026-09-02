import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capture, writeJson } from './build-metadata.mjs'
import { argument } from './release-utils.mjs'

export function imagePlatforms(index) {
  const platforms = (index.manifests || []).filter(item => item.platform?.os === 'linux' && ['amd64', 'arm64'].includes(item.platform.architecture))
  assert.deepEqual(platforms.map(item => item.platform.architecture).sort(), ['amd64', 'arm64'], '镜像必须包含 Linux amd64 和 arm64')
  return platforms.map(item => {
    const attestation = index.manifests.find(entry => entry.annotations?.['vnd.docker.reference.digest'] === item.digest && entry.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest')
    assert.ok(attestation, `${item.platform.architecture} 缺少 BuildKit attestation`)
    return { architecture: item.platform.architecture, digest: item.digest, attestationDigest: attestation.digest }
  })
}

export function verifyPredicates(manifest) {
  const types = (manifest.layers || []).map(item => item.annotations?.['in-toto.io/predicate-type'])
  assert.ok(types.includes('https://spdx.dev/Document'), '镜像缺少 SPDX SBOM')
  assert.ok(types.some(type => /^https:\/\/slsa.dev\/provenance\/v(0\.2|1)$/.test(type)), '镜像缺少 SLSA provenance')
  return types
}

async function main() {
  const image = argument(process.argv, '--image')
  if (!/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(image || '')) throw new Error('必须提供固定 GHCR digest')
  const inspect = reference => JSON.parse(capture('docker', ['buildx', 'imagetools', 'inspect', reference, '--raw']))
  const platforms = imagePlatforms(inspect(image))
  for (const platform of platforms) platform.predicates = verifyPredicates(inspect(`${image.split('@')[0]}@${platform.attestationDigest}`))
  const output = path.resolve(argument(process.argv, '--output', '.artifacts/registry-verification.json'))
  await mkdir(path.dirname(output), { recursive: true })
  await writeJson(output, { image, platforms, verifiedAt: new Date().toISOString() })
  console.log('已验证双架构镜像及其 SPDX/SLSA attestations')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
