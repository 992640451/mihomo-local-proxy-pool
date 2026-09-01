import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadSubscriptionCatalog } from '../server/subscriptionCatalog.mjs'

test('loads a self-contained Clash Verge subscription catalog', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppm-catalog-'))
  try {
    await mkdir(path.join(root, 'profiles'))
    await writeFile(path.join(root, 'profiles.yaml'), `items:
  - uid: provider-a
    type: remote
    name: 匿名测试订阅
    file: provider-a.yaml
`)
    await writeFile(path.join(root, 'profiles', 'provider-a.yaml'), `proxies:
  - name: 日本测试节点
    type: ss
    server: 192.0.2.10
    port: 443
    cipher: aes-128-gcm
    password: test-password
  - name: 美国测试节点
    type: ss
    server: 198.51.100.20
    port: 8443
    cipher: aes-128-gcm
    password: test-password
`)

    const catalog = await loadSubscriptionCatalog(root)
    assert.equal(catalog.providers.length, 1)
    assert.equal(catalog.nodes.length, 2)
    assert.equal(catalog.countries.length, 2)
    assert.equal(catalog.providers.reduce((sum,p)=>sum+p.nodeCount,0), catalog.nodes.length)
    assert.ok(catalog.nodes.every(node => node.id && node.name && node.providerId && node.provider))
    assert.ok(catalog.countries.every(country => country.code && country.name && country.count > 0))
    assert.deepEqual(catalog.listeners, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
