import assert from 'node:assert/strict'
import test from 'node:test'
import { redactSensitive, redactText, redactUrl } from '../server/security/redaction.mjs'
import { parseSubscription } from '../server/subscriptions/parser.mjs'
import { AuditStore } from '../server/audit/store.mjs'

test('redacts URL credentials, terminal path segments, query values and fragments', () => {
  const output = redactUrl('https://alice:password@example.com/api/subscription/super-secret?token=abcd&user=visible#private')
  assert.equal(output.includes('alice'), false)
  assert.equal(output.includes('password'), false)
  assert.equal(output.includes('super-secret'), false)
  assert.equal(output.includes('abcd'), false)
  assert.match(output, /\/api\/subscription\/\*\*\*/)
  assert.match(output, /token=\*\*\*/)
})

test('YAML parse errors expose only an error code and position, never source lines', () => {
  const uuid = '11111111-2222-3333-4444-555555555555'
  assert.throws(() => parseSubscription(`proxies:\n - uuid: ${uuid}\n   uuid: ${uuid}\n`, { subscriptionId: 'test' }), error => {
    assert.match(error.message, /YAML 解析失败.*DUPLICATE_KEY.*第 3 行/)
    assert.doesNotMatch(error.message, /uuid|11111111/)
    return true
  })
})

test('redacts proxy identities, quoted secrets and private key blocks without masking resource IDs', () => {
  const uuid = '11111111-2222-3333-4444-555555555555'
  const output = redactText(`uuid: ${uuid}\n{"password": "secret with spaces", "private-key": "private material"}\n-----BEGIN PRIVATE KEY-----\nbase64-private-material\n-----END PRIVATE KEY-----`)
  assert.doesNotMatch(output, /11111111|secret with spaces|private material|base64-private-material/)
  assert.deepEqual(redactSensitive({ id: uuid, uuid, private_key: 'hidden', 'pre-shared-key': 'hidden' }), { id: uuid, uuid: '<redacted>', private_key: '<redacted>', 'pre-shared-key': '<redacted>' })
})

test('historical audit rows are redacted again when read', () => {
  const store = new AuditStore()
  try {
    const event = store.record({ action: 'subscription.create', message: 'failed' })
    store.db.prepare('UPDATE audit_events SET message=?,metadata_json=? WHERE id=?').run('YAML 解析失败：old source snippet containing private-value', JSON.stringify({ uuid: 'legacy-credential' }), event.id)
    assert.doesNotMatch(JSON.stringify(store.list()), /private-value|legacy-credential/)
    assert.doesNotMatch(JSON.stringify(store.get(event.id)), /private-value|legacy-credential/)
  } finally { store.close() }
})

test('redacts secrets from error text and nested diagnostic values', () => {
  const text = redactText('fetch https://example.com/sub/private?token=abcd failed; password=hunter2 Authorization: Bearer abc.def')
  assert.equal(text.includes('private'), false)
  assert.equal(text.includes('abcd'), false)
  assert.equal(text.includes('hunter2'), false)
  assert.equal(text.includes('abc.def'), false)

  assert.deepEqual(redactSensitive({
    url: 'https://example.com/sub/private?token=abcd',
    headers: { authorization: 'Bearer abc.def' },
    nested: { count: 3, password: 'hunter2' },
  }), {
    url: 'https://example.com/sub/***?token=***',
    headers: { authorization: '<redacted>' },
    nested: { count: 3, password: '<redacted>' },
  })
})
