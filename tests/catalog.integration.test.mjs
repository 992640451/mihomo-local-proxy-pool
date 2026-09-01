import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultConfigDir, loadSubscriptionCatalog } from '../server/subscriptionCatalog.mjs'

test('loads the installed Clash Verge subscription catalog', async () => {
  const catalog = await loadSubscriptionCatalog(defaultConfigDir())
  assert.ok(catalog.providers.length >= 1)
  assert.ok(catalog.nodes.length >= 1)
  assert.ok(catalog.countries.length >= 1)
  assert.equal(catalog.providers.reduce((sum,p)=>sum+p.nodeCount,0), catalog.nodes.length)
  assert.ok(catalog.nodes.every(node => node.id && node.name && node.providerId && node.provider))
  assert.ok(catalog.countries.every(country => country.code && country.name && country.count > 0))
  assert.ok(Array.isArray(catalog.listeners))
})
