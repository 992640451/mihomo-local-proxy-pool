import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { fetchSubscription } from '../server/subscriptions/fetcher.mjs'
import { SubscriptionService } from '../server/subscriptions/service.mjs'
import { SubscriptionStore } from '../server/subscriptions/store.mjs'

const yaml = 'proxies:\n  - name: test\n    type: ss\n    server: edge.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret\n'

async function fixtureServer() {
  const server = createServer((req, res) => {
    if (req.url === '/error') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ message: 'Unsupported client' }))
    }
    if (!String(req.headers['user-agent']).startsWith('mihomo/')) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ message: 'Unsupported client' }))
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(yaml)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

test('订阅下载默认使用 Mihomo 兼容 User-Agent', async () => {
  const { server, base } = await fixtureServer()
  try {
    const result = await fetchSubscription(`${base}/subscription`, { allowPrivateNetworks: true })
    assert.equal(result.content, yaml)
  } finally { server.close(); await once(server, 'close') }
})
test('订阅下载错误包含服务端安全诊断信息', async () => {
  const { server, base } = await fixtureServer()
  try {
    await assert.rejects(() => fetchSubscription(`${base}/error`, { allowPrivateNetworks: true }), /HTTP 400（Unsupported client）/)
  } finally { server.close(); await once(server, 'close') }
})

test('重新导入同一失败 URL 会复用原记录', async () => {
  const { server, base } = await fixtureServer()
  const store = new SubscriptionStore({ masterKey: 'test-only-master-key-at-least-32-characters' })
  try {
    const url = `${base}/subscription`
    const id = store.insertSubscription({ name: '失败记录', sourceType: 'url', url })
    store.recordFailure(id, 'initial failure')
    const service = new SubscriptionService({ store, fetchOptions: { allowPrivateNetworks: true } })
    const imported = await service.create({ name: '重试订阅', url })
    assert.equal(imported.id, id)
    assert.equal(imported.nodeCount, 1)
    assert.equal(store.list().length, 1)
  } finally { store.close(); server.close(); await once(server, 'close') }
})
