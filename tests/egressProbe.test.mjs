import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeEgressPayload } from '../server/egressProbe.mjs'

test('normalizes a detected proxy exit into Chinese country metadata', () => {
  assert.deepEqual(normalizeEgressPayload({
    ip: '142.249.36.67', success: true, country: 'United States', country_code: 'US',
    region: 'California', city: 'Los Angeles', flag: { emoji: '🇺🇸' },
  }), { ip:'142.249.36.67', countryCode:'US', country:'美国', region:'California', city:'Los Angeles', flag:'🇺🇸' })
})

test('rejects incomplete or failed exit lookup responses', () => {
  assert.throws(() => normalizeEgressPayload({ success:false, message:'rate limited' }), /rate limited/)
  assert.throws(() => normalizeEgressPayload({ success:true, ip:'142.249.36.67' }), /响应不完整/)
})
