import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ApiTokenStore } from '../server/automation/tokenStore.mjs'

test('API tokens persist only digests, expiry, last use and revocation across restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ppm-token-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'tokens.sqlite')
  let store = new ApiTokenStore({ filename, credentialVersion: 'v1' })
  const token = store.create({ name: 'CI', scopes: ['ports:write'], expiresInDays: 1 }, 1000)
  assert.deepEqual(token.scopes, ['ports:write', 'read'])
  assert.equal(store.authenticate('wrong', 1001), null)
  assert.equal(store.authenticate(token.secret, 1001).id, token.id)
  assert.equal(store.list()[0].lastUsedAt, 1001)
  assert.equal(JSON.stringify(store.list()).includes(token.secret), false)
  store.close()
  assert.equal((await readFile(filename)).includes(Buffer.from(token.secret)), false)
  store = new ApiTokenStore({ filename, credentialVersion: 'v1' })
  assert.ok(store.authenticate(token.secret, 2000))
  assert.equal(store.authenticate(token.secret, 86401000), null)
  assert.equal(store.revoke(token.id, 2100), true)
  store.close()
  store = new ApiTokenStore({ filename, credentialVersion: 'v1' })
  assert.equal(store.authenticate(token.secret, 2200), null)
  const next = store.create({ name: 'new', scopes: ['read'] })
  store.close()
  store = new ApiTokenStore({ filename, credentialVersion: 'v2' })
  assert.equal(store.authenticate(next.secret), null)
  assert.ok(store.list().find(item => item.id === next.id).revokedAt)
  store.close()
})

test('token issuance validates scopes, names, lifetime and active-token quota', () => {
  const store = new ApiTokenStore({ credentialVersion: 'test' })
  try {
    for (const scopes of [[], ['admin'], ['toString'], 'read']) assert.throws(() => store.create({ name: 'CI', scopes }))
    assert.throws(() => store.create({ name: 'CI\nheader', scopes: ['read'] }))
    for (const expiresInDays of [0, 366, 1.5, '90']) assert.throws(() => store.create({ name: 'CI', scopes: ['read'], expiresInDays }))
    for (let index = 0; index < 100; index++) store.create({ name: `CI ${index}`, scopes: ['read'] })
    assert.throws(() => store.create({ name: 'quota', scopes: ['read'] }), /100/)
    store.revoke(store.list()[0].id)
    assert.ok(store.create({ name: 'replacement', scopes: ['read'] }).secret)
  } finally { store.close() }
})
