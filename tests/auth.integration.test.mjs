import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { scryptSync } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

async function startServer(port, env) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`server timeout: ${stderr}`)), 15000)
    const onData = () => finish()
    const onExit = code => finish(new Error(`server exited ${code}: ${stderr}`))
    const finish = error => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('exit', onExit)
      error ? reject(error) : resolve()
    }
    child.stdout.on('data', onData)
    child.once('exit', onExit)
  })
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await once(child, 'exit')
}

test('restores an authenticated HttpOnly cookie session after a server restart and persists logout revocation', async () => {
  const port = 42991, salt = 'test-salt', password = 'test-password'
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ppm-auth-restart-'))
  const sessionDb = path.join(tempDir, 'sessions.sqlite')
  const env = {
    AUTH_USERNAME: 'test-user',
    AUTH_PASSWORD_SALT: salt,
    AUTH_PASSWORD_SCRYPT: scryptSync(password, salt, 64).toString('hex'),
    AUTH_SESSION_DB: sessionDb,
    SUBSCRIPTION_MODE: 'native',
    SUBSCRIPTION_DB: path.join(tempDir, 'subscriptions.sqlite'),
    SUBSCRIPTION_MASTER_KEY: 'test-master-key-for-auth-suite',
    AUTH_SESSION_IDLE_SECONDS: '3600',
    AUTH_SESSION_MAX_SECONDS: '86400',
    AUTH_SESSION_TOUCH_SECONDS: '1',
    AUTH_REMEMBER_IDLE_SECONDS: '604800',
    AUTH_REMEMBER_MAX_SECONDS: '1209600',
    AUTH_SESSION_VERSION: 'test-v1',
  }
  const base = `http://127.0.0.1:${port}/api`
  let child
  try {
    child = await startServer(port, env)
    const health = await fetch(`http://127.0.0.1:${port}/healthz`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).status, 'ok')
    const unauthenticated = await fetch(`${base}/runtime`, { headers: { 'X-Request-Id': 'auth-suite-request' } })
    assert.equal(unauthenticated.status, 401)
    assert.equal(unauthenticated.headers.get('x-request-id'), 'auth-suite-request')
    assert.deepEqual(await unauthenticated.json(), {
      error: {
        code: 'AUTH_REQUIRED',
        message: '需要登录',
        requestId: 'auth-suite-request',
      },
    })
    assert.equal((await fetch(`${base}/auth/session`)).status, 401)
    assert.equal((await fetch(`${base}/auth/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:'test-user',password:'wrong'}) })).status, 401)

    const browserLogin = await fetch(`${base}/auth/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:'test-user',password,remember:false}) })
    assert.equal(browserLogin.status, 200)
    assert.equal((await browserLogin.json()).remembered, false)
    assert.equal(browserLogin.headers.get('set-cookie')?.includes('Max-Age'), false)

    const login = await fetch(`${base}/auth/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:'test-user',password,remember:true}) })
    assert.equal(login.status, 200)
    const body = await login.json(), cookie = login.headers.get('set-cookie')
    assert.equal(body.authenticated, true)
    assert.equal(body.remembered, true)
    assert.equal(body.expiresIn, 604800)
    assert.ok(cookie?.includes('ppm_session='))
    assert.ok(cookie?.includes('HttpOnly'))
    assert.ok(cookie?.includes('SameSite=Lax'))
    assert.ok(cookie?.includes('Max-Age=1209600'))
    const sessionCookie = cookie.split(';', 1)[0]
    assert.equal((await fetch(`${base}/runtime`, { headers:{Cookie:sessionCookie} })).status, 200)
    const missing = await fetch(`${base}/missing`, { headers:{Cookie:sessionCookie} })
    assert.equal(missing.status, 404)
    const missingBody = await missing.json()
    assert.equal(missingBody.error.code, 'API_NOT_FOUND')
    assert.equal(missingBody.error.requestId, missing.headers.get('x-request-id'))

    await stopServer(child)
    child = await startServer(port, env)
    const restored = await fetch(`${base}/auth/session`, { headers:{Cookie:sessionCookie} })
    assert.equal(restored.status, 200)
    assert.equal((await restored.json()).remembered, true)
    assert.equal((await fetch(`${base}/runtime`, { headers:{Cookie:sessionCookie} })).status, 200)

    const logout = await fetch(`${base}/auth/logout`, { method:'POST', headers:{Cookie:sessionCookie} })
    assert.equal(logout.status, 204)
    assert.ok(logout.headers.get('set-cookie')?.includes('Max-Age=0'))
    await stopServer(child)
    child = await startServer(port, env)
    assert.equal((await fetch(`${base}/runtime`, { headers:{Cookie:sessionCookie} })).status, 401)
  } finally {
    await stopServer(child)
    await rm(tempDir, { recursive: true, force: true })
  }
})
