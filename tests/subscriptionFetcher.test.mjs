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

test('Fake-IP 环境通过 DoH 校验真实地址并固定连接目标', async () => {
  const dispatches = []
  let requested = 0
  const result = await fetchSubscription('https://subscription.example/config', {
    lookup: async () => [
      { address: '198.18.0.7', family: 4 },
      { address: 'fdfe:dcba:9876::7', family: 6 },
    ],
    dohUrls: ['https://resolver.example/dns-query'],
    dohFetch: async url => {
      assert.equal(url.hostname, 'resolver.example')
      assert.equal(url.searchParams.get('name'), 'subscription.example')
      const answer = url.searchParams.get('type') === 'A'
        ? [{ name: 'subscription.example', type: 1, data: '8.8.8.8' }]
        : []
      return new Response(JSON.stringify({ Status: 0, Answer: answer }), {
        status: 200,
        headers: { 'Content-Type': 'application/dns-json' },
      })
    },
    dispatcherFactory: addresses => {
      dispatches.push(addresses)
      return { close: async () => {} }
    },
    request: async (_url, init) => {
      requested += 1
      assert.ok(init.dispatcher)
      return new Response(yaml, { status: 200 })
    },
  })
  assert.equal(result.content, yaml)
  assert.equal(requested, 1)
  assert.deepEqual(dispatches, [[{ address: '8.8.8.8', family: 4 }]])
})

test('Fake-IP 的 DoH 真实结果为私网地址时仍然拒绝', async () => {
  let requested = false
  await assert.rejects(() => fetchSubscription('https://subscription.example/config', {
    lookup: async () => [{ address: '198.18.0.7', family: 4 }],
    dohLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    request: async () => { requested = true },
  }), /内网、环回或保留地址/)
  assert.equal(requested, false)
})

test('混合公网和私网解析结果不会借 DoH 绕过安全检查', async () => {
  let dohRequested = false
  await assert.rejects(() => fetchSubscription('https://subscription.example/config', {
    lookup: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
    dohLookup: async () => { dohRequested = true; return [{ address: '8.8.8.8', family: 4 }] },
  }), /内网、环回或保留地址/)
  assert.equal(dohRequested, false)
})

test('订阅重定向会重新校验目标地址', async () => {
  let requested = 0
  await assert.rejects(() => fetchSubscription('https://subscription.example/config', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    dispatcherFactory: () => ({ close: async () => {} }),
    request: async () => {
      requested += 1
      return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } })
    },
  }), /内网、环回或保留地址/)
  assert.equal(requested, 1)
})
