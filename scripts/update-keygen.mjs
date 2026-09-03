import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readJson, writeJson } from '../server/updates/files.mjs'
const directory = path.resolve('.local', 'update-signing')
await mkdir(directory, { recursive: true, mode: 0o700 })
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicPem = publicKey.export({ type: 'spki', format: 'pem' })
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const keyId = createHash('sha256').update(publicPem).digest('hex').slice(0, 16)
const privateFile = path.join(directory, `${keyId}.pem`)
await writeFile(privateFile, privatePem, { mode: 0o600, flag: 'wx' })
const keys = await readJson('release/update-public-keys.json', {})
keys[keyId] = publicPem
await writeJson('release/update-public-keys.json', keys)
console.log(`更新签名公钥已登记：${keyId}`)
console.log(`私钥仅保存于被 Git 忽略的文件：${privateFile}`)
console.log('发布前将私钥文件内容配置为仓库 Actions Secret：UPDATE_SIGNING_PRIVATE_KEY。不要提交或分享私钥。')
