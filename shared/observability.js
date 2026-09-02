export const OBSERVABILITY_DEFAULTS = Object.freeze({
  enabled: false,
  intervalSeconds: 900,
  concurrency: 3,
  timeoutMs: 5000,
  attempts: 2,
  retentionDays: 7,
  maxSamples: 20000,
})
export const OBSERVABILITY_LIMITS = Object.freeze({ nodeBatch: 100, scheduledPorts: 10, cooldownMs: 15000 })

export function validateObservabilitySettings(patch, current = OBSERVABILITY_DEFAULTS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('检测设置必须是对象')
  const next = { ...current }
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(OBSERVABILITY_DEFAULTS, key)) throw new Error(`未知检测设置：${key}`)
    if (key === 'enabled') {
      if (typeof patch[key] !== 'boolean') throw new Error('enabled 必须为布尔值')
      next[key] = patch[key]
      continue
    }
    const bounds = { intervalSeconds: [300, 86400], concurrency: [1, 6], timeoutMs: [1000, 10000], attempts: [2, 8], retentionDays: [1, 30], maxSamples: [100, 50000] }[key]
    if (!Number.isInteger(patch[key]) || patch[key] < bounds[0] || patch[key] > bounds[1]) throw new Error(`${key} 必须是 ${bounds[0]}–${bounds[1]} 的整数`)
    next[key] = patch[key]
  }
  return next
}

export function observationState({ healthy, checkedAt }, now = Date.now(), staleMs = 600000) {
  if (!checkedAt || healthy === null || healthy === undefined) return 'unknown'
  if (now - checkedAt > staleMs) return 'stale'
  return healthy ? 'healthy' : 'failed'
}
