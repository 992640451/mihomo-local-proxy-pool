import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { argument } from './release-utils.mjs'
import { readJson } from '../server/updates/files.mjs'
import { compareVersions } from '../server/updates/manifest.mjs'

export async function validateUpdateSigning({ root, privateKey }) {
  if (!privateKey) throw new Error('缺少 UPDATE_SIGNING_PRIVATE_KEY，不能发布可执行的更新清单')
  const { version } = await readJson(path.join(root, 'package.json'))
  const policy = await readJson(path.join(root, 'release', 'update-policy.json'))
  if (!policy || Object.keys(policy).some(key => !['minVersion', 'maxVersion'].includes(key)) || compareVersions(policy.minVersion, policy.maxVersion) > 0 || compareVersions(policy.maxVersion, version) >= 0) throw new Error('更新来源版本范围无效，必须早于目标正式版本')
  const key = createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('更新签名必须使用 Ed25519 私钥')
  const publicPem = createPublicKey(key).export({ type: 'spki', format: 'pem' })
  const keyId = createHash('sha256').update(publicPem).digest('hex').slice(0, 16)
  const keys = await readJson(path.join(root, 'release', 'update-public-keys.json'))
  if (keys?.[keyId] !== publicPem) throw new Error('签名私钥与客户端内置公钥不匹配')
  return { version, policy, key, keyId, keys }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const keyFile = argument(process.argv, '--key-file')
  const privateKey = keyFile ? await readFile(keyFile, 'utf8') : process.env.UPDATE_SIGNING_PRIVATE_KEY
  validateUpdateSigning({ root: path.resolve(argument(process.argv, '--root', '.')), privateKey })
    .then(({ version, keyId }) => console.log(`更新签名预检通过：v${version}，公钥 ${keyId}`))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
