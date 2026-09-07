import { SESSION_STRATEGY, nodeFingerprint, publicSession, sessionError } from './proxySessionStore.mjs'

export function requireSessionPort(item, store) {
  if (!store) throw sessionError('此部署未配置持久化代理会话', 'PROXY_SESSION_UNSUPPORTED', 501)
  if (!item) throw sessionError('端口配置不存在', 'PORT_NOT_FOUND', 404)
  if (item.strategy !== SESSION_STRATEGY) throw sessionError('此端口未启用会话轮换', 'PROXY_SESSION_UNSUPPORTED', 400)
}

export function sessionSnapshot(port, store) {
  const session = publicSession(store.current(port))
  return { port: Number(port), state: session?.state || 'idle', session, lastNodeId: store.lastNode(port) }
}

async function verifyBinding(request, port, name) {
  const group = await request(`/proxies/${encodeURIComponent(`PPM-${port}`)}`)
  if (group.now !== name || group.all?.length !== 1 || group.all[0] !== name) {
    throw sessionError('核心节点绑定尚未确认，请查询会话状态', 'PROXY_SESSION_BINDING_FAILED', 503)
  }
}

async function clearPortConnections(request, port) {
  const groupName = `PPM-${port}`
  // Blocking the group first prevents new forwarding while old connections drain.
  for (let pass = 0; pass < 3; pass++) {
    const payload = await request('/connections'), connections = payload.connections === null ? [] : payload.connections
    if (!Array.isArray(connections)) throw new Error('核心未返回连接列表')
    const matches = connections.filter(connection => connection.chains?.includes(groupName))
    if (!matches.length) return
    for (const connection of matches) await request(`/connections/${encodeURIComponent(connection.id)}`, { method: 'DELETE' })
  }
  const payload = await request('/connections'), connections = payload.connections === null ? [] : payload.connections
  if (!Array.isArray(connections) || connections.some(connection => connection.chains?.includes(groupName))) throw new Error('此端口仍有未清理的连接，请重试结束会话')
}

async function blockAndDrain(context) {
  await context.apply()
  await verifyBinding(context.request, context.port, 'REJECT')
  await clearPortConnections(context.request, context.port)
}

export async function beginProxySession(context, input = {}) {
  const { port, item, store, definitions, request, apply } = context
  requireSessionPort(item, store)
  const { launchId, profileId = '' } = input
  if (typeof launchId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(launchId)) throw sessionError('启动标识须为 8–128 位字母、数字或 . _ : -', 'INVALID_LAUNCH_ID', 400)
  if (typeof profileId !== 'string' || profileId.length > 256 || /[\x00-\x1f]/.test(profileId)) throw sessionError('配置文件标识无效', 'INVALID_PROFILE_ID', 400)
  const previous = store.find(port, launchId)
  if (previous) {
    if (previous.profileId !== profileId) throw sessionError('同一启动标识不能用于不同配置文件')
    if (previous.state === 'active') await verifyBinding(request, port, `ppm-node-${previous.nodeId}`)
    return { ...sessionSnapshot(port, store), session: publicSession(previous), state: previous.state }
  }
  if (!item.enabled) throw sessionError('端口已停用', 'PORT_DISABLED', 400)
  store.assertIdle(port)
  let record = store.create(port, launchId, profileId)
  try {
    await blockAndDrain(context)
    const last = store.lastNode(port), ids = item.nodeIds
    const start = (ids.indexOf(last) + 1) % ids.length
    const byId = new Map(definitions.map(node => [node.id, node]))
    const deadline = Date.now() + 60000
    let chosen = null
    for (let offset = 0; offset < ids.length && Date.now() < deadline; offset++) {
      const id = ids[(start + offset) % ids.length], definition = byId.get(id)
      if (id === last || !definition || definition.active === false || definition.subscriptionEnabled === false) continue
      const timeoutMs = Math.max(1, Math.min(item.strategyOptions.timeoutMs, deadline - Date.now()))
      const query = new URLSearchParams({ url: item.strategyOptions.healthCheckUrl, timeout: String(timeoutMs) })
      try {
        const response = await request(`/proxies/${encodeURIComponent(`ppm-node-${id}`)}/delay?${query}`, { timeoutMs: timeoutMs + 1000 })
        if (Number.isFinite(response.delay) && response.delay > 0) { chosen = definition; break }
      } catch { /* A failed candidate does not change the current binding. */ }
    }
    if (!chosen) {
      store.save({ ...record, state: 'ended', endedAt: Date.now(), error: '无其他可用节点，或本次检测超时' })
      throw sessionError('无其他可用节点，或本次检测超时', 'NO_ALTERNATIVE_NODE', 503)
    }
    record = store.save({ ...record, state: 'activating', nodeId: chosen.id, nodeName: chosen.raw.name, nodeFingerprint: nodeFingerprint(chosen.raw) })
    await apply()
    await verifyBinding(request, port, `ppm-node-${chosen.id}`)
    record = store.save({ ...record, state: 'active', startedAt: Date.now() })
    return sessionSnapshot(port, store)
  } catch (error) {
    if (store.byId(port, record.sessionId)?.state !== 'ended') {
      // No credentials or raw core responses are persisted in the public record.
      store.save({ ...record, state: 'recovery-required', error: '开始使用未完成，请结束此会话后重新开始' })
      await blockAndDrain(context).catch(() => {})
    }
    if (error.code === 'NO_ALTERNATIVE_NODE') throw error
    throw Object.assign(sessionError('开始使用未完成，请查询状态并结束此会话后重试', 'PROXY_SESSION_START_FAILED', 503), { cause: error })
  }
}

export async function finishProxySession(context, sessionId) {
  const { port, item, store } = context
  requireSessionPort(item, store)
  const record = typeof sessionId === 'string' ? store.byId(port, sessionId) : null
  if (!record) throw sessionError('代理会话不存在', 'PROXY_SESSION_NOT_FOUND', 404)
  if (record.state === 'ended') return { ...sessionSnapshot(port, store), session: publicSession(record), state: 'ended' }
  store.save({ ...record, state: 'ending', error: null })
  try {
    await blockAndDrain(context)
    const ended = store.save({ ...record, state: 'ended', error: null, endedAt: Date.now() })
    return { ...sessionSnapshot(port, store), session: publicSession(ended), state: 'ended' }
  } catch {
    store.save({ ...record, state: 'recovery-required', error: '结束使用未完成，请重试结束，暂时不能开始新会话' })
    throw sessionError('结束使用未完成，请重试结束会话', 'PROXY_SESSION_END_FAILED', 503)
  }
}
