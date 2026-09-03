import { createHash } from 'node:crypto'
import YAML from 'yaml'

const IDENTITY_FIELDS = ['uuid', 'id', 'username', 'public-key', 'peer', 'client-fingerprint']

function normalized(value) { return String(value ?? '').trim().toLowerCase() }

function endpointKey(raw) {
  const identity = IDENTITY_FIELDS.map(key => normalized(raw[key])).filter(Boolean).join('|')
  return [normalized(raw.type), normalized(raw.server), normalized(raw.port), identity].join('|')
}

function shortHash(value, length = 24) {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

export function parseSubscription(content, { subscriptionId, maxNodes = 5000 } = {}) {
  if (!subscriptionId) throw new Error('缺少订阅 ID')
  let document
  try { document = YAML.parse(String(content || '')) || {} }
  catch (error) {
    // YAML errors may embed entire source lines, including proxy credentials.
    const code = /^[A-Z_]+$/.test(error.code || '') ? error.code : 'INVALID_YAML'
    const position = error.linePos?.[0]
    const location = Number.isInteger(position?.line) && Number.isInteger(position?.col) ? `，第 ${position.line} 行 ${position.col} 列` : ''
    throw new Error(`YAML 解析失败（${code}${location}）`)
  }
  if (!Array.isArray(document.proxies)) throw new Error('订阅内容缺少 proxies 数组')
  if (!document.proxies.length) throw new Error('订阅没有可用节点')
  if (document.proxies.length > maxNodes) throw new Error(`订阅节点超过上限（${maxNodes}）`)

  const usedKeys = new Set()
  const nodes = document.proxies.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`第 ${index + 1} 个节点格式无效`)
    const raw = structuredClone(value), name = String(raw.name || '').trim()
    if (!name) throw new Error(`第 ${index + 1} 个节点缺少 name`)
    if (!raw.type) throw new Error(`节点“${name}”缺少 type`)
    if (!raw.server || !raw.port) throw new Error(`节点“${name}”缺少 server 或 port`)
    let stableKey = endpointKey(raw)
    if (usedKeys.has(stableKey)) stableKey = `${stableKey}|duplicate:${shortHash(name, 12)}`
    if (usedKeys.has(stableKey)) stableKey = `${stableKey}|index:${index}`
    usedKeys.add(stableKey)
    return { id: shortHash(`${subscriptionId}\0${stableKey}`), stableKey, name, raw }
  })
  return { format: 'mihomo-yaml', nodes, nodeCount: nodes.length }
}
