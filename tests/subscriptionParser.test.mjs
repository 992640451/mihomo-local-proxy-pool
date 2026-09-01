import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSubscription } from '../server/subscriptions/parser.mjs'

const yaml = name => `proxies:\n  - name: ${name}\n    type: ss\n    server: edge.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret\n`

test('订阅解析生成不受节点名称影响的稳定标识', () => {
  const before = parseSubscription(yaml('香港 A'), { subscriptionId: 'sub-a' })
  const after = parseSubscription(yaml('香港 A 已改名'), { subscriptionId: 'sub-a' })
  assert.equal(before.nodes[0].id, after.nodes[0].id)
  assert.equal(before.nodes[0].stableKey, after.nodes[0].stableKey)
})
test('订阅解析拒绝空节点和不完整节点', () => {
  assert.throws(() => parseSubscription('proxies: []', { subscriptionId: 'sub-a' }), /没有可用节点/)
  assert.throws(() => parseSubscription('proxies:\n  - name: bad\n    type: ss', { subscriptionId: 'sub-a' }), /server 或 port/)
})
