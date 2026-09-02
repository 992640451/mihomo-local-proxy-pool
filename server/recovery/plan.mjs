import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { portNodeIds } from '../../shared/portConfig.js'

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
export const configurationDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const conflict = message => Object.assign(new Error(message), { status: 409, code: 'CONFIGURATION_PLAN_STALE' })

export class ConfigurationPlanSigner {
  constructor() { this.key = randomBytes(32) }
  sign(revision, recoveryPackage, now = Date.now()) {
    const expiresAt = now + 600000
    const body = Buffer.from(JSON.stringify({ revision, packageDigest: configurationDigest(recoveryPackage), expiresAt })).toString('base64url')
    return { expiresAt, planToken: `${body}.${createHmac('sha256', this.key).update(body).digest('base64url')}` }
  }
  verify(planToken, revision, recoveryPackage, now = Date.now()) {
    if (typeof planToken !== 'string' || planToken.length > 2048) throw conflict('请先生成配置预检计划')
    const [body, signature, extra] = planToken.split('.')
    const expected = createHmac('sha256', this.key).update(body || '').digest('base64url')
    if (extra !== undefined || !/^[A-Za-z0-9_-]{43}$/.test(signature || '') || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw conflict('预检计划无效或服务已重启，请重新预检')
    let plan
    try { plan = JSON.parse(Buffer.from(body, 'base64url').toString()) } catch { throw conflict('预检计划无效') }
    if (plan.expiresAt <= now || plan.revision !== revision || plan.packageDigest !== configurationDigest(recoveryPackage)) throw conflict('预检已过期、当前配置或恢复包已变化，请重新预检')
  }
}

function delta(before, after) {
  const added = [], modified = [], deleted = []
  let unchanged = 0
  for (const [id, value] of after) {
    if (!before.has(id)) added.push(id)
    else if (configurationDigest(value) !== configurationDigest(before.get(id))) modified.push(id)
    else unchanged++
  }
  for (const id of before.keys()) if (!after.has(id)) deleted.push(id)
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort(), unchanged }
}
const resources = value => ({
  subscriptions: new Map(value.subscriptions.map(({ nodes, ...subscription }) => [subscription.id, subscription])),
  nodes: new Map(value.subscriptions.flatMap(subscription => subscription.nodes.map(node => [node.id, { ...node, subscriptionId: subscription.id }]))),
  ports: new Map(Object.entries(value.ports.ports)),
})

export function configurationChanges(previous, next) {
  const before = resources(previous), after = resources(next)
  const available = new Set(next.subscriptions.filter(item => item.enabled).flatMap(item => item.nodes.filter(node => node.active).map(node => node.id)))
  const missingNodes = [], unavailableNodes = []
  for (const [port, item] of after.ports) {
    const missing = portNodeIds(item).filter(id => !after.nodes.has(id))
    const unavailable = portNodeIds(item).filter(id => after.nodes.has(id) && !available.has(id))
    if (missing.length) missingNodes.push({ port: Number(port), nodeIds: missing })
    if (unavailable.length) unavailableNodes.push({ port: Number(port), nodeIds: unavailable })
  }
  return { changes: Object.fromEntries(Object.keys(before).map(key => [key, delta(before[key], after[key])])), missingNodes, unavailableNodes }
}
