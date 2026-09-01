import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultConfigDir, loadSubscriptionCatalog } from '../server/subscriptionCatalog.mjs'

test('loads the installed Clash Verge subscription catalog', async () => {
  const catalog = await loadSubscriptionCatalog(defaultConfigDir())
  assert.ok(catalog.providers.length >= 2)
  assert.ok(catalog.nodes.length >= 100)
  assert.ok(catalog.countries.length > 4)
  assert.equal(catalog.providers.reduce((sum,p)=>sum+p.nodeCount,0), catalog.nodes.length)
  assert.ok(catalog.nodes.some(node => node.name === '🇺🇸11美国西集群-全网优化(hy2)'))
  assert.ok(Array.isArray(catalog.listeners))
})
