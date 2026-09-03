import { sign } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { argument } from './release-utils.mjs'
import { hashFile, readJson, writeJson } from '../server/updates/files.mjs'
import { UPDATE_REPOSITORY, verifyManifest } from '../server/updates/manifest.mjs'
import { validateUpdateSigning } from './validate-update-signing.mjs'

export async function createUpdateManifest({ root, directory, privateKey, image, coreImage }) {
  const { version, policy, key, keyId, keys } = await validateUpdateSigning({ root, privateKey })
  const portable = {}; let revision
  for (const name of await readdir(directory)) {
    const match = /^proxy-port-manager-v([\d.]+)-(windows|linux|macos)-(x64|arm64)\.(zip|tar\.gz)$/.exec(name)
    if (!match) continue
    if (match[1] !== version) throw new Error('更新归档版本不一致')
    const info = await readJson(path.join(directory, `${name}.build.json`))
    if (!info || (revision && revision !== info.revision) || info.version !== version) throw new Error('更新归档构建身份不一致')
    revision = info.revision
    portable[`${match[2]}-${match[3]}`] = { url: `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${version}/${name}`, sha256: await hashFile(path.join(directory, name)), bytes: (await stat(path.join(directory, name))).size }
  }
  if (!Object.keys(portable).length) throw new Error('没有可用的便携归档')
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, updaterProtocol: 1, repository: UPDATE_REPOSITORY, version, revision, ...policy, portable, ...(image && coreImage ? { docker: { image, coreImage } } : {}) }))
  const envelope = { algorithm: 'ed25519', keyId, payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }
  verifyManifest(envelope, keys, policy.minVersion)
  await writeJson(path.join(directory, 'update-manifest.json'), envelope)
  return envelope
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(argument(process.argv, '--root', '.'))
  const keyFile = argument(process.argv, '--key-file')
  const privateKey = keyFile ? await readFile(keyFile, 'utf8') : process.env.UPDATE_SIGNING_PRIVATE_KEY
  if (!privateKey) throw new Error('缺少 UPDATE_SIGNING_PRIVATE_KEY，不能发布可执行的更新清单')
  await createUpdateManifest({ root, directory: path.resolve(argument(process.argv, '--directory', 'release-assets')), privateKey, image: process.env.RELEASE_IMAGE_DIGEST ? `${process.env.RELEASE_IMAGE}@${process.env.RELEASE_IMAGE_DIGEST}` : null, coreImage: process.env.RELEASE_CORE_IMAGE })
  console.log('已生成并验证签名更新清单')
}
