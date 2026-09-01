export const DEFAULT_PORT_SPECS = [
  { port: 17891, providerIncludes: 'iKuuu', nodeIncludes: '日本Y11' },
  { port: 17892, providerIncludes: 'iKuuu', nodeIncludes: '美国Y02' },
  { port: 17893, providerIncludes: '狗狗', nodeIncludes: '巴西' },
]

export const PORT_STRATEGIES = {
  select: { label: '手动选择', description: '固定使用所选主节点', minNodes: 1 },
  fallback: { label: '主备切换', description: '主节点不可用时按顺序切换', minNodes: 2 },
  'url-test': { label: '自动优选', description: '定期测速并使用延迟最低的节点', minNodes: 2 },
  'consistent-hashing': { label: '稳定均衡', description: '同一目标地址稳定分配到同一节点', minNodes: 2 },
  'round-robin': { label: '轮询均衡', description: '新连接依次分配给不同节点', minNodes: 2 },
}

export const DEFAULT_STRATEGY_OPTIONS = {
  healthCheckUrl: 'https://www.gstatic.com/generate_204', intervalSeconds: 60,
  timeoutMs: 5000, toleranceMs: 50, maxFailedTimes: 3,
}

export function portNodeIds(port = {}) {
  const values = Array.isArray(port.nodeIds) ? port.nodeIds : port.nodeId ? [port.nodeId] : []
  return [...new Set(values.filter(Boolean))]
}

export function normalizePort(port = {}) {
  const nodeIds = portNodeIds(port)
  const strategy = PORT_STRATEGIES[port.strategy] ? port.strategy : nodeIds.length > 1 ? 'fallback' : 'select'
  return { ...port, nodeId: nodeIds[0] || '', nodeIds, strategy, strategyOptions: { ...DEFAULT_STRATEGY_OPTIONS, ...(port.strategyOptions || {}) } }
}

export function createInitialPorts(nodes, listeners = []) {
  if (listeners.length) return listeners.map(item => normalizePort(item))
  return DEFAULT_PORT_SPECS.map((spec, index) => {
    const candidates = nodes.filter(node => node.provider.includes(spec.providerIncludes))
    const node = candidates.find(item => item.name.includes(spec.nodeIncludes))
      || candidates.find(item => spec.nodeIncludes.includes(item.country)) || candidates[0] || nodes[index]
    return node ? normalizePort({ id: `port-${spec.port}`, port: spec.port, protocol: 'Mixed', nodeId: node.id, enabled: true, lastChecked: index ? `${index} 分钟前` : '刚刚' }) : null
  }).filter(Boolean)
}

