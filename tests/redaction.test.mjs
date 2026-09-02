import assert from 'node:assert/strict'
import test from 'node:test'
import { redactSensitive, redactText, redactUrl } from '../server/security/redaction.mjs'

test('redacts URL credentials, terminal path segments, query values and fragments', () => {
  const output = redactUrl('https://alice:password@example.com/api/subscription/super-secret?token=abcd&user=visible#private')
  assert.equal(output.includes('alice'), false)
  assert.equal(output.includes('password'), false)
  assert.equal(output.includes('super-secret'), false)
  assert.equal(output.includes('abcd'), false)
  assert.match(output, /\/api\/subscription\/\*\*\*/)
  assert.match(output, /token=\*\*\*/)
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
