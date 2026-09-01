import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

function deriveKey(masterKey) {
  const value = String(masterKey || '')
  if (value.length < 16) throw new Error('SUBSCRIPTION_MASTER_KEY 至少需要 16 个字符')
  return createHash('sha256').update(value).digest()
}
export class SecretBox {
  constructor(masterKey) { this.key = deriveKey(masterKey) }

  encrypt(value) {
    if (value === null || value === undefined) return null
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`
  }

  decrypt(value) {
    if (value === null || value === undefined) return null
    const [version, iv, tag, body] = String(value).split('.')
    if (version !== 'v1' || !iv || !tag || body === undefined) throw new Error('无法识别的加密数据格式')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
  }
}