export function dedupePortsByPort(ports = []) {
  const seen = new Set()
  return ports.filter(item => {
    const port = Number(item.port), key = Number.isInteger(port) ? `port:${port}` : `id:${item.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map(normalizePort)
}

export function restorePortState(nodes, listeners = [], saved = []) {
  const nodeIds = new Set(nodes.map(node => node.id))
  const custom = dedupePortsByPort(saved.filter(port => port.managedBy !== 'mihomo' && portNodeIds(port).some(id => nodeIds.has(id))))
    .map(port => normalizePort({ ...port, nodeIds: portNodeIds(port).filter(id => nodeIds.has(id)) }))
  if (listeners.length) return dedupePortsByPort([...createInitialPorts(nodes, listeners), ...custom])
  return custom.length ? custom : createInitialPorts(nodes)
}

export function enrichPort(port, nodes = []) {
  const normalized = normalizePort(port)
  const selectedNodes = normalized.nodeIds.map(id => nodes.find(node => node.id === id)).filter(Boolean)
  return { ...normalized, node: selectedNodes[0], nodes: selectedNodes, strategyMeta: PORT_STRATEGIES[normalized.strategy] }
}

export function nextAvailablePort(ports, start = 17900, end = 17999) {
  const used = new Set(ports.map(item => Number(item.port)))
  for (let value = start; value <= end; value += 1) if (!used.has(value)) return value
  return null
}

export function filterPorts(ports, filters, nodes = []) {
  const query = filters.query.trim().toLowerCase()
  return ports.filter(rawPort => {
    const port = normalizePort(rawPort)
    const selectedNodes = port.nodeIds.map(id => nodes.find(item => item.id === id)).filter(Boolean)
    if (!selectedNodes.length && !port.isGlobal) return false
    if (port.isGlobal && filters.provider !== '全部订阅') return false
    if (port.isGlobal && filters.country !== '全部国家') return false
    if (filters.provider !== '全部订阅' && !selectedNodes.some(node => node.provider === filters.provider)) return false
    if (filters.country !== '全部国家' && !selectedNodes.some(node => node.country === filters.country)) return false
    if (filters.status === '在线' && !port.enabled) return false
    if (filters.status === '已停用' && port.enabled) return false
    const haystack = [port.port, port.protocol, port.routeName, port.listenerName, port.isGlobal ? 'Mihomo 核心 动态路由 全局入口' : '', PORT_STRATEGIES[port.strategy]?.label, ...selectedNodes.flatMap(node => [node.provider, node.country, node.name, node.code])]
    return !query || haystack.join(' ').toLowerCase().includes(query)
  })
}

export function validatePortDraft(draft, ports, editingId = null) {
  const normalized = normalizePort(draft), port = Number(normalized.port), nodeIds = normalized.nodeIds
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return '端口必须是 1024–65535 的整数'
  if (!(port >= 17891 && port <= 17893) && !(port >= 17900 && port <= 17999)) return '内置核心端口范围为 17891–17893 或 17900–17999'
  if (ports.some(item => item.id !== editingId && Number(item.port) === port)) return `端口 ${port} 已被占用`
  if (!nodeIds.length) return '请至少选择一个代理节点'
  if (!PORT_STRATEGIES[normalized.strategy]) return '请选择节点使用方式'
  if (nodeIds.length < PORT_STRATEGIES[normalized.strategy].minNodes) return `${PORT_STRATEGIES[normalized.strategy].label}至少需要 ${PORT_STRATEGIES[normalized.strategy].minNodes} 个节点`
  return ''
}

export function reorderPortNode(nodeIds, nodeId, direction) {
  const current = [...nodeIds], index = current.indexOf(nodeId), next = index + direction
  if (index < 0 || next < 0 || next >= current.length) return current
  ;[current[index], current[next]] = [current[next], current[index]]
  return current
}

export function buildMihomoPortConfig(rawPort, nodes = []) {
  const port = normalizePort(rawPort)
  const names = port.nodeIds.map(id => nodes.find(node => node.id === id)?.name).filter(Boolean)
  const group = { name: `PPM-${port.port}`, type: port.strategy, proxies: names }
  if (port.strategy === 'consistent-hashing' || port.strategy === 'round-robin') { group.type = 'load-balance'; group.strategy = port.strategy }
  if (group.type !== 'select') {
    group.url = port.strategyOptions.healthCheckUrl
    group.interval = Number(port.strategyOptions.intervalSeconds)
    group.timeout = Number(port.strategyOptions.timeoutMs)
    group['max-failed-times'] = Number(port.strategyOptions.maxFailedTimes)
  }
  if (port.strategy === 'url-test') group.tolerance = Number(port.strategyOptions.toleranceMs)
  const listenerTypes = { Mixed: 'mixed', MIXED: 'mixed', HTTP: 'http', SOCKS5: 'socks' }
  return { proxyGroup: group, listener: { name: `ppm-${port.port}`, type: listenerTypes[port.protocol] || String(port.protocol || 'mixed').toLowerCase(), listen: '127.0.0.1', port: Number(port.port), proxy: group.name, udp: true } }
}

export function removePortById(ports, id) { return ports.filter(item => item.id !== id) }
