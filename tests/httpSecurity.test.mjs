import { registerReliabilityRoutes } from '../server/routes/reliability.mjs'
import { registerSubscriptionRoutes } from '../server/routes/subscriptions.mjs'
import { registerPortRoutes } from '../server/routes/ports.mjs'
import { registerAuditRoutes } from '../server/routes/audit.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { requestContext } from '../server/http/requestContext.mjs'
import { createOriginGuard, securityHeaders } from '../server/security/http.mjs'
import { createMutationGate } from '../server/recovery/mutationGate.mjs'

test('sets browser security headers and rejects cross-origin mutations', async t => {
  const app = express()
  app.use(requestContext)
  app.use(securityHeaders)
  app.use('/api', createOriginGuard())
  app.use(express.json())
  app.post('/api/value', (_req, res) => res.json({ ok: true }))
  const server = await new Promise(resolve => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate))
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port, url = `http://127.0.0.1:${port}/api/value`
  const accepted = await fetch(url, { method: 'POST', headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(accepted.status, 200)
  assert.match(accepted.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.match(accepted.headers.get('content-security-policy'), /fonts\.gstatic\.com/)
  assert.equal(accepted.headers.get('x-content-type-options'), 'nosniff')
  const rejected = await fetch(url, { method: 'POST', headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(rejected.status, 403)
  assert.equal((await rejected.json()).error.code, 'CROSS_ORIGIN_REQUEST')
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function mutationFixture(t) {
  const app = express(), gate = createMutationGate()
  let operation
  const slow = async (_req, res) => {
    const active = operation
    res.once('close', active.closed.resolve)
    active.started.resolve()
    try {
      await active.release.promise
      return res.json({ ok: true })
    } finally { active.completed.resolve() }
  }
  app.use(requestContext)
  app.post('/api/slow-write', gate.mutation(slow))
  app.post('/api/write', gate.mutation((_req, res) => res.json({ ok: true })))
  app.post('/api/failing-write', gate.mutation(async () => { throw new Error('write failed') }))
  app.post('/api/failing-restore', gate.restore(async () => { throw new Error('restore failed') }))
  registerReliabilityRoutes(app, {
    mutationGate: gate,
    recoveryService: {
      restore: async () => {
        const active = operation
        active.started.resolve()
        await active.release.promise
        active.completed.resolve()
        return { ok: true }
      },
      inspect: async () => ({ summary: { ok: true } }),
    },
  })
  // Exercise the real route registrations: all share the same gate.
  registerSubscriptionRoutes(app, { mutationGate: gate })
  registerPortRoutes(app, { mutationGate: gate })
  registerAuditRoutes(app, { mutationGate: gate })
  app.use((_error, _req, res, _next) => res.status(500).end())
  const server = await new Promise(resolve => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate))
  })
  t.after(() => { operation?.release.resolve(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    request: (path, options = {}) => fetch(`${base}${path}`, { method: 'POST', ...options }),
    begin() {
      operation = { started: deferred(), closed: deferred(), release: deferred(), completed: deferred() }
      return operation
    },
    server,
  }
}

test('guards real routes including trailing slashes and case-insensitive restore URLs', async t => {
  const fixture = await mutationFixture(t), write = fixture.begin()
  const activeWrite = fixture.request('/api/slow-write')
  await write.started.promise
  for (const path of ['/api/recovery/restore', '/api/recovery/restore/', '/API/RECOVERY/RESTORE/?check=1', '/api/recovery/export', '/API/RECOVERY/EXPORT/']) {
    const blocked = await fixture.request(path)
    assert.equal(blocked.status, 409)
    assert.equal((await blocked.json()).error.code, 'CONFIGURATION_BUSY')
  }
  write.release.resolve()
  assert.equal((await activeWrite).status, 200)
  const restore = fixture.begin(), activeRestore = fixture.request('/API/RECOVERY/RESTORE/')
  await restore.started.promise
  for (const [method, path] of [
    ['POST', '/api/write'], ['POST', '/api/subscriptions'], ['PATCH', '/api/subscriptions/id'],
    ['DELETE', '/api/subscriptions/id'], ['POST', '/api/subscriptions/id/refresh'],
    ['POST', '/api/subscriptions/refresh-all'], ['POST', '/api/subscriptions/preview'],
    ['PUT', '/api/ports/17900'], ['DELETE', '/api/ports/17900'], ['POST', '/api/ports/17900/verify'],
    ['DELETE', '/api/audit'],
  ]) {
    const blocked = await fixture.request(path, { method })
    assert.equal(blocked.status, 409, `${method} ${path}`)
    assert.equal((await blocked.json()).error.code, 'RECOVERY_IN_PROGRESS')
  }
  assert.equal((await fixture.request('/api/recovery/restore/')).status, 409)
  const blockedExport = await fixture.request('/api/recovery/export')
  assert.equal(blockedExport.status, 409)
  assert.equal((await blockedExport.json()).error.code, 'CONFIGURATION_BUSY')
  assert.equal((await fixture.request('/API/RECOVERY/INSPECT/')).status, 200)
  assert.equal((await fixture.request('/api/unknown')).status, 404)
  restore.release.resolve()
  assert.equal((await activeRestore).status, 200)
  assert.equal((await fixture.request('/api/write')).status, 200)
})

for (const kind of ['write', 'restore']) {
  test(`keeps the ${kind} lease after client disconnect until the operation completes`, async t => {
    const fixture = await mutationFixture(t), active = fixture.begin()
    const controller = new AbortController()
    // Observe the actual server response closing, not just the client's rejection.
    fixture.server.once('request', (_req, res) => res.once('close', active.closed.resolve))
    const pending = fixture.request(kind === 'write' ? '/api/slow-write' : '/api/recovery/restore/', { signal: controller.signal })
    const aborted = assert.rejects(pending, { name: 'AbortError' })
    await active.started.promise
    controller.abort()
    await aborted
    await active.closed.promise
    const blocked = await fixture.request(kind === 'write' ? '/api/recovery/restore/' : '/api/write')
    assert.equal(blocked.status, 409)
    assert.equal((await blocked.json()).error.code, kind === 'write' ? 'CONFIGURATION_BUSY' : 'RECOVERY_IN_PROGRESS')
    active.release.resolve()
    await active.completed.promise
    const next = fixture.begin()
    next.release.resolve()
    assert.equal((await fixture.request('/api/recovery/restore')).status, 200)
    assert.equal((await fixture.request('/api/write')).status, 200)
  })
}

test('releases leases when a handler rejects', async t => {
  const fixture = await mutationFixture(t)
  for (const path of ['/api/failing-write', '/api/failing-restore']) {
    assert.equal((await fixture.request(path)).status, 500)
    const next = fixture.begin()
    next.release.resolve()
    assert.equal((await fixture.request('/api/recovery/restore')).status, 200)
    assert.equal((await fixture.request('/api/write')).status, 200)
  }
})
