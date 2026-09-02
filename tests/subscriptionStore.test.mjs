import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SubscriptionStore } from '../server/subscriptions/store.mjs'
import { SubscriptionService } from '../server/subscriptions/service.mjs'
import { fetchSubscription } from '../server/subscriptions/fetcher.mjs'

const masterKey = 'test-only-master-key-at-least-32-characters'
const config = (name = '日本 01') => `proxies:\n  - name: ${name}\n    type: ss\n    server: jp.example.com\n    port: 8443\n    cipher: aes-128-gcm\n    password: very-sensitive-password\n`

test('订阅密文存储、节点改名保持 ID，并在坏版本时保留上一版', async () => {
  const store = new SubscriptionStore({ masterKey })
  const service = new SubscriptionService({ store })
  const created = await service.create({ name: '测试订阅', content: config() })
  const original = service.getDefinitions()[0]

  const rawNode = store.db.prepare('SELECT raw_encrypted FROM subscription_nodes WHERE id=?').get(original.id).raw_encrypted
  const snapshot = store.db.prepare('SELECT content_encrypted FROM subscription_snapshots WHERE subscription_id=?').get(created.id).content_encrypted
  assert.equal(rawNode.includes('very-sensitive-password'), false)
  assert.equal(snapshot.includes('very-sensitive-password'), false)

  await service.update(created.id, { content: config('日本 01 新名称') })
  const renamed = service.getDefinitions()[0]
  assert.equal(renamed.id, original.id)
  assert.equal(renamed.raw.name, '日本 01 新名称')

  await assert.rejects(() => service.update(created.id, { content: 'proxies: []' }), /没有可用节点/)
  assert.equal(service.getDefinitions()[0].raw.name, '日本 01 新名称')
  assert.match(service.list()[0].lastError, /没有可用节点/)
  await service.update(created.id, { enabled: false })
  assert.equal(service.getDefinitions().length, 0)
  assert.equal(service.getDefinitions({ includeDisabled: true }).length, 1)
  store.close()
})

test('订阅 URL 只以脱敏形式出现在公共列表', async () => {
  const store = new SubscriptionStore({ masterKey })
  const id = store.insertSubscription({ name: 'remote', sourceType: 'url', url: 'https://private-user:private-pass@example.com/api/subscription/super-secret?token=abcd#private-fragment' })
  assert.equal(store.get(id).url.includes('super-secret'), false)
  assert.equal(store.get(id).url.includes('abcd'), false)
  assert.equal(store.get(id).url.includes('private-'), false)
  store.recordFailure(id, 'failed password=short-secret https://example.com/sub/private-key')
  assert.equal(store.get(id).lastError.includes('short-secret'), false)
  assert.equal(store.get(id).lastError.includes('private-key'), false)
  assert.equal(store.get(id, { secrets: true }).url.includes('super-secret'), true)
  store.close()
})

test('hybrid 首次迁移保留 Clash Verge 节点 ID', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ppm-subscription-migration-'))
  await mkdir(path.join(directory, 'profiles'))
  await writeFile(path.join(directory, 'profiles.yaml'), 'items:\n  - uid: legacy-a\n    type: remote\n    name: 旧订阅\n    file: legacy.yaml\n    url: https://example.com/sub/token\n')
  await writeFile(path.join(directory, 'profiles', 'legacy.yaml'), config('日本 01'))
  const store = new SubscriptionStore({ masterKey })
  const service = new SubscriptionService({ store, mode: 'hybrid', legacySource: directory })
  await service.initialize()
  assert.equal(service.list().length, 1)
  assert.equal(service.getDefinitions()[0].id, createHash('sha1').update('legacy-a:日本 01').digest('hex').slice(0, 16))
  store.close()
  await rm(directory, { recursive: true, force: true })
})

test('订阅下载默认拒绝环回和内网地址', async () => {
  await assert.rejects(() => fetchSubscription('http://127.0.0.1:65530/subscription'), /内网、环回或保留地址/)
})

test('订阅优先级统一决定订阅列表和节点定义顺序', async () => {
  const store = new SubscriptionStore({ masterKey })
  const service = new SubscriptionService({ store })
  const low = await service.create({ name: '低优先级', content: config('低节点'), priority: 10 })
  await service.create({ name: '高优先级', content: config('高节点'), priority: 80 })
  assert.deepEqual(service.list().map(item => item.name), ['高优先级', '低优先级'])
  assert.deepEqual(service.getDefinitions().map(item => item.provider), ['高优先级', '低优先级'])
  await service.update(low.id, { priority: 100 })
  assert.deepEqual(service.list().map(item => item.name), ['低优先级', '高优先级'])
  await assert.rejects(() => service.update(low.id, { priority: 10001 }), /优先级/)
  store.close()
})
