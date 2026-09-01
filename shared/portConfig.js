export const PORT_STRATEGIES = {
  select: { label: '手动选择', description: '固定使用所选主节点', minNodes: 1 },
  fallback: { label: '主备切换', description: '主节点不可用时按顺序切换', minNodes: 2 },
  'url-test': { label: '自动优选', description: '定期测速并使用延迟最低的节点', minNodes: 2 },
  'consistent-hashing': { label: '稳定均衡', description: '同一目标地址稳定分配到同一节点', minNodes: 2 },
  'round-robin': { label: '轮询均衡', description: '新连接依次分配给不同节点', minNodes: 2 },
}

export const DEFAULT_STRATEGY_OPTIONS = {
  healthCheckUrl: 'https://www.gstatic.com/generate_204',
  intervalSeconds: 60,
  timeoutMs: 5000,
  toleranceMs: 50,
  maxFailedTimes: 3,
}

export const LISTENER_TYPES = { Mixed: 'mixed', MIXED: 'mixed', HTTP: 'http', SOCKS5: 'socks', SOCKS: 'socks' }

export function portNodeIds(port = {}) {
  const values = Array.isArray(port.nodeIds) ? port.nodeIds : port.nodeId ? [port.nodeId] : []
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
}

export function normalizeStrategyOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) options = {}
  return {
    healthCheckUrl: String(options.healthCheckUrl || DEFAULT_STRATEGY_OPTIONS.healthCheckUrl).trim(),
    intervalSeconds: Number(options.intervalSeconds ?? DEFAULT_STRATEGY_OPTIONS.intervalSeconds),
    timeoutMs: Number(options.timeoutMs ?? DEFAULT_STRATEGY_OPTIONS.timeoutMs),
    toleranceMs: Number(options.toleranceMs ?? DEFAULT_STRATEGY_OPTIONS.toleranceMs),
    maxFailedTimes: Number(options.maxFailedTimes ?? DEFAULT_STRATEGY_OPTIONS.maxFailedTimes),
  }
}

export function normalizePortConfig(port = {}) {
  const nodeIds = portNodeIds(port)
  const strategy = PORT_STRATEGIES[port.strategy] ? port.strategy : nodeIds.length > 1 ? 'fallback' : 'select'
  return {
    ...port,
    nodeId: nodeIds[0] || '',
    nodeIds,
    strategy,
    strategyOptions: normalizeStrategyOptions(port.strategyOptions),
  }
}

function integerInRange(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum
}

export function validatePortConfig(rawPort, { availableNodeIds, portAllowed } = {}) {
  if (rawPort?.strategy !== undefined && !PORT_STRATEGIES[rawPort.strategy]) throw new Error('节点使用方式无效')
  const port = normalizePortConfig(rawPort)
  const numericPort = Number(port.port)
  if (!integerInRange(numericPort, 1024, 65535)) throw new Error('端口必须是 1024–65535 的整数')
  if (portAllowed && !portAllowed(numericPort)) throw new Error(`端口 ${numericPort} 不在可用端口范围内`)
  if (!LISTENER_TYPES[String(port.protocol || 'Mixed')]) throw new Error('仅支持 Mixed、HTTP、SOCKS5 协议')
  if (port.nodeIds.length < PORT_STRATEGIES[port.strategy].minNodes) throw new Error(`${PORT_STRATEGIES[port.strategy].label}至少需要 ${PORT_STRATEGIES[port.strategy].minNodes} 个节点`)
  if (port.nodeIds.length > 64) throw new Error('单个端口最多允许 64 个节点')
  if (availableNodeIds) {
    const missing = port.nodeIds.find(id => !availableNodeIds.has(id))
    if (missing) throw new Error(`所选节点不存在或订阅已更新：${missing}`)
  }
  if (port.strategy !== 'select') {
    let url
    try { url = new URL(port.strategyOptions.healthCheckUrl) } catch { throw new Error('健康检查地址无效') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('健康检查地址仅支持 HTTP 或 HTTPS')
    if (!integerInRange(port.strategyOptions.intervalSeconds, 10, 86400)) throw new Error('健康检查周期必须是 10–86400 秒的整数')
    if (!integerInRange(port.strategyOptions.timeoutMs, 500, 60000)) throw new Error('健康检查超时必须是 500–60000 毫秒的整数')
    if (!integerInRange(port.strategyOptions.maxFailedTimes, 1, 20)) throw new Error('最大失败次数必须是 1–20 的整数')
    if (!integerInRange(port.strategyOptions.toleranceMs, 0, 5000)) throw new Error('切换容差必须是 0–5000 毫秒的整数')
  }
  return { ...port, port: numericPort, protocol: String(port.protocol || 'Mixed'), enabled: port.enabled !== false }
}

export function buildProxyGroup(rawPort, proxyNames, name = `PPM-${rawPort.port}`) {
  const port = normalizePortConfig(rawPort)
  const group = { name, type: port.strategy, proxies: [...proxyNames] }
  if (port.strategy === 'consistent-hashing' || port.strategy === 'round-robin') {
    group.type = 'load-balance'
    group.strategy = port.strategy
  }
  if (group.type !== 'select') {
    group.url = port.strategyOptions.healthCheckUrl
    group.interval = port.strategyOptions.intervalSeconds
    group.timeout = port.strategyOptions.timeoutMs
    group['max-failed-times'] = port.strategyOptions.maxFailedTimes
  }
  if (port.strategy === 'url-test') group.tolerance = port.strategyOptions.toleranceMs
  return group
}

export function strategyFromProxyGroup(group = {}) {
  if (group.type === 'load-balance' && ['consistent-hashing', 'round-robin'].includes(group.strategy)) return group.strategy
  return PORT_STRATEGIES[group.type] ? group.type : 'select'
}

export function strategyOptionsFromProxyGroup(group = {}) {
  return normalizeStrategyOptions({
    healthCheckUrl: group.url,
    intervalSeconds: group.interval,
    timeoutMs: group.timeout,
    toleranceMs: group.tolerance,
    maxFailedTimes: group['max-failed-times'],
  })
}
