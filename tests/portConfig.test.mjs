import assert from 'node:assert/strict'
import test from 'node:test'
import { buildProxyGroup, normalizePortConfig, validatePortConfig } from '../shared/portConfig.js'

const availableNodeIds = new Set(['primary', 'backup'])

test('normalizes a legacy nodeId while preserving rollback compatibility', () => {
  const port = normalizePortConfig({ port: 17900, nodeId: 'primary' })
  assert.equal(port.nodeId, 'primary')
  assert.deepEqual(port.nodeIds, ['primary'])
  assert.equal(port.strategy, 'select')
})

test('validates the complete fallback contract on the server', () => {
  const port = validatePortConfig({ port: 17900, protocol: 'Mixed', nodeIds: ['primary', 'backup'], strategy: 'fallback' }, { availableNodeIds })
  assert.deepEqual(port.nodeIds, ['primary', 'backup'])
  assert.equal(port.nodeId, 'primary')
  assert.throws(() => validatePortConfig({ port: 17900, protocol: 'Mixed', nodeIds: ['primary'], strategy: 'fallback' }, { availableNodeIds }), /至少需要 2 个节点/)
  assert.throws(() => validatePortConfig({ port: 17900, protocol: 'Mixed', nodeIds: ['primary', 'missing'], strategy: 'fallback' }, { availableNodeIds }), /节点不存在/)
  assert.throws(() => validatePortConfig({ port: 17900, protocol: 'Mixed', nodeIds: ['primary', 'backup'], strategy: 'fallback', strategyOptions: { healthCheckUrl: 'file:///tmp/check' } }, { availableNodeIds }), /仅支持 HTTP/)
  assert.throws(() => validatePortConfig({ port: 17900, protocol: 'Mixed', nodeIds: ['primary', 'backup'], strategy: 'unknown' }, { availableNodeIds }), /使用方式无效/)
})

test('maps both load balancing strategies to Mihomo load-balance groups', () => {
  const consistent = buildProxyGroup({ port: 17900, nodeIds: ['primary', 'backup'], strategy: 'consistent-hashing' }, ['one', 'two'])
  const roundRobin = buildProxyGroup({ port: 17901, nodeIds: ['primary', 'backup'], strategy: 'round-robin' }, ['one', 'two'])
  assert.equal(consistent.type, 'load-balance')
  assert.equal(consistent.strategy, 'consistent-hashing')
  assert.equal(roundRobin.type, 'load-balance')
  assert.equal(roundRobin.strategy, 'round-robin')
})
