import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { RECOVERY_MAX_FILE_BYTES, RECOVERY_MAX_PAYLOAD_BYTES } from '../../shared/recoveryLimits.js'

const AAD = Buffer.from('proxy-port-manager:recovery:v1')
const DEFAULT_KDF = { name: 'scrypt', N: 16384, r: 8, p: 1 }

function passwordValue(password) {
  const value = String(password || '')
  if (value.length < 8) throw new Error('恢复包口令至少需要 8 个字符')
  if (value.length > 256) throw new Error('恢复包口令不能超过 256 个字符')
  return value
}

function deriveKey(password, salt, options) {
  return new Promise((resolve, reject) => {
    scrypt(passwordValue(password), salt, 32, { N: options.N, r: options.r, p: options.p, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

function decode(value, name, maximum = RECOVERY_MAX_PAYLOAD_BYTES) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maximum * 4 / 3) + 8) throw new Error(`恢复包 ${name} 无效`)
  const result = Buffer.from(value, 'base64')
  if (!result.length || result.length > maximum) throw new Error(`恢复包 ${name} 无效`)
  return result
}

export async function encryptRecoveryPayload(payload, password, options = {}) {
  const plain = JSON.stringify(payload)
  if (Buffer.byteLength(plain, 'utf8') > RECOVERY_MAX_PAYLOAD_BYTES) throw new Error('恢复包原始数据超过 24 MiB 上限，请减少订阅或节点后重试')
  const salt = options.salt || randomBytes(16)
  const iv = options.iv || randomBytes(12)
  const key = await deriveKey(password, salt, DEFAULT_KDF)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(AAD)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return {
    format: 'ppm-recovery',
    version: 1,
    createdAt: Date.now(),
    kdf: { ...DEFAULT_KDF, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') },
  }
}

export async function decryptRecoveryPayload(recoveryPackage, password) {
  if (!recoveryPackage || typeof recoveryPackage !== 'object' || Array.isArray(recoveryPackage)) throw new Error('恢复包格式无效')
  if (Buffer.byteLength(JSON.stringify(recoveryPackage), 'utf8') > RECOVERY_MAX_FILE_BYTES) throw new Error('恢复包文件超过 33 MiB 上限')
  if (recoveryPackage.format !== 'ppm-recovery' || recoveryPackage.version !== 1) throw new Error('不支持的恢复包格式或版本')
  const kdf = recoveryPackage.kdf || {}, cipherInfo = recoveryPackage.cipher || {}
  if (kdf.name !== 'scrypt' || kdf.N !== DEFAULT_KDF.N || kdf.r !== DEFAULT_KDF.r || kdf.p !== DEFAULT_KDF.p) throw new Error('恢复包密钥派生参数无效')
  if (cipherInfo.name !== 'aes-256-gcm') throw new Error('恢复包加密算法无效')
  const salt = decode(kdf.salt, 'salt', 64), iv = decode(cipherInfo.iv, 'iv', 32), tag = decode(cipherInfo.tag, 'tag', 32)
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error('恢复包加密参数无效')
  const data = decode(cipherInfo.data, 'data')
  const key = await deriveKey(password, salt, kdf)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(AAD)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    return JSON.parse(plain)
  } catch {
    throw new Error('恢复包口令错误或文件已损坏')
  }
}
