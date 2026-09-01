import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createCredentialVersion, SessionStore } from '../server/sessionStore.mjs'

async function storeFixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppm-session-store-'))
  const filename = path.join(root, 'sessions.sqlite')
  const store = new SessionStore({
    filename,
    idleMs: 10_000,
    absoluteMs: 30_000,
    touchIntervalMs: 1_000,
    credentialVersion: 'v1',
    ...options,
  })
  return { root, filename, store }
}

test('stores a token digest and restores a session from the same database', async t => {
  const fixture = await storeFixture()
  const now = Date.now()
  fixture.store.create('raw-secret-token', 'admin', now)
  fixture.store.close()

  const reopened = new SessionStore({ filename:fixture.filename, idleMs:10_000, absoluteMs:30_000, touchIntervalMs:1_000, credentialVersion:'v1' })
  t.after(async () => { reopened.close(); await rm(fixture.root, { recursive: true, force: true }) })
  assert.deepEqual(reopened.find('raw-secret-token', { now:now+1_000 }), { username:'admin', createdAt:now, lastSeenAt:now, absoluteExpiresAt:now+30_000, idleTimeoutMs:10_000 })
  assert.equal(reopened.find('different-token', { now:now+1_000 }), null)
})

test('supports a longer per-session lifetime for remembered logins', async t => {
  const fixture = await storeFixture()
  t.after(async () => { fixture.store.close(); await rm(fixture.root, { recursive: true, force: true }) })
  const now = Date.now()
  fixture.store.create('browser-session', 'admin', now)
  fixture.store.create('remembered-session', 'admin', now, { idleMs:20_000, absoluteMs:60_000 })

  assert.equal(fixture.store.find('browser-session', { now:now+10_000 }), null)
  assert.equal(fixture.store.find('remembered-session', { now:now+10_000 })?.idleTimeoutMs, 20_000)
  assert.equal(fixture.store.find('remembered-session', { now:now+20_000 }), null)
})

test('migrates an existing session database to per-session idle timeouts', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppm-session-migration-'))
  const filename = path.join(root, 'sessions.sqlite')
  const legacy = new DatabaseSync(filename)
  legacy.exec(`CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    credential_version TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    absolute_expires_at INTEGER NOT NULL
  )`)
  legacy.close()

  const store = new SessionStore({ filename, idleMs:10_000, absoluteMs:30_000, touchIntervalMs:1_000, credentialVersion:'v1' })
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  const now = Date.now()
  store.create('post-migration-token', 'admin', now, { idleMs:20_000, absoluteMs:60_000 })
  assert.equal(store.find('post-migration-token', { now:now+10_000 })?.idleTimeoutMs, 20_000)
})

test('expires idle sessions, persists logout, and changes the credential version with the password hash', async t => {
  const fixture = await storeFixture()
  const now = Date.now()
  fixture.store.create('idle-token', 'admin', now)
  assert.equal(fixture.store.find('idle-token', { now:now+10_000 }), null)
  fixture.store.create('logout-token', 'admin', now+12_000)
  assert.equal(fixture.store.delete('logout-token'), true)
  fixture.store.create('version-token', 'admin', now+12_000)
  fixture.store.close()

  const changed = new SessionStore({ filename:fixture.filename, idleMs:10_000, absoluteMs:30_000, touchIntervalMs:1_000, credentialVersion:'v2' })
  t.after(async () => { changed.close(); await rm(fixture.root, { recursive: true, force: true }) })
  assert.equal(changed.find('logout-token', { now:now+13_000 }), null)
  assert.equal(changed.find('version-token', { now:now+13_000 }), null)
  assert.notEqual(createCredentialVersion('admin', 'hash-a', '1'), createCredentialVersion('admin', 'hash-b', '1'))
})
