import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeEgressPayload, verifyProxyPool } from '../server/egressProbe.mjs'

test('normalizes a detected proxy exit into Chinese country metadata', () => {
  assert.deepEqual(normalizeEgressPayload({
    ip: '192.0.2.67', success: true, country: 'United States', country_code: 'US',
    region: 'California', city: 'Los Angeles', flag: { emoji: '🇺🇸' },
  }), { ip:'192.0.2.67', countryCode:'US', country:'美国', region:'California', city:'Los Angeles', flag:'🇺🇸' })
})

test('rejects incomplete or failed exit lookup responses', () => {
  assert.throws(() => normalizeEgressPayload({ success:false, message:'rate limited' }), /rate limited/)
  assert.throws(() => normalizeEgressPayload({ success:true, ip:'192.0.2.67' }), /响应不完整/)
})

test('summarizes sequential pool probes by exit IP while preserving failures', async () => {
  const exits = ['192.0.2.1', '198.51.100.2', null, '192.0.2.1']
  let index = 0
  const result = await verifyProxyPool({
    host: '127.0.0.1', port: 17900, attempts: 4,
    probe: async () => {
      const ip = exits[index++]
      if (!ip) throw new Error('temporary failure')
      return { ip, countryCode: 'US', country: '美国', region: '', city: '', flag: '🇺🇸', latencyMs: 100, checkedAt: '2026-09-01T00:00:00.000Z' }
    },
  })
  assert.equal(result.successes, 3)
  assert.equal(result.failures, 1)
  assert.equal(result.uniqueExitCount, 2)
  assert.deepEqual(result.distribution.map(item => [item.ip, item.count, item.averageLatencyMs]), [
    ['192.0.2.1', 2, 100], ['198.51.100.2', 1, 100],
  ])
  assert.equal(result.samples[2].error, 'temporary failure')
  await assert.rejects(() => verifyProxyPool({ host: '127.0.0.1', port: 17900, attempts: 21 }), /2–20/)
})
